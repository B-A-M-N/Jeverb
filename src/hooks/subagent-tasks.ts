/**
 * Subagent-task domain: the task a parent handed a subagent, per session.
 *
 * Pure transitions over task lists; `Store` applies these inside its
 * transactional session update. Only a type reference to `store.ts`
 * (`SessionState`) would be needed and is avoided — transitions operate on
 * task lists, so the runtime direction stays one-way. `store.ts` re-exports
 * the vocabulary for existing importers.
 */

/** Subagent spawns kept per session. Parallel fan-out is rarely wider. */
export const MAX_SUBAGENT_TASKS = 8;
/** A spawn recorded and never consumed stops standing in for a request. */
export const SUBAGENT_TASK_TTL_MS = 30 * 60 * 1000;

/**
 * The task a subagent was given, captured from the parent's `Agent` spawn.
 *
 * It exists because a tool call made inside a subagent is scored against the
 * *user's* prompts today, and the subagent is not doing what the user last
 * asked for — it is doing what the parent told it to. Four of the five model
 * trips in the first live week were that mistake. The prompt here is the
 * parent's own text, not a file and not a tool result.
 */
export interface SubagentTask {
  agent_type: string;
  spawn_tool_use_id?: string;
  subagent_id?: string;
  child_session_id?: string;
  /** Redacted and clamped by the caller. */
  prompt: string;
  ts: number;
}

/** Live spawns, expired ones dropped. */
export function liveSubagentTasks(tasks: readonly SubagentTask[], now: number): SubagentTask[] {
  return tasks.filter((task) => now - task.ts <= SUBAGENT_TASK_TTL_MS);
}

/** Host-issued identity bound to an exact spawn call or unique task type. */
export interface SubagentTaskBinding {
  subagentId?: string;
  childSessionId?: string;
  parentToolUseId?: string;
}

/**
 * Pure session-state transitions for subagent tasks. `Store` applies these
 * inside its transactional session update; the logic itself is IO-free and
 * unit-testable here.
 */

/** Record the task a parent just handed a subagent, capping the list. */
export function applyRememberSubagentTask(
  tasks: readonly SubagentTask[],
  task: SubagentTask,
  now: number,
): SubagentTask[] {
  return [...liveSubagentTasks(tasks, now), task].slice(-MAX_SUBAGENT_TASKS);
}

/** Bind a host-issued identity to the single unbound task it identifies. */
export function applyBindSubagentTask(
  tasks: readonly SubagentTask[],
  agentType: string,
  identity: SubagentTaskBinding,
  now: number,
): { tasks: SubagentTask[]; bound: boolean } {
  const live = liveSubagentTasks(tasks, now);
  const indexes = live
    .map((task, index) => ({ task, index }))
    .filter(({ task }) =>
      task.agent_type === agentType && task.subagent_id === undefined && task.child_session_id === undefined &&
      (identity.parentToolUseId === undefined || task.spawn_tool_use_id === identity.parentToolUseId),
    )
    .map(({ index }) => index);
  if (indexes.length !== 1) return { tasks: [...tasks], bound: false };
  const index = indexes[0]!;
  const task = live[index]!;
  const next = [...live];
  next[index] = {
    ...task,
    ...(identity.subagentId === undefined ? {} : { subagent_id: identity.subagentId }),
    ...(identity.childSessionId === undefined ? {} : { child_session_id: identity.childSessionId }),
  };
  return { tasks: next, bound: true };
}

/**
 * The live task for this agent type, when there is exactly one.
 *
 * Reads without consuming. Two live tasks of the same type means two
 * same-type subagents running in parallel and nothing here can say which
 * one is calling, so the answer is "unknown" rather than a guess.
 */
export function selectSubagentTask(
  tasks: readonly SubagentTask[],
  agentType: string,
  identity: string | undefined,
  now: number,
): SubagentTask | undefined {
  const matching = liveSubagentTasks(tasks, now).filter((task) => {
    if (identity !== undefined) return task.subagent_id === identity || task.child_session_id === identity;
    return task.agent_type === agentType;
  });
  return matching.length === 1 ? matching[0] : undefined;
}

/**
 * Remove the single task an identity (or agent type) identifies. Returns
 * `undefined` when no task list should remain, so the caller can drop the
 * session key instead of storing an empty list.
 */
export function applyDropSubagentTask(
  tasks: readonly SubagentTask[],
  agentType: string,
  identity: string | undefined,
  now: number,
): SubagentTask[] | undefined {
  const live = liveSubagentTasks(tasks, now);
  const matching = live.filter((task) => identity !== undefined
    ? task.subagent_id === identity || task.child_session_id === identity
    : task.agent_type === agentType);
  if (matching.length !== 1) return [...tasks];
  const remaining = live.filter((task) => task !== matching[0]);
  return remaining.length > 0 ? remaining : undefined;
}

/** Split the overloaded trailing args of take/drop into identity and clock. */
export function parseTaskIdentity(identityOrNow?: string | number, maybeNow?: string | number): { identity: string | undefined; now: number } {
  const identity = [identityOrNow, maybeNow].find((value): value is string => typeof value === "string");
  const now = typeof identityOrNow === "number" ? identityOrNow : typeof maybeNow === "number" ? maybeNow : Date.now();
  return { identity, now };
}
