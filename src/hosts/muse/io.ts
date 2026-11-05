import type { Readable } from "node:stream";

/** Default caps: hook payloads are kilobytes; anything near a megabyte is a broken pipe, not an event. */
export const MAX_STDIN_BYTES = 1024 * 1024;
/** Reading must finish well inside the hook wall-clock budget (3.5 s dispatch + hook timeouts). */
export const STDIN_TIMEOUT_MS = 2500;

export class StdinTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`hook stdin exceeded the ${MAX_STDIN_BYTES} byte cap (${bytes} bytes read); refusing to buffer an unbounded payload`);
    this.name = "StdinTooLargeError";
  }
}

export class StdinTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`hook stdin did not close within ${timeoutMs}ms; refusing to wait out the hook budget on a stuck pipe`);
    this.name = "StdinTimeoutError";
  }
}

export interface StdinReadOptions {
  maxBytes?: number;
  timeoutMs?: number;
}

/**
 * Read a hook payload with explicit bounds. The previous unbounded
 * accumulator let a stuck or hostile pipe grow the hook process without
 * limit before any deadline applied. Callers treat bound violations as
 * malformed input: no output, exit 0 — the same fail-open advisory posture
 * as unparseable JSON, never a crash deny.
 */
export async function readStdinText(
  stream: Readable = process.stdin as unknown as Readable,
  opts: StdinReadOptions = {},
): Promise<string> {
  const maxBytes = opts.maxBytes ?? MAX_STDIN_BYTES;
  const timeoutMs = opts.timeoutMs ?? STDIN_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new StdinTimeoutError(timeoutMs)), timeoutMs);
    timer.unref?.();
  });
  const read = (async (): Promise<string> => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of stream) {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
      bytes += buf.length;
      if (bytes > maxBytes) throw new StdinTooLargeError(bytes);
      chunks.push(buf);
    }
    return Buffer.concat(chunks).toString("utf8");
  })();
  try {
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
