/**
 * Purpose: persist private, content-verified full graph outputs.
 * Owner: opt-in graph artifact storage under the configured runtime data directory.
 * Forbidden: retaining partial artifacts or storing output in the source tree.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { removeStaleTempFiles } from "../hooks/store-lock.js";
import { writeAllSync } from "../util/write-all.js";

export const MAX_GRAPH_ARTIFACT_BYTES = 4 * 1024 * 1024;

export interface GraphOutputArtifact {
  artifactId: string;
  runId: string;
  nodeId: string;
  digest: string;
  bytes: number;
  content: string;
}

function safeRunId(runId: string): boolean {
  return /^[A-Za-z0-9_-]{1,100}$/.test(runId);
}

function digest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new Error("graph artifact directory is not an owned real directory");
  }
  if ((stat.mode & 0o077) !== 0) throw new Error("graph artifact directory permissions must be private (0700)");
}

/** Private opt-in store for complete graph outputs. Artifacts are immutable and content verified. */
export class GraphOutputArtifactStore {
  constructor(readonly dir: string) {
    ensurePrivateDir(dir);
  }

  write(runId: string, nodeId: string, content: string): { artifactId: string; digest: string; bytes: number } {
    if (!safeRunId(runId)) throw new Error("invalid graph artifact run id");
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_GRAPH_ARTIFACT_BYTES) throw new Error(`graph output exceeds the ${MAX_GRAPH_ARTIFACT_BYTES}-byte artifact limit`);
    const artifactId = randomUUID();
    const value = { schema: 1, runId, nodeId, digest: digest(content), bytes, content };
    const target = join(this.dir, `jeverb-graph-output-${runId}-${artifactId}.json`);
    removeStaleTempFiles(this.dir);
    const temp = `${target}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    let fd = -1;
    try {
      fd = openSync(temp, "wx", 0o600);
      writeAllSync(fd, `${JSON.stringify(value)}\n`);
      fsyncSync(fd);
      closeSync(fd);
      fd = -1;
      renameSync(temp, target);
      const dirFd = openSync(this.dir, "r");
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    } catch (error) {
      if (fd >= 0) {
        try { closeSync(fd); } catch { /* preserve the original write failure */ }
      }
      try { if (existsSync(temp)) rmSync(temp, { force: true }); } catch { /* best effort cleanup only */ }
      throw error;
    }
    return { artifactId, digest: value.digest, bytes };
  }

  read(runId: string, artifactId: string): GraphOutputArtifact {
    if (!safeRunId(runId) || !/^[0-9a-f-]{36}$/.test(artifactId)) throw new Error("invalid graph artifact reference");
    const path = join(this.dir, `jeverb-graph-output-${runId}-${artifactId}.json`);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      throw new Error("graph artifact is not an owned regular file");
    }
    if ((stat.mode & 0o077) !== 0) throw new Error("graph artifact permissions must be private (0600)");
    if (stat.size > MAX_GRAPH_ARTIFACT_BYTES + 16_384) throw new Error("graph artifact exceeds the read limit");
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("invalid graph artifact envelope");
    const value = raw as Record<string, unknown>;
    if (
      value["schema"] !== 1 || value["runId"] !== runId || typeof value["nodeId"] !== "string" ||
      typeof value["content"] !== "string" || typeof value["digest"] !== "string" ||
      value["bytes"] !== Buffer.byteLength(value["content"], "utf8") ||
      value["digest"] !== digest(value["content"])
    ) throw new Error("graph artifact integrity check failed");
    return {
      artifactId,
      runId,
      nodeId: value["nodeId"],
      digest: value["digest"],
      bytes: value["bytes"],
      content: value["content"],
    };
  }
}
