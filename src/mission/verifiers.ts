/**
 * Real verifier producers + adapters for per-criterion verification.
 *
 * Purpose: turn host-owned observations into `MissionCriterionVerification`
 * verdicts that the allowlist gate (`validateCriterionVerifications` in
 * graph-binding.ts) can count. Every adapter declares a capability stating
 * precisely what its evidence proves — and, just as importantly, what it
 * does not prove. No speculative adapters: the registry below is the whole
 * set. A new adapter is a new capability entry plus tests, never an
 * inferred extension of an existing one.
 *
 * Adapters and their trust boundaries:
 *
 * - `test-execution`: proves the named test report recorded a pass for this
 *   candidate. Reads host-supplied test records only; never executes
 *   commands, never consults model text. Does not prove the suite covers
 *   the criterion or that the code is semantically correct.
 * - `build-artifact`: proves a file exists at the declared path with
 *   exactly the expected sha256 at read time. Local filesystem reads under
 *   an explicit host-controlled root; nothing is executed. The read is
 *   symlink-safe: symlinks on the final path or any ancestor directory are
 *   refused (even in-root targets), the opened file descriptor is
 *   re-verified to sit inside the root, and anything unreadable abstains
 *   instead of reading outside bytes. Proves presence+digest, not
 *   provenance, freshness, or safety.
 * - `file-state`: proves each listed path matches its expected digest —
 *   the asserted repo snapshot. Same symlink-safe filesystem boundary as
 *   `build-artifact`. Proves state, not authorship.
 * - `tree-binding`: proves candidate C was evaluated against a tree snapshot
 *   whose root digest is T. Pure: the snapshot map is host-supplied, the
 *   adapter never reads the workspace implicitly. Proves the association
 *   claim, not that the tree was built or tested.
 * - `service-readback`: proves an authorized service returned an
 *   observation at read time. Requires an injected authorized reader;
 *   without one the adapter abstains (`undefined`), never fabricates.
 *   Proves the readback, not the service's correctness.
 *
 * Outputs carry: criterion, verifier, mission revision, candidate digest,
 * graph nodes+attempts, evidence ref, observed result, verdict, timestamp,
 * and policy/adapter version. Findings persist as `CriterionVerification`
 * ledger receipts (durable + idempotent) via `persistVerifierFinding`, and
 * map to `MissionCriterionVerification` via `findingToVerification`, reusing
 * the receipt mechanisms — never a parallel bookkeeping path.
 *
 * Verified-outcome is never execution-observed: verifier receipts carry no
 * `outcome` field at all (the receipt vocabulary has no verified-outcome
 * value, and stamping `execution-observed` on an independent verdict would
 * erase exactly the distinction the trusted path exists to enforce).
 *
 * Failure semantics: an adapter returns `undefined` when it could not
 * observe (unreadable input, symlink refusal, no authorized reader) — the
 * caller then counts nothing and the criterion stays `unresolved`. An
 * observed negative (failing tests, absent or mismatched artifact) is a
 * `failed` finding, never silence. Malformed identity inputs (bad digests,
 * empty ids) throw: that is a host programming error, not an observation.
 *
 * Identity encoding: every compound identifier in this module (finding
 * correlation ids, tree root digests, receipt subject hashes) hashes a
 * canonical length-delimited tuple encoding (`encodeTupleFields`), so
 * distinct field tuples cannot forge the same id. The current correlation
 * id scheme is v2 (`FINDING_CORRELATION_ID_VERSION`); v1 ids (naive NUL
 * join) remain valid ledger rows, matched via
 * `findingReceiptCorrelationIdCandidates` — old receipts are honored, new
 * receipts are canonical.
 */

import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { O_NOFOLLOW, O_RDONLY } from "node:constants";
import { join, relative, resolve, sep } from "node:path";
import { hashSubject } from "../evidence/receipt-validation.js";
import type { EvidenceLedger, EvidenceRecord } from "../evidence/ledger.js";
import type { MissionCriterionVerification } from "./closure.js";

/** Policy/adapter version stamped on every verifier output. */
export const VERIFIER_ADAPTER_VERSION = "mission-verifiers/1";

const HEX64 = /^[0-9a-f]{64}$/;
const MAX_ID_CHARS = 200;
const MAX_DETAIL_CHARS = 200;

