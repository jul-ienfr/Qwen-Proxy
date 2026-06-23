/**
 * Video Generation Routes - Video generation endpoint
 * Adapted from upstream Qwen-Proxy chat.image.video.js
 */

import type { Context } from 'hono';
import crypto from 'crypto';
import { getQwenHeaders } from '../services/playwright.js';
import { getNextAccount, getNextAvailableAccount, markAccountRateLimited, getAccountCooldownInfo } from '../core/account-manager.js';
import { requestLogger } from '../core/request-logger.js';
import { getDebugLogger } from '../core/debug-logger.js';

const CACHED_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

// ─── SSE Parsing Helpers (shared with images.ts) ──────────────────────────────

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
    if (payload && payload !== '[DONE]') payloads.push(payload);
  }

  return { payloads, buffer: remainBuffer };
}

function extractResourceUrlFromText(text: string): string | null {
  if (!text) return null;
  const markdownUrl = text.match(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/i)?.[1];
  if (markdownUrl) return markdownUrl;
  const downloadUrl = text.match(/\[Download [^\]]+\]\((https?:\/\/[^\s)]+)\)/i)?.[1];
  if (downloadUrl) return downloadUrl;
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

  const directCandidates = [
    payload.content, payload.url, payload.video, payload.video_url,
    payload.download_url, payload.file_url, payload.output_url,
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

function extractVideoTaskID(text: string): string | null {
  if (!text) return null;
  const patterns = [
    /"task_id"\s*:\s*"([^"]+)"/i,
    /"taskId"\s*:\s*"([^"]+)"/i,
    /task_id\s*[:=]\s*["']?([a-zA-Z0-9._-]+)["']?/i,
    /taskId\s*[:=]\s*["']?([a-zA-Z0-9._-]+)["']?/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function extractVideoTaskIDFromPayload(payload: any): string | null {
  if (!payload) return null;

  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return extractVideoTaskIDFromPayload(JSON.parse(trimmed));
      } catch {
        return extractVideoTaskID(trimmed);
      }
    }
    return extractVideoTaskID(trimmed);
  }

  if (typeof payload !== 'object') return null;

  // Direct fields
  if (payload.task_id) return String(payload.task_id);
  if (payload.taskId) return String(payload.taskId);
  if (payload.id && (payload.task_status || payload.status === 'pending' || payload.status === 'running')) {
    return String(payload.id);
  }

  // Nested
  const candidates = [payload.wanx, payload.data, payload.output, payload.result, payload.results];
  for (const candidate of candidates) {
    const id = extractVideoTaskIDFromPayload(candidate);
    if (id) return id;
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

// ─── Video Generation: POST /v1/videos ────────────────────────────────────────

export async function videoGenerations(c: Context) {
  const startTime = Date.now();

  try {
    const body = await c.req.json();
    const { prompt, model, size } = body;

    if (!prompt) {
      return c.json({ error: { message: 'prompt is required', type: 'invalid_request_error' } }, 400);
    }

    const dbg = getDebugLogger();
    if (dbg.isEnabled()) {
      dbg.log('REQUEST', 'videos.ts', `Video generation: ${model || 'default'}`, {
        prompt: prompt.slice(0, 100),
        model,
      });
    }

    // Resolve model
    const videoModel = resolveVideoModel(model);

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
        const result = await generateVideo({
          prompt,
          model: videoModel,
          accountId: account.id,
        });

        requestLogger.log({
          originalModel: model || 'video',
          mappedModel: videoModel,
          protocol: 'openai',
          endpoint: '/v1/videos',
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

        return c.json(result);
      } catch (err: any) {
        if (err.status === 429 || err.code === 'RateLimited') {
          markAccountRateLimited(account.id, 24 * 60 * 60 * 1000, 'RateLimited');
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
        message: err.error || err.message || 'Video generation failed',
        type: status >= 500 ? 'server_error' : 'invalid_request_error',
      },
    }, status as any);
  }
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

function resolveVideoModel(model?: string): string {
  if (model) {
    const base = model.replace(/-video$/, '');
    return `${base}-video`;
  }
  return 'wanx2.1-t2v-turbo-video';
}

interface VideoGenOptions {
  prompt: string;
  model: string;
  accountId: string;
}

async function generateVideo(options: VideoGenOptions): Promise<any> {
  const { prompt, model, accountId } = options;

  const { headers: qHeaders } = await getQwenHeaders(false, accountId);

  // Create chat session
  const chatId = await createVideoChat(model, qHeaders);
  if (!chatId) throw new Error('Failed to create video chat');

  // Send video generation request
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
      chat_type: 'video',
      feature_config: { output_schema: 'phase' },
      models: [model],
      timestamp: Date.now(),
      user_action: 'chat',
      fid: '',
      parentId: null,
      childrenIds: [],
      extra: { meta: { subChatType: 't2v' } },
      sub_chat_type: 't2v',
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

  // Parse SSE response for task ID or direct URL
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let contentUrl: string | null = null;
  let videoTaskId: string | null = null;

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

        const taskId = extractVideoTaskIDFromPayload(parsed);
        if (taskId && !videoTaskId) videoTaskId = taskId;
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
      const taskId = extractVideoTaskIDFromPayload(parsed);
      if (taskId && !videoTaskId) videoTaskId = taskId;
    } catch { /* ignore */ }
  }

  // If we got a direct URL, return it
  if (contentUrl) {
    return {
      id: `video_${Date.now()}`,
      object: 'video',
      created: Math.floor(Date.now() / 1000),
      model,
      data: { url: contentUrl },
    };
  }

  // If we have a task ID, poll for completion
  if (videoTaskId) {
    const videoUrl = await pollVideoTask(videoTaskId, qHeaders);
    return {
      id: `video_${Date.now()}`,
      object: 'video',
      created: Math.floor(Date.now() / 1000),
      model,
      data: { url: videoUrl },
    };
  }

  throw { status: 502, error: 'Upstream did not return a video URL or task ID' };
}

async function createVideoChat(
  model: string,
  headers: Record<string, string>,
): Promise<string | null> {
  try {
    const body = JSON.stringify({
      title: 'Video Generation',
      models: [model],
      chat_mode: 'normal',
      chat_type: 'video',
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

async function pollVideoTask(taskId: string, headers: Record<string, string>): Promise<string> {
  const maxAttempts = 60;
  const delayMs = 20_000; // 20 seconds between polls

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, delayMs));

    try {
      const response = await fetch(`https://chat.qwen.ai/api/v2/videos/${taskId}`, {
        method: 'GET',
        headers: {
          'accept': 'application/json',
          'cookie': headers.cookie || '',
          'user-agent': headers['user-agent'] || '',
          'origin': 'https://chat.qwen.ai',
          'referer': 'https://chat.qwen.ai/',
        },
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) continue;

      const data = await response.json();
      const status = data.task_status || data.status;

      if (status === 'Succeeded' || status === 'succeeded' || status === 'completed') {
        const url = extractResourceUrlFromPayload(data);
        if (url) return url;
      }

      if (status === 'Failed' || status === 'failed' || status === 'error') {
        throw { status: 502, error: `Video generation failed: ${data.error || data.message || 'Unknown error'}` };
      }

      // Still processing, continue polling
    } catch (err: any) {
      if (err.status) throw err;
      // Network error, continue polling
    }
  }

  throw { status: 504, error: 'Video generation timed out after 20 minutes' };
}
