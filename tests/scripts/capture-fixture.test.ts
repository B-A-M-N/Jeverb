import { describe, expect, it } from "vitest";
import { capture } from "../../scripts/capture-fixture.js";

describe("capture-fixture privacy boundary", () => {
  it("drops free-form reasons that can contain paths or user text", () => {
    const captured = capture(
      [
        {
          event: "PreToolUse",
          decision: "trip",
          signals: { credential_exposure: 0.91 },
          prefilter: "argument names sensitive material (/home/person/.aws/credentials)",
          reasons: ["private user-provided text: CAPTURE-PRIVATE-MARKER"],
        },
      ],
      1,
    );

    const serialized = JSON.stringify(captured);
    expect(serialized).not.toContain("CAPTURE-PRIVATE-MARKER");
    expect(serialized).not.toContain("/home/person/.aws/credentials");
    expect(captured[0]?.prefilter).toBe("argument names sensitive material");
    expect(captured[0]).not.toHaveProperty("reasons");
  });
});
