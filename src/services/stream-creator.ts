import { getQwenHeaders, getBasicHeaders, getGuestHeaders, getPageForAccount, browserFetch, browserStreamFetch, CHROME_CLIENT_HINTS } from './playwright.js';
import { MAX_PAYLOAD_SIZE } from '../core/model-registry.js';
import { config } from '../core/config.js';
import { RetryableQwenStreamError, QwenUpstreamError, handleErrorBody, handleJsonErrorBody } from './error-handler.js';
import { getWarmedChat, releaseWarmChat } from './warm-pool.js';
import crypto from 'crypto';
import { getDebugLogger } from '../core/debug-logger.js';
import { browserStreamFetchWS } from './stream-ws-bridge.js';

const CACHED_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const BASE_TIMEOUT_MS = 120000;
const TIMEOUT_PER_MB = 30000;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export interface QwenMessage {
  fid: string;
  parentId: string | null;
  childrenIds: string[];
  role: 'user' | 'assistant';
  content: string;
  user_action: string;
  files: any[];
  timestamp: number;
  models: string[];
  chat_type: string;
  feature_config: {
    thinking_enabled: boolean;
    output_schema: string;
    research_mode: string;
    auto_thinking: boolean;
    thinking_mode: string;
    thinking_format: string;
    auto_search: boolean;
  };
  extra: {
    meta: {
      subChatType: string;
    };
  };
  sub_chat_type: string;
  parent_id: string | null;
}

export interface QwenPayload {
  stream: boolean;
  version: string;
  incremental_output: boolean;
  chat_id: string;
  chat_mode: string;
  model: string;
  parent_id: string | null;
  messages: QwenMessage[];
  timestamp: number;
}

export interface QwenFileEntry {
  type: string;
  file: any;
  id: string;
  url: string;
  name: string;
  [key: string]: any;
}

import { getSessionManager } from '../core/session-manager.js';

/**
 * Update the parent_id for a session (called when response.created arrives from Qwen).
 * Delegates to the session manager.
 */
export function updateSessionParent(sessionId: string, parentId: string | null) {
  if (sessionId && parentId) {
    getSessionManager().setParentId(sessionId, parentId);
  }
}

const TMD_MARKERS = ['FAIL_SYS_USER_VALIDATE', '_____tmd_____', 'RGV587_ERROR'];

function addTmdPeekToStream(
  stream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let peekedFirstChunk = false;

  return new ReadableStream<Uint8Array>({
    start() {
      reader = stream.getReader();
    },
    async pull(streamController) {
      try {
        if (!reader) throw new Error('TMD peek reader not initialized');
        const { done, value } = await reader.read();
        if (done) {
          streamController.close();
          return;
        }
        // Check first chunk for TMD markers
        if (!peekedFirstChunk) {
          peekedFirstChunk = true;
          const text = new TextDecoder().decode(value);
          for (const marker of TMD_MARKERS) {
            if (text.includes(marker)) {
              stream.cancel(`TMD challenge detected in stream: ${marker}`).catch(() => {});
              throw new QwenUpstreamError(
                `Qwen TMD anti-bot challenge detected in SSE stream: ${marker}`,
                'FAIL_SYS_USER_VALIDATE',
                403,
              );
            }
          }
        }
        streamController.enqueue(value);
      } catch (err) {
        if (err instanceof QwenUpstreamError) throw err;
        streamController.error(err);
      }
    },
    cancel(reason) {
      reader?.cancel(reason).catch(() => {});
    },
  });
}