function clamp(text: string, max = MAX_DETAIL_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function requireId(value: string, field: string): void {
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_ID_CHARS) {
    throw new Error(`verifier ${field} is missing or unbounded`);
  }
}

function requireDigest(value: string, field: string): void {
  if (typeof value !== "string" || !HEX64.test(value)) {
    throw new Error(`verifier ${field} is not a 64-hex digest`);
  }
}

function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Canonical tuple encoding for compound identifiers. Each field is
 * length-prefixed (`<length>:<bytes>`) and fields are comma-joined, so
 * decoding is unambiguous for arbitrary field content — including fields
 * that contain digits, colons, commas, spaces, newlines, or NUL bytes.
 * Naive joins on any fixed separator are forgeable (e.g. `["V X", "R"]`
 * vs `["V", "X R"]` on a space join); this encoding is not: distinct
 * tuples always encode to distinct strings. Every hashed compound
 * identity in this module goes through this encoder.
 */
export function encodeTupleFields(fields: string[]): string {
  return fields.map((field) => `${field.length}:${field}`).join(",");
}

/** Machine-readable reason a verifier file read was refused or failed. */
export type VerifierFileErrorCode = "unsafe" | "not-found" | "not-regular" | "unreadable";

/** Thrown when a verifier file cannot be read through the secure path. */
export class VerifierFileError extends Error {
  readonly code: VerifierFileErrorCode;
  constructor(code: VerifierFileErrorCode, message: string) {
    super(message);
    this.name = "VerifierFileError";
    this.code = code;
  }
}

/**
 * Traversal verdict for a declared verifier path. `"ok"` means every
 * on-disk check passed; `"absent"` means a component is definitively
 * missing from real disk (a virtual/memory seam names nothing on disk);
 * `"opaque"` means inspection itself was denied (permissions), so nothing
 * is proven either way. Only positively observed symlink escapes throw.
 */
type TraversalVerdict = "ok" | "absent" | "opaque";

/**
 * Refuse symlink traversal on a declared verifier path. Every inspectable
 * component of the resolved path at or below the root — the final file and
 * each ancestor directory — must not be a symbolic link, and the fully
 * resolved path must stay inside the root's real path. Any observed
 * symlink is refused, even one whose target sits inside the root:
 * allowlisting in-root targets would reintroduce aliasing and swap-window
 * reasoning the adapters refuse to do.
 *
 * Throws `VerifierFileError` with code `"unsafe"` the moment a symlink or
 * a root escape is observed — never after reading through it. Anything
 * else (missing components, denied inspection) is reported, not thrown:
 * a virtual/memory seam names nothing on disk, so injected readers fall
 * through to their own bytes, while the default disk reader resolves the
 * ambiguity at open time.
 */
function checkVerifierTraversal(root: string, absolute: string): TraversalVerdict {
  const base = resolve(root);
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return "absent";
  }
  const rel = relative(base, absolute);
  const parts = rel === "" ? [] : rel.split(sep);
  let current = base;
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    current = join(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") return "absent";
      return "opaque";
    }
    if (stat.isSymbolicLink()) {
      throw new VerifierFileError("unsafe", "verifier path traverses a symbolic link");
    }
  }
  let real: string;
  try {
    real = realpathSync(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return "absent";
    return "opaque";
  }
  if (real !== realRoot && !real.startsWith(`${realRoot}${sep}`)) {
    throw new VerifierFileError("unsafe", "verifier path resolves outside its root");
  }
  return "ok";
}

/**
 * Read one file inside a host-controlled root without following symlinks.
 * Lexical escapes throw (host programming error, as with
 * `resolveVerifierPath`); symlink escapes, non-regular files, and
 * unreadable files throw a coded `VerifierFileError` so callers fail
 * closed to `unresolved`, never to a verdict over outside bytes.
 *
 * TOCTOU notes: the final component opens with `O_NOFOLLOW`, and after
 * opening, the file descriptor's own resolved path is verified to still
 * sit inside the root (Linux `/proc/self/fd` self-view) before any byte
 * is read — so an ancestor directory swapped for a symlink between
 * inspection and open is still refused. Whatever digest the caller
 * computes is over the bytes actually opened, never over a path name.
 */
