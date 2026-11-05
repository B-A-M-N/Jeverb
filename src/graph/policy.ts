import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Execution authorization for graph shell nodes.
 *
 * Pattern screening (`inspectToolCall`) is risk *detection*, not authority:
 * a command passes screening because nothing matched, which is not a grant.
 * Authority comes from this policy — an explicitly constructed object that
 * says shell execution is permitted at all, where it runs, how much may run
 * at once, and which privilege classes are never allowed. Every graph runner
 * in this repo must build one and hand it to the authorizer; there is no
 * default-permit path.
 */

export interface ExecutionPolicy {
  /**
   * Master switch. `false` denies every shell node before inspection.
   * Default-deny: both constructors leave this `false` unless the operator
   * explicitly enables shell execution. Host approval of the tool call is
   * necessary but not sufficient — this switch is the separate opt-in.
   */
  allowShell: boolean;
  /**
   * Working directory shell nodes run in. This sets the starting directory
   * only — it is NOT a filesystem boundary. Confinement comes from the
   * sandboxed runner, not from this path.
   */
  workspaceRoot: string;
  /** Max shell nodes in flight at once, graph-wide. */
  maxParallelShells: number;
  /** Per-node wall-clock budget in ms. */
  nodeTimeoutMs: number;
  /** Whole-graph wall-clock budget in ms. */
  graphTimeoutMs: number;
  /** Deny privilege-escalation prefixes (`sudo`, `su`, `doas`) outright. */
  denyPrivileged: boolean;
  /**
   * Allow bounded retries/repeats of shell nodes the author marked
   * `idempotent: true`. Default `false`: a model self-asserting idempotency
   * is not authority to re-execute a state-changing command — only an
   * explicit operator profile enables it. Read-only Jev nodes are unaffected.
   */
  allowShellRetry: boolean;
  /** Allow graph authors to persist complete command output in private artifacts. Default-deny. */
  allowOutputArtifacts: boolean;
  /**
   * Whether sandboxed shell nodes may reach the network. Default `false`:
   * the runner unshares the network namespace unless the operator opts in.
   */
  allowNetwork: boolean;
  /**
   * Execution profile selecting a resource-limit preset. `inspect` is for
   * read-only investigation (tight limits, no writes to the workspace);
   * `implement` for ordinary code-changing work; `networked` for explicitly
   * authorized networked work (still bounded). Profiles never widen what the
   * policy denies: network still requires `allowNetwork`, shell still
   * requires `allowShell`.
   */
  profile: SandboxProfile;
  /**
   * Explicit resource-limit override. When absent the profile preset
   * applies. Only the operator (policy constructor) may set this — never
   * the graph author.
   */
  resourceLimits?: ResourceLimits;
  /**
   * Bind the workspace read-only. Read-only nodes can still use `/tmp`
   * (tmpfs) for scratch. Default `false` (implement profile writes).
   */
  readOnlyWorkspace: boolean;
}

/** Execution profile: which resource-limit preset a shell node runs under. */
export type SandboxProfile = "inspect" | "implement" | "networked";

/** Linux resource controls applied inside the sandbox via hard `ulimit`s. */
export interface ResourceLimits {
  /** Address-space ceiling in MiB (ulimit -v). */
  maxMemoryMb: number;
  /** Max user processes (ulimit -u): bounds fork bombs and fan-out. */
  maxProcesses: number;
  /** Max single-file size in bytes (ulimit -f). */
  maxFileBytes: number;
  /** Max CPU seconds (ulimit -t); wall-clock is bounded separately. */
  maxCpuSeconds: number;
}

const MIB = 1024 * 1024;

/** Preset limits per profile. `networked` matches `implement`: network
 * access is authorized by `allowNetwork`, not by looser resources. */
export const SANDBOX_PROFILES: Record<SandboxProfile, ResourceLimits> = {
  inspect: { maxMemoryMb: 256, maxProcesses: 16, maxFileBytes: 10 * MIB, maxCpuSeconds: 30 },
  implement: { maxMemoryMb: 512, maxProcesses: 64, maxFileBytes: 100 * MIB, maxCpuSeconds: 120 },
  networked: { maxMemoryMb: 512, maxProcesses: 64, maxFileBytes: 100 * MIB, maxCpuSeconds: 120 },
};

