/**
 * Line Extractor — Shared utility for extracting complete lines from
 * chunked string buffers without O(n^2) concatenation.
 *
 * Used by both the standard SSE parser (stream-handler) and the fast
 * direct-stream-proxy to avoid duplicating identical line-scanning logic.
 *
 * Design decisions:
 * - Uses array join instead of string += for building lines (avoids O(n^2)).
 * - Pure function: does not mutate the input array. The caller is responsible
 *   for removing consumed chunks using the returned metadata.
 * - Returns chunk index and newline offset so callers can perform efficient
 *   index-based buffer trimming without re-scanning.
 */

/** Result of a successful line extraction. */
export interface LineExtractResult {
  /** The extracted line content (without the trailing newline). */
  line: string;
  /**
   * Total number of characters consumed from the buffer, including the
   * trailing newline character. The caller should subtract this from
   * `bufTotalLen` after extracting the line.
   */
  consumed: number;
  /**
   * Index of the chunk that contained the newline delimiter.
   * Chunks 0..chunkIndex-1 are fully consumed and should be removed.
   */
  chunkIndex: number;
  /**
   * Character offset within `chunks[chunkIndex]` where the newline was found.
   * After removing full chunks, the caller should substring the remaining
   * first chunk starting at `newlineOffset + 1` to skip past the delimiter.
   */
  newlineOffset: number;
}

/**
 * Extract the next complete line (delimited by '\n') from a chunked string buffer.
 *
 * Scans the array of string chunks looking for a newline character. When found,
 * the line is assembled from the partial first chunk, any full middle chunks,
 * and the partial last chunk — all joined together via `Array.prototype.join`
 * rather than repeated string concatenation.
 *
 * The function does NOT mutate the input `chunks` array. After receiving the
 * result, the caller should:
 * 1. Splice out chunks 0..result.chunkIndex-1 (fully consumed chunks).
 * 2. Substring the remaining first chunk at `result.newlineOffset + 1`.
 * 3. Subtract `result.consumed` from `bufTotalLen`.
 *
 * @param chunks - The buffer chunks to scan. Must not be empty.
 * @returns The extracted line with consumption metadata, or `null` if no
 *          complete line (no '\n' delimiter) is found across all chunks.
 *
 * @example
 * ```ts
 * const buf: string[] = ['hello ', 'world\nmore data'];
 * const result = extractLineFromChunks(buf);
 * // result = { line: 'hello world', consumed: 12, chunkIndex: 1, newlineOffset: 5 }
 * // Caller cleanup:
 * //   buf.splice(0, 1);              // remove 'hello '
 * //   buf[0] = buf[0].substring(6);  // trim 'world\n' -> 'more data'
 * ```
 */
export function extractLineFromChunks(
  chunks: string[],
): LineExtractResult | null {
  for (let ci = 0; ci < chunks.length; ci++) {
    const nlIdx = chunks[ci].indexOf('\n');
    if (nlIdx === -1) continue;

    // Build the line by collecting substring segments, then join once.
    const parts: string[] = [];

    // Full chunks before the one containing the newline.
    for (let j = 0; j < ci; j++) {
      parts.push(chunks[j]);
    }

    // Partial segment from the chunk containing the newline (before '\n').
    if (nlIdx > 0) {
      parts.push(chunks[ci].substring(0, nlIdx));
    }

    const line = parts.length === 1 ? parts[0] : parts.join('');
    const consumed = line.length + 1; // +1 for the '\n' itself

    return { line, consumed, chunkIndex: ci, newlineOffset: nlIdx };
  }

  // No newline found in any chunk — no complete line available yet.
  return null;
}

/**
 * Trim consumed chunks from the buffer after a successful line extraction.
 *
 * Removes fully consumed chunks (0..chunkIndex-1) and trims the remaining
 * first chunk to skip past the newline delimiter. Also updates bufTotalLen.
 *
 * @param chunks - The buffer chunks array (mutated in place).
 * @param result - The result from extractLineFromChunks().
 * @param bufTotalLen - Current total length counter (mutated in place).
 */
export function trimConsumedChunks(
  chunks: string[],
  result: { chunkIndex: number; newlineOffset: number; consumed: number },
  bufTotalLen: { value: number },
): void {
  // Remove fully consumed chunks
  if (result.chunkIndex > 0) {
    chunks.splice(0, result.chunkIndex);
  }
  // Trim the remaining first chunk to skip past the newline
  if (chunks.length > 0) {
    chunks[0] = chunks[0].substring(result.newlineOffset + 1);
  }
  bufTotalLen.value -= result.consumed;
  if (bufTotalLen.value < 0) bufTotalLen.value = 0;
}
