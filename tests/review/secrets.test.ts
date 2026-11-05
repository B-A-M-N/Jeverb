import { describe, expect, it } from "vitest";
import { calibratedReviewFixture } from "./calibration-fixture.js";
import {
  detectLiveCredentialPatterns,
  redactSecretsForModel,
  runDetectors,
} from "../../src/review/detectors.js";
import { ReviewService, reviewToReason } from "../../src/review/service.js";

/** Wrap a line as the single added line of a minimal unified diff (new-file line 2). */
function addedDiff(line: string): string {
  return [
    "diff --git a/k.ts b/k.ts",
    "--- a/k.ts",
    "+++ b/k.ts",
    "@@ -1,2 +1,3 @@",
    " const a = 1;",
    `+${line}`,
    " const b = 2;",
    "",
  ].join("\n");
}

function removedDiff(line: string): string {
  return [
    "diff --git a/k.ts b/k.ts",
    "--- a/k.ts",
    "+++ b/k.ts",
    "@@ -1,2 +1,1 @@",
    `-${line}`,
    " const b = 2;",
    "",
  ].join("\n");
}

function contextDiff(line: string): string {
  return [
    "diff --git a/k.ts b/k.ts",
    "--- a/k.ts",
    "+++ b/k.ts",
    "@@ -1,2 +1,2 @@",
    ` ${line}`,
    " const b = 2;",
    "",
  ].join("\n");
}

/** Secret-looking literal carried in a `+++` file header, never a hunk body. */
function headerDiff(literal: string): string {
  return [
    "diff --git a/k.ts b/k.ts",
    "--- a/k.ts",
    `+++ b/${literal}`,
    "@@ -1 +1 @@",
    " same",
    "",
  ].join("\n");
}

// Obviously fake literals shaped like each family (never real credentials).
const OPENAI = `sk-${"Ab3X9q".repeat(5)}`;
const GITHUB_GHP = `ghp_${"a1b2c3d4".repeat(4)}`;
const GITHUB_GHO = `gho_${"e5f6a7b8".repeat(4)}`;
const GITHUB_PAT = `github_pat_${"a1_".repeat(8)}`;
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const AWS_SECRET_LINE = "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const STRIPE = `sk_live_${"t3st".repeat(6)}`;
const SLACK_B = `xoxb-${"123456".repeat(3)}-${"abcdef".repeat(3)}`;
const SLACK_P = `xoxp-${"654321".repeat(3)}-${"fedcba".repeat(3)}`;
const GENERIC_LINE = `password = "${"s3cr3t".repeat(6)}"`;
const GENERIC_LINE2 = `api_key: ${"Zz9".repeat(12)}`;
const PEM_LINE = "-----BEGIN RSA PRIVATE KEY-----";
const OPENROUTER = `sk-or-v1-${"m0d3l".repeat(6)}`;

