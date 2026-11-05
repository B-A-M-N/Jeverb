/**
 * Whether a caller-supplied `data_dir` may become a session's directory.
 *
 * A session's data directory decides where its evidence lands, so the daemon
 * does not take the caller's word for it: the candidate must name a real
 * directory under one of the daemon's allowed roots, owned by this user, with
 * symlinks resolved before the containment check so a link inside the roots
 * pointing outside them is an escape, not a pass.
 */

import { realpathSync, statSync } from "node:fs";
import { isAbsolute, sep } from "node:path";

export type DataDirVerdict = { ok: true; path: string } | { ok: false; reason: string };

/**
 * Validate a caller-supplied data directory.
 *
 * Returns the canonical (symlink-resolved) path on success, so the registry
 * stores one spelling per directory and `dir/../dir` cannot alias past a
 * comparison. Every failure names the reason without echoing secrets — there
 * are none here, only paths — for the daemon log and the `forbidden` counter.
 */
export function validateDataDir(candidate: unknown, allowedRoots: readonly string[]): DataDirVerdict {
  if (typeof candidate !== "string" || candidate.trim() === "") {
    return { ok: false, reason: "missing data_dir" };
  }
  const raw = candidate.trim();
  if (!isAbsolute(raw)) return { ok: false, reason: "data_dir is not absolute" };
  let resolved: string;
  try {
    // Resolves every symlink component: an escape through a link lands
    // outside the roots below and is rejected rather than followed.
    resolved = realpathSync(raw);
  } catch {
    return { ok: false, reason: "data_dir does not exist" };
  }
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(resolved);
  } catch {
    return { ok: false, reason: "data_dir is not readable" };
  }
  if (!stat.isDirectory()) return { ok: false, reason: "data_dir is not a directory" };
  if (typeof process.geteuid === "function" && stat.uid !== process.geteuid()) {
    return { ok: false, reason: "data_dir is not owned by this user" };
  }
  for (const root of allowedRoots) {
    let canonical: string;
    try {
      canonical = realpathSync(root);
    } catch {
      continue;
    }
    if (resolved === canonical || resolved.startsWith(canonical + sep)) {
      return { ok: true, path: resolved };
    }
  }
  return { ok: false, reason: "data_dir is outside the allowed roots" };
}
