/**
 * Purpose: create-only and deterministic output primitives for repository scripts.
 * Owner: script output lifecycle; callers own path selection and artifact meaning.
 * Forbidden: replacing measured evidence or silently refreshing changed generated data.
 */
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

export type ArtifactContents = string | Uint8Array;

export function assertOutputPathAvailable(path: string): void {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`refusing to overwrite existing output: ${path}`);
}

/** Create measured output exactly once; callers must choose a new path to rerun. */
export function writeNewArtifact(path: string, contents: ArtifactContents): void {
  writeFileSync(path, contents, { flag: "wx" });
}

/** Recreate deterministic generated data without replacing a differing artifact. */
export function writeDeterministicArtifact(path: string, contents: ArtifactContents): "created" | "unchanged" {
  try {
    writeNewArtifact(path, contents);
    return "created";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = lstatSync(path);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error(`refusing to reuse non-regular generated output: ${path}`);
    }
    const expected = typeof contents === "string" ? Buffer.from(contents) : Buffer.from(contents);
    if (readFileSync(path).equals(expected)) return "unchanged";
    throw new Error(`refusing to overwrite differing generated output: ${path}`);
  }
}

/**
 * Atomically replace a derived artifact while preserving its existing mode.
 * Callers must first retain the old bytes as a separate create-only artifact;
 * measured receipts and manifests must continue to use create-only writes.
 */
export function replaceDerivedArtifact(path: string, contents: ArtifactContents): void {
  const target = lstatSync(path);
  if (!target.isFile() || target.isSymbolicLink()) {
    throw new Error(`refusing to replace non-regular derived output: ${path}`);
  }
  const temp = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, contents, { flag: "wx", mode: target.mode & 0o777 });
    const fileFd = openSync(temp, "r");
    try {
      fsyncSync(fileFd);
    } finally {
      closeSync(fileFd);
    }
    renameSync(temp, path);
    try {
      const dirFd = openSync(dirname(path), "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      // Some filesystems do not support syncing directories.
    }
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // Preserve the original replacement failure.
    }
    throw error;
  }
}
