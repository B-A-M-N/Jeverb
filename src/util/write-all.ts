import { writeSync } from "node:fs";

export type SyncBufferWriter = (
  fd: number,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number | null,
) => number;

/** Write every byte or throw; a short write must never be reported as durable success. */
export function writeAllSync(fd: number, content: string | Buffer, writer: SyncBufferWriter = writeSync): void {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  let offset = 0;
  while (offset < bytes.length) {
    const written = writer(fd, bytes, offset, bytes.length - offset, null);
    if (!Number.isSafeInteger(written) || written <= 0 || written > bytes.length - offset) {
      throw new Error("file write did not make valid forward progress");
    }
    offset += written;
  }
}
