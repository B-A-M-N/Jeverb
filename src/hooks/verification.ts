/**
 * The verification ledger: what the stop check knows that Jev cannot see.
 *
 * Jev reads the final message and nothing else, so it can tell you that a
 * message *claims* the tests pass. Whether they do is a fact about the session,
 * and facts about the session are bookkeeping — counted in code, compared in
 * code, and never asked of a classifier.
 *
 * Two numbers are all it takes for the legacy rule: whether the last check
 * passed, and how many edits have happened since one ran. A message that says
 * "all tests pass" after a failing `npm test` with no passing run since is the
 * one case where a stop hook has evidence rather than an opinion.
 *
 * The legacy rule consults only the single most recent check, so a failed
 * `test` followed by a passing `lint` reads as corroboration for a "tests
 * pass" claim. The claim-aware rule below keeps the latest record per kind
 * (`byKind`), per-kind staleness, and uncertainty from mutating ops whose
 * outcome was never demonstrated — a passing lint never satisfies a test
 * claim.
 *
 * Everything here is pure except where it is handed a `Store`. No clock, no
 * model, no network.
 */

import { redactAndClamp } from "./redact.js";
import { prefilterBash, readBashMarker, scanBash } from "./prefilter.js";
import type { HookInput } from "./types.js";

/** Longest command text kept in the ledger, redacted first. */
export const MAX_LEDGER_COMMAND_CHARS = 200;

export const VERIFICATION_KINDS = ["test", "build", "typecheck", "lint"] as const;
export type VerificationKind = (typeof VERIFICATION_KINDS)[number];

/**
 * npm-style script names, mapped to what running them establishes.
 *
 * `check`, `verify`, `validate` and `ci` are read as `test`: in practice they
 * run the whole suite, and `test` is the strongest of the four claims, so
 * reading them as anything weaker would let "all tests pass" off the hook.
 */
const SCRIPT_KINDS: [RegExp, VerificationKind][] = [
  [/^(type-?checks?|types|tsc)\b/, "typecheck"],
  [/^(lint|lints|eslint|format:check|fmt:check|style|stylelint)\b/, "lint"],
  [/^(build|compile|bundle|dist|prepack)\b/, "build"],
  [/^(tests?|unit|e2e|spec|specs|coverage|smoke|check|checks|verify|validate|ci|audit)\b/, "test"],
];

function fromScriptName(name: string | undefined): VerificationKind | undefined {
  if (name === undefined) return undefined;
  // `test:unit`, `lint-staged`, `type-check:ci` all key off the first word.
  const normalized = name.toLowerCase().replace(/^run:/, "");
  for (const [pattern, kind] of SCRIPT_KINDS) {
    if (pattern.test(normalized)) return kind;
  }
  return undefined;
}

/** Test runners invoked directly. */
const DIRECT: Record<string, VerificationKind> = {
  vitest: "test",
  jest: "test",
  mocha: "test",
  ava: "test",
  tap: "test",
  pytest: "test",
  phpunit: "test",
  rspec: "test",
  ctest: "test",
  tsc: "typecheck",
  mypy: "typecheck",
  pyright: "typecheck",
  flow: "typecheck",
  eslint: "lint",
  biome: "lint",
  rubocop: "lint",
  flake8: "lint",
  pylint: "lint",
  stylelint: "lint",
  shellcheck: "lint",
  "golangci-lint": "lint",
  tflint: "lint",
  prettier: "lint",
  ruff: "lint",
};

/** Package-manager style front ends whose first word is a subcommand. */
const RUNNERS = new Set(["npm", "pnpm", "yarn", "bun", "npx", "pnpx", "deno", "bunx"]);

function firstWord(args: string[]): string | undefined {
  return args.find((arg) => !arg.startsWith("-"));
}

