import { describe, expect, it } from "vitest";
import {
  applyBindSubagentTask,
  applyDropSubagentTask,
  applyRememberSubagentTask,
  liveSubagentTasks,
  MAX_SUBAGENT_TASKS,
  parseTaskIdentity,
  selectSubagentTask,
  SUBAGENT_TASK_TTL_MS,
  type SubagentTask,
} from "../../src/hooks/subagent-tasks.js";

const task = (overrides: Partial<SubagentTask> = {}): SubagentTask => ({
  agent_type: "Explore",
  prompt: "survey the repo",
  ts: 1000,
  ...overrides,
});

describe("liveSubagentTasks", () => {
  it("drops expired spawns", () => {
    const tasks = [task({ ts: 1 }), task({ ts: 2000 })];
    expect(liveSubagentTasks(tasks, 2000 + SUBAGENT_TASK_TTL_MS).map((t) => t.ts)).toEqual([2000]);
  });
});

describe("subagent task transitions", () => {
  it("remember caps the list", () => {
    const many = Array.from({ length: MAX_SUBAGENT_TASKS + 3 }, (_, i) => task({ prompt: `t-${i}`, ts: 2000 }));
    const remembered = applyRememberSubagentTask(many, task({ prompt: "new", ts: 2000 }), 2000);
    expect(remembered).toHaveLength(MAX_SUBAGENT_TASKS);
    expect(remembered[remembered.length - 1]?.prompt).toBe("new");
  });

  it("bind attaches identity only when exactly one unbound task matches", () => {
    const tasks = [task({ spawn_tool_use_id: "u-1" }), task({ agent_type: "Worker", spawn_tool_use_id: "u-1" })];
    const { tasks: bound, bound: ok } = applyBindSubagentTask(tasks, "Explore", { parentToolUseId: "u-1" }, 2000);
    expect(ok).toBe(true);
    expect("subagent_id" in bound[0]!).toBe(false);
    const withId = applyBindSubagentTask(bound, "Explore", { subagentId: "child-a" }, 2000);
    expect(withId.bound).toBe(true);
    expect(withId.tasks[0]).toMatchObject({ subagent_id: "child-a" });
    const ambiguous = applyBindSubagentTask(
      [task({ spawn_tool_use_id: "u-1" }), task({ agent_type: "Explore", spawn_tool_use_id: "u-1" })],
      "Explore",
      {},
      2000,
    );
    expect(ambiguous.bound).toBe(false);
  });

  it("select returns the task only when exactly one matches", () => {
    const tasks = [task({ subagent_id: "child-a" }), task({ subagent_id: "child-b", agent_type: "Worker" })];
    expect(selectSubagentTask(tasks, "Explore", "child-a", 2000)?.subagent_id).toBe("child-a");
    expect(selectSubagentTask(tasks, "Explore", "child-b", 2000)?.subagent_id).toBe("child-b");
    expect(selectSubagentTask([task(), task()], "Explore", undefined, 2000)).toBeUndefined();
    expect(selectSubagentTask(tasks, "Explore", "missing", 2000)).toBeUndefined();
  });

  it("drop removes the single match and reports an empty list for key deletion", () => {
    const tasks = [task({ subagent_id: "child-a" }), task({ subagent_id: "child-b" })];
    expect(applyDropSubagentTask(tasks, "Explore", "child-a", 2000)?.map((t) => t.subagent_id)).toEqual(["child-b"]);
    expect(applyDropSubagentTask([task({ subagent_id: "child-a" })], "Explore", "child-a", 2000)).toBeUndefined();
    const kept = applyDropSubagentTask(tasks, "Explore", "missing", 2000);
    expect(kept?.map((t) => t.subagent_id)).toEqual(["child-a", "child-b"]);
  });

  it("parseTaskIdentity splits overloaded trailing args", () => {
    expect(parseTaskIdentity("child-a", 2000)).toEqual({ identity: "child-a", now: 2000 });
    expect(parseTaskIdentity(2000)).toEqual({ identity: undefined, now: 2000 });
    expect(parseTaskIdentity("child-a")).toMatchObject({ identity: "child-a" });
  });
});
