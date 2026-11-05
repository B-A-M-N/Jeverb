/**
 * Wave 1 (evidence & verification policy) — D3, D7, D8.
 *
 * Each section pins the tightened spec against the ORIGINAL behavior first
 * (RED), then the fix turns it GREEN. These tests live here — never in the
 * existing `verification.test.ts`, which keeps pinning the legacy contract.
 */

import { describe, expect, it } from "vitest";
import {
  applyLedgerEvent,
  bashFailed,
  ledgerEvent,
  verificationKindsClaimed,
  verificationPolicy,
  type VerificationLedger,
} from "../../src/hooks/verification.js";
import type { HookInput } from "../../src/hooks/types.js";

const NOW = 1_700_000_000_000;
const AUTO = 0.85;
const PROJECT = "/home/dev/project";

const OK_RESPONSE = { stdout: "ok\n", stderr: "", interrupted: false, isImage: false };

function post(overrides: Partial<HookInput> = {}): HookInput {
  return {
    session_id: "s1",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_response: OK_RESPONSE,
    ...overrides,
  };
}

/** D3: the ledger must remember what EACH kind established. */
function failedTestThenPassingLint(): VerificationLedger {
  let ledger: VerificationLedger = { edits_since: 0 };
  ledger = applyLedgerEvent(
    ledger,
    {
      verification: { kind: "test", ok: false, ts: NOW - 7 * 60_000, command: "npm test" },
      edited: false,
    },
  );
  ledger = applyLedgerEvent(
    ledger,
    {
      verification: { kind: "lint", ok: true, ts: NOW - 60_000, command: "npm run lint" },
      edited: false,
    },
  );
  return ledger;
}

describe("D3 claim-aware verification policy", () => {
  it("blocks a test claim when tests failed even though lint passed after", () => {
    const ledger = failedTestThenPassingLint();
    const result = verificationPolicy(0.95, ledger, AUTO, NOW, ["test"]);
    expect(result.block).toBe(true);
    expect(result.reason).toContain("test");
  });

  it("stays silent on a lint claim corroborated by the passing lint run", () => {
    const ledger = failedTestThenPassingLint();
    const result = verificationPolicy(0.95, ledger, AUTO, NOW, ["lint"]);
    expect(result.block).toBe(false);
    expect(result.logOnly).toBe(false);
  });

  it("treats an edit after the test run as stale for tests but fresh for a later lint", () => {
    let ledger: VerificationLedger = { edits_since: 0 };
    ledger = applyLedgerEvent(
      ledger,
      { verification: { kind: "test", ok: true, ts: NOW - 300_000, command: "npm test" }, edited: false },
    );
    ledger = applyLedgerEvent(ledger, { edited: true });
    ledger = applyLedgerEvent(
      ledger,
      { verification: { kind: "lint", ok: true, ts: NOW - 60_000, command: "npm run lint" }, edited: false },
    );
    const tests = verificationPolicy(0.95, ledger, AUTO, NOW, ["test"]);
    expect(tests.block).toBe(false);
    expect(tests.logOnly).toBe(true);
    expect(tests.reasons.join(" ")).toContain("test");
    const lint = verificationPolicy(0.95, ledger, AUTO, NOW, ["lint"]);
    expect(lint.logOnly).toBe(false);
  });

  it("blocks when a later failure of the claimed kind invalidates an earlier pass", () => {
    let ledger: VerificationLedger = { edits_since: 0 };
    ledger = applyLedgerEvent(
      ledger,
      { verification: { kind: "test", ok: true, ts: NOW - 300_000, command: "npm test" }, edited: false },
    );
    ledger = applyLedgerEvent(
      ledger,
      { verification: { kind: "test", ok: false, ts: NOW - 60_000, command: "npm test" }, edited: false },
    );
    const result = verificationPolicy(0.95, ledger, AUTO, NOW, ["test"]);
    expect(result.block).toBe(true);
  });

  it("logs rather than accuses when the claimed kind never ran", () => {
    const ledger = failedTestThenPassingLint();
    const result = verificationPolicy(0.95, ledger, AUTO, NOW, ["build"]);
    expect(result.block).toBe(false);
    expect(result.logOnly).toBe(true);
  });
});

