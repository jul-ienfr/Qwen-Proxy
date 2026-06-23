/**
 * Image Generation Routes - OpenAI-compatible image endpoints
 * Adapted from upstream Qwen-Proxy chat.image.video.js
 */

import type { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import crypto from 'crypto';
import { getQwenHeaders } from '../services/playwright.js';
import { getNextAccount, getNextAvailableAccount, markAccountRateLimited, getAccountCooldownInfo } from '../core/account-manager.js';
import { loadAccounts } from '../core/accounts.js';
import { metrics } from '../core/metrics.js';
import { requestLogger } from '../core/request-logger.js';
import { getDebugLogger } from '../core/debug-logger.js';

const CACHED_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

// ─── Size Mapping (OpenAI format → Qwen format) ──────────────────────────────

const SIZE_MAP: Record<string, string> = {
  '1024x1024': '1:1',
  '1536x1024': '4:3',
  '1024x1536': '3:4',
  '1792x1024': '16:9',
  '1024x1792': '9:16',
};

function normalizeSize(size?: string): string {
  if (!size) return '1:1';
  return SIZE_MAP[size] || size;
}

// ─── SSE Parsing Helpers ──────────────────────────────────────────────────────

function parseSsePayloads(buffer: string, flush = false): { payloads: string[]; buffer: string } {
  const input = flush ? `${buffer}\n\n` : buffer;
  const events = input.split(/\r?\n\r?\n/);
  const payloads: string[] = [];
  const remainBuffer = flush ? '' : (events.pop() || '');

  for (const event of events) {
    const dataLines = event
      .split(/\r?\n/)
      .filter(item => item.trim().startsWith('data:'))
      .map(item => item.replace(/^data:\s*/, '').trim())
      .filter(Boolean);

    if (dataLines.length === 0) continue;

    const payload = dataLines.join('\n').trim();
    if (payload && payload !== '[DONE]') {
      payloads.push(payload);
    }
  }

  return { payloads, buffer: remainBuffer };
}

function extractResourceUrlFromText(text: string): string | null {
  if (!text) return null;

  // Markdown image: ![alt](url)
  const markdownUrl = text.match(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/i)?.[1];
  if (markdownUrl) return markdownUrl;

  // Download link: [Download ...](url)
  const downloadUrl = text.match(/\[Download [^\]]+\]\((https?:\/\/[^\s)]+)\)/i)?.[1];
  if (downloadUrl) return downloadUrl;

  // Plain URL
  const plainUrl = text.match(/https?:\/\/[^\s<>"')\]]+/i)?.[0];
  return plainUrl || null;
}

function extractResourceUrlFromPayload(payload: any): string | null {
  if (!payload) return null;

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const url = extractResourceUrlFromPayload(item);
      if (url) return url;
    }
    return null;
  }

  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        const url = extractResourceUrlFromPayload(parsed);
        if (url) return url;
      } catch { /* ignore */ }
    }
    return extractResourceUrlFromText(trimmed);
  }

  if (typeof payload !== 'object') return null;

  // Direct candidates
  const directCandidates = [
    payload.content, payload.url, payload.image, payload.image_url,
    payload.video, payload.video_url, payload.download_url, payload.file_url,
    payload.resource_url, payload.output_url, payload.result_url, payload.uri,
  ];

  for (const candidate of directCandidates) {
    if (typeof candidate === 'string') {
      const url = extractResourceUrlFromText(candidate);
      if (url) return url;
    }
    if (candidate && typeof candidate === 'object') {
      const url = extractResourceUrlFromPayload(candidate);
      if (url) return url;
    }
  }

  // Nested candidates
  const nestedCandidates = [
    payload.data, payload.message, payload.delta, payload.extra,
    payload.choices, payload.output, payload.result, payload.results,
  ];

  for (const candidate of nestedCandidates) {
    const url = extractResourceUrlFromPayload(candidate);
    if (url) return url;
  }

  return null;
}

