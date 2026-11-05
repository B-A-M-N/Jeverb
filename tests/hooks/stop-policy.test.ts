import { describe, expect, it } from "vitest";
import { stopRequestOf, STOP_QUESTIONS } from "../../src/hooks/handlers/stop.js";

describe("Stop request builder", () => {
  it("builds the host classification state and complete question set", () => {
    const request = { latest: "Implement the fix", previous: ["Investigate the failure"] };
    const message = "The requested fix is complete and verified.";

    expect(stopRequestOf(request, message)).toEqual({
      state: {
        request,
        final_message: message,
      },
      questions: STOP_QUESTIONS,
    });
    expect(Object.keys(STOP_QUESTIONS).sort()).toEqual([
      "addresses_request",
      "asks_user",
      "claims_complete",
      "claims_verified",
      "says_check_failing",
      "says_part_not_done",
      "says_step_deferred",
    ]);
  });
});