function secureReadFileSync(root: string, declaredPath: string): Buffer {
  const absolute = resolveVerifierPath(root, declaredPath);
  // Proven symlink escapes throw here; anything unproven resolves at open.
  const traversal = checkVerifierTraversal(root, absolute);
  let realRoot: string | undefined;
  try {
    realRoot = realpathSync(root);
  } catch {
    realRoot = undefined;
  }
  let fd: number;
  try {
    fd = openSync(absolute, O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new VerifierFileError("not-found", `artifact absent: ${declaredPath}`);
    }
    if (code === "ELOOP") {
      throw new VerifierFileError("unsafe", "verifier path is a symbolic link");
    }
    throw new VerifierFileError("unreadable", `verifier file cannot be opened: ${declaredPath}`);
  }
  try {
    if (!fstatSync(fd).isFile()) {
      throw new VerifierFileError("not-regular", `verifier path is not a regular file: ${declaredPath}`);
    }
    // Post-open containment: closes the check-then-open window on ancestor
    // directories (swapped for a symlink between inspection and open).
    // Whatever bytes the caller digests next are the opened file's; refuse
    // unless it still sits inside the root. When the fd self-view is
    // unavailable (non-Linux) only a fully inspected `"ok"` path proceeds —
    // an `"opaque"` pre-check fails closed instead of trusting the open.
    let contained = false;
    let selfView = false;
    try {
      const opened = realpathSync(`/proc/self/fd/${fd}`);
      selfView = true;
      contained = realRoot !== undefined && (opened === realRoot || opened.startsWith(`${realRoot}${sep}`));
    } catch (error) {
      if (error instanceof VerifierFileError) throw error;
      selfView = false;
    }
    if (selfView && !contained) {
      throw new VerifierFileError("unsafe", "verifier file resolves outside its root");
    }
    if (!selfView && traversal !== "ok") {
      throw new VerifierFileError("unreadable", `verifier file cannot be contained in its root: ${declaredPath}`);
    }
    return readFileSync(fd);
  } finally {
    try {
      closeSync(fd);
    } catch {
      // The read outcome already determines the verdict; ignore close noise.
    }
  }
}

/**
 * Read the bytes of one declared verifier file. With no injected `fs` the
 * bytes come from the symlink-safe default above. With an injected seam
 * (memory filesystems in tests, host readers in production) traversal is
 * still refused when the declared path names a real on-disk symlink escape,
 * then the bytes come through the seam; purely virtual paths name nothing
 * on disk and skip straight to the seam. Production hosts with real files
 * should omit `fs` so both inspection and bytes stay on the secure path —
 * an injected reader is trusted to return the bytes of the declared path.
 */
function readAdapterFile(
  root: string,
  declaredPath: string,
  absolute: string,
  fs: VerifierFs | undefined,
): Buffer {
  if (fs === undefined) return secureReadFileSync(root, declaredPath);
  checkVerifierTraversal(root, absolute);
  return fs.readFile(absolute);
}

/**
 * Hardened read of one declared verifier file under an explicit
 * host-controlled root. This is the single seam for observation reads that
 * must carry the adapter guarantees: lexical escapes throw (host
 * programming error, as with `resolveVerifierPath`), symlink escapes on
 * the final path or any ancestor directory throw `VerifierFileError`
 * (`unsafe` — even for in-root targets), non-regular files and unreadable
 * files throw coded errors, and TOCTOU between inspection and open fails
 * closed via `O_NOFOLLOW` plus a post-open containment check. With an
 * injected `fs` the same traversal refusal applies on real disk before
 * the bytes come through the seam; purely virtual paths fall through to
 * the seam's bytes.
 *
 * Callers that cannot observe (any throw) must abstain (`unobserved`),
 * never verdict over outside bytes.
 */
export function readVerifierFileBytes(root: string, declaredPath: string, fs?: VerifierFs): Buffer {
  const absolute = resolveVerifierPath(root, declaredPath);
  return readAdapterFile(root, declaredPath, absolute, fs);
}

export interface VerifierCapability {
  verifierId: string;
  adapterVersion: string;
  /** Precisely what evidence produced by this adapter proves (and excludes). */
  proves: string;
  /** The trust boundary the adapter operates inside. */
  trustBoundary: string;
}

