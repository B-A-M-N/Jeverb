import { describe, expect, it, vi } from "vitest";

// Break redaction for this file only: the real module is intact elsewhere.
vi.mock("../../src/review/detectors.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/review/detectors.js")>();
  return {
    ...actual,
    redactSecretsForModel: (): string => {
      throw new Error("redact boom");
    },
  };
});

import { ReviewService } from "../../src/review/service.js";
import { calibratedReviewFixture } from "./calibration-fixture.js";

const CHECKS = [{ id: "security", type: "noul", instructions: { question: "Safe?", inspect: "diff", focus: "all" } } as never];
const READY = {
  ...calibratedReviewFixture(CHECKS),
  status: "ready" as const,
};

const benignDiff = `diff --git a/k.ts b/k.ts
--- a/k.ts
+++ b/k.ts
@@ -1 +1,2 @@
 const a = 1;
+const b = 2;
`;

describe("redaction failure fails closed", () => {
  it("returns UNAVAILABLE and never calls the model when redaction throws", async () => {
    let calls = 0;
    const model = {
      async evaluate(input: { state: { diff: string }; questions: Record<string, unknown> }) {
        calls++;
        return {
          answers: Object.fromEntries(
            Object.keys(input.questions).map((id) => [id, { type: "noul", noul: 0.1 }]),
          ),
        };
      },
    };
    const svc = new ReviewService(model as never, { checks: CHECKS, ...READY });
    const result = await svc.review({ diff: benignDiff, files: [] });
    expect(calls).toBe(0);
    expect(result.lane).toBe("UNAVAILABLE");
    expect(result.lane).not.toBe("MERGE");
    expect(result.findings[0]?.id).toBe("review:redaction-failed");
  });
});
