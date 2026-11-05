import { describe, expect, it } from "vitest";
import {
  adversarialRequest,
  affirmativeRequest,
  MISSION_CLOSURE_QUESTION,
  type MissionClosureEvidence,
} from "../../src/mission/closure.js";

const evidence: MissionClosureEvidence = {
  missionId: "mission-fixture",
  objective: "Deliver the feature",
  missionRevision: "mission-r2",
  evidenceRevision: "evidence-r4",
  criteria: [{
    id: "feature",
    statement: "The feature works",
    verified: true,
    outcome: "The regression test passes",
    evidenceRef: "verification:run-1",
    missionRevision: "mission-r2",
    evidenceRevision: "evidence-r4",
  }],
  tests: { passed: true, independent: true, evidenceRef: "verifier:run-2", revision: "evidence-r4" },
  operations: { pending: 0, uncertain: 0 },
  blockers: [],
};

describe("mission closure production request builders", () => {
  it("builds Jev A from bounded outcome fields and the production question", () => {
    const request = affirmativeRequest(evidence);
    expect(request).toEqual({
      state: {
        objective: "Deliver the feature",
        acceptanceCriteria: [{
          id: "feature",
          statement: "The feature works",
          outcome: "The regression test passes",
          evidenceRef: "verification:run-1",
        }],
        tests: { passed: true, independent: true, evidenceRef: "verifier:run-2" },
        operations: { pending: 0, uncertain: 0 },
        blockers: [],
        graphRuns: [],
        missionRevision: "mission-r2",
        evidenceRevision: "evidence-r4",
      },
      questions: { closure: MISSION_CLOSURE_QUESTION },
    });
  });

  it("builds Jev B with verification flags and one question per criterion", () => {
    const request = adversarialRequest(evidence);
    expect(request.state.acceptanceCriteria).toEqual([{
      id: "feature",
      statement: "The feature works",
      verified: true,
      outcome: "The regression test passes",
      evidenceRef: "verification:run-1",
    }]);
    expect(Object.keys(request.questions).sort()).toEqual(["gap", "gap_feature"]);
    expect(request.state.graphRuns).toEqual([]);
  });
});