export const VERIFIER_CAPABILITIES: VerifierCapability[] = [
  {
    verifierId: "test-execution",
    adapterVersion: VERIFIER_ADAPTER_VERSION,
    proves: "the named test report recorded a pass for this candidate; proves the suite ran and passed, not suite coverage or semantic correctness",
    trustBoundary: "reads host-supplied test records only; never executes commands, never consults model text",
  },
  {
    verifierId: "build-artifact",
    adapterVersion: VERIFIER_ADAPTER_VERSION,
    proves: "a file exists at the declared path with exactly the expected sha256 at read time; proves presence and digest, not provenance, freshness, or safety",
    trustBoundary: "local filesystem reads under an explicit host-controlled root; nothing is executed and nothing leaves the host",
  },
  {
    verifierId: "file-state",
    adapterVersion: VERIFIER_ADAPTER_VERSION,
    proves: "each listed path matches its expected digest at read time; proves the asserted snapshot state, not authorship or intent",
    trustBoundary: "local filesystem reads under an explicit host-controlled root; nothing is executed and nothing leaves the host",
  },
  {
    verifierId: "tree-binding",
    adapterVersion: VERIFIER_ADAPTER_VERSION,
    proves: "candidate C was evaluated against the tree snapshot whose root digest is T; proves the association claim, not that the tree was built or tested",
    trustBoundary: "pure function over a host-supplied snapshot map; never reads the workspace implicitly",
  },
  {
    verifierId: "service-readback",
    adapterVersion: VERIFIER_ADAPTER_VERSION,
    proves: "the authorized service returned the recorded observation at read time; proves the readback, not the service's correctness",
    trustBoundary: "requires an injected authorized reader; without one the adapter abstains, never fabricates",
  },
];

export interface VerifierGraphNode {
  runId: string;
  nodeId: string;
  attemptId?: string;
}

export interface VerifierFinding {
  criterionId: string;
  verifierId: string;
  adapterVersion: string;
  missionRevision: string;
  candidateDigest: string;
  graphNodes: VerifierGraphNode[];
  evidenceRef: string;
  /** The raw observation (exit state, digest comparison, readback summary) — never a proof claim. */
  observedResult: string;
  result: "satisfied" | "failed";
  verifiedAt: number;
  /** The capability's `proves` text, carried so the receipt states its own limits. */
  proves: string;
}

export interface VerifierInputBase {
  criterionId: string;
  missionRevision: string;
  candidateDigest: string;
  /** Graph nodes+attempts the finding traces to (observed lineage, not proof). */
  graphNodes?: VerifierGraphNode[];
  verifiedAt?: number;
  now?: () => number;
}

function baseFinding(
  input: VerifierInputBase,
  verifierId: string,
  result: "satisfied" | "failed",
  evidenceRef: string,
  observedResult: string,
): VerifierFinding {
  requireId(input.criterionId, "criterionId");
  requireDigest(input.missionRevision, "missionRevision");
  requireDigest(input.candidateDigest, "candidateDigest");
  const capability = VERIFIER_CAPABILITIES.find((entry) => entry.verifierId === verifierId);
  if (capability === undefined) throw new Error(`unknown verifier ${verifierId}`);
  const graphNodes = (input.graphNodes ?? []).filter(
    (node) => typeof node?.runId === "string" && typeof node?.nodeId === "string",
  );
  const verifiedAt = input.verifiedAt ?? input.now?.() ?? Date.now();
  if (!Number.isFinite(verifiedAt)) throw new Error("verifier verifiedAt is not finite");
  return {
    criterionId: input.criterionId,
    verifierId,
    adapterVersion: VERIFIER_ADAPTER_VERSION,
    missionRevision: input.missionRevision,
    candidateDigest: input.candidateDigest,
    graphNodes,
    evidenceRef: clamp(evidenceRef),
    observedResult: clamp(observedResult),
    result,
    verifiedAt,
    proves: capability.proves,
  };
}

/**
 * Test execution/result validation: the host supplies the test outcome, the
 * adapter records it. Satisfied only when the report says the suite passed.
 */
export function verifyTestExecution(
  input: VerifierInputBase & { evidenceRef: string; passed: boolean },
): VerifierFinding {
  requireId(input.evidenceRef, "evidenceRef");
  return baseFinding(
    input,
    "test-execution",
    input.passed ? "satisfied" : "failed",
    input.evidenceRef,
    input.passed ? `test report passed (${input.evidenceRef})` : `test report failed (${input.evidenceRef})`,
  );
}

/** Minimal filesystem seam: tests inject memory, production reads disk. */
export interface VerifierFs {
  readFile: (path: string) => Buffer;
}

/**
 * Resolve a declared path under an explicit host-controlled root. Absolute
 * paths must already sit under the root; anything escaping it throws.
 */
