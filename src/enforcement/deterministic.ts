export const PROTECTED_COMMANDS = ["rm -rf /", "mkfs", "dd if="];

/**
 * Normalize a shell command for *matching* (never for execution).
 *
 * Attackers routinely dodge literal substring screens with quoting
 * (`"rm" -rf /`), backslash escapes (`r\m -rf /`), `$IFS` splitting, and
 * `sh -c` wrappers. The normalizer strips those obfuscations and splits the
 * command into segments on shell separators, so each segment can be judged
 * on what it actually asks for. Matching stays conservative by design: this
 * is a tripwire over known-destructive families, not a sandbox — full
 * confinement of arbitrary bash requires OS-level isolation, which the
 * ExecutionPolicy documents as a residual risk.
 */
function normalizeWhole(command: string): string {
  let s = command.toLowerCase();
  s = s.replace(/\\(.)/g, "$1"); // backslash escapes: r\m -> rm
  s = s.replace(/["']/g, ""); // quoting used as obfuscation: "rm" -> rm
  s = s.replace(/\$\{?ifs\}?/g, " "); // $IFS / ${IFS} word splitting
  s = s.replace(/\$'\\?.'/g, " "); // $'\n' style escapes
  s = s.replace(/\$\(([^()]*)\)/g, " $1 "); // $(...) inlined one level
  s = s.replace(/`([^`]*)`/g, " $1 "); // backticks inlined one level
  return s.replace(/\s+/g, " ").trim();
}

function normalizeSegments(command: string): string[] {
  return normalizeWhole(command)
    .split(/;|&&|\|\||\||&|\n/)
    .map((seg) => seg.replace(/^(sudo(\s+-[^\s]+)*|command|exec|env(\s+[a-z_]+=\S+)*|nohup|setsid)\s+/, "").trim())
    .filter((seg) => seg !== "");
}

/** A recursive flag anywhere in the segment plus a root-escaping target. */
function hasRecursiveFlag(segment: string): boolean {
  return /(^|\s)-[a-z]*r[a-z]*(\s|$)/.test(segment);
}

/** `/`, `/*`, `~...`, or anything climbing through `..`. */
function hasRootishTarget(segment: string): boolean {
  return /(^|\s)(\/(\*|\s|$)|~(\s|$|\/)|\S*\.\.\S*)(\s|$)/.test(segment);
}

// Whole-command families: these span shell separators (pipes, `;`, `&`),
// so they are judged before splitting. Each answers "does this command
// destroy data, devices, or the host?" — never "is this on an allowlist?",
// because absence of a match grants nothing.
const DESTRUCTIVE_WHOLE = [
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/, // fork bomb
  /\b(curl|wget)\b[^;]*\|\s*(sudo\s+)?(bash|sh|zsh|dash|fish|python3?|perl|ruby|php)\b/, // pipe-to-shell (interpreters included)
];

// Destructive families, matched per normalized segment.
const DESTRUCTIVE_SEGMENT = [
  /\bmkfs(\s|\.|$)/, // filesystem creation
  /\bdd\b.*\bof\s*=\s*\/dev\//, // block writes to devices
  />\s*\/dev\/(?!null|zero|stdout|stderr|tty)\S+/, // redirection onto devices (not the null/stdio sinks)
  /\bshred\b/, // secure deletion
];

// Pipe-to-shell: fetched remote content executed directly by a shell.
// Kept narrow so ordinary pipelines (e.g. `echo hi | grep hi`) stay open.
const PIPE_TO_SHELL =
  /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(bash|sh|zsh|dash|fish)\b/;

// Promotion, release, and deployment operations. This detects the authority
// required for the operation; the caller decides whether that authority is
// available. Interactive Muse delegates the request to its approval system,
// while graph execution denies promotion because graphs have no release role.
// Matched per normalized segment on the leading tool + verb, so `pushd`
// and commentary mentioning "deploy" do not trip it.
const PROMOTION_SEGMENT = [
  /\bgit\s+push\b/, // publishes commits to a remote
  /\bnpm\s+(publish|dist-tag|deprecate|unpublish)\b/,
  /\b(yarn\s+npm\s+publish|yarn\s+publish|pnpm\s+publish)\b/,
  /\bcargo\s+publish\b/,
  /\btwine\s+upload\b/,
  /\bgem\s+push\b/,
  /\bnuget\s+push\b/,
  /\bhelm\s+(upgrade|install|uninstall|rollback)\b/,
  /\bkubectl\s+(apply|delete|create|replace|scale|rollout|patch|expose)\b/,
  /\bterraform\s+(apply|destroy)\b/,
  /\btofu\s+(apply|destroy)\b/,
  /\bdocker\s+push\b/,
  /\bgh\s+release\s+(create|upload|publish|delete)\b/,
  /\bjfrog\s+(upload|delete|promote)\b/,
  // Self-modification of the plugin host: a graph must never approve or
  // install capabilities for the agent it runs inside.
  /\bmuse\s+plugins?\s+(approve|install)\b/,
  /\bmuse\s+plugins?\s+hook\s+test\b/,
];

export function isPipeToShell(command: string): boolean {
  return PIPE_TO_SHELL.test(command.trim().toLowerCase());
}

function isDestructiveRemoval(segment: string): boolean {
  // `rm` (or recursive chmod/chown) is only destructive in combination: the
  // command names a removal tool, carries a recursive flag, and points it at
  // a root-escaping target. Each condition alone is ordinary shell use.
  const tool = /\brm\b/.test(segment) || /\b(chmod|chown)\b/.test(segment);
  return tool && hasRecursiveFlag(segment) && hasRootishTarget(segment);
}

export function isProtectedCommand(command: string): boolean {
  const whole = normalizeWhole(command);
  if (DESTRUCTIVE_WHOLE.some((pattern) => pattern.test(whole))) return true;
  return normalizeSegments(command).some(
    (seg) => isDestructiveRemoval(seg) || DESTRUCTIVE_SEGMENT.some((pattern) => pattern.test(seg)),
  );
}

/** Detect known promotion/release verbs; a match classifies risk, never grants authority. */
export function isPromotionCommand(command: string): boolean {
  return normalizeSegments(command).some((seg) => PROMOTION_SEGMENT.some((pattern) => pattern.test(seg)));
}

export function inspectToolCall(input: { tool_name?: string; tool_input?: Record<string, unknown> }): {
  /** `none` means no independent deny matched; it is not execution authorization. */
  enforcement: "deny" | "none";
  reason?: string;
  risk: "unclassified" | "destructive" | "external_execution" | "promotion";
  requiredAuthority?: "operator_release_approval";
} {
  const command = (input.tool_input as { command?: unknown } | undefined)?.command;
  if (input.tool_name === "Bash" && typeof command === "string") {
    if (isProtectedCommand(command)) {
      return { enforcement: "deny", risk: "destructive", reason: `Protected command blocked: ${command.slice(0, 200)}` };
    }
    if (isPromotionCommand(command)) {
      return {
        enforcement: "none",
        risk: "promotion",
        requiredAuthority: "operator_release_approval",
      };
    }
    if (isPipeToShell(command)) {
      return { enforcement: "deny", risk: "external_execution", reason: `Pipe-to-shell blocked: ${command.slice(0, 200)}` };
    }
  }
  return { enforcement: "none", risk: "unclassified" };
}

/** Promotion risk remains categorically forbidden inside graph execution. */
export function inspectGraphToolCall(input: { tool_name?: string; tool_input?: Record<string, unknown> }): {
  enforcement: "deny" | "none";
  reason?: string;
  risk: "unclassified" | "destructive" | "external_execution" | "promotion";
  requiredAuthority?: "operator_release_approval";
} {
  const result = inspectToolCall(input);
  if (result.risk !== "promotion" || result.enforcement === "deny") return result;
  const command = (input.tool_input as { command?: unknown } | undefined)?.command;
  return {
    ...result,
    enforcement: "deny",
    reason: `Promotion/release blocked: graphs cannot publish, push, deploy, or approve capabilities: ${typeof command === "string" ? command.slice(0, 200) : ""}`,
  };
}

/**
 * Enforcement boundary: protected vs advisory actions (Phase 3).
 *
 * Classification is deterministic and needs no inference: a tool call is
 * `protected` when it can change state outside the agent's scratch space
 * (destructive, external-execution, or promotion risk on a shell call, or a
 * non-read tool), and `advisory` when it is read-only or effect-free.
 * Screening (`inspectToolCall` returning `none`) detects known-bad shapes;
 * it never grants authority — a screened-but-unauthorized protected call is
 * still refused until the mandatory authorization boundary admits it.
 */
export type ActionClass = "protected" | "advisory";

/** Read-only MCP/host tools whose effect is confined to observation. */
const ADVISORY_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
]);

