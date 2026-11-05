import { addedLines, parseUnifiedDiff } from "./diff-parse.js";

export interface DetectorFinding {
  id: string;
  severity: "hard" | "review" | "note";
  path?: string;
  line?: number;
  message: string;
}

export interface ReviewInput {
  diff: string;
  title?: string;
  description?: string;
  files?: string[];
  signal?: AbortSignal;
}


/** Attach source location only when known (exactOptionalPropertyTypes). */
function located(
  base: Omit<DetectorFinding, "path" | "line">,
  loc: { path?: string; line?: number },
): DetectorFinding {
  return {
    ...base,
    ...(loc.path !== undefined ? { path: loc.path } : {}),
    ...(loc.line !== undefined ? { line: loc.line } : {}),
  };
}

export interface DetectorResult {
  hardBlock: DetectorFinding[];
  review: DetectorFinding[];
  notes: DetectorFinding[];
}

export interface SecretPattern {
  /** Stable detector id carried on every finding from this pattern. */
  id: string;
  /** Human-readable label for messages (never includes matched text). */
  label: string;
  /**
   * Added-line detection regex. No `g` flag: the same object is reused
   * across `test()` calls, where a global flag would make `lastIndex`
   * stateful.
   */
  detect: RegExp;
  /**
   * Global redaction regex. Defaults to a globalized `detect`; set
   * explicitly when redaction must cover more than the detection hit
   * (e.g. the body of a multi-line PEM block, not just its BEGIN line).
   */
  redact?: RegExp;
}

/**
 * Live-secret pattern table, most-specific first. At most one finding is
 * reported per added line (first match wins), so a line that resembles two
 * families — e.g. an OpenAI key assigned to a `key =` variable — yields the
 * specific family id, not a duplicate pair. The generic high-entropy
 * assignment stays last so it only fires when no specific family matched.
 */
export const SECRET_PATTERNS: SecretPattern[] = [
  { id: "credential:openrouter", label: "OpenRouter API key", detect: /sk-or-[A-Za-z0-9_-]{8,}/ },
  { id: "credential:openai", label: "OpenAI API key", detect: /sk-[A-Za-z0-9]{8,}/ },
  {
    id: "credential:github",
    label: "GitHub token",
    detect: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}/,
  },
  { id: "credential:aws-access-key", label: "AWS access key id", detect: /AKIA[0-9A-Z]{16}/ },
  {
    id: "credential:aws-secret",
    label: "AWS secret access key",
    detect: /aws_secret_access_key\s*=\s*\S+/i,
  },
  { id: "credential:stripe", label: "Stripe live secret key", detect: /sk_live_[A-Za-z0-9]{8,}/ },
  { id: "credential:slack", label: "Slack token", detect: /xox[bpasr]-[A-Za-z0-9-]{8,}/ },
  {
    id: "credential:pem-private-key",
    label: "PEM private key",
    detect: /-----BEGIN (?:[A-Z0-9 ]* )?PRIVATE KEY-----/,
    // The BEGIN line is redacted even when no END marker is present:
    // hunk splitting can separate a block across chunks, and a lone
    // BEGIN line already proves key material is adjacent.
    redact: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----)?/g,
  },
  {
    id: "credential:generic-secret-assignment",
    label: "high-entropy secret assignment",
    detect: /(?:\bpassword\b|\bpasswd\b|\bsecret\b|\bapi[_-]?key\b|\bkey\b|\bauth[_-]?token\b|\btoken\b|\bclient[_-]?secret\b|\baccess[_-]?token\b)\s*[:=]\s*['"]?[A-Za-z0-9._~+/=-]{32,}['"]?/i,
  },
];

/**
 * Legacy `[pattern, label]` view of the table. Prefer `SECRET_PATTERNS`
 * (stable detector ids) and `redactSecretsForModel` (global redaction) in
 * new code.
 */
export const CREDENTIAL_PATTERNS: Array<[RegExp, string]> = SECRET_PATTERNS.map((p) => [p.detect, p.label]);

function globalize(re: RegExp): RegExp {
  return new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
}

/**
 * Redaction-only safety net for bare high-entropy tokens: a secret value
 * split from its keyword context (multi-line JSON, wrapped assignments,
 * hunk truncation) matches no anchored detector, but must still not reach
 * the model. Deliberately NOT a finding — blocking on every 32+ character
 * token-shaped run would hard-block benign hashes, while redacting them
 * only costs the model some context. Requires a digit so plain words are
 * never touched; commit SHAs caught here are collateral, fail-safe by
 * design.
 */
const BARE_TOKEN_REDACT = /(?<![A-Za-z0-9._~+/=-])[A-Za-z0-9._~+/=-]{32,}(?![A-Za-z0-9._~+/=-])/g;