export function resolveVerifierPath(root: string, path: string): string {
  const base = resolve(root);
  const absolute = resolve(base, path);
  if (absolute !== base && !absolute.startsWith(`${base}${sep}`)) {
    throw new Error("verifier path escapes its root");
  }
  return absolute;
}

/**
 * Build-artifact existence+digest: satisfied only when the artifact exists
 * and its sha256 equals the expected digest. The read is symlink-safe (see
 * `secureReadFileSync`): a symlink escape, a non-regular file, or an
 * unreadable file is unobservable (`undefined`), never a quiet pass and
 * never a verdict over outside bytes. An absent artifact is an observed
 * negative (`failed`); digest mismatch names both digests so rotation is
 * visible, never silent.
 */
export function verifyBuildArtifact(
  input: VerifierInputBase & {
    path: string;
    expectedDigest: string;
    root?: string;
    fs?: VerifierFs;
  },
): VerifierFinding | undefined {
  requireId(input.path, "path");
  requireDigest(input.expectedDigest, "expectedDigest");
  const root = input.root ?? process.cwd();
  const absolute = resolveVerifierPath(root, input.path);
  const fs = input.fs;
  let bytes: Buffer;
  try {
    bytes = readAdapterFile(root, input.path, absolute, fs);
  } catch (error) {
    if (error instanceof VerifierFileError && error.code === "unsafe") return undefined;
    if (error instanceof VerifierFileError && (error.code === "not-regular" || error.code === "unreadable")) {
      return undefined;
    }
    if (error instanceof VerifierFileError && error.code === "not-found") {
      return baseFinding(input, "build-artifact", "failed", input.path, `artifact absent: ${input.path}`);
    }
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return baseFinding(input, "build-artifact", "failed", input.path, `artifact absent: ${input.path}`);
    }
    return undefined;
  }
  const observed = sha256Hex(bytes);
  if (observed !== input.expectedDigest) {
    return baseFinding(
      input,
      "build-artifact",
      "failed",
      input.path,
      `sha256 mismatch for ${input.path}: observed ${observed} expected ${input.expectedDigest}`,
    );
  }
  return baseFinding(input, "build-artifact", "satisfied", input.path, `artifact digest matches: ${observed}`);
}

/**
 * File/repo-state assertions: satisfied only when every listed path matches
 * its expected digest. The first mismatch fails the finding and names the
 * path; any unreadable file — including a symlink escape, a non-regular
 * file, or a permission failure — abstains (`undefined`), never a quiet
 * pass and never a verdict over outside bytes. The observed result
 * carries the tree root digest over the sorted length-delimited
 * path:digest entries.
 */
export function verifyFileState(
  input: VerifierInputBase & {
    files: Array<{ path: string; expectedDigest: string }>;
    root?: string;
    fs?: VerifierFs;
  },
): VerifierFinding | undefined {
  if (!Array.isArray(input.files) || input.files.length === 0) throw new Error("verifier files list is empty");
  const root = input.root ?? process.cwd();
  const fs = input.fs;
  const lines: string[] = [];
  for (const file of input.files) {
    requireId(file?.path, "path");
    requireDigest(file?.expectedDigest, "expectedDigest");
    const absolute = resolveVerifierPath(root, file.path);
    let bytes: Buffer;
    try {
      bytes = readAdapterFile(root, file.path, absolute, fs);
    } catch {
      return undefined;
    }
    const observed = sha256Hex(bytes);
    if (observed !== file.expectedDigest) {
      return baseFinding(
        input,
        "file-state",
        "failed",
        file.path,
        `state mismatch for ${file.path}: observed ${observed} expected ${file.expectedDigest}`,
      );
    }
    lines.push(encodeTupleFields([file.path, observed]));
  }
  lines.sort();
  return baseFinding(
    input,
    "file-state",
    "satisfied",
    `${input.files.length} asserted paths`,
    `all ${input.files.length} paths match (tree ${sha256Hex(encodeTupleFields(lines))})`,
  );
}

function treeRootDigest(tree: Record<string, string>): string {
  const lines = Object.entries(tree)
    .map(([path, digest]) => {
      requireId(path, "path");
      requireDigest(digest, "expectedDigest");
      return encodeTupleFields([path, digest]);
    })
    .sort();
  if (lines.length === 0) throw new Error("verifier tree snapshot is empty");
  return sha256Hex(encodeTupleFields(lines));
}

