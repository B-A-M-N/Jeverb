/**
 * Install-wide master switch (kill switch) state.
 *
 * Owned by the control layer: `control/` and `evidence/` read authoritative
 * suppression state from here, never from `hooks/store.ts`, so the hooks
 * state store stays a leaf and the layering control -> hooks stays one-way
 * (control may not depend on hooks at runtime).
 */

import { lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PROTECTED_MASTER_SWITCH_PATH } from "./constants.js";

/**
 * Plugin-wide state is read from the service-owned location, never the legacy
 * user data directory. The old marker is not consulted after migration.
 */
export function globalDisablePathFor(_dataDir?: string): string {
  return PROTECTED_MASTER_SWITCH_PATH;
}

export function environmentDisableOverride(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["1", "true", "yes", "on"].includes((env.JEV_HOOKS_DISABLE ?? "").trim().toLowerCase());
}

/** True when the install-wide kill switch is set. Never throws. */
export function isGloballyDisabled(
  dataDir: string,
  statePath = PROTECTED_MASTER_SWITCH_PATH,
  requireRootOwned = true,
): boolean {
  return readMasterSwitch(dataDir, false, statePath, requireRootOwned).effective === "OFF";
}

export interface MasterSwitchStatus {
  desired: "ON" | "OFF" | "UNKNOWN";
  effective: "ON" | "OFF";
  scope: "install-wide";
  generation: string | null;
  markerPath: string;
  environmentOverride: boolean;
}

/** Read persisted state only from the protected service path. */
export function readMasterSwitch(
  _dataDir: string,
  envDisabled = false,
  statePath = PROTECTED_MASTER_SWITCH_PATH,
  requireRootOwned = true,
): MasterSwitchStatus {
  let desired: MasterSwitchStatus["desired"] = "ON";
  let generation: string | null = null;
  try {
    const path = statePath;
    const stat = lstatSync(path);
    const parent = lstatSync(dirname(path));
    if (
      !stat.isFile()
      || stat.isSymbolicLink()
      || !parent.isDirectory()
      || parent.isSymbolicLink()
      || (requireRootOwned && (stat.uid !== 0 || parent.uid !== 0 || (stat.mode & 0o022) !== 0 || (parent.mode & 0o022) !== 0))
    ) {
      desired = "UNKNOWN";
    } else {
      const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (
        value.schema_version === 1
        && (value.desired === "ON" || value.desired === "OFF")
        && typeof value.generation === "string"
        && /^[0-9a-f]{32}$/.test(value.generation)
      ) {
        desired = value.desired;
        generation = value.generation;
      } else desired = "UNKNOWN";
    }
  } catch (error) {
    desired = "UNKNOWN";
  }
  return {
    desired,
    effective: desired === "OFF" || desired === "UNKNOWN" || envDisabled ? "OFF" : "ON",
    scope: "install-wide",
    generation,
    markerPath: statePath,
    environmentOverride: envDisabled,
  };
}

/** Atomically change persisted suppression state; this does not establish authorization. */
export function writeMasterSwitch(_dataDir: string, _disabled: boolean): never {
  throw new Error("master switch writes are owned by the protected jeverb-control service");
}

/** Legacy marker path for controlled migration and diagnostics only. */
export function legacyDisablePathFor(dataDir: string): string {
  return join(dataDir, "disabled");
}
