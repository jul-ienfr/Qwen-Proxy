/**
 * Fast JSON string escaper — avoids JSON.stringify overhead for SSE content.
 * Shared between direct-stream-proxy and stream-handler.
 */

const ESCAPE_MAP: Record<string, string> = {
  '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r',
  '\t': '\\t', '\b': '\\b', '\f': '\\f',
};

const ESCAPE_REGEX = /[\\"\n\r\t\b\f]/g;

export function escapeJsonStringFast(str: string): string {
  if (str.length === 0) return str;
  if (!ESCAPE_REGEX.test(str)) return str;
  return str.replace(ESCAPE_REGEX, (ch) => ESCAPE_MAP[ch] || ch);
}