/**
 * Source-tree/candidate-revision binding: satisfied only when the observed
 * snapshot equals the expected snapshot exactly. Pure — both maps are
 * host-supplied, so a test can pin the snapshot while production threads
 * the snapshot the candidate was actually evaluated against.
 */
export function verifyTreeBinding(
  input: VerifierInputBase & {
    expectedTree: Record<string, string>;
    actualTree: Record<string, string>;
  },
): VerifierFinding {
  const expectedRoot = treeRootDigest(input.expectedTree);
  const actualRoot = treeRootDigest(input.actualTree);
  if (expectedRoot !== actualRoot) {
    return baseFinding(
      input,
      "tree-binding",
      "failed",
      `tree ${actualRoot.slice(0, 16)}`,
      `tree snapshot differs: observed root ${actualRoot} expected root ${expectedRoot}`,
    );
  }
  return baseFinding(
    input,
    "tree-binding",
    "satisfied",
    `tree ${actualRoot.slice(0, 16)}`,
    `candidate ${input.candidateDigest.slice(0, 16)} evaluated against tree root ${actualRoot}`,
  );
}

/**
 * Authorized service readback where supported: the host injects the
 * authorized reader. Without a reader — or when the reader abstains — the
 * adapter returns `undefined`, never a fabricated verdict.
 */
export function verifyServiceReadback(
  input: VerifierInputBase & {
    evidenceRef: string;
    read?: () => { ok: boolean; observation: string } | undefined;
  },
): VerifierFinding | undefined {
  requireId(input.evidenceRef, "evidenceRef");
  if (input.read === undefined) return undefined;
  const reply = input.read();
  if (reply === undefined) return undefined;
  if (typeof reply.ok !== "boolean" || typeof reply.observation !== "string" || reply.observation.trim() === "") {
    return undefined;
  }
  return baseFinding(
    input,
    "service-readback",
    reply.ok ? "satisfied" : "failed",
    input.evidenceRef,
    `service observation: ${reply.observation}`,
  );
}

/**
 * Version tag for the canonical finding correlation id below. Bumped when
 * the encoding changes so a v2 id can never equal a v1 id for the same
 * finding by construction (the tag is a hashed field, not a prefix).
 */
export const FINDING_CORRELATION_ID_VERSION = "finding-correlation/v2";

/**
 * Stable correlation id for a finding: criterion, verifier, revisions, and
 * verdict. Retries of the same observation dedupe; a changed verdict or a
 * rotated candidate is a different receipt, never a silent overwrite. The
 * fields hash through the canonical tuple encoding, so distinct findings
 * cannot forge the same id no matter what the free-text fields contain.
 */
export function findingReceiptCorrelationId(finding: VerifierFinding): string {
  return sha256Hex(
    encodeTupleFields([
      FINDING_CORRELATION_ID_VERSION,
      finding.verifierId,
      finding.criterionId,
      finding.missionRevision,
      finding.candidateDigest,
      finding.result,
      finding.observedResult,
      finding.evidenceRef,
    ]),
  );
}

/**
 * Pre-hardening correlation id (naive NUL join). The NUL separator is
 * forgeable when free-text fields contain NUL bytes, so new receipts use
 * the canonical id above — but receipts persisted before the change keep
 * their v1 ids in the ledger, and those rows stay valid. Hosts matching a
 * fresh finding against stored receipts can try both encodings via
 * `findingReceiptCorrelationIdCandidates`.
 */
export function findingReceiptCorrelationIdV1(finding: VerifierFinding): string {
  return sha256Hex(
    [
      finding.verifierId,
      finding.criterionId,
      finding.missionRevision,
      finding.candidateDigest,
      finding.result,
      finding.observedResult,
      finding.evidenceRef,
    ].join("\u0000"),
  );
}

/**
 * Correlation ids under which a finding may appear in durable storage:
 * the canonical v2 id first, then the legacy v1 id when it differs. Lets
 * hosts honor receipts persisted before the encoding change without
 * re-minting them, while all new receipts carry the canonical id.
 */
export function findingReceiptCorrelationIdCandidates(finding: VerifierFinding): string[] {
  const current = findingReceiptCorrelationId(finding);
  const legacy = findingReceiptCorrelationIdV1(finding);
  return legacy === current ? [current] : [current, legacy];
}