/** Classify one pipeline segment. */
function classifySegment(command: string, args: string[]): VerificationKind | undefined {
  if (RUNNERS.has(command)) {
    const sub = firstWord(args);
    if (sub === undefined) return undefined;
    if (sub === "run" || sub === "run-script") {
      const rest = args.slice(args.indexOf(sub) + 1);
      return fromScriptName(firstWord(rest));
    }
    if (sub === "exec" || sub === "x" || sub === "dlx") {
      const rest = args.slice(args.indexOf(sub) + 1);
      const inner = firstWord(rest);
      return inner === undefined ? undefined : classifySegment(inner.toLowerCase(), rest.slice(rest.indexOf(inner) + 1));
    }
    // `npm test`, `yarn lint`, `bun test`, `deno check`.
    return DIRECT[sub] ?? fromScriptName(sub);
  }

  if (command === "cargo") {
    const sub = firstWord(args);
    if (sub === "test" || sub === "nextest") return "test";
    if (sub === "check") return "typecheck";
    if (sub === "build" || sub === "b") return "build";
    if (sub === "clippy") return "lint";
    if (sub === "fmt" && args.includes("--check")) return "lint";
    return undefined;
  }

  if (command === "go") {
    const sub = firstWord(args);
    if (sub === "test") return "test";
    if (sub === "build" || sub === "install") return "build";
    if (sub === "vet") return "lint";
    return undefined;
  }

  if (command === "make" || command === "gmake" || command === "just") {
    // A bare `make` builds; a named target says what it is.
    const target = firstWord(args);
    return target === undefined ? "build" : (fromScriptName(target) ?? "build");
  }

  if (command === "mvn" || command === "gradle" || command === "gradlew" || command === "./gradlew") {
    const target = firstWord(args);
    if (target === undefined) return undefined;
    if (/^(test|check|verify)/.test(target)) return "test";
    if (/^(build|package|assemble|compile)/.test(target)) return "build";
    return undefined;
  }

  if (command === "dotnet") {
    const sub = firstWord(args);
    if (sub === "test") return "test";
    if (sub === "build") return "build";
    return undefined;
  }

  if (command === "python" || command === "python3") {
    // `python -m pytest`, `python -m mypy`.
    if (args[0] === "-m") return DIRECT[(args[1] ?? "").toLowerCase()];
    return undefined;
  }

  const direct = DIRECT[command];
  if (direct === undefined) return undefined;
  // `ruff check` lints; `ruff format` does not verify anything.
  if (command === "ruff") return firstWord(args) === "check" ? "lint" : undefined;
  if (command === "prettier") {
    return args.some((arg) => ["--check", "-c", "-l", "--list-different"].includes(arg)) ? "lint" : undefined;
  }
  if (command === "biome") return firstWord(args) === "check" || firstWord(args) === "lint" ? "lint" : undefined;
  return direct;
}

/**
 * What running `command` would establish, or `undefined` for a command that
 * verifies nothing.
 *
 * A compound command counts if any segment matches: `npm run build && npm test`
 * is a test run, and the strongest claim in the chain is the one recorded.
 */
export function verificationKind(command: string): VerificationKind | undefined {
  const scan = scanBash(command);
  // Order of precedence when a chain does several things at once.
  const ranking: VerificationKind[] = ["test", "typecheck", "build", "lint"];
  let best: VerificationKind | undefined;
  for (const segment of scan.segments) {
    let index = 0;
    while (index < segment.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[index] as string)) index += 1;
    const raw = (segment[index] ?? "").split("/").pop() ?? "";
    const kind = classifySegment(raw.toLowerCase(), segment.slice(index + 1));
    if (kind === undefined) continue;
    if (best === undefined || ranking.indexOf(kind) < ranking.indexOf(best)) best = kind;
  }
  return best;
}

// ------------------------------------------------------------------ the outcome

/** `Exit code N` is the documented first line of a failed Bash `error`. */
const EXIT_CODE_LINE = /^\s*Exit code\s+(\d+)/i;