describe("verificationKindsClaimed", () => {
  const cases: [string, string[]][] = [
    ["All tests pass.", ["test"]],
    ["The build succeeds and lint is clean.", ["build", "lint"]],
    ["Typecheck is clean.", ["typecheck"]],
    ["All checks pass.", ["test", "build", "typecheck", "lint"]],
    ["Fixed the bug, still working on it.", []],
    ["Ran npm test, 3 failures.", []],
  ];
  for (const [message, expected] of cases) {
    it(`${JSON.stringify(message)} -> [${expected.join(", ")}]`, () => {
      expect(verificationKindsClaimed(message)).toEqual(expected);
    });
  }
});

describe("D7 unknown tool-response shapes are never success", () => {
  it("bashFailed is unknowable for an empty object response", () => {
    expect(bashFailed(post({ tool_response: {} }))).toBeUndefined();
  });

  it("bashFailed is unknowable when no response was delivered at all", () => {
    const input = post({});
    delete (input as { tool_response?: unknown }).tool_response;
    expect(bashFailed(input)).toBeUndefined();
  });

  it("no verification record is minted for a check with an unknown outcome", () => {
    const event = ledgerEvent(post({ tool_input: { command: "npm test" }, tool_response: {} }), NOW);
    expect(event.verification).toBeUndefined();
    expect(event.edited).toBe(false);
  });

  it("still reads the documented success shape as success", () => {
    expect(bashFailed(post())).toBe(false);
    expect(ledgerEvent(post({ tool_input: { command: "npm test" } }), NOW).verification?.ok).toBe(true);
  });
});

describe("D8 uncertain mutating ops taint staleness", () => {
  it("marks a failed Write as uncertain rather than a clean no-edit", () => {
    const event = ledgerEvent(
      {
        session_id: "s1",
        hook_event_name: "PostToolUseFailure",
        tool_name: "Write",
        error: "File has not been read yet. Read it first.",
      },
      NOW,
    );
    expect(event.edited).toBe(false);
    expect(event.uncertain).toBe(true);
  });

  it("marks a cancelled in-project Bash mutation as uncertain", () => {
    const event = ledgerEvent(
      post({ tool_input: { command: "sed -i 's/a/b/' src/x.ts" }, cwd: PROJECT, is_interrupt: true }),
      NOW,
    );
    expect(event.edited).toBe(false);
    expect(event.uncertain).toBe(true);
  });

  it("marks a failed in-project Bash mutation as uncertain", () => {
    const event = ledgerEvent(
      {
        session_id: "s1",
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        tool_input: { command: "sed -i 's/a/b/' src/x.ts" },
        cwd: PROJECT,
        error: "Exit code 1\nsed: no such file",
      },
      NOW,
    );
    expect(event.edited).toBe(false);
    expect(event.uncertain).toBe(true);
  });

  it("treats a failed out-of-project Bash write as demonstrated nonmutation", () => {
    const event = ledgerEvent(
      {
        session_id: "s1",
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        tool_input: { command: "echo x > /etc/passwd" },
        cwd: PROJECT,
        error: "Exit code 1\npermission denied",
      },
      NOW,
    );
    expect(event.edited).toBe(false);
    expect(event.uncertain).not.toBe(true);
  });

  it("folds uncertainty into the ledger without inventing an edit", () => {
    const passing = { kind: "test" as const, ok: true, ts: NOW - 60_000, command: "npm test" };
    const next = applyLedgerEvent({ last: passing, edits_since: 0 }, { edited: false, uncertain: true });
    expect(next.edits_since).toBe(0);
    expect(next.last).toEqual(passing);
    expect(next.uncertain_since).toBe(1);
  });

  it("renders prior verification uncorroborated-but-unaccused after an uncertain op", () => {
    const ledger: VerificationLedger = {
      last: { kind: "test", ok: true, ts: NOW - 60_000, command: "npm test" },
      edits_since: 0,
      uncertain_since: 1,
    };
    const result = verificationPolicy(0.95, ledger, AUTO, NOW, ["test"]);
    expect(result.block).toBe(false);
    expect(result.logOnly).toBe(true);
  });
});