/** Classify a tool call without inference. Unknown tools are protected. */
export function classifyAction(input: { tool_name?: string; tool_input?: Record<string, unknown> }): ActionClass {
  if (input.tool_name === "Bash") {
    const risk = inspectToolCall(input).risk;
    return risk === "unclassified" ? "advisory" : "protected";
  }
  if (input.tool_name !== undefined && ADVISORY_TOOLS.has(input.tool_name)) return "advisory";
  return "protected";
}

/**
 * Host-supplied authority for a protected action. Only the host constructs
 * this: model-supplied source/session ids and MCP tool names are descriptive
 * metadata, never authority, so they cannot appear here by construction.
 */
export interface HostAuthority {
  /** Authenticated principal (never `unverified:*`, never model-supplied). */
  principal: string;
  /** What the principal explicitly granted (e.g. `operator_release_approval`). */
  grant: string;
}

/**
 * Mandatory authorization boundary for protected actions. Deterministic:
 * enforcement works without inference. A protected action is admitted only
 * when host authority covering the required grant is present; when authority
 * is unavailable the call is refused — never degraded into permission.
 * Advisory actions pass through (they carry no authority either way).
 */
export function authorizeProtectedAction(input: {
  actionClass: ActionClass;
  requiredAuthority?: string | undefined;
  authority?: HostAuthority | undefined;
}): { allowed: boolean; reason: string } {
  if (input.actionClass === "advisory") {
    return { allowed: true, reason: "advisory action carries no state change; no authority required" };
  }
  if (input.authority === undefined) {
    return { allowed: false, reason: "protected action refused: no host authority is available" };
  }
  if (input.authority.principal.trim() === "" || input.authority.principal.startsWith("unverified:")) {
    return { allowed: false, reason: "protected action refused: no verified principal" };
  }
  if (input.requiredAuthority !== undefined && input.authority.grant !== input.requiredAuthority) {
    return {
      allowed: false,
      reason: `protected action refused: grant ${input.authority.grant} does not cover ${input.requiredAuthority}`,
    };
  }
  return { allowed: true, reason: `protected action authorized by ${input.authority.principal}` };
}

/**
 * Degraded low-risk behavior with explicit partial-coverage reporting. When
 * some evidence could not be judged (model unavailable, quota exhausted,
 * Stop error), low-risk advisory behavior may continue — but only with the
 * coverage gap reported: how much was judged, how much exists, and what was
 * left uncovered. Partial coverage never authorizes a protected action.
 */
export interface CoverageReport {
  judged: number;
  total: number;
  uncovered: string[];
}

export function degradedAdvisoryResult(coverage: CoverageReport): {
  enforcement: "none";
  advisoryOnly: true;
  partialCoverage: CoverageReport & { coverage: string };
} {
  const ratio = coverage.total === 0 ? "0/0" : `${coverage.judged}/${coverage.total}`;
  return {
    enforcement: "none",
    advisoryOnly: true,
    partialCoverage: {
      ...coverage,
      coverage: `judged ${ratio}; uncovered: ${coverage.uncovered.length === 0 ? "none" : coverage.uncovered.join(", ")}`,
    },
  };
}