/**
 * Did this Bash tool call fail?
 *
 * `true` failed, `false` succeeded, `undefined` unknowable — which includes an
 * interrupt, because a cancelled test run is not evidence that anything is
 * broken.
 *
 * Claude Code documents a non-zero Bash exit as `PostToolUseFailure`, carrying
 * a top-level `error` string whose first line is `Exit code N`, plus an
 * optional `is_interrupt`. A successful `PostToolUse` carries a `tool_response`
 * of `{stdout, stderr, interrupted, isImage}` with no exit code at all. Both
 * are handled, and so are the structured fields the docs do not promise
 * (`exit_code`, `isError`, `success`), because a hook that reads one undocumented
 * field defensively costs nothing and a hook that trusts one shape breaks.
 *
 * `stdout` is deliberately never scanned for `Exit code N`: a test suite that
 * prints that string is not a failed command.
 */
export function bashFailed(input: HookInput): boolean | undefined {
  if (input.is_interrupt === true) return undefined;

  const response = (typeof input.tool_response === "object" && input.tool_response !== null
    ? (input.tool_response as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  if (response.interrupted === true) return undefined;

  const exit = response.exit_code ?? response.exitCode;
  if (typeof exit === "number") return exit !== 0;
  if (response.isError === true || response.is_error === true) return true;
  if (response.success === false) return true;

  const errorText = typeof input.error === "string" ? input.error : typeof response.error === "string" ? response.error : undefined;
  if (errorText !== undefined && errorText !== "") {
    const match = EXIT_CODE_LINE.exec(errorText);
    if (match !== null) return Number(match[1]) !== 0;
    // A failure message with no exit-code line: Claude Code could not even
    // start the shell. That is not the command reporting a verdict.
    return input.hook_event_name === "PostToolUseFailure" ? undefined : true;
  }

  if (input.hook_event_name === "PostToolUseFailure") return true;
  if (response.isError === false || response.success === true) return false;
  // A PostToolUse that delivered a result is the documented success path: the
  // harness reports a tool failure as PostToolUseFailure, so a delivered
  // response means the tool ran without reporting one. But a missing, null,
  // or empty response demonstrates nothing — recording ok:true on silence
  // would mint corroboration the command never earned. Fail closed: unknown.
  if (typeof input.tool_response === "object" && input.tool_response !== null && Object.keys(response).length > 0) {
    return false;
  }
  return undefined;
}

export interface VerificationRecord {
  kind: VerificationKind;
  ok: boolean;
  /** Epoch ms. */
  ts: number;
  /** Redacted, clamped. */
  command: string;
  /** Workspace the check ran in, when the post-tool event carried one. */
  cwd?: string;
}

export interface VerificationLedger {
  last?: VerificationRecord;
  /** Edits since a verification command last ran. */
  edits_since: number;
  /**
   * Per-kind latest outcome. `last` is the most recent check of any kind;
   * `byKind` preserves the latest test/build/lint/typecheck result so a
   * passing test is not forgotten when a build runs afterwards.
   */
  byKind?: Partial<Record<VerificationKind, VerificationRecord>>;
  /** Edits since the last passing/failing run of each kind. */
  editsSinceByKind?: Partial<Record<VerificationKind, number>>;
  /**
   * Potentially-mutating ops with an undemonstrated outcome (failed,
   * cancelled, or unknowable) since a verification command last ran.
   */
  uncertain_since?: number;
}

export const EMPTY_LEDGER: VerificationLedger = { edits_since: 0 };

/** Tools whose success is an edit. */
const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "Update"]);

export interface LedgerEvent {
  /** A verification command that ran to a verdict. */
  verification?: VerificationRecord | undefined;
  /** This call edited a file in the project. */
  edited: boolean;
  /**
   * This call may have mutated the project but its outcome was never
   * demonstrated (failed, cancelled, or unknowable). Invalidates staleness
   * without asserting an edit happened.
   */
  uncertain?: boolean;
}

