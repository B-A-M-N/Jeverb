import { describe, expect, it } from "vitest";
import { writeAllSync, type SyncBufferWriter } from "../../src/util/write-all.js";

describe("writeAllSync", () => {
  it("continues after short writes using the correct byte offsets", () => {
    const chunks: Buffer[] = [];
    const calls: Array<{ offset: number; length: number; position: number | null }> = [];
    const writer: SyncBufferWriter = (_fd, buffer, offset, length, position) => {
      calls.push({ offset, length, position });
      const count = Math.min(2, length);
      chunks.push(Buffer.from(buffer.subarray(offset, offset + count)));
      return count;
    };

    writeAllSync(7, "a💡bc", writer);

    expect(Buffer.concat(chunks).toString("utf8")).toBe("a💡bc");
    expect(calls.map((call) => call.offset)).toEqual([0, 2, 4, 6]);
    expect(calls.every((call) => call.position === null)).toBe(true);
  });

  it("throws when a writer reports no forward progress", () => {
    const writer: SyncBufferWriter = () => 0;
    expect(() => writeAllSync(7, "receipt", writer)).toThrow(/forward progress/);
  });
});
