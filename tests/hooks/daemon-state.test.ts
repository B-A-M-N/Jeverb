import { chmodSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { emptyCounters, writeDaemonState, type DaemonState } from "../../src/hooks/daemon/state-file.js";

describe("daemon state file lifecycle", () => {
  it("cleans a sibling temp when atomic state replacement fails", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "jev-daemon-state-rename-failure-"));
    const statePath = join(dataDir, "daemon.json");
    mkdirSync(statePath);
    chmodSync(statePath, 0o500);
    const now = Date.now();
    const state: DaemonState = {
      pid: process.pid,
      port: 18769,
      version: "test",
      protocol: 1,
      bundle_path: "",
      bundle_mtime: 0,
      data_dir: dataDir,
      started_at: now,
      updated_at: now,
      state: "running",
      counters: emptyCounters(),
      restarts: 0,
    };

    writeDaemonState(dataDir, state);

    expect(readdirSync(dataDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
