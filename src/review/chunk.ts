import type { ReviewInput } from "./detectors.js";
import { parseUnifiedDiff } from "./diff-parse.js";

export interface DiffChunk {
  index: number;
  text: string;
  files: string[];
}

const DEFAULT_MAX_CHARS = 8000;

/**
 * Split a unified diff into model-sized chunks along file/hunk boundaries.
 *
 * Each chunk carries the `diff --git` / `---` / `+++` file header plus whole
 * hunks, so a hunk never loses its header context mid-review. Hunks are
 * packed greedily up to `maxChars`; a single hunk larger than the budget is
 * hard-split with the file header repeated on each piece.
 */
export function chunkDiff(diff: string, maxChars: number = DEFAULT_MAX_CHARS): DiffChunk[] {
  if (diff.length === 0) return [{ index: 0, text: "", files: [] }];
  const files = parseUnifiedDiff(diff);
  if (files.length === 0) {
    // Not a unified diff (or no parseable hunks): fall back to plain
    // character windows so unstructured input is still reviewable.
    return plainChunks(diff, [], maxChars);
  }
  const chunks: DiffChunk[] = [];
  let current = "";
  let currentFiles: string[] = [];
  const flush = (): void => {
    if (current.length > 0) {
      chunks.push({ index: chunks.length, text: current, files: [...new Set(currentFiles)] });
      current = "";
      currentFiles = [];
    }
  };
  for (const file of files) {
    const header = `diff --git a/${file.path} b/${file.path}\n`;
    for (const hunk of file.hunks) {
      const body = `${hunk.header}\n${hunk.lines.map((l) => `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.text}`).join("\n")}\n`;
      const piece = `${header}${body}`;
      if (current.length > 0 && current.length + piece.length > maxChars) flush();
      if (piece.length > maxChars) {
        flush();
        // Oversized hunk: hard-split the body, repeating the header.
        for (let start = 0; start < body.length; start += maxChars) {
          chunks.push({ index: chunks.length, text: `${header}${body.slice(start, start + maxChars)}`, files: [file.path] });
        }
        continue;
      }
      current += piece;
      currentFiles.push(file.path);
    }
  }
  flush();
  if (chunks.length === 0) return [{ index: 0, text: "", files: [] }];
  return chunks;
}

export function inputFiles(input: ReviewInput): string[] {
  return input.files ?? [];
}

function plainChunks(diff: string, files: string[], maxChars: number): DiffChunk[] {
  const chunks: DiffChunk[] = [];
  for (let start = 0; start < diff.length; start += maxChars) {
    chunks.push({ index: chunks.length, text: diff.slice(start, start + maxChars), files });
  }
  return chunks;
}


