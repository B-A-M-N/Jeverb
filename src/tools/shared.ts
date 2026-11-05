/**
 * Pieces every tool shares: zod fragments, the state/question normalizers that
 * keep `exactOptionalPropertyTypes` happy, and a bounded-concurrency mapper.
 *
 * Nothing here imports the Jev client. Tools are written against the
 * `DecisionModel` contract so they can be tested with a fake and reused with a
 * different provider.
 */

import { z } from "zod";
import type { GateThresholds } from "../decision/types.js";
import { mapWithConcurrency, sumUsage } from "../util/concurrency.js";
export { jsonRecord, toInstructions, toQuestion, toState, type QuestionInput, type ToolConfig } from "./runtime-shared.js";

// --------------------------------------------------------------- zod fragments

/** A JSON value, one level of structure deep enough for state and criteria. */
const jsonValue = z.unknown();

export const stateSchema = z
  .union([z.string(), z.array(jsonValue), z.record(z.string(), jsonValue)])
  .describe("The content to judge: a plain string, or structured data that questions reference by path.");

export const instructionsSchema = z
  .union([z.string(), z.array(jsonValue), z.record(z.string(), jsonValue)])
  .describe("The question itself. Write it in full; question ids are never sent to the model.");

export const thresholdsSchema = z
  .object({
    auto: z.number().min(0).max(1).optional().describe("At or above this certainty, act automatically."),
    review: z.number().min(0).max(1).optional().describe("At or above this certainty (but below auto), proceed with care."),
  })
  .optional()
  .describe("Override the server's configured gating thresholds for this call only.");

export const gateSchema = z.enum(["auto", "review", "escalate"]);

export const usageSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
});

/** Fields every tool result carries, as a raw shape to spread into outputs. */
export const envelopeShape = {
  model: z.string().describe("The versioned model id that actually answered."),
  usage: usageSchema.describe("Token usage. Jev charges for input tokens only."),
  latency_ms: z.number().describe("Wall-clock time for the underlying API call(s), including retries."),
} as const;

// ---------------------------------------------------------------- normalizers

/**
 * A rubric entry, prose or structure.
 *
 * Non-recursive on purpose: `z.unknown()` inside the array and record arms
 * means zod 4 inlines the whole union, so the JSON Schema the MCP client sees
 * carries no `$ref` — and a `$ref` is what some clients silently drop.
 */
const entrySchema = z
  .union([z.string(), z.array(z.unknown()), z.record(z.string(), z.unknown()), z.null()])
  .describe(
    "A rubric entry: a string, or JSON structure such as {what, not_for, examples} / {summary, signals}.",
  );

export const choiceQuestionSchema = z.object({
  type: z.literal("choice"),
  instructions: instructionsSchema,
  criteria: z
    .record(z.string(), entrySchema)
    .describe("option -> rubric. Use null when the option name says it all. At least 2 options; add an 'other'/'none' escape hatch."),
});

export const scoreQuestionSchema = z.object({
  type: z.literal("score"),
  instructions: instructionsSchema,
  criteria: z.array(entrySchema).min(2).describe("Ordered level descriptions, lowest first. At least 2."),
});

export const noulQuestionSchema = z.object({
  type: z.literal("noul"),
  instructions: instructionsSchema,
  criteria: z
    .object({ true: entrySchema.optional(), false: entrySchema.optional() })
    .optional()
    .describe("Optional clarification of what yes and no mean. Keep them aligned with the instructions."),
});

export const questionSchema = z.discriminatedUnion("type", [
  choiceQuestionSchema,
  scoreQuestionSchema,
  noulQuestionSchema,
]);

// ------------------------------------------------------------------- utilities

export { mapWithConcurrency, sumUsage };