function addIdleTimeoutToStream(
  stream: ReadableStream<Uint8Array>,
  controller: AbortController,
  idleTimeoutMs: number,
  label: string,
  onTimeout?: () => void,
  onDone?: () => void,
): ReadableStream<Uint8Array> {
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const clearIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };

  const resetIdleTimer = () => {
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      const message = `${label} idle timeout after ${idleTimeoutMs}ms without upstream data`;
      clearIdleTimer();
      controller.abort();
      onTimeout?.();
      try { stream.cancel(message).catch(() => {}); } catch { /* ignore */ }
    }, idleTimeoutMs);
  };

  return new ReadableStream<Uint8Array>({
    start() {
      reader = stream.getReader();
      resetIdleTimer();
    },
    async pull(streamController) {
      try {
        if (!reader) throw new Error('Stream reader was not initialized');
        const { done, value } = await reader.read();
        if (done) {
          clearIdleTimer();
          onDone?.();
          streamController.close();
          return;
        }
        resetIdleTimer();
        streamController.enqueue(value);
      } catch (err) {
        clearIdleTimer();
        onDone?.();
        streamController.error(err);
      }
    },
    cancel(reason) {
      clearIdleTimer();
      onDone?.();
      return stream.cancel(reason);
    },
  });
}

function getClientHintsHeaders(): Record<string, string> {
  return {
    'sec-ch-ua': CHROME_CLIENT_HINTS,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  };
}

let cachedModels: any[] | null = null;
let lastModelsFetch = 0;

const nativeToolsDisabled = new Set<string>();
const disablingNativeToolsInProgress = new Set<string>();