function parseUpstreamError(data: any): { error: string; code: string; status: number } | null {
  try {
    let payload = data;
    if (Array.isArray(payload) && payload.length > 0) payload = payload[0];
    if (typeof payload === 'string') payload = JSON.parse(payload);

    if (!payload || payload.success !== false || !payload.data?.code) return null;

    const errorData = payload.data;
    if (errorData.code === 'RateLimited') {
      const waitHours = errorData.num;
      return {
        error: `Rate limited. ${waitHours ? `Please wait ~${waitHours} hours.` : 'Please try again later.'}`,
        code: errorData.code,
        status: 429,
      };
    }

    return {
      error: errorData.details || errorData.code || 'Upstream error',
      code: errorData.code,
      status: 500,
    };
  } catch {
    return null;
  }
}

// ─── Image Generation: POST /v1/images/generations ────────────────────────────

export async function imageGenerations(c: Context) {
  const startTime = Date.now();

  try {
    const body = await c.req.json();
    const {
      prompt,
      model,
      n = 1,
      size,
      response_format = 'url',
    } = body;

    if (!prompt) {
      return c.json({ error: { message: 'prompt is required', type: 'invalid_request_error' } }, 400);
    }

    const dbg = getDebugLogger();
    if (dbg.isEnabled()) {
      dbg.log('REQUEST', 'images.ts', `Image generation: ${model || 'default'}`, {
        prompt: prompt.slice(0, 100),
        model,
        size,
        response_format,
      });
    }

    // Resolve model
    const imageModel = resolveImageModel(model);

    // Get account and headers
    let account = getNextAccount();
    const triedAccountIds = new Set<string>();
    let lastError: any = null;

    while (account) {
      if (triedAccountIds.has(account.id)) {
        account = getNextAvailableAccount(triedAccountIds);
        continue;
      }
      triedAccountIds.add(account.id);

      const cooldownInfo = getAccountCooldownInfo(account.id);
      if (cooldownInfo) {
        account = getNextAvailableAccount(triedAccountIds);
        continue;
      }

      try {
        const result = await generateImage({
          prompt,
          model: imageModel,
          size: normalizeSize(size),
          n,
          accountId: account.id,
        });

        // Format response (OpenAI-compatible)
        const data = result.data.map((item: any) => {
          if (response_format === 'b64_json' && item.url) {
            // TODO: download and convert to base64
            return { url: item.url };
          }
          return { url: item.url };
        });

        const response = {
          created: Math.floor(Date.now() / 1000),
          data,
        };

        requestLogger.log({
          originalModel: model || 'image',
          mappedModel: imageModel,
          protocol: 'openai',
          endpoint: '/v1/images/generations',
          clientIp: c.req.header('x-forwarded-for') || 'unknown',
          userAgent: c.req.header('user-agent') || 'unknown',
          thinking: false,
          hasTools: false,
          streamMode: false,
          inputTokens: 0,
          outputTokens: 0,
          cacheTokens: 0,
          totalTokens: 0,
          startTime,
          endTime: Date.now(),
          streamCreationMs: 0,
          success: true,
          statusCode: 200,
          accountId: account.id,
        });

        return c.json(response);
      } catch (err: any) {
        if (err.status === 429 || err.code === 'RateLimited') {
          const hourHint = err.message?.match?.(/Wait about (\d+) hour/);
          const cooldownMs = hourHint ? parseInt(hourHint[1]) * 60 * 60 * 1000 : undefined;
          markAccountRateLimited(account.id, cooldownMs, 'RateLimited');
        }
        lastError = err;
        account = getNextAvailableAccount(triedAccountIds);
      }
    }

    throw lastError || new Error('All accounts failed');
  } catch (err: any) {
    const status = err.status || 500;
    return c.json({
      error: {
        message: err.error || err.message || 'Image generation failed',
        type: status >= 500 ? 'server_error' : 'invalid_request_error',
      },
    }, status as any);
  }
}

// ─── Image Edit: POST /v1/images/edits ───────────────────────────────────────

