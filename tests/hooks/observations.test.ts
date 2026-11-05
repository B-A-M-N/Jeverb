import { describe, expect, it } from "vitest";
import { EMPTY_SESSION, type SessionState } from "../../src/hooks/store.js";
import {
  applyRememberReissue,
  claimPostTx,
  claimStopTx,
  foldPostTx,
  postObservationKey,
  takeReissueTx,
} from "../../src/hooks/observations.js";

const state = (overrides: Partial<SessionState> = {}): SessionState => ({ ...EMPTY_SESSION, ...overrides });

describe("observation transactions", () => {
  it("builds a policy-versioned claim key per scope", () => {
    expect(postObservationKey("u-1", "state")).not.toBe(postObservationKey("u-1", "receipt"));
    expect(postObservationKey("u-1", "state")).not.toBe(postObservationKey("u-2", "state"));
  });

  it("claimStopTx claims once, then asks for no write", () => {
    const first = claimStopTx(state(), "stop-1", 3);
    expect(first?.value).toBe("claimed");
    expect(first?.state.stop_blocks).toBe(1);
    expect(first?.state.stop_interventions).toEqual(["stop-1"]);
    const dup = claimStopTx(first!.state, "stop-1", 3);
    expect(dup).toBeUndefined();
    const capped = claimStopTx(state({ stop_blocks: 3 }), "stop-2", 3);
    expect(capped).toBeUndefined();
    const revised = claimStopTx(state(), "stop-1", 3, "rev-a");
    expect(revised?.state.stop_block_revisions).toEqual(["rev-a"]);
  });

  it("applyRememberReissue caps the list", () => {
    const pending = applyRememberReissue(undefined, { tool_use_id: "u-1", ts: 1, tool_name: "Bash" });
    expect(pending).toHaveLength(1);
    const many = Array.from({ length: 25 }, (_, i) => ({ tool_use_id: `u-${i}`, ts: i, tool_name: "Bash" }));
    expect(applyRememberReissue(many, { tool_use_id: "u-new", ts: 99, tool_name: "Bash" })).toHaveLength(20);
  });

  it("claimPostTx claims once, then asks for no write", () => {
    const key = postObservationKey("u-1", "state");
    const first = claimPostTx(key, 1000)!(state());
    expect(first?.value).toBe(true);
    expect(claimPostTx(key, 1000)!(first!.state)).toBeUndefined();
  });

  it("foldPostTx folds once with the claim in one state", () => {
    const key = postObservationKey("u-1", "receipt");
    const fold = (s: SessionState): SessionState => ({ ...s, stop_blocks: s.stop_blocks + 10 });
    const first = foldPostTx(key, 1000, fold)!(state());
    expect(first?.value).toBe("folded");
    expect(first?.state.stop_blocks).toBe(10);
    expect(first?.state.processed_posts).toHaveLength(1);
    expect(foldPostTx(key, 1000, fold)!(first!.state)).toBeUndefined();
  });

  it("takeReissueTx consumes exactly the matching re-issue", () => {
    const pending = [
      { tool_use_id: "u-1", ts: 1, tool_name: "Bash" },
      { tool_use_id: "u-2", ts: 2, tool_name: "Bash" },
    ];
    const took = takeReissueTx("u-1")!(state({ pending_reissues: pending }));
    expect(took?.value.tool_use_id).toBe("u-1");
    expect(took?.state.pending_reissues?.map((p) => p.tool_use_id)).toEqual(["u-2"]);
    expect(takeReissueTx("missing")!(state({ pending_reissues: pending }))).toBeUndefined();
  });
});
