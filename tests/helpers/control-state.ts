import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EvidenceLedger } from "../../src/evidence/ledger.js";
import { Store } from "../../src/hooks/store.js";
import { loadHookConfig } from "../../src/hooks/config.js";

export function testSwitchPath(dataDir: string): string {
  return join(dataDir, "control-state.json");
}

export function setTestSwitch(dataDir: string, desired: "ON" | "OFF"): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(testSwitchPath(dataDir), `${JSON.stringify({
    schema_version: 1,
    desired,
    generation: randomUUID().replaceAll("-", ""),
    updated_at: Date.now(),
    used_request_ids: [],
  })}\n`, { mode: 0o600 });
}

export function testStore(dataDir: string): Store {
  try {
    if (!readTestStateExists(dataDir)) setTestSwitch(dataDir, "ON");
  } catch {
    // Intentionally unwritable test paths model a missing protected state and
    // must remain effectively OFF instead of failing in fixture setup.
  }
  return new Store(dataDir, { masterSwitchPath: testSwitchPath(dataDir), requireRootOwnedMasterSwitch: false });
}

/**
 * Ledger bound to a test control switch (ON), mirroring how production call
 * sites pass their configured switch through. Bare `new EvidenceLedger`
 * defaults to the install-wide protected path and fails closed where that
 * state is absent, so tests that intend appends to succeed must use this.
 */
export function testLedger(
  dataDir: string,
  name = "evidence.log",
  extra: { bundlePath?: string } = {},
): EvidenceLedger {
  try {
    if (!readTestStateExists(dataDir)) setTestSwitch(dataDir, "ON");
  } catch {
    // Intentionally unwritable test paths stay effectively suppressing.
  }
  return new EvidenceLedger(join(dataDir, name), {
    ...extra,
    switchPath: testSwitchPath(dataDir),
    requireRootOwnedSwitch: false,
  });
}

/**
 * Same as {@link testLedger} but derives the data dir and file name from a
 * complete ledger path. For call sites that only have the path at hand.
 */
export function testLedgerForFile(ledgerPath: string, extra: { bundlePath?: string } = {}): EvidenceLedger {
  return testLedger(dirname(ledgerPath), ledgerPath.split("/").pop() ?? "evidence.log", extra);
}

/** Test-only interactive config backed by a same-UID temporary switch file. */
export function testHookConfig(dataDir: string, env: NodeJS.ProcessEnv = {}): ReturnType<typeof loadHookConfig> {
  setTestSwitch(dataDir, "ON");
  return {
    ...loadHookConfig({ ...env, CLAUDE_PLUGIN_DATA: dataDir }),
    masterSwitchPath: testSwitchPath(dataDir),
  };
}

function readTestStateExists(dataDir: string): boolean {
  return existsSync(testSwitchPath(dataDir));
}
