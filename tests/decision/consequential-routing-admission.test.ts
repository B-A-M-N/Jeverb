import { describe, expect, it } from "vitest";
import {
  admitProtectedSuccessor,
  classifyBranchTarget,
  CONSEQUENTIAL_ROUTING_FAMILY,
  gateConsequentialRouting,
  type RoutingActiveIdentity,
  type VerifiedRoutingQualification,
} from "../../src/decision/routing.js";
import { questionSetHashFor } from "../../src/jev/qualification.js";

const QHASH = "c".repeat(64);
const SET_HASH = questionSetHashFor([QHASH]);

function active(): RoutingActiveIdentity {
  return {
    backend: "fake",
    model: "fake-model",
    modelVersion: "v1",
    questionFamily: SET_HASH,
    policyHash: "p".repeat(64),
  };
}

function qualified(id = "qual-1"): VerifiedRoutingQualification {
  return {
    verified: true,
    qualificationId: id,
    id,
    family: CONSEQUENTIAL_ROUTING_FAMILY,
    backend: "fake",
    model: "fake-model",
    modelVersion: "v1",
    questionFamily: SET_HASH,
    policyHash: "p".repeat(64),
    qualified: true,
  };
}

const judgment = { provider: "fake", model: "fake-model", questionHash: QHASH };

describe("advisory vs consequential classification is explicit", () => {
  it("treats shell nodes dispatched on a Jev decision as consequential", () => {
    expect(classifyBranchTarget("shell", "decision.verdict")).toBe("consequential");
    expect(classifyBranchTarget("shell", "decision.choice")).toBe("consequential");
    expect(classifyBranchTarget("shell", "decision.score")).toBe("consequential");
  });

  it("keeps jev diagnostics, lane gates, and join-only branches advisory", () => {
    expect(classifyBranchTarget("jev", "decision.verdict")).toBe("advisory");
    expect(classifyBranchTarget("jev", "decision.verdict", true)).toBe("consequential");
    expect(classifyBranchTarget("review", "decision.verdict")).toBe("advisory");
    expect(classifyBranchTarget("shell", "review.lane")).toBe("advisory");
    expect(classifyBranchTarget("shell", undefined)).toBe("advisory");
    expect(classifyBranchTarget("expand", "decision.verdict")).toBe("advisory");
  });
});

describe("protected successor admission", () => {
  it("records the routing kind on every disposition, never authorization", () => {
    for (const result of [
      admitProtectedSuccessor({ judgment, confidence: 0.9 }),
      admitProtectedSuccessor({ admission: { active: active() }, judgment, confidence: 0.9 }),
      admitProtectedSuccessor({ admission: { active: active(), qualification: qualified() }, judgment, confidence: 0.9 }),
    ]) {
      expect(result.kind).toBe("routing");
    }
  });

  it("admits the route on a verified qualification bound to the live judgment", () => {
    const result = admitProtectedSuccessor({
      admission: { active: active(), qualification: qualified("qual-9") },
      judgment,
      confidence: 0.9,
    });
    expect(result).toMatchObject({ disposition: "allow-consequential", mode: "consequential" });
    expect(result.reasons.join("; ")).toContain("qual-9");
  });

  it("defers when no admission is provisioned, even at high confidence", () => {
    const result = admitProtectedSuccessor({ judgment, confidence: 0.999 });
    expect(result.disposition).toBe("advisory-only");
    expect(result.mode).toBe("advisory");
  });

  it("treats a caller-supplied qualified flag without verifier attestation as unavailable", () => {
    const { verified: _dropped, qualificationId: _id, ...unverified } = qualified();
    const result = admitProtectedSuccessor({
      admission: { active: active(), qualification: unverified as never },
      judgment,
      confidence: 0.99,
    });
    expect(result.disposition).toBe("advisory-only");
    expect(result.mode).toBe("advisory");
  });

  it("blocks judgments from another backend, model, or question set", () => {
    const base = { active: active(), qualification: qualified() };
    expect(
      admitProtectedSuccessor({ admission: base, judgment: { ...judgment, provider: "other" } }, ).disposition,
    ).toBe("blocked");
    expect(
      admitProtectedSuccessor({ admission: base, judgment: { ...judgment, model: "other-model" } }).disposition,
    ).toBe("blocked");
    expect(
      admitProtectedSuccessor({ admission: base, judgment: { ...judgment, questionHash: "d".repeat(64) } }).disposition,
    ).toBe("blocked");
  });

  it("defers below-threshold confidence and refuses malformed records", () => {
    const base = { active: active(), qualification: qualified() };
    expect(admitProtectedSuccessor({ admission: base, judgment, confidence: 0.5 }).disposition).toBe("advisory-only");
    const malformed: VerifiedRoutingQualification = { ...qualified(), backend: "" };
    const diagnosed = admitProtectedSuccessor({ admission: { active: active(), qualification: malformed }, judgment, confidence: 0.9 });
    expect(diagnosed.disposition).toBe("diagnostic");
  });

  it("binds the live question set with the canonical single-set hash", () => {
    // Byte-identical to questionSetHashFor([hash]): the verifier and the
    // runtime compare identical bytes, never a re-derived meaning.
    expect(questionSetHashFor([QHASH])).toBe(SET_HASH);
  });

  it("never admits a mission-closure qualification for routing", () => {
    const mission = { ...qualified(), family: "mission-closure" };
    const result = admitProtectedSuccessor({
      admission: { active: active(), qualification: mission },
      judgment,
      confidence: 0.95,
    });
    expect(result.disposition).toBe("blocked");
    expect(gateConsequentialRouting({ qualification: mission, active: active(), confidence: 0.95 }).disposition).toBe("blocked");
  });
});