const CASES: Array<{ family: string; id: string; line: string; literal: string }> = [
  { family: "OpenAI", id: "credential:openai", line: `const key = "${OPENAI}";`, literal: OPENAI },
  { family: "GitHub ghp", id: "credential:github", line: `const token = "${GITHUB_GHP}";`, literal: GITHUB_GHP },
  { family: "GitHub gho", id: "credential:github", line: `const token = "${GITHUB_GHO}";`, literal: GITHUB_GHO },
  { family: "GitHub pat", id: "credential:github", line: `const token = "${GITHUB_PAT}";`, literal: GITHUB_PAT },
  { family: "AWS key id", id: "credential:aws-access-key", line: `const id = "${AWS_KEY}";`, literal: AWS_KEY },
  { family: "AWS secret", id: "credential:aws-secret", line: AWS_SECRET_LINE, literal: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
  { family: "Stripe", id: "credential:stripe", line: `const key = "${STRIPE}";`, literal: STRIPE },
  { family: "Slack xoxb", id: "credential:slack", line: `const token = "${SLACK_B}";`, literal: SLACK_B },
  { family: "Slack xoxp", id: "credential:slack", line: `const token = "${SLACK_P}";`, literal: SLACK_P },
  { family: "generic assignment", id: "credential:generic-secret-assignment", line: GENERIC_LINE, literal: "s3cr3t".repeat(6) },
  { family: "generic api_key", id: "credential:generic-secret-assignment", line: GENERIC_LINE2, literal: "Zz9".repeat(12) },
  { family: "PEM block", id: "credential:pem-private-key", line: PEM_LINE, literal: PEM_LINE },
  { family: "OpenRouter", id: "credential:openrouter", line: `const key = "${OPENROUTER}";`, literal: OPENROUTER },
];

describe("live-secret detectors fire on added lines", () => {
  for (const c of CASES) {
    it(`${c.family} reports ${c.id} with severity hard and a file/line location`, () => {
      const findings = detectLiveCredentialPatterns(addedDiff(c.line));
      const hit = findings.find((f) => f.id === c.id);
      expect(hit, c.family).toBeDefined();
      expect(hit).toMatchObject({ id: c.id, severity: "hard", path: "k.ts", line: 2 });
      expect(hit?.message).not.toContain(c.literal);
    });
  }

  it("reports at most one finding per added line (most-specific family wins)", () => {
    // An OpenAI key assigned to `key =` resembles two families; only the
    // specific id is reported, never a duplicate pair.
    const findings = detectLiveCredentialPatterns(addedDiff(`const key = "${OPENAI}";`));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe("credential:openai");
  });

  it("hard-blocks via the combined runDetectors entry", () => {
    const result = runDetectors({ diff: addedDiff(`const key = "${OPENAI}";`) });
    expect(result.hardBlock.length).toBeGreaterThan(0);
    expect(result.hardBlock.every((f) => f.severity === "hard")).toBe(true);
  });
});

describe("live-secret detectors ignore non-added lines", () => {
  for (const c of CASES) {
    it(`${c.family}: no finding on deletion lines`, () => {
      expect(detectLiveCredentialPatterns(removedDiff(c.line))).toEqual([]);
    });
    it(`${c.family}: no finding on context lines`, () => {
      expect(detectLiveCredentialPatterns(contextDiff(c.line))).toEqual([]);
    });
    it(`${c.family}: no finding in diff headers`, () => {
      expect(detectLiveCredentialPatterns(headerDiff(c.line))).toEqual([]);
    });
  }
});

describe("redactSecretsForModel removes every literal", () => {
  for (const c of CASES) {
    it(`${c.family}: literal gone, placeholder present`, () => {
      const redacted = redactSecretsForModel(`prefix ${c.literal} suffix`);
      expect(redacted).not.toContain(c.literal);
      expect(redacted).toContain("[REDACTED]");
    });
  }

  it("redacts a whole multi-line PEM block, not just the BEGIN line", () => {
    const block = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEpAIBAAKCAQEA7bq83f4kep4LQj38fFKE",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const redacted = redactSecretsForModel(block);
    expect(redacted).not.toContain("PRIVATE KEY");
    expect(redacted).not.toContain("MIIEpAIBAAKCAQEA7bq83f4kep4LQj38fFKE");
    expect(redacted).toContain("[REDACTED]");
  });

  it("redacts every family in one pass over an added-line diff", () => {
    const diff = CASES.map((c) => `+${c.line}`).join("\n");
    const redacted = redactSecretsForModel(diff);
    for (const c of CASES) expect(redacted, c.family).not.toContain(c.literal);
  });
});

const CHECKS = [{ id: "security", type: "noul", instructions: { question: "Safe?", inspect: "diff", focus: "all" } } as never];
const READY = { ...calibratedReviewFixture(CHECKS), status: "ready" as const };

describe("review service secret handling", () => {
  it("BLOCKs on an added secret without calling the model", async () => {
    let calls = 0;
    const model = {
      async evaluate(): Promise<never> {
        calls++;
        throw new Error("must not be called");
      },
    };
    const svc = new ReviewService(model as never, { checks: CHECKS, ...READY });
    const result = await svc.review({ diff: addedDiff(`const key = "${OPENAI}";`), files: [] });
    expect(calls).toBe(0);
    expect(result.lane).toBe("BLOCK");
    expect(result.findings[0]?.severity).toBe("hard");
  });

  it("never sends raw secrets to the model, even from deletion lines", async () => {
    const seen: string[] = [];
    const model = {
      async evaluate(input: { state: { diff: string }; questions: Record<string, unknown> }) {
        seen.push(input.state.diff);
        return {
          answers: Object.fromEntries(
            Object.keys(input.questions).map((id) => [id, { type: "noul", noul: 0.1 }]),
          ),
        };
      },
    };
    const svc = new ReviewService(model as never, { checks: CHECKS, ...READY });
    // Secret only in a removed line: no hard-block, so the model IS called —
    // the chunk it receives must already be redacted.
    const result = await svc.review({ diff: removedDiff(`const old = "${OPENAI}";`), files: [] });
    expect(seen.length).toBeGreaterThan(0);
    for (const diff of seen) {
      expect(diff).not.toContain(OPENAI);
      expect(diff).toContain("[REDACTED]");
    }
    expect(result.lane).toBe("MERGE");
  });

  it("reviewToReason carries redacted text only", () => {
    const reason = reviewToReason({
      lane: "BLOCK",
      source: "deterministic",
      findings: [{ id: "credential:openai", severity: "hard", message: `saw ${OPENAI} here` }],
      policyVersion: "1",
    });
    expect(reason).toContain("BLOCK");
    expect(reason).not.toContain(OPENAI);
  });
});
