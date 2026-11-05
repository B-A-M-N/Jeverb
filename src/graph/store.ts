/**
 * Purpose: persist immutable graph definitions for later replay and edits.
 * Owner: graph-definition storage under the configured runtime data directory.
 * Forbidden: storing definitions in the source tree or retaining crash temps indefinitely.
 */
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { removeStaleTempFiles, withFileLock } from "../hooks/store-lock.js";
import { writeAllSync } from "../util/write-all.js";
import type { Graph } from "./executor.js";

const MAX_GRAPH_DEFINITION_BYTES = 1024 * 1024;

function safeRunId(runId: string): boolean {
  return /^[A-Za-z0-9_-]{1,100}$/.test(runId);
}

function definitionsDir(dataDir: string): string {
  const path = join(dataDir, "graph-definitions");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new Error("graph definition store is not a private, user-owned directory");
  }
  return path;
}

export function graphDefinitionPath(dataDir: string, runId: string): string {
  if (!safeRunId(runId)) throw new Error("invalid graph run identifier");
  return join(definitionsDir(dataDir), `graph-${runId}.json`);
}

export function hasGraphDefinition(dataDir: string, runId: string): boolean {
  const path = graphDefinitionPath(dataDir, runId);
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function saveGraphDefinition(dataDir: string, runId: string, graph: Graph): string {
  const path = graphDefinitionPath(dataDir, runId);
  const serialized = `${JSON.stringify(graph)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_GRAPH_DEFINITION_BYTES) {
    throw new Error(`graph definition exceeds ${MAX_GRAPH_DEFINITION_BYTES} bytes`);
  }
  const dir = dirname(path);
  const locked = withFileLock(dir, `graph-definition-${runId}`, () => {
    // Definitions live in a subdirectory of dataDir, so daily root-level
    // maintenance cannot see crash-orphaned atomic-write temps here.
    removeStaleTempFiles(dir);
    if (existsSync(path)) throw new Error("graph definition already exists for this run id");
    const temp = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    let fd = -1;
    try {
      fd = openSync(temp, "wx", 0o600);
      writeAllSync(fd, serialized);
      fsyncSync(fd);
      closeSync(fd);
      fd = -1;
      renameSync(temp, path);
      const dirFd = openSync(dir, "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
      return path;
    } catch (error) {
      if (fd >= 0) closeSync(fd);
      rmSync(temp, { force: true });
      throw error;
    }
  });
  if (!locked.locked || locked.value === undefined) throw new Error("could not acquire graph-definition lock");
  return locked.value;
}

export function loadGraphDefinition(dataDir: string, runId: string): Graph {
  const path = graphDefinitionPath(dataDir, runId);
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("saved graph definition not found");
    throw new Error("saved graph definition could not be inspected");
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
      stat.size > MAX_GRAPH_DEFINITION_BYTES) {
    throw new Error("saved graph definition failed ownership, mode, type, or size validation");
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error("saved graph definition is malformed");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("saved graph definition is not an object");
  }
  return value as Graph;
}