/** Resolve the effective limits: explicit operator override, else the profile preset. */
export function limitsFor(policy: { profile: SandboxProfile; resourceLimits?: ResourceLimits }): ResourceLimits {
  return policy.resourceLimits ?? SANDBOX_PROFILES[policy.profile];
}

export const DEFAULT_NODE_TIMEOUT_MS = 30_000;
export const DEFAULT_GRAPH_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_PARALLEL_SHELLS = 4;

export function defaultExecutionPolicy(
  workspaceRoot: string,
  overrides: Partial<ExecutionPolicy> = {},
): ExecutionPolicy {
  return {
    // Default-deny. Callers that need shell execution — production server
    // wiring, explicitly opted-in tests — say so with `allowShell: true`.
    allowShell: false,
    workspaceRoot,
    maxParallelShells: DEFAULT_MAX_PARALLEL_SHELLS,
    nodeTimeoutMs: DEFAULT_NODE_TIMEOUT_MS,
    graphTimeoutMs: DEFAULT_GRAPH_TIMEOUT_MS,
    denyPrivileged: true,
    // Default no network. Sandboxed nodes get an unshared network namespace
    // unless the operator opts in.
    allowNetwork: false,
    allowShellRetry: false,
    allowOutputArtifacts: false,
    profile: "implement",
    readOnlyWorkspace: false,
    ...overrides,
  };
}

function readNumber(env: Record<string, string | undefined>, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(Math.floor(n), max));
}

interface GraphDataDirSettings {
  graph_shell?: "allow" | "deny";
  graph_retry?: "allow" | "deny";
  graph_capture_output?: boolean;
  graph_network?: "allow" | "deny";
  graph_profile?: SandboxProfile;
  graph_readonly?: boolean;
  graph_max_parallel?: number;
  graph_node_timeout_ms?: number;
  graph_timeout_ms?: number;
}

/**
 * Muse clears custom variables before starting plugin MCP servers, so shell
 * authority can also be configured by the operator in the private plugin
 * data-dir `config.json`. Any unsafe, malformed, or foreign-owned file is
 * ignored; the shell master switch therefore remains default-deny.
 */
function readGraphDataDirSettings(dataDir: string | undefined): GraphDataDirSettings {
  if (dataDir === undefined || dataDir.trim() === "") return {};
  const path = join(dataDir, "config.json");
  try {
    const parent = lstatSync(dataDir);
    const file = lstatSync(path);
    if (
      !parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o022) !== 0 ||
      !file.isFile() || file.isSymbolicLink() || (file.mode & 0o022) !== 0 || file.size > 64 * 1024 ||
      (typeof process.getuid === "function" && (parent.uid !== process.getuid() || file.uid !== process.getuid()))
    ) return {};
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const raw = parsed as Record<string, unknown>;
    const result: GraphDataDirSettings = {};
    for (const key of ["graph_shell", "graph_retry", "graph_network"] as const) {
      const value = raw[key];
      if (value === "allow" || value === "deny") result[key] = value;
    }
    if (raw.graph_profile === "inspect" || raw.graph_profile === "implement" || raw.graph_profile === "networked") {
      result.graph_profile = raw.graph_profile;
    }
    if (typeof raw.graph_readonly === "boolean") result.graph_readonly = raw.graph_readonly;
    if (typeof raw.graph_capture_output === "boolean") result.graph_capture_output = raw.graph_capture_output;
    if (typeof raw.graph_max_parallel === "number" && Number.isFinite(raw.graph_max_parallel)) result.graph_max_parallel = raw.graph_max_parallel;
    if (typeof raw.graph_node_timeout_ms === "number" && Number.isFinite(raw.graph_node_timeout_ms)) result.graph_node_timeout_ms = raw.graph_node_timeout_ms;
    if (typeof raw.graph_timeout_ms === "number" && Number.isFinite(raw.graph_timeout_ms)) result.graph_timeout_ms = raw.graph_timeout_ms;
    return result;
  } catch {
    return {};
  }
}

function resolveSetting(
  env: Record<string, string | undefined>,
  envKey: string,
  fileValue: string | undefined,
): string | undefined {
  const envValue = env[envKey];
  return envValue !== undefined && envValue.trim() !== "" ? envValue.trim().toLowerCase() : fileValue;
}

/**
 * Resolve policy from explicit environment overrides and the operator-owned
 * plugin data-dir config. Shell execution is default-deny; both routes require
 * an explicit allow. Host approval of the tool call is still required; this
 * policy is the second, in-process boundary, not a replacement for it.
 */