/**
 * Replace every live-secret-looking literal with `[REDACTED]`. Runs over
 * the whole table (including the multi-line PEM body), so redaction never
 * depends on which detector fired, then sweeps bare high-entropy tokens
 * with no keyword context. Throws on non-string input so callers can
 * fail closed instead of passing text through unredacted.
 */
export function redactSecretsForModel(text: string): string {
  if (typeof text !== "string") throw new TypeError("redactSecretsForModel expects a string");
  let out = text;
  for (const p of SECRET_PATTERNS) {
    out = out.replace(p.redact ?? globalize(p.detect), "[REDACTED]");
  }
  out = out.replace(BARE_TOKEN_REDACT, (run) => (/\d/.test(run) ? "[REDACTED]" : run));
  return out;
}

interface AddedLine {
  path?: string;
  line?: number;
  text: string;
}

/**
 * Added lines from a parsed unified diff. When the input is not a unified
 * diff at all (no parseable hunks), fall back to the legacy raw scan of
 * `+`-prefixed lines: detectors fail closed on unparseable input rather
 * than silently seeing nothing.
 */
function addedOrLegacy(diff: string): AddedLine[] {
  const files = parseUnifiedDiff(diff);
  if (files.some((f) => f.hunks.length > 0)) return addedLines(files);
  const out: AddedLine[] = [];
  diff.split("\n").forEach((raw, i) => {
    if (raw.startsWith("+") && !raw.startsWith("+++")) out.push({ line: i + 1, text: raw.slice(1) });
  });
  return out;
}

export function detectLiveCredentialPatterns(diff: string): DetectorFinding[] {
  const out: DetectorFinding[] = [];
  // Added lines only: a secret-looking string in removed code or a `+++`
  // file header is not an introduced credential. The parser also yields the
  // new-file line number, replacing the old raw-diff line index.
  for (const line of addedOrLegacy(diff)) {
    const hit = SECRET_PATTERNS.find((p) => p.detect.test(line.text));
    if (hit !== undefined) {
      out.push(
        located({ id: hit.id, severity: "hard", message: `Live credential pattern: ${hit.label}` }, line),
      );
    }
  }
  return out;
}

export function detectWorkflowPermissionExpansion(diff: string): DetectorFinding[] {
  // Added lines only: a pre-existing `permissions:` block in context lines
  // is not an expansion introduced by this diff.
  const hit = addedOrLegacy(diff).find((line) => /permissions\s*:\s*write-all/i.test(line.text));
  if (hit !== undefined) {
    return [located({ id: "workflow:write-all", severity: "hard", message: "Workflow grants write-all permissions" }, hit)];
  }
  return [];
}

export function detectInvisibleControlCharacters(diff: string): DetectorFinding[] {
  const hit = addedOrLegacy(diff).find((line) =>
    // biome-ignore lint: intentional control-character class
    /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/.test(line.text),
  );
  if (hit !== undefined) {
    return [located({ id: "obfuscation:invisible-unicode", severity: "hard", message: "Invisible Unicode control characters" }, hit)];
  }
  return [];
}

export function detectReviewerInstructionInjection(diff: string): DetectorFinding[] {
  const hit = addedOrLegacy(diff).find((line) =>
    /ignore (all )?previous instructions|you are (now )?the reviewer/i.test(line.text),
  );
  if (hit !== undefined) {
    return [located({ id: "injection:reviewer-instructions", severity: "hard", message: "Reviewer instruction injection" }, hit)];
  }
  return [];
}

export function detectUnreviewedBinaryOrGeneratedFiles(input: ReviewInput): DetectorFinding[] {
  const files = input.files ?? [];
  const hit = files.filter((f) => /\.(png|jpg|zip|min\.js|bundle\.js)$/i.test(f));
  return hit.map((path) => ({ id: "binary:unreviewed", severity: "review" as const, path, message: `Binary or generated file needs review: ${path}` }));
}

export function mergeDetectors(parts: DetectorFinding[][]): DetectorResult {
  const all = parts.flat();
  return {
    hardBlock: all.filter((f) => f.severity === "hard"),
    review: all.filter((f) => f.severity === "review"),
    notes: all.filter((f) => f.severity === "note"),
  };
}

export function runDetectors(input: ReviewInput): DetectorResult {
  return mergeDetectors([
    detectLiveCredentialPatterns(input.diff),
    detectWorkflowPermissionExpansion(input.diff),
    detectInvisibleControlCharacters(input.diff),
    detectReviewerInstructionInjection(input.diff),
    detectUnreviewedBinaryOrGeneratedFiles(input),
  ]);
}
