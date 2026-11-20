/**
 * Talking to other services without trusting them: a body's bytes are
 * counted as they stream, so the read stops at the cap instead of buffering
 * whatever the other side sends, and every request has a deadline.
 */

/** The body's bytes, or undefined once it passes `max` (the rest is never read). */
export async function readCapped(res: Response, max: number): Promise<Uint8Array | undefined> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > max) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** How long one agent, check or evaluation run may take. */
export const RUN_MS = 120_000;

/** The caller's signal, if any, bounded by a timeout. */
export const withTimeout = (signal: AbortSignal | undefined, ms: number): AbortSignal =>
  AbortSignal.any(signal ? [signal, AbortSignal.timeout(ms)] : [AbortSignal.timeout(ms)]);
