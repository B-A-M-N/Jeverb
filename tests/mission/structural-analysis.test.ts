import { describe, expect, it } from "vitest";
import { analyzeCriterionTypeScriptStructure } from "../../src/mission/structural-analysis.js";
import { buildMissionProofObligation, proofObligationId, validMissionProofObligation } from "../../src/mission/proof-obligations.js";
import { projectProofObligationForRequest } from "../../src/mission/closure.js";

const files: Record<string, string> = {
  "src/billing.ts": `export function calculateTotal(amount: number, rate: number): number { return amount * (1 - rate / 100); }\n`,
  "test/billing.test.ts": `import { calculateTotal } from "../src/billing.js";\nexport function checkDiscount(): boolean { return calculateTotal(100, 10) === 90; }\n`,
};

describe("host-declared TypeScript structure evidence", () => {
  it("resolves bounded import/call relationships and binds them to one obligation", () => {
    const result = analyzeCriterionTypeScriptStructure({
      root: "/workspace",
      files: Object.keys(files),
      criterionId: "criterion-discount",
      proofObligationId: proofObligationId("criterion-discount", "Apply percentage discounts"),
      missionRevision: "a".repeat(64),
      candidateDigest: "b".repeat(64),
      fs: { readFile: (absolute) => Buffer.from(files[absolute.replace("/workspace/", "")] ?? "") },
    });
    expect(result.provenance).toBe("host:typescript-compiler/v1");
    expect(result.criterionId).toBe("criterion-discount");
    expect(result.proofObligationId).toBe(proofObligationId("criterion-discount", "Apply percentage discounts"));
    expect(result.fileDigests).toHaveLength(2);
    expect(result.symbols.map((symbol) => symbol.name)).toContain("calculateTotal");
    expect(result.imports).toContainEqual(expect.objectContaining({
      path: "test/billing.test.ts", specifier: "../src/billing.js", resolution: "compiler-resolved", resolvedPath: "src/billing.ts",
    }));
    expect(result.calls).toContainEqual(expect.objectContaining({
      path: "test/billing.test.ts", callerSymbolId: expect.any(String), callee: "calculateTotal",
      relation: "compiler-resolved", targetSymbolId: expect.any(String),
    }));
    expect(result.limitations).toContain("static structure only; no behavior is verified");

    const obligation = buildMissionProofObligation({
      criterionId: "criterion-discount",
      requirement: "Apply percentage discounts",
      graphEvidence: [],
      codeStructure: result,
    });
    expect(validMissionProofObligation(obligation, "criterion-discount", "Apply percentage discounts", {
      missionRevision: "a".repeat(64), candidateDigest: "b".repeat(64),
    })).toBe(true);
    const modelInput = projectProofObligationForRequest(obligation);
    expect(modelInput?.id).toBe(result.proofObligationId);
    expect(modelInput?.codeStructure?.calls).toContainEqual(expect.objectContaining({
      relation: "compiler-resolved", targetSymbolId: expect.any(String),
    }));
    expect(modelInput?.codeStructure?.calls.length).toBeLessThanOrEqual(64);
  });

  it("rejects paths outside the host root and non-TypeScript source paths", () => {
    const common = {
      root: "/workspace", criterionId: "criterion-discount",
      proofObligationId: proofObligationId("criterion-discount", "Apply percentage discounts"),
      missionRevision: "a".repeat(64), candidateDigest: "b".repeat(64),
      fs: { readFile: () => Buffer.from("") },
    };
    expect(() => analyzeCriterionTypeScriptStructure({ ...common, files: ["../outside.ts"] })).toThrow(/escapes/);
    expect(() => analyzeCriterionTypeScriptStructure({ ...common, files: ["src/billing.js"] })).toThrow(/TypeScript/);
  });
});