/**
 * Read one post-tool event as a ledger event. Pure.
 *
 * `cwd` is needed only to tell an in-project Bash write from any other one,
 * using the same prefilter the permission gate uses — so "a `sed -i` counts as
 * an edit" is true in exactly the cases where the gate stayed silent about it.
 */
export function ledgerEvent(input: HookInput, now: number): LedgerEvent {
  const toolName = input.tool_name ?? "";
  const failed = bashFailed(input);

  if (toolName === "Bash" || toolName === "PowerShell") {
    const raw = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
    if (raw.trim() === "") return { edited: false };
    // The same stripping the gate did, for the same reason: `npm test
    // # jev:intended …` is a test run, and the marker's words are not arguments.
    const command = readBashMarker(raw).command;
    if (command.trim() === "") return { edited: false };

    const kind = verificationKind(command);
    if (kind !== undefined) {
      // A check with no demonstrated outcome is evidence of nothing either
      // way: not a verification (D7), and not a mutation either — check
      // commands are not mutating ops, so an interrupted `npm test` stays a
      // clean no-edit rather than tainting staleness.
      if (failed === undefined) return { edited: false };
      const record: VerificationRecord = {
        kind,
        ok: !failed,
        ts: now,
        command: redactAndClamp(command, MAX_LEDGER_COMMAND_CHARS),
      };
      const checkCwd = input.cwd;
      if (checkCwd !== undefined && checkCwd !== "") record.cwd = checkCwd;
      return { verification: record, edited: false };
    }

    // Not a check. Did it edit the project? The prefilter already knows.
    if (failed === false) {
      const cwd = input.cwd;
      if (cwd === undefined || cwd === "") return { edited: false };
      const verdict = prefilterBash(command, { cwd, strict: false });
      // An `escalate` verdict never reports a write: it is a command the gate
      // stopped, not an edit that happened.
      return { edited: verdict.kind !== "escalate" && verdict.writesInProject === true };
    }
    // Failed, cancelled, or unknowable: no confirmed edit — but a command
    // that may write to the project may have written before it failed. Taint
    // staleness unless the prefilter demonstrates nonmutation (a verdict that
    // positively reports no in-project write).
    return uncertainBashEvent(command, input.cwd);
  }

  if (EDIT_TOOLS.has(toolName)) {
    if (failed === false) return { edited: true };
    // A mutating tool with an undemonstrated outcome: no confirmed edit, but
    // prior verification is stale until a check runs again.
    return { edited: false, uncertain: true };
  }
  return { edited: false };
}

/**
 * A Bash command that is not a check and ran to no demonstrated outcome.
 * Clean only when nonmutation is demonstrated; uncertain otherwise.
 */
function uncertainBashEvent(command: string, cwd: string | undefined): LedgerEvent {
  if (cwd === undefined || cwd === "") return { edited: false, uncertain: true };
  let verdict: ReturnType<typeof prefilterBash>;
  try {
    verdict = prefilterBash(command, { cwd, strict: false });
  } catch {
    return { edited: false, uncertain: true };
  }
  if (verdict.kind !== "escalate" && verdict.writesInProject === false) return { edited: false };
  return { edited: false, uncertain: true };
}

