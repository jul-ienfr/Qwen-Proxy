/**
 * Image Generation Routes - OpenAI-compatible image endpoints
 * Adapted from upstream Qwen-Proxy chat.image.video.js
 */

import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import crypto from 'crypto';
import { getQwenHeaders } from '../services/playwright.js';
import { getNextAccount, getNextAvailableAccount, markAccountRateLimited, getAccountCooldownInfo } from '../core/account-manager.js';
import { requestLogger } from '../core/request-logger.js';
import { getDebugLogger } from '../core/debug-logger.js';
import { readSseStreamForUrl } from '../utils/media-helpers.js';

const CACHED_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

interface UpstreamError {
  status?: number;
  code?: string;
  message?: string;
  error?: string;
}

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
    let lastError: UpstreamError | null = null;

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
        const data = await Promise.all(result.data.map(async (item: { url: string }) => {
          if (response_format === 'b64_json' && item.url) {
            try {
              const resp = await fetch(item.url, { signal: AbortSignal.timeout(30_000) });
              if (resp.ok) {
                const buffer = Buffer.from(await resp.arrayBuffer());
                return { b64_json: buffer.toString('base64') };
              }
            } catch { /* fall through to url */ }
          }
          return { url: item.url };
        }));

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
      } catch (err: unknown) {
        const e = err as UpstreamError;
        if (e.status === 429 || e.code === 'RateLimited') {
          const hourHint = e.message?.match?.(/Wait about (\d+) hour/);
          const cooldownMs = hourHint ? parseInt(hourHint[1]) * 60 * 60 * 1000 : undefined;
          markAccountRateLimited(account.id, cooldownMs, 'RateLimited');
        }
        lastError = e;
        account = getNextAvailableAccount(triedAccountIds);
      }
    }

    throw lastError || new Error('All accounts failed');
  } catch (err: unknown) {
    const e = err as UpstreamError;
    const status = e.status || 500;
    return c.json({
      error: {
        message: e.error || e.message || 'Image generation failed',
        type: status >= 500 ? 'server_error' : 'invalid_request_error',
      },
    }, status as ContentfulStatusCode);
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
    let lastError: UpstreamError | null = null;

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
      } catch (err: unknown) {
        const e = err as UpstreamError;
        if (e.status === 429 || e.code === 'RateLimited') {
          const hourHint = e.message?.match?.(/Wait about (\d+) hour/);
          const cooldownMs = hourHint ? parseInt(hourHint[1]) * 60 * 60 * 1000 : undefined;
          markAccountRateLimited(account.id, cooldownMs, 'RateLimited');
        }
        lastError = e;
        account = getNextAvailableAccount(triedAccountIds);
      }
    }

    throw lastError || new Error('All accounts failed');
  } catch (err: unknown) {
    const e = err as UpstreamError;
    const status = e.status || 500;
    return c.json({
      error: {
        message: e.error || e.message || 'Image edit failed',
        type: status >= 500 ? 'server_error' : 'invalid_request_error',
      },
    }, status as ContentfulStatusCode);
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
  const { prompt, model, size: _size, n: _n, accountId } = options;

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
  const { contentUrl } = await readSseStreamForUrl(response.body!);

  if (!contentUrl) throw { status: 502, error: 'Upstream did not return an image URL' };

  return { data: [{ url: contentUrl }] };
}

async function generateImageEdit(options: ImageGenOptions & { imageUrl: string }): Promise<{ data: Array<{ url: string }> }> {
  // Similar to generateImage but with image_edit chat_type
  const { prompt, model, size: _size, n: _n, accountId, imageUrl } = options;

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
  const { contentUrl } = await readSseStreamForUrl(response.body!);

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