/** Map a finding to the counted verdict shape; the receipt id links the durable row. */
export function findingToVerification(
  finding: VerifierFinding,
  receiptCorrelationId: string,
): MissionCriterionVerification {
  requireDigest(receiptCorrelationId, "receiptCorrelationId");
  return {
    criterionId: finding.criterionId,
    verifierId: finding.verifierId,
    missionRevision: finding.missionRevision,
    candidateDigest: finding.candidateDigest,
    result: finding.result,
    receiptCorrelationId,
    verifiedAt: finding.verifiedAt,
    evidenceRef: finding.evidenceRef,
    observedResult: finding.observedResult,
    ...(finding.graphNodes.length === 0 ? {} : { graphNodes: finding.graphNodes.map((node) => ({ ...node })) }),
    adapterVersion: finding.adapterVersion,
  };
}

export type PersistVerifierFindingResult =
  | { status: "appended" | "duplicate"; correlationId: string }
  | { status: "conflict" | "unavailable"; correlationId: string; reason: string };

/**
 * Persist one durable, idempotent verifier receipt. The record carries no
 * `outcome` field on purpose: a verified outcome is never
 * `execution-observed`, and the vocabulary offers no verified-outcome value
 * to stamp instead. Same finding twice is a duplicate; a different verdict
 * under the same correlation id is a conflict, never an overwrite. A final
 * read-back confirms the row survived on disk before reporting success.
 */
export function persistVerifierFinding(
  ledger: EvidenceLedger,
  sessionId: string,
  finding: VerifierFinding,
): PersistVerifierFindingResult {
  requireId(sessionId, "sessionId");
  const correlationId = findingReceiptCorrelationId(finding);
  const record: EvidenceRecord = {
    schema: 1,
    id: "",
    ts: new Date(finding.verifiedAt).toISOString(),
    sessionId,
    decisionId: correlationId.slice(0, 32),
    correlationId,
    event: "CriterionVerification",
    subjectHash: hashSubject(
      encodeTupleFields([finding.criterionId, finding.missionRevision, finding.candidateDigest, finding.result]),
    ),
    policyVersion: `verifier/${finding.verifierId}/${finding.adapterVersion}`,
    deterministicFindings: [
      `criterion_hash=${hashSubject(finding.criterionId)}`,
      `verifier=${finding.verifierId}`,
      `result=${finding.result}`,
      `candidate=${finding.candidateDigest.slice(0, 16)}`,
      `observed=${finding.observedResult}`,
      `evidence_ref=${finding.evidenceRef}`,
    ],
    enforcement: finding.result === "satisfied" ? "criterion_satisfied" : "criterion_failed",
    reasons: [finding.proves],
    latencyMs: 0,
  };
  const appended = ledger.appendDetailed(record, { durable: true, idempotencyKey: correlationId });
  if (!appended.ok) {
    if (appended.error.code === "LEDGER_IDEMPOTENCY_CONFLICT") {
      return { status: "conflict", correlationId, reason: "a different verdict is already recorded under this finding identity" };
    }
    return { status: "unavailable", correlationId, reason: appended.error.message };
  }
  try {
    const read = ledger.read();
    if (read.corrupt !== undefined) return { status: "unavailable", correlationId, reason: "ledger read reported corruption after append" };
    const present = read.records.some(
      (entry) => entry.event === "CriterionVerification" && entry.correlationId === correlationId,
    );
    if (!present) return { status: "unavailable", correlationId, reason: "verifier receipt is not on disk after append" };
  } catch (error) {
    return { status: "unavailable", correlationId, reason: error instanceof Error ? error.message : String(error) };
  }
  return appended.duplicate === true ? { status: "duplicate", correlationId } : { status: "appended", correlationId };
}

/**
 * Durable receipt presence for the allowlist gate: the correlation ids of
 * `CriterionVerification` receipts in a ledger read. Pass the set as
 * `receiptsPresent` so only verdicts with a durably persisted receipt
 * count — a verdict whose receipt was never written (or was pruned) stays
 * `unresolved`, fail closed.
 */
export function verificationReceiptIds(
  records: Array<{ correlationId?: string; event: string }>,
): Set<string> {
  const ids = new Set<string>();
  for (const record of records) {
    if (record?.event === "CriterionVerification" && typeof record.correlationId === "string") {
      ids.add(record.correlationId);
    }
  }
  return ids;
}