export function resolveExecutionPolicy(
  env: Record<string, string | undefined>,
  workspaceRoot: string,
  dataDir?: string,
): ExecutionPolicy {
  const file = readGraphDataDirSettings(dataDir);
  const profileValue = resolveSetting(env, "JEV_GRAPH_PROFILE", file.graph_profile);
  return {
    allowShell: resolveSetting(env, "JEV_GRAPH_SHELL", file.graph_shell) === "allow",
    workspaceRoot,
    maxParallelShells: readNumber(env, "JEV_GRAPH_MAX_PARALLEL", file.graph_max_parallel ?? DEFAULT_MAX_PARALLEL_SHELLS, 1, 16),
    nodeTimeoutMs: readNumber(env, "JEV_GRAPH_NODE_TIMEOUT_MS", file.graph_node_timeout_ms ?? DEFAULT_NODE_TIMEOUT_MS, 1_000, 300_000),
    graphTimeoutMs: readNumber(env, "JEV_GRAPH_TIMEOUT_MS", file.graph_timeout_ms ?? DEFAULT_GRAPH_TIMEOUT_MS, 5_000, 600_000),
    denyPrivileged: true,
    allowNetwork: resolveSetting(env, "JEV_GRAPH_NETWORK", file.graph_network) === "allow",
    allowShellRetry: resolveSetting(env, "JEV_GRAPH_RETRY", file.graph_retry) === "allow",
    allowOutputArtifacts: resolveSetting(env, "JEV_GRAPH_CAPTURE_OUTPUT", file.graph_capture_output === true ? "allow" : undefined) === "allow",
    profile: profileValue === "inspect"
      ? "inspect"
      : profileValue === "networked"
        ? "networked"
        : "implement",
    readOnlyWorkspace: resolveSetting(env, "JEV_GRAPH_READONLY", file.graph_readonly === true ? "allow" : undefined) === "allow",
  };
}

/**
 * Privilege escalation has no legitimate graph use; denied before screening.
 *
 * Basename-aware: the invoked binary's basename is matched, not a path
 * prefix, so absolute paths (`/usr/bin/sudo ...`) cannot dodge the gate.
 * Each shell segment's leading binary is judged after stripping common
 * launcher wrappers (`env VAR=..`, `command`, `exec`, `nohup`, `setsid`).
 * Covered binaries (all verified privilege wrappers on Linux):
 * `sudo` (run as another user, usually root), `su` (switch user),
 * `doas` (OpenBSD/Linux run-as), `runas` (Windows run-as),
 * `pkexec` (polkit: execute a command as another user),
 * `setpriv` (util-linux: run a program with different Linux privilege
 * settings — uid/gid/caps), `sg` (execute a command as a different group
 * ID), `capsh` (capability shell wrapper — can raise capabilities/uid).
 * Matching is exact-basename equality, so lookalikes (`sgx-tool`,
 * `capsh-tool`, `super`) never trip it.
 */
const PRIVILEGED_BINARIES = new Set([
  "sudo",
  "su",
  "doas",
  "runas",
  "pkexec",
  "setpriv",
  "sg",
  "capsh",
]);

/** Launcher wrappers that never confer privilege but may precede the real binary. */
const WRAPPER_PREFIX = /^(command|exec|nohup|setsid|nice|env(\s+[a-z_0-9]+=\S+)*)\s+/;

function leadingBinaryBasename(segment: string): string {
  let rest = segment.trim().toLowerCase();
  let stripped = rest.replace(WRAPPER_PREFIX, "");
  while (stripped !== rest) {
    rest = stripped;
    stripped = rest.replace(WRAPPER_PREFIX, "");
  }
  const token = rest.split(/\s+/, 1)[0] ?? "";
  const unquoted = token.replace(/^['"]+|['"]+$/g, "");
  const base = unquoted.split("/").pop() ?? "";
  return base.replace(/^['"]+|['"]+$/g, "");
}

export function isPrivilegedCommand(command: string): boolean {
  const segments = command
    .trim()
    .toLowerCase()
    .split(/;|&&|\|\||\||&|`|\$\(|\(|\)|\n|\r/);
  return segments.some((segment) => PRIVILEGED_BINARIES.has(leadingBinaryBasename(segment)));
}
