import { describe, expect, it } from "vitest";
import {
  CONSEQUENTIAL_ROUTING_FAMILY,
  degradedRoutingFor,
  gateConsequentialRouting,
  type RoutingActiveIdentity,
  type RoutingQualification,
} from "../../src/decision/routing.js";

const ACTIVE: RoutingActiveIdentity = {
  backend: "typesafe",
  model: "jev-1.14.0",
  modelVersion: "2026-09-01",
  questionFamily: "branch-predicates-v3",
  policyHash: "policy-routing-v3",
};

function qualified(overrides: Partial<RoutingQualification> = {}): RoutingQualification {
  return {
    id: "qual-routing-001",
    family: CONSEQUENTIAL_ROUTING_FAMILY,
    backend: ACTIVE.backend,
    model: ACTIVE.model,
    modelVersion: ACTIVE.modelVersion,
    questionFamily: ACTIVE.questionFamily,
    policyHash: ACTIVE.policyHash,
    qualified: true,
    ...overrides,
  };
}

describe("consequential routing is a distinct decision family", () => {
  it("records routing (never authorization or verification) on every disposition", () => {
    const results = [
      gateConsequentialRouting({ active: ACTIVE, confidence: 0.9 }),
      gateConsequentialRouting({ qualification: qualified(), active: ACTIVE, confidence: 0.9 }),
      gateConsequentialRouting({
        qualification: qualified({ family: "mission-closure" }),
        active: ACTIVE,
        confidence: 0.9,
      }),
    ];
    for (const result of results) expect(result.kind).toBe("routing");
  });

  it("rejects mission-closure qualification even when identity matches exactly", () => {
    for (const family of ["mission-closure", "mission-completion", "mission-closure-3stage"]) {
      const result = gateConsequentialRouting({
        qualification: qualified({ family }),
        active: ACTIVE,
        confidence: 0.99,
      });
      expect(result.disposition).toBe("blocked");
      expect(result.mode).toBe("advisory");
    }
  });

  it("rejects unknown families without a release policy", () => {
    const result = gateConsequentialRouting({
      qualification: qualified({ family: "consequential-something-else" }),
      active: ACTIVE,
      confidence: 0.9,
    });
    expect(result.disposition).toBe("blocked");
  });
});

describe("advisory vs consequential routing", () => {
  it("allows advisory routing with no qualification at all", () => {
    const result = gateConsequentialRouting({ active: ACTIVE, confidence: 0.9 });
    expect(result).toMatchObject({ disposition: "advisory-only", mode: "advisory" });
  });

  it("defers an unqualified record to advisory-only", () => {
    const result = gateConsequentialRouting({
      qualification: qualified({ qualified: false }),
      active: ACTIVE,
      confidence: 0.95,
    });
    expect(result.disposition).toBe("advisory-only");
  });

  it("admits the consequential route on exact identity match above the floor", () => {
    const result = gateConsequentialRouting({
      qualification: qualified(),
      active: ACTIVE,
      confidence: 0.9,
      thresholds: { auto: 0.9, review: 0.7 },
    });
    expect(result).toMatchObject({
      disposition: "allow-consequential",
      mode: "consequential",
    });
  });

  it.each([
    ["backend", { backend: "openrouter" }],
    ["model", { model: "jev-1.13.0" }],
    ["modelVersion", { modelVersion: "2026-08-01" }],
    ["questionFamily", { questionFamily: "branch-predicates-v2" }],
    ["policyHash", { policyHash: "policy-routing-v2" }],
  ])("blocks on %s mismatch", (_field, override) => {
    const result = gateConsequentialRouting({
      qualification: qualified(override),
      active: ACTIVE,
      confidence: 0.9,
    });
    expect(result.disposition).toBe("blocked");
    expect(result.mode).toBe("advisory");
  });

  it("reports malformed records as diagnostic, not silent advisory", () => {
    const result = gateConsequentialRouting({
      qualification: qualified({ modelVersion: "  " }),
      active: ACTIVE,
      confidence: 0.9,
    });
    expect(result.disposition).toBe("diagnostic");
    expect(result.reasons.join(" ")).toMatch(/malformed/);
  });

  it("defers below-floor confidence to advisory-only", () => {
    const result = gateConsequentialRouting({
      qualification: qualified(),
      active: ACTIVE,
      confidence: 0.5,
    });
    expect(result.disposition).toBe("advisory-only");
  });

  it("defers missing confidence to advisory-only", () => {
    const result = gateConsequentialRouting({ qualification: qualified(), active: ACTIVE });
    expect(result.disposition).toBe("advisory-only");
  });

  it("never lets confidence substitute for qualification", () => {
    const result = gateConsequentialRouting({ active: ACTIVE, confidence: 0.999 });
    expect(result.disposition).toBe("advisory-only");
    expect(result.mode).toBe("advisory");
  });

  it("leaves existing qualification thresholds untouched", () => {
    const thresholds = { auto: 0.9, review: 0.7 };
    gateConsequentialRouting({ qualification: qualified(), active: ACTIVE, confidence: 0.9, thresholds });
    expect(thresholds).toEqual({ auto: 0.9, review: 0.7 });
  });
});

describe("degraded routing paths (quota / Stop / timeout)", () => {
  it.each([
    ["quota exhausted", new Error("openrouter 429 quota exhausted")],
    ["Stop error", new Error("Stop hook failed: model error")],
    ["model timeout", new Error("judgment timeout after 30000ms")],
    ["model unavailable", new Error("socket hang up")],
  ])("degrades %s to advisory-only, never an admission", (_name, error) => {
    const result = degradedRoutingFor(error);
    expect(result.kind).toBe("routing");
    expect(result.disposition).toBe("advisory-only");
    expect(result.mode).toBe("advisory");
  });
});
