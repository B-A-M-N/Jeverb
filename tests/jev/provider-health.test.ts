import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, readdirSync } from "node:fs";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  providerHealthRecordQuotaFailure,
  providerHealthRecordProbe,
  providerHealthRecordSuccess,
  providerHealthResetForTests,
  providerHealthShouldSkip,
} from "../../src/jev/provider-health.js";

describe("provider health circuit", () => {
  it("opens after repeated quota failures and allows recovery", () => {
    providerHealthResetForTests();
    const key = { backend: "jev-gateway", model: "typesafe/jev-1.14", generation: "test-1" };
    expect(providerHealthShouldSkip(key)).toBe(false);
    providerHealthRecordQuotaFailure(key);
    providerHealthRecordQuotaFailure(key);
    expect(providerHealthShouldSkip(key)).toBe(false);
    providerHealthRecordQuotaFailure(key);
    expect(providerHealthShouldSkip(key)).toBe(true);
    providerHealthRecordSuccess(key);
    expect(providerHealthShouldSkip(key)).toBe(false);
  });

  it("shares quota state across hook processes and leases one recovery probe", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "jev-provider-health-"));
    const key = { backend: "jev-gateway", model: "typesafe/jev-1.14", generation: "cfg-1", credentialIdentity: "cred-a", stateDir };
    const now = { value: 1000 };
    const opts = { now: () => now.value };
    for (let i = 0; i < 3; i += 1) providerHealthRecordQuotaFailure(key, opts);

    // A fresh key object sees the durable state just as a new hook process would.
    const freshProcessKey = { ...key };
    expect(providerHealthShouldSkip(freshProcessKey, opts)).toBe(true);
    now.value = 301_001;
    expect(providerHealthShouldSkip(freshProcessKey, opts)).toBe(false);
    expect(providerHealthShouldSkip(key, opts)).toBe(true);

    now.value += 1;
    providerHealthRecordQuotaFailure(freshProcessKey, opts);
    expect(providerHealthShouldSkip(key, opts)).toBe(true);
  });

  it("cleans its sibling temp when atomic replacement fails", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "jev-provider-health-rename-failure-"));
    const statePath = join(stateDir, "provider-health.json");
    mkdirSync(statePath);
    chmodSync(statePath, 0o500);
    const key = { backend: "jev-gateway", model: "typesafe/jev-1.14", stateDir };

    providerHealthRecordProbe(key);

    expect(readdirSync(stateDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
