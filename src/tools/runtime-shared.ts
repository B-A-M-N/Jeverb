/** Runtime helpers shared by the host graph runner and MCP tool wrappers.
 *
 * This module deliberately contains no schema-library imports so host hooks
 * can reuse the graph execution path without bundling MCP validation code.
 */
import type { EntryType, GateThresholds, Instructions, Json, Question, State } from "../decision/types.js";
import type { FileAccessOptions } from "../files/index.js";
import type { ExecutionPolicy } from "../graph/policy.js";
import type { ReviewService } from "../review/service.js";

export function toState(value: string | unknown[] | Record<string, unknown>): State {
  return value as State;
}

export function toInstructions(value: string | unknown[] | Record<string, unknown>): Instructions {
  return value as Instructions;
}

type EntryInput = string | unknown[] | Record<string, unknown> | null;

export type QuestionInput =
  | { type: "choice"; instructions: string | unknown[] | Record<string, unknown>; criteria: Record<string, EntryInput> }
  | { type: "score"; instructions: string | unknown[] | Record<string, unknown>; criteria: EntryInput[] }
  | { type: "noul"; instructions: string | unknown[] | Record<string, unknown>; criteria?: { true?: EntryInput | undefined; false?: EntryInput | undefined } | undefined };

function toEntry(value: EntryInput): EntryType {
  return value as EntryType;
}

export function toQuestion(input: QuestionInput): Question {
  switch (input.type) {
    case "choice": {
      const criteria: Record<string, EntryType> = {};
      for (const [option, entry] of Object.entries(input.criteria)) criteria[option] = toEntry(entry);
      return { type: "choice", instructions: toInstructions(input.instructions), criteria };
    }
    case "score":
      return { type: "score", instructions: toInstructions(input.instructions), criteria: input.criteria.map((entry) => toEntry(entry)) };
    case "noul": {
      const criteria: { true?: EntryType; false?: EntryType } = {};
      if (input.criteria?.true !== undefined) criteria.true = toEntry(input.criteria.true);
      if (input.criteria?.false !== undefined) criteria.false = toEntry(input.criteria.false);
      const question: Question = { type: "noul", instructions: toInstructions(input.instructions) };
      return Object.keys(criteria).length === 0 ? question : { ...question, criteria };
    }
  }
}

export interface ToolConfig {
  model: string;
  thresholds: GateThresholds;
  maxConcurrency: number;
  rankMaxCandidatesPerRequest?: number | undefined;
  maxConcurrencyExplicit?: boolean | undefined;
  files?: FileAccessOptions | undefined;
  execution?: ExecutionPolicy | undefined;
  review?: ReviewService | undefined;
  dataDir?: string | undefined;
  /** Host-only fresh journal identity; never accepted through MCP tool input. */
  initialRunId?: string | undefined;
  masterSwitchPath?: string | undefined;
  museSessionId?: string | undefined;
}

export { mapWithConcurrency, sumUsage } from "../util/concurrency.js";

export function jsonRecord(value: Record<string, Json>): Record<string, Json> {
  return value;
}
