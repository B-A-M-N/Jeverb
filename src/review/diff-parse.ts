/**
 * Minimal unified-diff parser for review tooling.
 *
 * Detectors and chunking must reason about *added* lines — not raw text —
 * so a secret-looking string in removed code, or a `+++` file header that
 * happens to match a pattern, cannot trip (or dodge) a finding. This module
 * turns `git diff` output into file/hunk/line records with new-file line
 * numbers; anything that does not parse as a hunk body is ignored rather
 * than guessed at.
 */

export type DiffLineKind = "add" | "del" | "ctx";

export interface ParsedDiffLine {
  kind: DiffLineKind;
  /** Line content without the leading +/-/space marker. */
  text: string;
  /** 1-based line number in the new file, for added/context lines. */
  newLine?: number;
}

export interface ParsedDiffHunk {
  /** The raw `@@ ... @@` header, preserved so chunks keep context. */
  header: string;
  lines: ParsedDiffLine[];
}

export interface ParsedDiffFile {
  /** New-file path (`/dev/null` for deletions, without the `b/` prefix). */
  path: string;
  binary: boolean;
  hunks: ParsedDiffHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function stripPrefix(path: string): string {
  if (path === "/dev/null") return path;
  return path.replace(/^[ab]\//, "");
}

export function parseUnifiedDiff(diff: string): ParsedDiffFile[] {
  const files: ParsedDiffFile[] = [];
  let current: ParsedDiffFile | undefined;
  let newLine = 0;

  const startFile = (path: string): ParsedDiffFile => {
    const file: ParsedDiffFile = { path: stripPrefix(path), binary: false, hunks: [] };
    files.push(file);
    return file;
  };

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const parts = raw.split(" ");
      current = startFile(parts[parts.length - 1] ?? "unknown");
      newLine = 0;
      continue;
    }
    if (raw.startsWith("Binary files ") && raw.endsWith(" differ")) {
      if (current !== undefined) current.binary = true;
      continue;
    }
    if (raw.startsWith("@@")) {
      const m = HUNK_RE.exec(raw);
      if (current === undefined || m === null || m[2] === undefined) continue;
      newLine = Number(m[2]);
      current.hunks.push({ header: raw, lines: [] });
      continue;
    }
    if (current === undefined) continue;
    const hunk = current.hunks[current.hunks.length - 1];
    if (hunk === undefined) continue;
    if (raw.startsWith("\\")) continue;
    const marker = raw[0];
    const text = raw.slice(1);
    if (marker === "+") {
      hunk.lines.push({ kind: "add", text, newLine });
      newLine += 1;
    } else if (marker === "-") {
      hunk.lines.push({ kind: "del", text });
    } else if (marker === " ") {
      hunk.lines.push({ kind: "ctx", text, newLine });
      newLine += 1;
    }
    // Anything else (e.g. `---`/`+++` headers, index lines) carries no
    // hunk-body marker and is ignored: never guess line kind.
  }
  return files;
}

/** Added-line texts in order, for detectors that scan introduced content. */
export function addedLines(files: ParsedDiffFile[]): Array<{ path?: string; line?: number; text: string }> {
  const out: Array<{ path?: string; line?: number; text: string }> = [];
  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind !== "add") continue;
        out.push({
          path: file.path,
          ...(line.newLine !== undefined ? { line: line.newLine } : {}),
          text: line.text,
        });
      }
    }
  }
  return out;
}