export async function imageEdits(c: Context) {
  const startTime = Date.now();

  try {
    const formData = await c.req.formData();
    const image = formData.get('image') as File | null;
    const prompt = formData.get('prompt') as string || '';
    const model = formData.get('model') as string || '';
    const n = parseInt(formData.get('n') as string || '1', 10);
    const size = formData.get('size') as string || undefined;

    if (!image) {
      return c.json({ error: { message: 'image is required', type: 'invalid_request_error' } }, 400);
    }

    // Resolve model
    const imageModel = resolveImageModel(model, 'image_edit');

    // Get account
    let account = getNextAccount();
    const triedAccountIds = new Set<string>();
    let lastError: any = null;

    while (account) {
      if (triedAccountIds.has(account.id)) {
        account = getNextAvailableAccount(triedAccountIds);
        continue;
      }
      triedAccountIds.add(account.id);

      const cooldownInfo = getAccountCooldownInfo(account.id);
      if (cooldownInfo) {
        account = getNextAvailableAccount(triedAccountIds);
        continue;
      }

      try {
        // Upload image to Qwen OSS first
        const imageBuffer = Buffer.from(await image.arrayBuffer());
        const uploadedUrl = await uploadToQwenOSS(imageBuffer, image.name, account.id);

        const result = await generateImageEdit({
          prompt,
          model: imageModel,
          imageUrl: uploadedUrl,
          size: normalizeSize(size),
          n,
          accountId: account.id,
        });

        const response = {
          created: Math.floor(Date.now() / 1000),
          data: result.data,
        };

        requestLogger.log({
          originalModel: model || 'image_edit',
          mappedModel: imageModel,
          protocol: 'openai',
          endpoint: '/v1/images/edits',
          clientIp: c.req.header('x-forwarded-for') || 'unknown',
          userAgent: c.req.header('user-agent') || 'unknown',
          thinking: false,
          hasTools: false,
          streamMode: false,
          inputTokens: 0,
          outputTokens: 0,
          cacheTokens: 0,
          totalTokens: 0,
          startTime,
          endTime: Date.now(),
          streamCreationMs: 0,
          success: true,
          statusCode: 200,
          accountId: account.id,
        });

        return c.json(response);
      } catch (err: any) {
        if (err.status === 429 || err.code === 'RateLimited') {
          const hourHint = err.message?.match?.(/Wait about (\d+) hour/);
          const cooldownMs = hourHint ? parseInt(hourHint[1]) * 60 * 60 * 1000 : undefined;
          markAccountRateLimited(account.id, cooldownMs, 'RateLimited');
        }
        lastError = err;
        account = getNextAvailableAccount(triedAccountIds);
      }
    }

    throw lastError || new Error('All accounts failed');
  } catch (err: any) {
    const status = err.status || 500;
    return c.json({
      error: {
        message: err.error || err.message || 'Image edit failed',
        type: status >= 500 ? 'server_error' : 'invalid_request_error',
      },
    }, status as any);
  }
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

function resolveImageModel(model?: string, chatType = 'image'): string {
  if (model) {
    // Strip any existing suffix and add -image
    const base = model.replace(/-(image|video|image-edit)$/, '');
    if (chatType === 'image_edit') return `${base}-image-edit`;
    return `${base}-image`;
  }
  // Default model
  return 'wanx2.1-t2i-turbo-image';
}

interface ImageGenOptions {
  prompt: string;
  model: string;
  size: string;
  n: number;
  accountId: string;
}

async function generateImage(options: ImageGenOptions): Promise<{ data: Array<{ url: string }> }> {
  const { prompt, model, size, n, accountId } = options;

  // Get headers for this account
  const { headers: qHeaders } = await getQwenHeaders(false, accountId);

  // Create chat session
  const chatId = await createImageChat(model, qHeaders, accountId);
  if (!chatId) throw new Error('Failed to create image chat');

  // Send image generation request
  const payload = {
    stream: false,
    version: '2.1',
    incremental_output: true,
    chat_id: chatId,
    model,
    messages: [{
      role: 'user',
      content: prompt,
      files: [],
      chat_type: 'image',
      feature_config: { output_schema: 'phase' },
      models: [model],
      timestamp: Date.now(),
      user_action: 'chat',
      fid: '',
      parentId: null,
      childrenIds: [],
      extra: { meta: { subChatType: 't2i' } },
      sub_chat_type: 't2i',
      parent_id: null,
    }],
    timestamp: Date.now(),
  };

  const response = await fetch(`https://chat.qwen.ai/api/v2/chats/${chatId}/completions`, {
    method: 'POST',
    headers: {
      'accept': 'text/event-stream',
      'content-type': 'application/json',
      'cookie': qHeaders.cookie || '',
      'user-agent': qHeaders['user-agent'] || '',
      'origin': 'https://chat.qwen.ai',
      'referer': 'https://chat.qwen.ai/',
      'x-request-id': crypto.randomUUID(),
      'timezone': CACHED_TIMEZONE,
      ...(qHeaders['bx-ua'] ? { 'bx-ua': qHeaders['bx-ua'] } : {}),
      ...(qHeaders['bx-umidtoken'] ? { 'bx-umidtoken': qHeaders['bx-umidtoken'] } : {}),
      ...(qHeaders['bx-v'] ? { 'bx-v': qHeaders['bx-v'] } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw { status: response.status, error: `Upstream error: ${response.status} ${errorText.slice(0, 200)}` };
  }

  // Parse SSE response
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let contentUrl: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const { payloads, buffer: newBuffer } = parseSsePayloads(buffer);
    buffer = newBuffer;

    for (const payload of payloads) {
      try {
        const parsed = JSON.parse(payload);
        const error = parseUpstreamError(parsed);
        if (error) throw error;

        const url = extractResourceUrlFromPayload(parsed);
        if (url && !contentUrl) contentUrl = url;
      } catch (err: any) {
        if (err.status) throw err;
      }
    }
  }

  // Flush remaining
  const { payloads } = parseSsePayloads(buffer, true);
  for (const payload of payloads) {
    try {
      const parsed = JSON.parse(payload);
      const url = extractResourceUrlFromPayload(parsed);
      if (url && !contentUrl) contentUrl = url;
    } catch { /* ignore */ }
  }

  if (!contentUrl) throw { status: 502, error: 'Upstream did not return an image URL' };

  return { data: [{ url: contentUrl }] };
}

async function generateImageEdit(options: ImageGenOptions & { imageUrl: string }): Promise<{ data: Array<{ url: string }> }> {
  // Similar to generateImage but with image_edit chat_type
  const { prompt, model, size, n, accountId, imageUrl } = options;

  const { headers: qHeaders } = await getQwenHeaders(false, accountId);
  const chatId = await createImageChat(model, qHeaders, accountId, 'image_edit');
  if (!chatId) throw new Error('Failed to create image edit chat');

  // Build content with image reference
  const content = `![image](${imageUrl})\n${prompt}`;

  const payload = {
    stream: false,
    version: '2.1',
    incremental_output: true,
    chat_id: chatId,
    model,
    messages: [{
      role: 'user',
      content,
      files: [{
        type: 'image',
        file: { filename: 'image.png', type: 'image/png', size: 0 },
        id: crypto.randomUUID(),
        url: imageUrl,
        name: 'image.png',
        collection_name: '',
        progress: 100,
        status: 'uploaded',
        greenNet: 'success',
        size: 0,
        error: '',
        itemId: crypto.randomUUID(),
        file_type: 'image/png',
        showType: 'image',
        file_class: 'vision',
        uploadTaskId: crypto.randomUUID(),
      }],
      chat_type: 'image_edit',
      feature_config: { output_schema: 'phase' },
      models: [model],
      timestamp: Date.now(),
      user_action: 'chat',
      fid: '',
      parentId: null,
      childrenIds: [],
      extra: { meta: { subChatType: 'image_edit' } },
      sub_chat_type: 'image_edit',
      parent_id: null,
    }],
    timestamp: Date.now(),
  };

  const response = await fetch(`https://chat.qwen.ai/api/v2/chats/${chatId}/completions`, {
    method: 'POST',
    headers: {
      'accept': 'text/event-stream',
      'content-type': 'application/json',
      'cookie': qHeaders.cookie || '',
      'user-agent': qHeaders['user-agent'] || '',
      'origin': 'https://chat.qwen.ai',
      'referer': 'https://chat.qwen.ai/',
      'x-request-id': crypto.randomUUID(),
      'timezone': CACHED_TIMEZONE,
      ...(qHeaders['bx-ua'] ? { 'bx-ua': qHeaders['bx-ua'] } : {}),
      ...(qHeaders['bx-umidtoken'] ? { 'bx-umidtoken': qHeaders['bx-umidtoken'] } : {}),
      ...(qHeaders['bx-v'] ? { 'bx-v': qHeaders['bx-v'] } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw { status: response.status, error: `Upstream error: ${response.status} ${errorText.slice(0, 200)}` };
  }

  // Parse SSE response (same as generateImage)
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let contentUrl: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { payloads, buffer: newBuffer } = parseSsePayloads(buffer);
    buffer = newBuffer;
    for (const payload of payloads) {
      try {
        const parsed = JSON.parse(payload);
        const error = parseUpstreamError(parsed);
        if (error) throw error;
        const url = extractResourceUrlFromPayload(parsed);
        if (url && !contentUrl) contentUrl = url;
      } catch (err: any) {
        if (err.status) throw err;
      }
    }
  }

  const { payloads } = parseSsePayloads(buffer, true);
  for (const payload of payloads) {
    try {
      const parsed = JSON.parse(payload);
      const url = extractResourceUrlFromPayload(parsed);
      if (url && !contentUrl) contentUrl = url;
    } catch { /* ignore */ }
  }

  if (!contentUrl) throw { status: 502, error: 'Upstream did not return an edited image URL' };

  return { data: [{ url: contentUrl }] };
}

async function createImageChat(
  model: string,
  headers: Record<string, string>,
  accountId: string,
  chatType = 'image',
): Promise<string | null> {
  try {
    const body = JSON.stringify({
      title: `${chatType} Generation`,
      models: [model],
      chat_mode: 'normal',
      chat_type: chatType,
      timestamp: Date.now(),
      project_id: '',
    });

    const response = await fetch('https://chat.qwen.ai/api/v2/chats/new', {
      method: 'POST',
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'cookie': headers.cookie || '',
        'user-agent': headers['user-agent'] || '',
        'origin': 'https://chat.qwen.ai',
        'referer': 'https://chat.qwen.ai/',
        'x-request-id': crypto.randomUUID(),
        'timezone': CACHED_TIMEZONE,
        ...(headers['bx-ua'] ? { 'bx-ua': headers['bx-ua'] } : {}),
        ...(headers['bx-umidtoken'] ? { 'bx-umidtoken': headers['bx-umidtoken'] } : {}),
        ...(headers['bx-v'] ? { 'bx-v': headers['bx-v'] } : {}),
      },
      body,
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) return null;
    const json = await response.json();
    return json.chat_id || json.id || json.data?.chat_id || json.data?.id || null;
  } catch {
    return null;
  }
}

async function uploadToQwenOSS(buffer: Buffer, filename: string, accountId: string): Promise<string> {
  // Reuse the existing upload infrastructure
  const { getSTSToken } = await import('./upload.js');
  const { headers: qHeaders } = await getQwenHeaders(false, accountId);

  const headers = {
    cookie: qHeaders.cookie || '',
    'user-agent': qHeaders['user-agent'] || '',
    'bx-ua': qHeaders['bx-ua'] || '',
    'bx-umidtoken': qHeaders['bx-umidtoken'] || '',
    'bx-v': qHeaders['bx-v'] || '',
  };

  const stsData = await getSTSToken(filename, buffer.length, 'image', headers);

  const OSS = (await import('ali-oss')).default;
  const client = new OSS({
    region: stsData.region,
    accessKeyId: stsData.access_key_id,
    accessKeySecret: stsData.access_key_secret,
    stsToken: stsData.security_token,
    bucket: stsData.bucketname,
    endpoint: `https://${stsData.endpoint}`,
    secure: true,
  });

  await client.put(stsData.file_path, buffer, {
    headers: { 'Content-Type': 'image/png' },
  });

  return stsData.file_url.split('?')[0];
}
