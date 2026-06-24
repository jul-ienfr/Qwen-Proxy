/**
 * Shared SSE parsing and URL extraction helpers for images.ts and videos.ts
 */

// ─── SSE Parsing ─────────────────────────────────────────────────────────────

export function parseSsePayloads(buffer: string, flush = false): { payloads: string[]; buffer: string } {
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

// ─── URL Extraction ──────────────────────────────────────────────────────────

export function extractResourceUrlFromText(text: string): string | null {
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

export function extractResourceUrlFromPayload(payload: any): string | null {
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

// ─── Error Parsing ───────────────────────────────────────────────────────────

export function parseUpstreamError(data: any): { error: string; code: string; status: number } | null {
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

// ─── SSE Stream Reader ───────────────────────────────────────────────────────

export interface StreamResult {
  contentUrl: string | null;
  videoTaskId?: string | null;
}

export async function readSseStreamForUrl(
  responseBody: ReadableStream,
  extractTaskId?: (payload: any) => string | null,
): Promise<StreamResult> {
  const reader = responseBody.getReader();
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

        if (extractTaskId) {
          const taskId = extractTaskId(parsed);
          if (taskId && !videoTaskId) videoTaskId = taskId;
        }
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
      if (extractTaskId) {
        const taskId = extractTaskId(parsed);
        if (taskId && !videoTaskId) videoTaskId = taskId;
      }
    } catch { /* ignore */ }
  }

  return { contentUrl, videoTaskId };
}

// ─── Common Headers Builder ──────────────────────────────────────────────────

// ─── Video Task ID Extraction ────────────────────────────────────────────────

export function extractVideoTaskID(text: string): string | null {
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

export function extractVideoTaskIDFromPayload(payload: any): string | null {
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

export function buildQwenHeaders(
  qHeaders: Record<string, string>,
  opts?: { accept?: string },
): Record<string, string> {
  return {
    'accept': opts?.accept || 'text/event-stream',
    'content-type': 'application/json',
    'cookie': qHeaders.cookie || '',
    'user-agent': qHeaders['user-agent'] || '',
    'origin': 'https://chat.qwen.ai',
    'referer': 'https://chat.qwen.ai/',
    'x-request-id': crypto.randomUUID(),
    'timezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    ...(qHeaders['bx-ua'] ? { 'bx-ua': qHeaders['bx-ua'] } : {}),
    ...(qHeaders['bx-umidtoken'] ? { 'bx-umidtoken': qHeaders['bx-umidtoken'] } : {}),
    ...(qHeaders['bx-v'] ? { 'bx-v': qHeaders['bx-v'] } : {}),
  };
}