/** Fold a ledger event into the ledger. Pure. */
export function applyLedgerEvent(ledger: VerificationLedger, event: LedgerEvent): VerificationLedger {
  if (event.verification !== undefined) {
    // A check ran, so "edits since a check ran" is zero again — whether it
    // passed or failed. What it established is in `last.ok`.
    // Preserve per-kind outcomes: other kinds keep their own staleness.
    // A fresh check run postdates every uncertain op so far, resolving them.
    const byKind: Partial<Record<VerificationKind, VerificationRecord>> = { ...(ledger.byKind ?? {}) };
    byKind[event.verification.kind] = event.verification;
    const editsSinceByKind: Partial<Record<VerificationKind, number>> = { ...(ledger.editsSinceByKind ?? {}) };
    for (const kind of Object.keys(byKind) as VerificationKind[]) {
      if (kind === event.verification.kind) editsSinceByKind[kind] = 0;
      else if (editsSinceByKind[kind] === undefined) {
        const prior = ledger.byKind?.[kind];
        editsSinceByKind[kind] = prior !== undefined ? ledger.edits_since : 0;
      }
    }
    return { last: event.verification, edits_since: 0, byKind, editsSinceByKind, uncertain_since: 0 };
  }
  if (!event.edited && event.uncertain !== true) return ledger;
  const next: VerificationLedger = {
    edits_since: ledger.edits_since + (event.edited ? 1 : 0),
    uncertain_since: (ledger.uncertain_since ?? 0) + (event.uncertain === true ? 1 : 0),
  };
  if (ledger.last !== undefined) next.last = ledger.last;
  if (ledger.byKind !== undefined) {
    next.byKind = { ...ledger.byKind };
    if (event.edited) {
      const nextCounts: Partial<Record<VerificationKind, number>> = {};
      for (const kind of Object.keys(next.byKind) as VerificationKind[]) {
        nextCounts[kind] = (ledger.editsSinceByKind?.[kind] ?? ledger.edits_since) + 1;
      }
      next.editsSinceByKind = nextCounts;
    } else if (ledger.editsSinceByKind !== undefined) {
      next.editsSinceByKind = { ...ledger.editsSinceByKind };
    }
  } else if (ledger.editsSinceByKind !== undefined) {
    next.editsSinceByKind = { ...ledger.editsSinceByKind };
  }
  return next;
}

/**
 * Latest outcome for one check kind with its own staleness count. Falls back
 * to `last` for ledgers written before per-kind tracking existed.
 */
export function currentCheck(
  ledger: VerificationLedger | undefined,
  kind: VerificationKind,
): { record: VerificationRecord; editsSince: number } | undefined {
  if (ledger === undefined) return undefined;
  const perKind = ledger.byKind?.[kind];
  if (perKind !== undefined) {
    return {
      record: perKind,
      editsSince: ledger.editsSinceByKind?.[kind] ?? ledger.edits_since,
    };
  }
  if (ledger.last?.kind === kind) return { record: ledger.last, editsSince: ledger.edits_since };
  return undefined;
}

// ----------------------------------------------- which kind a claim requires

/** Pass-language: the message says something already passed or succeeded. */
const PASS_WORD = /\bpass(?:es|ed|ing)?\b|\bsucceed(?:s|ed|ing)?\b|\bsuccessful(?:ly)?\b|\bgreen\b|\bclean\b|\bno (?:new |remaining )?(?:errors?|failures?|warnings?|issues?)\b/i;

/** Kind-language per verification kind. */
const KIND_WORDS: [VerificationKind, RegExp][] = [
  ["test", /\btests?\b|\btesting\b|\btest suites?\b|\bspecs?\b|\bunit tests?\b|\be2e\b|\bpytest\b|\bvitest\b|\bjest\b|\bcoverage\b|\bsmoke tests?\b/i],
  ["build", /\bbuilds?\b|\bcompil(?:e[sd]?|ing|ation)\b|\bbundle[sd]?\b|\bdist\b/i],
  ["typecheck", /\btype-?checks?\b|\btyping\b|\btsc\b|\bmypy\b|\bpyright\b/i],
  ["lint", /\blint(?:s|ed|ing|er)?\b|\beslint\b|\bruff\b|\bclippy\b|\bvet\b|\bprettier\b|\bstylelint\b/i],
];

/** Generic "everything passes" language claims every kind at once. */
const ALL_PASS =
  /\b(?:all|everything|every|full|entire)\b[^.?!]{0,40}\bpass(?:es|ed|ing)?\b|\bchecks?\b[^.?!]{0,20}\bpass(?:es|ed|ing)?\b|\bci\b[^.?!]{0,20}\b(?:pass(?:es|ed|ing)?|green|successful)\b|\b(?:all|everything|every|full|entire)\b[^.?!]{0,40}\b(?:green|succeed(?:s|ed|ing)?|successful|clean)\b/i;

