/**
 * Video Generation Routes - Video generation endpoint
 * Adapted from upstream Qwen-Proxy chat.image.video.js
 */

import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import crypto from 'crypto';
import { getQwenHeaders } from '../services/playwright.js';
import { getNextAccount, getNextAvailableAccount, markAccountRateLimited, getAccountCooldownInfo } from '../core/account-manager.js';
import { requestLogger } from '../core/request-logger.js';
import { getDebugLogger } from '../core/debug-logger.js';
import { extractResourceUrlFromPayload, readSseStreamForUrl, extractVideoTaskIDFromPayload } from '../utils/media-helpers.js';

const CACHED_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

interface UpstreamError {
  status?: number;
  code?: string;
  message?: string;
  error?: string;
}

// ─── Video Generation: POST /v1/videos ────────────────────────────────────────

export async function videoGenerations(c: Context) {
  const startTime = Date.now();

  try {
    const body = await c.req.json();
    const { prompt, model, size: _size } = body;

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
      } catch (err: unknown) {
        const e = err as UpstreamError;
        if (e.status === 429 || e.code === 'RateLimited') {
          markAccountRateLimited(account.id, 24 * 60 * 60 * 1000, 'RateLimited');
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
        message: e.error || e.message || 'Video generation failed',
        type: status >= 500 ? 'server_error' : 'invalid_request_error',
      },
    }, status as ContentfulStatusCode);
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

interface VideoResult {
  id: string;
  object: string;
  created: number;
  model: string;
  data: { url: string };
}

async function generateVideo(options: VideoGenOptions): Promise<VideoResult> {
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
  const { contentUrl, videoTaskId } = await readSseStreamForUrl(
    response.body!,
    extractVideoTaskIDFromPayload,
  );

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
    } catch (err: unknown) {
      const e = err as UpstreamError;
      if (e.status) throw err;
      // Network error, continue polling
    }
  }

  throw { status: 504, error: 'Video generation timed out after 20 minutes' };
}
