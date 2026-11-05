/**
 * Wave 2 D9 — quota-suppression provenance.
 *
 * The shared provider-health circuit opens after 3 consecutive
 * quota/forbidden failures and `handlePreToolUse` then skips inference. That
 * skip is a degraded-mode allow: it must leave a `silent-quota-suppressed`
 * store record (consecutive-failure count + window, degraded marker) and must
 * never look like a verified approval (no `jev` provenance, no `allow`
 * decision, wire silence).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Answer, DecisionModel } from "../../src/decision/types.js";
import { toWireOutput } from "../../src/hooks/dispatch.js";
import {
  handlePreToolUse,
  providerHealthKey,
} from "../../src/hooks/handlers/pre-tool-use.js";
import type { HookInput } from "../../src/hooks/types.js";
import { JevForbiddenError, JevQuotaError } from "../../src/jev/errors.js";
import {
  providerHealthRecordQuotaFailure,
  providerHealthResetForTests,
} from "../../src/jev/provider-health.js";
import { FakeModel, noul, score } from "../helpers/fake-model.js";
import { cleanup, makeDeps, tempDir } from "./helpers.js";

const NOW = 1_700_000_000_000;
const QUOTA_WINDOW_MS = 5 * 60 * 1000;

function answers(): Record<string, Answer> {
  return {
    destructive: noul(0.02),
    outward_facing: noul(0.02),
    credential_exposure: noul(0.02),
    mentions_target: noul(0.9),
    same_task_area: noul(0.97),
    scope: score(0.97, ["unrelated", "ordinary step", "requested"], 0.9),
    blast_radius: score(0, ["none", "local", "shared", "production"], 0.9),
  };
}

function input(overrides: Partial<HookInput> = {}): HookInput {
  return {
    session_id: "s1",
    cwd: "/home/dev/project",
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "curl -X POST https://example.com/pay" },
    tool_use_id: "toolu_1",
    ...overrides,
  };
}

/** A model that always fails the way an exhausted quota does. */
function quotaFailingModel(counter: { calls: number }, error: unknown = new JevQuotaError("quota exhausted", { status: 429 })): DecisionModel {
  return {
    name: "quota-fail",
    async evaluate(): Promise<never> {
      counter.calls += 1;
      throw error;
    },
    async choice(): Promise<never> {
      throw error;
    },
    async score(): Promise<never> {
      throw error;
    },
    async probability(): Promise<never> {
      throw error;
    },
  } as DecisionModel;
}

let dir: string;
beforeEach(() => {
  dir = tempDir();
  providerHealthResetForTests();
});
afterEach(() => {
  cleanup(dir);
});

function rig(model: DecisionModel | null) {
  const deps = makeDeps(dir, { model, now: NOW });
  deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["fix the failing date parser test"] }));
  return deps;
}

describe("D9 quota-suppression provenance", () => {
  it("leaves a silent-quota-suppressed record instead of zero footprint", async () => {
    const counter = { calls: 0 };
    const deps = rig(quotaFailingModel(counter));
    for (let i = 0; i < 3; i += 1) {
      expect(await handlePreToolUse(input(), deps)).toBeUndefined();
    }
    expect(counter.calls).toBe(3);

    const probe = new FakeModel(answers);
    const probeDeps = rig(probe);
    const output = await handlePreToolUse(input(), probeDeps);

    // Degraded-mode allow: silent on the wire, classified on the side channel.
    expect(output).toBeUndefined();
    expect(toWireOutput(output)).toBeUndefined();
    expect(probe.calls).toHaveLength(0);
    expect(probeDeps.judgment).toEqual({ outcome: "QUOTA_EXHAUSTED" });

    // ... but present in the log, marked degraded, never an allow.
    const records = probeDeps.store.readLog().filter((r) => r.event === "PreToolUse");
    const suppressed = records.filter((r) => r.decision === "silent-quota-suppressed");
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]?.suppressed).toBe("quota-suppressed");
    expect(suppressed[0]?.policy?.degraded_mode).toBe(true);
    expect(suppressed[0]?.policy?.consecutive_quota_failures).toBe(3);
    expect(suppressed[0]?.policy?.quota_window_ms).toBe(QUOTA_WINDOW_MS);
    expect(suppressed[0]?.policy?.quota_circuit_open).toBe(true);
    expect(records.some((r) => r.decision === "allow")).toBe(false);
  });

  it("stays un-suppressed below the threshold and suppresses on the third failure", async () => {
    const counter = { calls: 0 };
    const deps = rig(quotaFailingModel(counter));
    expect(await handlePreToolUse(input(), deps)).toBeUndefined();
    expect(await handlePreToolUse(input(), deps)).toBeUndefined();
    expect(counter.calls).toBe(2);
    expect(deps.store.readLog().filter((r) => r.decision === "silent-quota-suppressed")).toHaveLength(0);

    expect(await handlePreToolUse(input(), deps)).toBeUndefined();
    expect(counter.calls).toBe(3);

    const probe = new FakeModel(answers);
    expect(await handlePreToolUse(input(), rig(probe))).toBeUndefined();
    expect(probe.calls).toHaveLength(0);
  });

  it("forbidden failures open the circuit too", async () => {
    const counter = { calls: 0 };
    const deps = rig(quotaFailingModel(counter, new JevForbiddenError("denied", { status: 403 })));
    for (let i = 0; i < 3; i += 1) {
      await handlePreToolUse(input(), deps);
    }
    const probe = new FakeModel(answers);
    const probeDeps = rig(probe);
    expect(await handlePreToolUse(input(), probeDeps)).toBeUndefined();
    expect(probe.calls).toHaveLength(0);
    expect(probeDeps.store.readLog().filter((r) => r.decision === "silent-quota-suppressed")).toHaveLength(1);
  });

  it("expires after the window: judgment runs again and a verified allow is distinct", async () => {
    const deps = rig(null);
    const key = providerHealthKey(deps.config);
    const openedAt = Date.now() - QUOTA_WINDOW_MS - 60_000;
    providerHealthRecordQuotaFailure(key, { now: () => openedAt });
    providerHealthRecordQuotaFailure(key, { now: () => openedAt });
    providerHealthRecordQuotaFailure(key, { now: () => openedAt });

    const probe = new FakeModel(answers);
    const probeDeps = rig(probe);
    const output = await handlePreToolUse(input(), probeDeps);

    // Probe window: the model is consulted again ...
    expect(probe.calls).toHaveLength(1);
    // ... and a real judgment stays distinguishable from degraded suppression.
    expect(output?.jev?.model).toBe("fake-1.0.0");
    const decisions = probeDeps.store.readLog().map((r) => r.decision);
    expect(decisions).toContain("allow");
    expect(decisions).not.toContain("silent-quota-suppressed");
  });

  it("never shapes a degraded allow like a verified approval", async () => {
    const counter = { calls: 0 };
    const deps = rig(quotaFailingModel(counter));
    for (let i = 0; i < 3; i += 1) {
      await handlePreToolUse(input(), deps);
    }
    const probeDeps = rig(new FakeModel(answers));
    const output = await handlePreToolUse(input(), probeDeps);

    // No provenance a downstream reader could mistake for "judgment allowed".
    expect(output?.jev).toBeUndefined();
    expect(output?.hookSpecificOutput).toBeUndefined();
    expect(output?.systemMessage).toBeUndefined();
    expect(output?.decision).toBeUndefined();
  });
});