/**
 * Which verification kinds a final message claims have passed. Deterministic
 * and purely textual: kind-language plus pass-language in the message. A
 * generic "all checks pass" claims every kind; a message with no
 * pass-language — or pass-language with no kind in it — claims no
 * identifiable kind, and the caller falls back to the legacy scalar rule.
 */
export function verificationKindsClaimed(message: string): VerificationKind[] {
  if (!PASS_WORD.test(message)) return [];
  // A named kind wins over a generic quantifier: "all tests pass" is a test
  // claim, not a claim about every kind. Only kindless pass-language ("all
  // checks pass", "everything is green") claims all four.
  const out: VerificationKind[] = [];
  for (const [kind, pattern] of KIND_WORDS) {
    if (pattern.test(message)) out.push(kind);
  }
  if (out.length > 0) return out;
  if (ALL_PASS.test(message)) return ["test", "build", "typecheck", "lint"];
  return [];
}

/** Workspace comparison tolerant of trailing slashes, nothing more. */
function sameWorkspace(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

// ------------------------------------------------------------------ the policy

export interface VerificationPolicyResult {
  block: boolean;
  /** Set when the claim could not be corroborated either way: log, do not act. */
  logOnly: boolean;
  reason?: string;
  reasons: string[];
}

/**
 * Should a final message that claims the checks pass be challenged?
 *
 * Block only on evidence: the message says checks pass, a check is on record,
 * and that check failed. Everything else is calibration data. In particular,
 * "you claimed the tests pass and I have no record of you running them" is NOT
 * a block — the async hook can lose its race with Stop, a check may have run
 * before the plugin was installed, and accusing Claude of lying on the strength
 * of missing bookkeeping is exactly the kind of false positive that gets a stop
 * hook turned off.
 *
 * `claimed` names which verification kinds the message claims passed (see
 * `verificationKindsClaimed`). When it names at least one kind, each claimed
 * kind is judged on its own latest record: a passing lint never satisfies a
 * test claim, a later failure of the claimed kind invalidates an earlier pass,
 * and edits after that kind's run make it stale. An empty or omitted `claimed`
 * keeps the legacy scalar rule over the single most recent check. `scope.cwd`
 * is the workspace the claim is evaluated in; a passing record from a
 * different workspace cannot corroborate (logged, never a block).
 */
export function verificationPolicy(
  claimsVerified: number,
  ledger: VerificationLedger,
  auto: number,
  now: number,
  claimed?: readonly VerificationKind[],
  scope?: { cwd?: string | undefined },
): VerificationPolicyResult {
  const claims = claimsVerified >= auto;
  if (!claims) return { block: false, logOnly: false, reasons: [] };

  if (claimed !== undefined && claimed.length > 0) {
    return claimAwarePolicy(claimsVerified, ledger, now, claimed, scope?.cwd);
  }

  const last = ledger.last;
  if (last !== undefined && !last.ok) {
    const minutes = Math.max(0, Math.round((now - last.ts) / 60_000));
    const ago = minutes === 0 ? "less than a minute ago" : `${minutes} min ago`;
    return {
      block: true,
      logOnly: false,
      reason:
        `[jev] Your final message says checks pass (p=${claimsVerified.toFixed(2)}), but the last ${last.kind} ` +
        `command (\`${last.command}\`) failed ${ago} and nothing has passed since. Re-run it, or correct the claim.`,
      reasons: [
        `the final message claims checks pass (p=${claimsVerified.toFixed(2)})`,
        `the last ${last.kind} command failed ${ago}`,
      ],
    };
  }

  if (last === undefined) {
    return {
      block: false,
      logOnly: true,
      reasons: [`claims checks pass (p=${claimsVerified.toFixed(2)}) with no verification command on record`],
    };
  }

  if (ledger.edits_since > 0) {
    return {
      block: false,
      logOnly: true,
      reasons: [
        `claims checks pass (p=${claimsVerified.toFixed(2)}) but ${ledger.edits_since} edit${
          ledger.edits_since === 1 ? "" : "s"
        } happened after the last ${last.kind} run`,
      ],
    };
  }

  return { block: false, logOnly: false, reasons: [] };
}

/**
 * The claim-aware rule: one verdict per claimed kind, each on that kind's
 * own latest record.
 *
 * - The kind's latest record failed → block (a later pass of the same kind
 *   would have replaced it, so a failure here means no passing run since).
 * - The kind never ran, ran stale (edits landed after it), ran in another
 *   workspace, or an uncertain op landed since any run → logOnly.
 * - Otherwise the kind is corroborated: silence.
 *
 * Ledgers written before per-kind history existed carry only `last`, which
 * stands in for its kind. The ledger is session-scoped by construction (it
 * is the session's own `verification` fold), so records never corroborate
 * across sessions.
 */
function claimAwarePolicy(
  claimsVerified: number,
  ledger: VerificationLedger,
  now: number,
  claimed: readonly VerificationKind[],
  scopeCwd: string | undefined,
): VerificationPolicyResult {
  const p = claimsVerified.toFixed(2);
  const failures: { kind: VerificationKind; record: VerificationRecord }[] = [];
  const notes: string[] = [];

  // No verification command on record at all: per-kind breakdown adds
  // nothing, so keep the legacy calibration note verbatim.
  if (ledger.last === undefined && (ledger.byKind === undefined || Object.keys(ledger.byKind).length === 0)) {
    return {
      block: false,
      logOnly: true,
      reasons: [`claims checks pass (p=${p}) with no verification command on record`],
    };
  }

  for (const kind of claimed) {
    const record = ledger.byKind?.[kind] ?? (ledger.last?.kind === kind ? ledger.last : undefined);
    if (record === undefined) {
      notes.push(`claims ${kind} passes (p=${p}) with no ${kind} run on record`);
      continue;
    }
    if (!record.ok) {
      failures.push({ kind, record });
      continue;
    }
    if (
      scopeCwd !== undefined &&
      scopeCwd !== "" &&
      record.cwd !== undefined &&
      record.cwd !== "" &&
      !sameWorkspace(record.cwd, scopeCwd)
    ) {
      notes.push(`claims ${kind} passes (p=${p}) but the last ${kind} run was in another workspace`);
      continue;
    }
    const staleEdits = ledger.editsSinceByKind?.[kind] ?? ledger.edits_since;
    if (staleEdits > 0) {
      notes.push(
        `claims ${kind} passes (p=${p}) but ${staleEdits} edit${staleEdits === 1 ? "" : "s"} happened after the last ${kind} run`,
      );
    }
  }

  if (failures.length > 0) {
    const latest = failures.reduce((a, b) => (b.record.ts > a.record.ts ? b : a));
    const minutes = Math.max(0, Math.round((now - latest.record.ts) / 60_000));
    const ago = minutes === 0 ? "less than a minute ago" : `${minutes} min ago`;
    return {
      block: true,
      logOnly: false,
      reason:
        `[jev] Your final message says checks pass (p=${p}), but the last ${latest.kind} ` +
        `command (\`${latest.record.command}\`) failed ${ago} and no passing ${latest.kind} run has happened since. ` +
        `Re-run it, or correct the claim.`,
      reasons: [
        `the final message claims checks pass (p=${p})`,
        `the last ${latest.kind} command failed ${ago}`,
      ],
    };
  }

  const uncertain = ledger.uncertain_since ?? 0;
  if (uncertain > 0) {
    notes.push(
      `claims checks pass (p=${p}) but ${uncertain} uncertain operation${uncertain === 1 ? "" : "s"} ` +
        `may have changed files after the last verification run`,
    );
  }

  if (notes.length > 0) return { block: false, logOnly: true, reasons: notes };
  return { block: false, logOnly: false, reasons: [] };
}
