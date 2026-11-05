import { describe, expect, it } from "vitest";
import { prepareBlindAnnotation, reconcileBlindAnnotations } from "../../src/jev/annotation.js";

function source(): string {
  return [
    { id: "case-complete-secret", state: { objective: "finish A", outcomes: ["A verified"] }, questions: { closure: { type: "choice", instructions: "Judge completion", criteria: { COMPLETE: "all fulfilled", INCOMPLETE: "work remains", BLOCKED: "external stop", INSUFFICIENT_EVIDENCE: "cannot tell" } } }, expected: { closure: { choice: "COMPLETE" } } },
    { id: "case-incomplete-secret", state: { objective: "finish B", outcomes: [] }, questions: { closure: { type: "choice", instructions: "Judge completion", criteria: { COMPLETE: "all fulfilled", INCOMPLETE: "work remains", BLOCKED: "external stop", INSUFFICIENT_EVIDENCE: "cannot tell" } } }, expected: { closure: { choice: "INCOMPLETE" } } },
  ].map((item) => JSON.stringify(item)).join("\n") + "\n";
}

function raterRows(packet: ReturnType<typeof prepareBlindAnnotation>["packet"], choices: Record<string, string>, reviewerId: string): string {
  return packet.cases.map((item) => JSON.stringify({
    reviewerId,
    annotationId: item.annotationId,
    answers: { closure: { choice: choices[item.annotationId], rationale: "The supplied outcome evidence supports this label.", evidenceRefs: ["state.outcomes"] } },
  })).join("\n") + "\n";
}

describe("blind evaluation annotation", () => {
  it("removes answer-bearing IDs and labels while binding a private source key", () => {
    const result = prepareBlindAnnotation(source(), (() => { let i = 0; return () => `blind-${++i}`; })());
    const visible = JSON.stringify(result.packet);
    expect(visible).not.toContain("case-complete-secret");
    expect(visible).not.toContain("case-incomplete-secret");
    expect(visible).not.toContain("expected");
    expect(result.key.cases).toHaveLength(2);
    expect(result.key.sourceHash).toBe(result.packet.sourceHash);
  });

  it("accepts new unlabeled source cases without exposing generated validation placeholders", () => {
    const unlabeled = source().split("\n").filter(Boolean).map((line) => {
      const row = JSON.parse(line) as Record<string, unknown>;
      delete row.expected;
      return JSON.stringify(row);
    }).join("\n") + "\n";
    const result = prepareBlindAnnotation(unlabeled, (() => { let i = 0; return () => `unlabeled-${++i}`; })());
    expect(result.packet.cases).toHaveLength(2);
    expect(JSON.stringify(result.packet)).not.toContain("expected");
    expect(result.packet.sourceHash).not.toBe(prepareBlindAnnotation(source()).packet.sourceHash);
  });

  it("releases labels only when two complete raters agree", () => {
    const result = prepareBlindAnnotation(source(), (() => { let i = 0; return () => `blind-${++i}`; })());
    const choices = Object.fromEntries(result.packet.cases.map((item) => [item.annotationId, item.state && (item.state as { objective: string }).objective === "finish A" ? "COMPLETE" : "INCOMPLETE"]));
    const agreedA = raterRows(result.packet, choices, "reviewer-a");
    const agreedB = raterRows(result.packet, choices, "reviewer-b");
    const reconciled = reconcileBlindAnnotations({ sourceText: source(), packet: result.packet, key: result.key, firstText: agreedA, secondText: agreedB });
    expect(reconciled).toMatchObject({ unanimous: true, cases: 2, judgments: 2, agreements: 2, disagreements: [] });
    expect(reconciled.labeledDataset).toContain('"expected":{"closure":{"choice":"COMPLETE"}}');
    expect(reconciled.audit).toHaveLength(2);
    const wrong = { ...choices, [result.packet.cases[0]!.annotationId]: "BLOCKED" };
    const disagreement = reconcileBlindAnnotations({ sourceText: source(), packet: result.packet, key: result.key, firstText: agreedA, secondText: raterRows(result.packet, wrong, "reviewer-b") });
    expect(disagreement.unanimous).toBe(false);
    expect(disagreement.labeledDataset).toBeUndefined();
    expect(disagreement.disagreements).toHaveLength(1);
    const adjudication = reconcileBlindAnnotations({ sourceText: source(), packet: result.packet, key: result.key, firstText: agreedA, secondText: raterRows(result.packet, wrong, "reviewer-b"), adjudicatorText: raterRows(result.packet, wrong, "adjudicator") });
    expect(adjudication).toMatchObject({ unanimous: false, resolved: true, disagreements: [{ choices: [choices[result.packet.cases[0]!.annotationId], "BLOCKED"] }] });
    expect(adjudication.labeledDataset).toContain('"choice":"BLOCKED"');
  });

  it("rejects missing labels, unsupported choices, and source/key drift", () => {
    const result = prepareBlindAnnotation(source(), (() => { let i = 0; return () => `blind-${++i}`; })());
    const validA = raterRows(result.packet, Object.fromEntries(result.packet.cases.map((item) => [item.annotationId, "COMPLETE"])), "reviewer-a");
    const validB = raterRows(result.packet, Object.fromEntries(result.packet.cases.map((item) => [item.annotationId, "COMPLETE"])), "reviewer-b");
    expect(() => reconcileBlindAnnotations({ sourceText: source(), packet: result.packet, key: result.key, firstText: validA.split("\n").slice(0, 1).join("\n"), secondText: validB })).toThrow(/cover 1\/2/);
    const invalid = validA.replace('"choice":"COMPLETE"', '"choice":"NOT_A_LABEL"');
    expect(() => reconcileBlindAnnotations({ sourceText: source(), packet: result.packet, key: result.key, firstText: invalid, secondText: validB })).toThrow(/listed criterion/);
    expect(() => reconcileBlindAnnotations({ sourceText: source(), packet: result.packet, key: result.key, firstText: validA, secondText: validA })).toThrow(/distinct reviewerId/);
    expect(() => reconcileBlindAnnotations({ sourceText: source() + "\n", packet: result.packet, key: result.key, firstText: validA, secondText: validB })).toThrow(/hashes must match/);
    const alteredPacket = structuredClone(result.packet);
    alteredPacket.cases[0]!.state = { objective: "mutated after review prep" };
    expect(() => reconcileBlindAnnotations({ sourceText: source(), packet: alteredPacket, key: result.key, firstText: validA, secondText: validB })).toThrow(/differs from the source/);
    const duplicateKey = structuredClone(result.key);
    duplicateKey.cases[0]!.sourceId = duplicateKey.cases[1]!.sourceId;
    expect(() => reconcileBlindAnnotations({ sourceText: source(), packet: result.packet, key: duplicateKey, firstText: validA, secondText: validB })).toThrow(/every source case exactly once/);
  });
});
