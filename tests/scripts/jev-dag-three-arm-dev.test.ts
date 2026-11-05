import { describe, expect, it } from "vitest";
import { protectedSwitchReady, threeArmRequestCeiling } from "../../scripts/jev-dag-three-arm-dev.js";

describe("three-arm DAG experiment budget", () => {
  it("counts one global request and two criterion-local requests per case criterion", () => {
    expect(threeArmRequestCeiling(12, 24)).toBe(60);
    expect(threeArmRequestCeiling(12, 0)).toBe(12);
    expect(threeArmRequestCeiling(1, 2)).toBe(5);
  });

  it("requires the real protected switch to be explicitly ON", () => {
    expect(protectedSwitchReady({ desired: "UNKNOWN", effective: "OFF" })).toBe(false);
    expect(protectedSwitchReady({ desired: "OFF", effective: "OFF" })).toBe(false);
    expect(protectedSwitchReady({ desired: "ON", effective: "OFF" })).toBe(false);
    expect(protectedSwitchReady({ desired: "ON", effective: "ON" })).toBe(true);
  });
});
