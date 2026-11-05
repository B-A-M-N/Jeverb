import { lstatSync, opendirSync, type Stats } from "node:fs";
import { join } from "node:path";
import type { Graph } from "./executor.js";
import { graphHash } from "./validate.js";
import { reconcileJournal } from "./journal.js";
import { hasGraphDefinition, loadGraphDefinition } from "./store.js";

const MAX_HISTORY_DIRECTORY_ENTRIES = 4096;
const MAX_HISTORY_RUNS = 256;
const MAX_HISTORY_FILE_BYTES = 4 * 1024 * 1024;
const MAX_HISTORY_TOTAL_BYTES = 32 * 1024 * 1024;
const RUN_ID = /^[A-Za-z0-9_-]{1,100}$/;

export interface GraphHistoryEntry {
  runId: string;
  graphHash: string;
  policyHash: string;
  updatedAt: string;
  definitionAvailable: boolean;
  nodes: Record<string, number>;
  uncertainAttempts: number;
}

function privateFile(path: string, maxBytes: number): Stats {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > maxBytes ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) throw new Error("graph history file failed ownership, mode, type, link, or size validation");
  return stat;
}

function journalPath(dataDir: string, runId: string): string {
  if (!RUN_ID.test(runId)) throw new Error("invalid graph run identifier");
  return join(dataDir, "graph-journals", `jeverb-graph-${runId}.jsonl`);
}

function readRun(dataDir: string, sessionId: string, runId: string): {
  graph: Graph;
  journal: ReturnType<typeof reconcileJournal>;
  updatedAt: string;
} {
  const path = journalPath(dataDir, runId);
  const stat = privateFile(path, MAX_HISTORY_FILE_BYTES);
  const journal = reconcileJournal(path);
  if (
    !journal.runStarted || journal.runId !== runId || journal.hostSessionId !== sessionId || journal.malformed !== 0 ||
    journal.graphHash === undefined || journal.policyHash === undefined
  ) throw new Error("graph run is unavailable or does not belong to the current Muse session");
  if (!hasGraphDefinition(dataDir, runId)) throw new Error("saved graph definition is unavailable");
  const graph = loadGraphDefinition(dataDir, runId);
  if (graphHash(graph) !== journal.graphHash) throw new Error("saved graph definition does not match its journal");
  return { graph, journal, updatedAt: stat.mtime.toISOString() };
}

/** List only private, well-formed runs recorded for this exact host session. */
export function listSessionGraphHistory(dataDir: string, sessionId: string, limit: number): {
  runs: GraphHistoryEntry[];
  unavailable: number;
} {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("history limit must be an integer in [1,50]");
  const directory = join(dataDir, "graph-journals");
  let dirStat;
  try {
    dirStat = lstatSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { runs: [], unavailable: 0 };
    throw new Error("graph history directory could not be inspected");
  }
  if (
    dirStat.isSymbolicLink() || !dirStat.isDirectory() || (dirStat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && dirStat.uid !== process.getuid())
  ) throw new Error("graph history directory failed ownership or mode validation");

  const names: string[] = [];
  const dir = opendirSync(directory);
  try {
    let entries = 0;
    for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
      entries += 1;
      if (entries > MAX_HISTORY_DIRECTORY_ENTRIES) throw new Error("graph history directory exceeds its scan limit");
      const match = /^jeverb-graph-([A-Za-z0-9_-]{1,100})\.jsonl$/.exec(entry.name);
      if (match !== null) names.push(match[1]!);
      if (names.length > MAX_HISTORY_RUNS) throw new Error("graph history exceeds its run limit");
    }
  } finally {
    dir.closeSync();
  }

  let totalBytes = 0;
  let unavailable = 0;
  const entries: GraphHistoryEntry[] = [];
  for (const runId of names) {
    try {
      const path = journalPath(dataDir, runId);
      const stat = privateFile(path, MAX_HISTORY_FILE_BYTES);
      totalBytes += stat.size;
      if (totalBytes > MAX_HISTORY_TOTAL_BYTES) throw new Error("graph history exceeds its byte limit");
      const { journal, updatedAt } = readRun(dataDir, sessionId, runId);
      const nodes: Record<string, number> = {};
      for (const node of journal.nodes) {
        if (!["succeeded", "failed", "skipped", "blocked", "cancelled", "outcome_unknown"].includes(node.status)) {
          throw new Error("graph journal contains an unknown node status");
        }
        nodes[node.status] = (nodes[node.status] ?? 0) + 1;
      }
      entries.push({
        runId,
        graphHash: journal.graphHash!,
        policyHash: journal.policyHash!,
        updatedAt,
        definitionAvailable: true,
        nodes,
        uncertainAttempts: journal.unknowns.length,
      });
    } catch (error) {
      if (error instanceof Error && /exceeds its (scan|run|byte) limit/.test(error.message)) throw error;
      // Do not reveal unscoped or malformed entries; surface only a count.
      unavailable += 1;
    }
  }
  entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.runId.localeCompare(b.runId));
  return { runs: entries.slice(0, limit), unavailable };
}

/** Load a saved run only when the host-injected Muse session matches its journal. */
export function loadSessionGraphForResume(dataDir: string, sessionId: string, runId: string): Graph {
  return readRun(dataDir, sessionId, runId).graph;
}