export async function disableNativeTools(accountId?: string): Promise<void> {
  const cacheKey = accountId || 'global';
  if (nativeToolsDisabled.has(cacheKey) || disablingNativeToolsInProgress.has(cacheKey)) {
    return;
  }
  disablingNativeToolsInProgress.add(cacheKey);

  try {
    const { headers } = await getQwenHeaders(false, accountId);

    const payload = {
      tools_enabled: {
        web_extractor: false,
        web_search_image: false,
        web_search: false,
        image_gen_tool: false,
        code_interpreter: false,
        history_retriever: false,
        image_edit_tool: false,
        bio: false,
        image_zoom_in_tool: false
      }
    };

    console.log(`[Qwen] Disabling native tools for ${cacheKey}...`);
    const page = getPageForAccount(accountId);
    if (page && !page.isClosed() && page.url().includes('chat.qwen.ai')) {
      try {
        const result = await browserFetch(page, 'https://chat.qwen.ai/api/v2/users/user/settings/update', {
          method: 'POST',
          headers: {
            'accept': 'application/json, text/plain, */*',
            'content-type': 'application/json',
            'x-request-id': crypto.randomUUID(),
            'timezone': CACHED_TIMEZONE,
          },
          body: JSON.stringify(payload),
          timeoutMs: config.timeouts.http,
        });
        if (result.status && result.status < 400) {
          console.log(`[Qwen] Native tools disabled successfully for ${cacheKey}.`);
          nativeToolsDisabled.add(cacheKey);
          return;
        }
        console.error(`[Qwen] Failed to disable native tools for ${cacheKey}: ${result.status} - ${result.body}`);
        return;
      } catch (err: any) {
        console.warn('[Qwen] browserFetch failed for disableNativeTools, falling back:', err.message);
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeouts.http);
    const response = await fetch('https://chat.qwen.ai/api/v2/users/user/settings/update', {
      method: 'POST',
      headers: {
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
        'content-type': 'application/json',
        'cookie': headers['cookie'],
        'origin': 'https://chat.qwen.ai',
        'referer': 'https://chat.qwen.ai/',
        'user-agent': headers['user-agent'],
        'x-request-id': crypto.randomUUID(),
        'bx-ua': headers['bx-ua'],
        'bx-umidtoken': headers['bx-umidtoken'],
        'bx-v': headers['bx-v']
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      const text = await response.text();
      console.error(`[Qwen] Failed to disable native tools for ${cacheKey}: ${response.status} - ${text}`);
    } else {
      console.log(`[Qwen] Native tools disabled successfully for ${cacheKey}.`);
      nativeToolsDisabled.add(cacheKey);
    }
  } catch (err: any) {
    console.error(`[Qwen] Error disabling native tools for ${cacheKey}: ${err.message}`);
  } finally {
    disablingNativeToolsInProgress.delete(cacheKey);
  }
}

export async function fetchQwenModels(accountId?: string): Promise<any[]> {
  const now = Date.now();
  if (cachedModels && (now - lastModelsFetch < 3600000)) {
    return cachedModels;
  }

  const page = getPageForAccount(accountId);
  if (page && !page.isClosed() && page.url().includes('chat.qwen.ai')) {
    try {
      const result = await browserFetch(page, 'https://chat.qwen.ai/api/models', {
        method: 'GET',
        headers: {
          'accept': 'application/json, text/plain, */*',
          'x-request-id': crypto.randomUUID(),
          'timezone': CACHED_TIMEZONE,
          'source': 'web',
        },
        timeoutMs: config.timeouts.http,
      });
      if (result.status && result.status < 400) {
        return processModelsJson(JSON.parse(result.body));
      }
    } catch (err: any) {
      console.warn('[Qwen] browserFetch failed for models, falling back:', err.message);
    }
  }

  const { cookie, userAgent, bxV, bxUa, bxUmidtoken } = await getBasicHeaders(accountId);

  const response = await fetch('https://chat.qwen.ai/api/models', {
    headers: {
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
      'cookie': cookie,
      'referer': 'https://chat.qwen.ai/',
      'user-agent': userAgent,
      'x-request-id': crypto.randomUUID(),
      'bx-v': bxV,
      'bx-ua': bxUa || '',
      'bx-umidtoken': bxUmidtoken || '',
      'timezone': CACHED_TIMEZONE,
      'source': 'web',
      ...getClientHintsHeaders(),
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch models from Qwen: ${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  return processModelsJson(json);
}

function processModelsJson(json: any): any[] {
  if (json.data && Array.isArray(json.data)) {
    const models = json.data.map((m: any) => ({
      id: m.id,
      object: 'model',
      created: m.info?.created_at || Math.floor(Date.now() / 1000),
      owned_by: m.owned_by || 'qwen'
    }));

    const hasPlus = models.some((m: any) => m.id === 'qwen3.7-plus');
    const base = [
      ...models,
      ...(hasPlus ? [] : [{ id: 'qwen3.7-plus', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'qwen' }])
    ];

    const extendedModels = [
      ...base,
      ...base.map((m: any) => ({ ...m, id: `${m.id}-no-thinking` }))
    ];

    cachedModels = extendedModels;
    lastModelsFetch = Date.now();
    return extendedModels;
  }

  return [];
}

export async function createQwenStream(
  prompt: string,
  enableThinking: boolean,
  modelId: string,
  forcedParentId?: string | null,
  accountId?: string,
  files?: QwenFileEntry[],
  pendingMultimodal?: Array<Array<{ type: string; text?: string; image_url?: { url: string }; video_url?: { url: string }; audio_url?: { url: string }; file_url?: { url: string } }>>,
  thinkingMode?: string,
  sessionContext?: {
    chatId: string;
    parentId: string | null;
    headers: Record<string, string>;
    accountId: string;
  },
): Promise<{ stream: ReadableStream, headers: Record<string, string>, uiSessionId: string, controller: AbortController, accountId: string }> {
  const streamStartMs = Date.now();
  const dbg = getDebugLogger();
  if (dbg.isEnabled()) {
    dbg.log('STREAM', 'stream-creator.ts', `Creating stream: model=${modelId}, account=${accountId || 'default'}`, {
      modelId,
      accountId: accountId || 'default',
      enableThinking,
      thinkingMode,
    });
  }
  let chatId: string;
  let chatHeaders: Record<string, string>;
  let leasedChat: any;
  let leasedChatReleased = false;

  const releaseLeasedChat = () => {
    if (leasedChatReleased || !leasedChat) return;
    leasedChatReleased = true;
    releaseWarmChat(leasedChat.accountId, leasedChat.chatId);
  };

  const wrapLeasedStream = (
    stream: ReadableStream<Uint8Array>,
    controller: AbortController,
    timeoutMs: number,
    label: string,
    onTimeout?: () => void,
  ) => {
    return addIdleTimeoutToStream(
      stream,
      controller,
      timeoutMs,
      label,
      onTimeout,
      () => {
        onTimeout?.();
        releaseLeasedChat();
      },
    );
  };

  if (accountId === 'guest') {
    chatHeaders = await getGuestHeaders();
    const guestPage = getPageForAccount('guest');
    const guestBody = JSON.stringify({
      title: 'Guest Chat',
      models: [modelId.replace('-no-thinking', '')],
      chat_mode: 'guest',
      chat_type: 't2t',
      timestamp: Date.now(),
      project_id: '',
    });

    if (guestPage && !guestPage.isClosed()) {
      try {
        const result = await browserFetch(guestPage, 'https://chat.qwen.ai/api/v2/chats/new', {
          method: 'POST',
          headers: { 'accept': 'application/json, text/plain, */*', 'content-type': 'application/json', 'x-request-id': crypto.randomUUID(), 'timezone': CACHED_TIMEZONE },
          body: guestBody,
          timeoutMs: config.timeouts.http,
        });
        if (!result.status || result.status >= 400) throw new Error(`Failed to create guest chat: ${result.status}`);
        const json = JSON.parse(result.body);
        chatId = json.chat_id || json.id || json.data?.chat_id || json.data?.id;
        if (!chatId) throw new Error(`Unexpected guest chat response: ${JSON.stringify(json).slice(0, 200)}`);
      } catch (err: any) {
        console.warn('[Qwen] browserFetch guest chat failed, falling back:', err.message);
        const response = await fetch('https://chat.qwen.ai/api/v2/chats/new', {
          method: 'POST',
          headers: { 'accept': 'application/json, text/plain, */*', 'content-type': 'application/json', cookie: chatHeaders['cookie'], origin: 'https://chat.qwen.ai', referer: 'https://chat.qwen.ai/c/guest', 'user-agent': chatHeaders['user-agent'], 'x-request-id': crypto.randomUUID(), 'bx-v': chatHeaders['bx-v'], 'bx-ua': chatHeaders['bx-ua'], 'bx-umidtoken': chatHeaders['bx-umidtoken'], ...getClientHintsHeaders() },
          body: guestBody,
          signal: AbortSignal.timeout(config.timeouts.http),
        });
        if (!response.ok) { throw new Error(`Failed to create guest chat: ${response.status}`, { cause: err }); }
        const json = await response.json();
        chatId = json.chat_id || json.id || json.data?.chat_id || json.data?.id;
        if (!chatId) { throw new Error(`Unexpected guest chat response: ${JSON.stringify(json).slice(0, 200)}`, { cause: err }); }
      }
    } else {
      const response = await fetch('https://chat.qwen.ai/api/v2/chats/new', {
        method: 'POST',
        headers: { 'accept': 'application/json, text/plain, */*', 'content-type': 'application/json', cookie: chatHeaders['cookie'], origin: 'https://chat.qwen.ai', referer: 'https://chat.qwen.ai/c/guest', 'user-agent': chatHeaders['user-agent'], 'x-request-id': crypto.randomUUID(), 'bx-v': chatHeaders['bx-v'], 'bx-ua': chatHeaders['bx-ua'], 'bx-umidtoken': chatHeaders['bx-umidtoken'], ...getClientHintsHeaders() },
        body: guestBody,
        signal: AbortSignal.timeout(config.timeouts.http),
      });
      if (!response.ok) throw new Error(`Failed to create guest chat: ${response.status}`);
      const json = await response.json();
      chatId = json.chat_id || json.id || json.data?.chat_id || json.data?.id;
      if (!chatId) throw new Error(`Unexpected guest chat response: ${JSON.stringify(json).slice(0, 200)}`);
    }
  } else if (sessionContext) {
    // Session mode: reuse existing chat and headers from the session
    chatId = sessionContext.chatId;
    chatHeaders = sessionContext.headers;
    // Don't set leasedChat - session manages its own lifecycle
  } else {
    try {
      leasedChat = await getWarmedChat(accountId);
    } catch (err: any) {
      if (err.message?.includes('chat is in progress') || err.message?.includes('The chat is in progress')) {
        const retryAfterMs = 2000 + Math.floor(Math.random() * 2000);
        throw new RetryableQwenStreamError(`Qwen: ${err.message}`, retryAfterMs);
      }
      throw err;
    }
    chatId = leasedChat.chatId;
    chatHeaders = leasedChat.headers;
  }

  const chatSetupMs = Date.now() - streamStartMs;
  console.log(`[Qwen] Chat setup completed in ${chatSetupMs}ms (chatId: ${chatId}, account: ${accountId || 'guest'})`);

  const actualParentId: string | null = sessionContext?.parentId ?? null;

  const resolvedFiles = files || [];
  if (pendingMultimodal && pendingMultimodal.length > 0 && resolvedFiles.length === 0) {
    try {
      const { processImagesForQwen } = await import('../routes/upload.js');
      const { headers: fullHeaders } = await getQwenHeaders(false, accountId);
      const uploadHeaders: Record<string, string> = {
        cookie: fullHeaders['cookie'] || chatHeaders['cookie'] || '',
        'user-agent': fullHeaders['user-agent'] || chatHeaders['user-agent'] || '',
        'bx-ua': fullHeaders['bx-ua'] || '',
        'bx-umidtoken': fullHeaders['bx-umidtoken'] || '',
        'bx-v': fullHeaders['bx-v'] || chatHeaders['bx-v'] || '',
      };
      if (!uploadHeaders['bx-ua']) {
        console.warn('[Qwen] Missing bx-ua header for multimodal upload, attempting forced refresh...');
        const { headers: refreshedHeaders } = await getQwenHeaders(true, accountId);
        uploadHeaders['cookie'] = refreshedHeaders['cookie'] || uploadHeaders['cookie'];
        uploadHeaders['user-agent'] = refreshedHeaders['user-agent'] || uploadHeaders['user-agent'];
        uploadHeaders['bx-ua'] = refreshedHeaders['bx-ua'] || '';
        uploadHeaders['bx-umidtoken'] = refreshedHeaders['bx-umidtoken'] || '';
        uploadHeaders['bx-v'] = refreshedHeaders['bx-v'] || uploadHeaders['bx-v'];
      }
      const results = await Promise.all(
        pendingMultimodal.map(parts => processImagesForQwen(parts, uploadHeaders))
      );
      for (const r of results) {
        resolvedFiles.push(...r.files);
      }
    } catch (err: any) {
      console.error('[Qwen] Failed to process multimodal uploads:', err.message);
      throw new Error(`Multimodal upload failed: ${err.message}`, { cause: err });
    }
  }

  try {
    const timestamp = Math.floor(Date.now() / 1000);
  const fid = crypto.randomUUID();
  const model = modelId.replace('-no-thinking', '');

  const payload: QwenPayload = {
    stream: true,
    version: '2.1',
    incremental_output: true,
    chat_id: chatId,
    chat_mode: accountId === 'guest' ? 'guest' : 'normal',
    model: model,
    parent_id: actualParentId,
    messages: [
      {
        fid: fid,
        parentId: actualParentId,
        childrenIds: [],
        role: 'user',
        content: prompt,
        user_action: 'chat',
        files: resolvedFiles,
        timestamp: timestamp,
        models: [model],
        chat_type: 't2t',
        feature_config: {
          thinking_enabled: enableThinking,
          output_schema: 'phase',
          research_mode: 'normal',
          auto_thinking: false,
          thinking_mode: thinkingMode || 'Thinking',
          thinking_format: 'summary',
          auto_search: false
        },
        extra: {
          meta: {
            subChatType: 't2t'
          }
        },
        sub_chat_type: 't2t',
        parent_id: actualParentId
      }
    ],
    timestamp: timestamp + 1
  };

  const payloadJson = JSON.stringify(payload);
  const payloadSize = Buffer.byteLength(payloadJson);
  if (payloadSize > MAX_PAYLOAD_SIZE) {
    throw new Error(`Payload too large: ${payloadSize} bytes exceeds limit of ${MAX_PAYLOAD_SIZE} bytes`);
  }
  const payloadMB = payloadSize / (1024 * 1024);
  const timeoutMs = BASE_TIMEOUT_MS + Math.ceil(payloadMB * TIMEOUT_PER_MB);

  const url = `https://chat.qwen.ai/api/v2/chat/completions?chat_id=${chatId}`;

  const completionHeaders: Record<string, string> = {
    'accept': 'text/event-stream',
    'content-type': 'application/json',
    'x-request-id': crypto.randomUUID(),
    'timezone': CACHED_TIMEZONE,
  };

  const page = getPageForAccount(accountId);
  const hasBrowser = page && !page.isClosed() && page.url().includes('chat.qwen.ai');

  // Smart fetch strategy:
  // - DIRECT_FETCH=true: Try direct Node.js fetch first (faster), fall back to browser on TMD
  // - DIRECT_FETCH=false: Use browser fetch (better anti-bot), fall back to direct on error
  const tryDirectFirst = config.directFetch && hasBrowser;
  const useBrowserOnly = !config.directFetch && hasBrowser;

  // Helper: attempt direct Node.js fetch (with TLS pool for HTTP/2)
  const tryDirectFetch = async (): Promise<{ stream: ReadableStream; controller: AbortController; headers: Record<string, string>; uiSessionId: string; freshChatId?: string } | null> => {
    const directController = new AbortController();
    const directTimeoutId = setTimeout(() => directController.abort(), timeoutMs);

    // Build headers for the request
    const requestHeaders: Record<string, string> = {
      'accept': 'application/json',
      'accept-language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
      'content-type': 'application/json',
      'cookie': chatHeaders['cookie'],
      'origin': 'https://chat.qwen.ai',
      'referer': accountId === 'guest' ? 'https://chat.qwen.ai/c/guest' : `https://chat.qwen.ai/c/${chatId}`,
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'timezone': CACHED_TIMEZONE,
      'user-agent': chatHeaders['user-agent'],
      'x-accel-buffering': 'no',
      'x-request-id': crypto.randomUUID(),
      'bx-v': chatHeaders['bx-v'],
      'bx-ua': chatHeaders['bx-ua'] || '',
      'bx-umidtoken': chatHeaders['bx-umidtoken'] || '',
      ...getClientHintsHeaders(),
    };

    try {
      // Direct Node.js fetch — faster than TLS pool for streaming
      // The TLS pool is used for non-streaming requests (warmup, chat creation)
      const response = await fetch(url, {
        method: 'POST',
        headers: requestHeaders,
        body: payloadJson,
        signal: directController.signal
      });
      clearTimeout(directTimeoutId);

      const responseContentType = response.headers.get('content-type') || '';
      if (response.ok && responseContentType.includes('text/event-stream') && response.body) {
        const tmdStream = addTmdPeekToStream(response.body);
        const controller = new AbortController();
        return { stream: wrapLeasedStream(tmdStream, controller, timeoutMs, `Qwen direct stream ${chatId}`), controller, headers: chatHeaders, uiSessionId: chatId };
      }

      // Check for TMD challenge
      if (response.ok && response.body) {
        const peekText = await response.clone().text().catch(() => '');
        if (peekText.includes('FAIL_SYS_USER_VALIDATE') || peekText.includes('_____tmd_____') || peekText.includes('RGV587_ERROR')) {
          console.warn('[Qwen] Direct fetch got TMD challenge, will fallback to browser');
          return null; // Signal to fallback
        }
        handleErrorBody(peekText, response.status);
      }

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          handleJsonErrorBody(errText);
        }
        throw new Error(`Failed to fetch from Qwen: ${response.status} ${response.statusText} - ${errText}`);
      }
    } catch (err: any) {
      clearTimeout(directTimeoutId);
      if (err instanceof QwenUpstreamError) throw err;
      // TMD-related errors should trigger fallback
      if (err.message?.includes('TMD') || err.message?.includes('FAIL_SYS_USER_VALIDATE')) {
        console.warn('[Qwen] Direct fetch TMD error, will fallback to browser');
        return null;
      }
      throw err;
    }
    return null;
  };

  // Helper: attempt browser fetch
  const tryBrowserFetch = async (freshChatId?: string): Promise<{ stream: ReadableStream; controller: AbortController; headers: Record<string, string>; uiSessionId: string } | null> => {
    if (!page || page.isClosed() || !page.url().includes('chat.qwen.ai')) return null;

    const targetChatId = freshChatId || chatId;
    const targetUrl = freshChatId ? `https://chat.qwen.ai/api/v2/chat/completions?chat_id=${freshChatId}` : url;

    try {
      // Use WebSocket bridge for 50-200x faster streaming when enabled
      const fetchFn = config.useWsBridge ? browserStreamFetchWS : browserStreamFetch;
      const browserResult = await fetchFn(page, targetUrl, {
        method: 'POST',
        headers: completionHeaders,
        body: payloadJson,
        timeoutMs,
      });

      if (browserResult.contentType.includes('text/event-stream') && browserResult.status < 400) {
        const tmdStream = addTmdPeekToStream(browserResult.stream);
        const controller = new AbortController();
        return { stream: wrapLeasedStream(tmdStream, controller, timeoutMs, `Qwen browser stream ${targetChatId}`, browserResult.abort), controller, headers: chatHeaders, uiSessionId: targetChatId };
      }

      if (browserResult.body) {
        const peekText = browserResult.body;
        if (peekText.includes('FAIL_SYS_USER_VALIDATE') || peekText.includes('_____tmd_____') || peekText.includes('RGV587_ERROR')) {
          // Try to refresh headers and create fresh chat
          try {
            const { headers: freshHeaders } = await getQwenHeaders(true, accountId);
            await sleep(500 + Math.floor(Math.random() * 1000));

            const freshChatBody = JSON.stringify({
              title: 'Nova Conversa',
              models: [model.replace('-no-thinking', '')],
              chat_mode: accountId === 'guest' ? 'guest' : 'normal',
              chat_type: 't2t',
              timestamp: Date.now(),
              project_id: '',
            });
            let newFreshChatId = targetChatId;
            try {
              const chatResult = await browserFetch(page, 'https://chat.qwen.ai/api/v2/chats/new', {
                method: 'POST',
                headers: { 'accept': 'application/json, text/plain, */*', 'content-type': 'application/json', 'x-request-id': crypto.randomUUID(), 'timezone': CACHED_TIMEZONE },
                body: freshChatBody,
                timeoutMs: config.timeouts.http,
              });
              if (chatResult.status && chatResult.status < 400) {
                const chatJson = JSON.parse(chatResult.body);
                const newId = chatJson.chat_id || chatJson.id || chatJson.data?.chat_id || chatJson.data?.id;
                if (newId) newFreshChatId = newId;
              }
            } catch {}

            const freshUrl = `https://chat.qwen.ai/api/v2/chat/completions?chat_id=${newFreshChatId}`;
            const retryResult = await browserStreamFetch(page, freshUrl, {
              method: 'POST',
              headers: completionHeaders,
              body: payloadJson,
              timeoutMs,
            });
            if (retryResult.contentType.includes('text/event-stream') && retryResult.status < 400) {
              const tmdStream = addTmdPeekToStream(retryResult.stream);
              const controller = new AbortController();
              return { stream: wrapLeasedStream(tmdStream, controller, timeoutMs, `Qwen browser stream ${newFreshChatId}`, retryResult.abort), controller, headers: freshHeaders, uiSessionId: newFreshChatId };
            }
            if (retryResult.body && (retryResult.body.includes('FAIL_SYS_USER_VALIDATE') || retryResult.body.includes('_____tmd_____'))) {
              throw new QwenUpstreamError('Qwen TMD challenge persists after header refresh and fresh chat.', 'FAIL_SYS_USER_VALIDATE', 403);
            }
            if (retryResult.body) {
              handleErrorBody(retryResult.body, retryResult.status);
            }
          } catch (retryErr) {
            if (retryErr instanceof QwenUpstreamError) throw retryErr;
          }
          throw new QwenUpstreamError('Qwen TMD anti-bot challenge detected. Headers were refreshed but the challenge persists.', 'FAIL_SYS_USER_VALIDATE', 403);
        }
        handleErrorBody(peekText, browserResult.status);
      }
    } catch (browserErr: any) {
      if (browserErr instanceof QwenUpstreamError || browserErr instanceof RetryableQwenStreamError) throw browserErr;
      console.warn('[Qwen] Browser stream fetch failed:', browserErr.message);
    }
    return null;
  };

  // Execute fetch strategy with fallback
  if (tryDirectFirst) {
    // DIRECT_FETCH=true: Try direct first, fallback to browser on TMD
    console.log(`[Qwen] Trying direct fetch for chatId: ${chatId}`);
    const directResult = await tryDirectFetch();
    if (directResult) {
      const totalSetupMs = Date.now() - streamStartMs;
      console.log(`[Qwen] Direct stream created in ${totalSetupMs}ms (chatId: ${chatId}, account: ${accountId || 'guest'})`);
      return { stream: directResult.stream, headers: directResult.headers, uiSessionId: directResult.uiSessionId, controller: directResult.controller, accountId: accountId || 'guest' };
    }
    // Fallback to browser
    console.log(`[Qwen] Falling back to browser fetch for chatId: ${chatId}`);
    const browserResult = await tryBrowserFetch();
    if (browserResult) {
      const totalSetupMs = Date.now() - streamStartMs;
      console.log(`[Qwen] Browser fallback stream created in ${totalSetupMs}ms (chatId: ${chatId}, account: ${accountId || 'guest'})`);
      return { stream: browserResult.stream, headers: browserResult.headers, uiSessionId: browserResult.uiSessionId, controller: browserResult.controller, accountId: accountId || 'guest' };
    }
  } else if (useBrowserOnly) {
    // DIRECT_FETCH=false: Use browser, fallback to direct on error
    console.log(`[Qwen] Trying browser fetch for chatId: ${chatId}`);
    const browserResult = await tryBrowserFetch();
    if (browserResult) {
      const totalSetupMs = Date.now() - streamStartMs;
      console.log(`[Qwen] Browser stream created in ${totalSetupMs}ms (chatId: ${chatId}, account: ${accountId || 'guest'})`);
      return { stream: browserResult.stream, headers: browserResult.headers, uiSessionId: browserResult.uiSessionId, controller: browserResult.controller, accountId: accountId || 'guest' };
    }
    // Fallback to direct
    console.log(`[Qwen] Falling back to direct fetch for chatId: ${chatId}`);
    const directResult = await tryDirectFetch();
    if (directResult) {
      const totalSetupMs = Date.now() - streamStartMs;
      console.log(`[Qwen] Direct fallback stream created in ${totalSetupMs}ms (chatId: ${chatId}, account: ${accountId || 'guest'})`);
      return { stream: directResult.stream, headers: directResult.headers, uiSessionId: directResult.uiSessionId, controller: directResult.controller, accountId: accountId || 'guest' };
    }
  } else {
    // No browser available, direct only
    console.log(`[Qwen] Direct fetch only (no browser) for chatId: ${chatId}`);
    const directResult = await tryDirectFetch();
    if (directResult) {
      const totalSetupMs = Date.now() - streamStartMs;
      console.log(`[Qwen] Direct stream created in ${totalSetupMs}ms (chatId: ${chatId}, account: ${accountId || 'guest'})`);
      return { stream: directResult.stream, headers: directResult.headers, uiSessionId: directResult.uiSessionId, controller: directResult.controller, accountId: accountId || 'guest' };
    }
  }

  throw new QwenUpstreamError('All fetch methods failed (direct and browser)', 'FETCH_FAILED', 502);
  } catch (err) {
    releaseLeasedChat();
    throw err;
  }
}
