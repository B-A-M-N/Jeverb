/**
 * Durable per-node execution journal for graph runs.
 *
 * The executor's in-memory results disappear with the process. A crash
 * between authorizing a side-effecting command and recording its outcome
 * would otherwise leave an executed command with no recoverable state —
 * and a naive retry would double-apply it. The journal persists
 * `run-started`, per-attempt `node-authorized` + `node-running`, and
 * `node-terminal` events as fsync'd JSONL, so a restart can classify every
 * interrupted attempt as `outcome_unknown` (reconcile, never blind-retry).
 * Each terminal record also captures the node's exact declared predecessor
 * ids, so criterion evidence can distinguish a root node from missing
 * dependency history and reject unsuccessful or absent predecessors.
 *
 * `running` is persisted BEFORE the side-effecting command is invoked.
 * Anything with `running` but no resolving terminal after a crash is uncertain
 * by construction. A later `blocked` terminal may only record that retry was
 * refused; it does not resolve the side effect.
 */
import { appendFileSync, existsSync, openSync, readFileSync, fsyncSync, closeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { writeAllSync } from "../util/write-all.js";
import type { JevDecision } from "./executor.js";

export type JournalEventType = "run-started" | "node-authorized" | "node-running" | "node-terminal";

export interface JournalEvent {
  type: JournalEventType;
  runId: string;
  ts: string;
  /**
   * Claimed submitter (model-supplied `source`): descriptive only, never
   * authority. Recorded so impersonation attempts are visible, not honored.
   */
  claimedSource?: string;
  /**
   * Authenticated principal. On transports without caller authentication
   * (stdio MCP) this is `unverified:<transport>`: an explicit statement
   * that no verified identity exists, never a forged operator name.
   */
  principal?: string;
  /** Candidate/operation correlation supplied out-of-band (env, harness). */
  candidate?: string;
  /** Effective resource ceilings recorded at run start (evidence of what was enforced). */
  resourceLimits?: { maxMemoryMb: number; maxProcesses: number; maxFileBytes: number; maxCpuSeconds: number };
  nodeId?: string;
  /** Declared graph predecessors captured on every terminal node event. */
  declaredDependencies?: string[];
  attemptId?: string;
  allowed?: boolean;
  reason?: string;
  inputHash?: string;
  /** Terminal status, present only on node-terminal. */
  status?: string;
  /** sha256 of the FULL node output, not the truncated excerpt. */
  outputDigest?: string;
  /** Optional private artifact id for a caller-requested full output. */
  outputArtifact?: string;
  /**
   * Recorded typed Jev judgment, present only on jev node-terminal events.
   * Replay restores this decision verbatim instead of re-invoking the
   * backend; it carries the provider/model/qualification identity of the
   * run that actually produced it, so a replay never misattributes it.
   */
  jev?: JevDecision;
  /**
   * Canonical effective-input digest (policy + descriptor + revision +
   * runtime dependency evidence/decisions) for the terminal outcome.
   * Resume matches on this, never on the static input hash alone.
   */
  effectiveInputHash?: string;
  /**
   * Graph revision (opts.graphHash) the node settled under. A prior outcome
   * from another revision is history, never inheritable identity.
   */
  revisionHash?: string;
  /**
   * Branch selected by this run's gate evaluation (e.g. the satisfied
   * condition and observed value, or the satisfied join). Reuse requires
   * the same branch: a changed branch is a different outcome, never a
   * re-execution of the recorded one.
   */
  branch?: string;
  /** sha256 of the graph + policy the run was authorized under. */
  graphHash?: string;
  policyHash?: string;
  /**
   * Structured decision evidence (Phase 2): which decision family this
   * terminal event records, and whether the judgment was allowed to select
   * a consequential branch. Absent on pre-Phase-2 events and on shell-node
   * terminals, which record no Jev judgment.
   */
  decisionKind?: "routing" | "authorization" | "verification";
  decisionMode?: "advisory" | "consequential";
  /** Deployed model version that produced the recorded judgment, if pinned. */
  modelVersion?: string;
  /** Qualification record id the consequential route was admitted under, if any. */
  qualificationId?: string;
}

/** Minimal writer surface the executor depends on (sync: fsync per event). */
export interface JournalWriter {
  record(event: JournalEvent): void;
  readonly path: string;
}

/** No-op writer for unit tests and callers that opt out of durability. */
export class NullJournal implements JournalWriter {
  readonly path = "<none>";
  record(_event: JournalEvent): void {
    /* no durability requested */
  }
}

export function newRunId(): string {
  return randomUUID();
}

export function digestFullOutput(output: string): string {
  return createHash("sha256").update(output, "utf8").digest("hex");
}

/**
 * Append-only fsync'd JSONL journal. One file per run
 * (`<dir>/jeverb-graph-<runId>.jsonl`). Concurrent appends from separate
 * processes use O_APPEND positioning; a single run has a single writer.
 */
export class FileJournal implements JournalWriter {
  readonly path: string;
  constructor(
    readonly runId: string,
    dir: string,
    private readonly hostSessionId?: string,
  ) {
    this.path = `${dir.replace(/\/+$/, "")}/jeverb-graph-${runId}.jsonl`;
  }

  record(event: JournalEvent): void {
    const line = `${JSON.stringify({
      ...event,
      runId: this.runId,
      ts: new Date().toISOString(),
      ...(this.hostSessionId === undefined ? {} : { hostSessionId: this.hostSessionId }),
    })}\n`;
    const fd = openSync(this.path, "a", 0o600);
    try {
      writeAllSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

export interface ReconciledNode {
  nodeId: string;
  /** Last terminal status, or outcome_unknown when interrupted. */
  status: string;
  attemptIds: string[];
  /** Declared predecessor ids. Undefined means legacy/unknown, never empty. */
  declaredDependencies?: string[];
  outputDigest?: string;
  outputArtifact?: string;
  /** Input hash of the terminal record: resume matches on this, never on id alone. */
  inputHash?: string;
  /** Recorded Jev judgment for a succeeded jev node: replay restores it verbatim. */
  jev?: JevDecision;
  /** Canonical effective-input digest of the terminal outcome. */
  effectiveInputHash?: string;
  /** Graph revision the node settled under. */
  revisionHash?: string;
  /** Branch selected by the settling run's gate evaluation. */
  branch?: string;
  /**
   * Decision family the settlement was evaluated under, when recorded.
   * Present on routing-gated branch settlements (admitted or refused).
   */
  decisionKind?: "routing" | "authorization" | "verification";
  /** Whether the recorded judgment was allowed to select a consequential branch. */
  decisionMode?: "advisory" | "consequential";
  /** Qualification record id the consequential route was admitted under, if any. */
  qualificationId?: string;
  /** Deployed model version that produced the recorded judgment, if pinned. */
  modelVersion?: string;
}

export interface Reconciliation {
  runId?: string;
  /** Host-injected Muse session identity, absent for legacy/unscoped journals. */
  hostSessionId?: string;
  runStarted: boolean;
  /** sha256 of the graph the journaled run executed (absent in old journals). */
  graphHash?: string;
  /** Policy fingerprint recorded at run start (absent only in legacy journals). */
  policyHash?: string;
  /** Run-level terminal record is out of scope for v1 (the caller owns it). */
  nodes: ReconciledNode[];
  /** Node ids with a persisted `running` but no terminal: uncertain. */
  unknowns: string[];
  /** Allowed authorizations with no subsequent running or terminal event. */
  pending: string[];
  malformed: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Classify a journal after a crash or before a restart. Never infers
 * success: a node with `running` but no `node-terminal` is
 * `outcome_unknown` and requires reconciliation (inspect, then explicitly
 * authorize a retry or mark superseded). Returns malformed-line count
 * instead of throwing on a torn tail write.
 */
export function reconcileJournal(path: string): Reconciliation {
  const nodes = new Map<string, {
    terminal?: string;
    attempts: string[];
    running: string[];
    authorized: string[];
    digest?: string;
    inputHash?: string;
    outputArtifact?: string;
    jev?: JevDecision;
    effectiveInputHash?: string;
    revisionHash?: string;
    branch?: string;
    decisionKind?: "routing" | "authorization" | "verification";
    decisionMode?: "advisory" | "consequential";
    qualificationId?: string;
    modelVersion?: string;
    declaredDependencies?: string[];
  }>();
  let runId: string | undefined;
  let runStarted = false;
  let journalGraphHash: string | undefined;
  let journalPolicyHash: string | undefined;
  let hostSessionId: string | undefined;
  let malformed = 0;
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { runStarted: false, nodes: [], unknowns: [], pending: [], malformed: 0 };
  }
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    if (!isRecord(event) || typeof event["type"] !== "string") {
      malformed += 1;
      continue;
    }
    if (hostSessionId === undefined && typeof event["hostSessionId"] === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(event["hostSessionId"])) {
      hostSessionId = event["hostSessionId"];
    }
    if (typeof event["runId"] === "string" && runId === undefined) runId = event["runId"];
    const nodeId = typeof event["nodeId"] === "string" ? event["nodeId"] : undefined;
    switch (event["type"]) {
      case "run-started":
        runStarted = true;
        if (typeof event["graphHash"] === "string") journalGraphHash = event["graphHash"];
        if (typeof event["policyHash"] === "string") journalPolicyHash = event["policyHash"];
        break;
      case "node-running": {
        if (nodeId === undefined) {
          malformed += 1;
          break;
        }
        const entry = nodes.get(nodeId) ?? { attempts: [], running: [], authorized: [] };
        const attemptId = typeof event["attemptId"] === "string" ? event["attemptId"] : undefined;
        if (attemptId === undefined) malformed += 1;
        // Even a malformed running record means an effect may have started.
        // Keep a synthetic identity so reconciliation fails closed.
        const id = attemptId ?? `unknown-attempt-${entry.attempts.length + 1}`;
        entry.attempts.push(id);
        entry.authorized = entry.authorized.filter((authorized) => authorized !== id);
        entry.running.push(id);
        nodes.set(nodeId, entry);
        break;
      }
      case "node-terminal": {
        if (nodeId === undefined || typeof event["status"] !== "string") {
          malformed += 1;
          break;
        }
        const entry = nodes.get(nodeId) ?? { attempts: [], running: [], authorized: [] };
        entry.terminal = event["status"];
        if (Array.isArray(event["declaredDependencies"]) && event["declaredDependencies"].length <= 64 &&
            event["declaredDependencies"].every((dependency) => typeof dependency === "string" && dependency.trim() !== "" && dependency.length <= 200) &&
            new Set(event["declaredDependencies"]).size === event["declaredDependencies"].length) {
          entry.declaredDependencies = [...event["declaredDependencies"]] as string[];
        } else {
          delete entry.declaredDependencies;
          if (event["declaredDependencies"] !== undefined) malformed += 1;
        }
        // A blocked terminal can be written by resume when it refuses to
        // retry an earlier `outcome_unknown` attempt. That records the
        // refusal, not the result of the side effect, so it must not erase
        // the unresolved running attempt. Other terminal states are emitted
        // after an attempt actually settled (or after a non-running preflight
        // outcome) and close the current uncertainty.
        if (event["status"] !== "blocked") entry.running = [];
        entry.authorized = [];
        if (typeof event["outputDigest"] === "string") entry.digest = event["outputDigest"];
        else delete entry.digest;
        if (typeof event["inputHash"] === "string") entry.inputHash = event["inputHash"];
        if (typeof event["outputArtifact"] === "string") entry.outputArtifact = event["outputArtifact"];
        else delete entry.outputArtifact;
        // A terminal event fully describes the outcome it records: fields it
        // omits are cleared, so an earlier success in the same file can never
        // leak a decision, branch, or effective identity into a later outcome.
        if (typeof event["effectiveInputHash"] === "string") entry.effectiveInputHash = event["effectiveInputHash"];
        else delete entry.effectiveInputHash;
        if (typeof event["revisionHash"] === "string") entry.revisionHash = event["revisionHash"];
        else delete entry.revisionHash;
        if (typeof event["branch"] === "string") entry.branch = event["branch"];
        else delete entry.branch;
        // Routing evidence for replay: the family and mode the settlement
        // was evaluated under, with the admitted qualification identity.
        // Like branch and jev above, omitted fields are cleared so an
        // earlier outcome can never leak into a later one.
        if (event["decisionKind"] === "routing" || event["decisionKind"] === "authorization" || event["decisionKind"] === "verification") {
          entry.decisionKind = event["decisionKind"];
        } else delete entry.decisionKind;
        if (event["decisionMode"] === "advisory" || event["decisionMode"] === "consequential") {
          entry.decisionMode = event["decisionMode"];
        } else delete entry.decisionMode;
        if (typeof event["qualificationId"] === "string") entry.qualificationId = event["qualificationId"];
        else delete entry.qualificationId;
        if (typeof event["modelVersion"] === "string") entry.modelVersion = event["modelVersion"];
        else delete entry.modelVersion;
        if (isRecord(event["jev"]) &&
            typeof event["jev"]["provider"] === "string" &&
            typeof event["jev"]["questionHash"] === "string" &&
            typeof event["jev"]["calibrated"] === "boolean") {
          entry.jev = event["jev"] as unknown as JevDecision;
        } else delete entry.jev;
        nodes.set(nodeId, entry);
        break;
      }
      case "node-authorized": {
        if (nodeId === undefined || typeof event["allowed"] !== "boolean") {
          malformed += 1;
          break;
        }
        const entry = nodes.get(nodeId) ?? { attempts: [], running: [], authorized: [] };
        const attemptId = typeof event["attemptId"] === "string" ? event["attemptId"] : undefined;
        if (event["allowed"] !== true) {
          entry.authorized.push(`denied-authorization-${entry.authorized.length + 1}`);
          nodes.set(nodeId, entry);
          break;
        }
        if (attemptId === undefined) {
          malformed += 1;
          entry.authorized.push(`unknown-authorization-${entry.authorized.length + 1}`);
        } else {
          entry.attempts.push(attemptId);
          entry.authorized.push(attemptId);
        }
        nodes.set(nodeId, entry);
        break;
      }
      default:
        malformed += 1;
        break;
    }
  }
  const out: ReconciledNode[] = [];
  const unknowns: string[] = [];
  const pending: string[] = [];
  for (const [nodeId, entry] of nodes) {
    if (entry.running.length > 0) {
      out.push({ nodeId, status: "outcome_unknown", attemptIds: entry.running });
      unknowns.push(nodeId);
    } else if (entry.terminal !== undefined) {
      out.push({
        nodeId,
        status: entry.terminal,
        attemptIds: entry.attempts,
        ...(entry.digest === undefined ? {} : { outputDigest: entry.digest }),
        ...(entry.outputArtifact === undefined ? {} : { outputArtifact: entry.outputArtifact }),
        ...(entry.inputHash === undefined ? {} : { inputHash: entry.inputHash }),
        ...(entry.jev === undefined ? {} : { jev: entry.jev }),
        ...(entry.effectiveInputHash === undefined ? {} : { effectiveInputHash: entry.effectiveInputHash }),
        ...(entry.revisionHash === undefined ? {} : { revisionHash: entry.revisionHash }),
        ...(entry.branch === undefined ? {} : { branch: entry.branch }),
        ...(entry.decisionKind === undefined ? {} : { decisionKind: entry.decisionKind }),
        ...(entry.decisionMode === undefined ? {} : { decisionMode: entry.decisionMode }),
        ...(entry.qualificationId === undefined ? {} : { qualificationId: entry.qualificationId }),
        ...(entry.modelVersion === undefined ? {} : { modelVersion: entry.modelVersion }),
        ...(entry.declaredDependencies === undefined ? {} : { declaredDependencies: entry.declaredDependencies }),
      });
    } else if (entry.authorized.length > 0) {
      out.push({ nodeId, status: "pending", attemptIds: entry.authorized });
      pending.push(nodeId);
    }
  }
  return {
    ...(runId === undefined ? {} : { runId }),
    ...(hostSessionId === undefined ? {} : { hostSessionId }),
    runStarted,
    ...(journalGraphHash === undefined ? {} : { graphHash: journalGraphHash }),
    ...(journalPolicyHash === undefined ? {} : { policyHash: journalPolicyHash }),
    nodes: out,
    unknowns,
    pending,
    malformed,
  };
}

/** True when a journal file exists at path (imported for the tool layer). */
export function journalExists(path: string): boolean {
  return existsSync(path);
}

export function appendLine(path: string, line: string): void {
  appendFileSync(path, line, { encoding: "utf8", mode: 0o600 });
}
