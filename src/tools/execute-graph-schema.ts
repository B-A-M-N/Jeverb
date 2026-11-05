/**
 * `jev_execute_graph` — run a bounded DAG of shell commands and Jev
 * judgments without returning to the planning model between steps.
 *
 * Every shell node is authorized by the same deterministic policy as
 * `PreToolUse` (see `src/graph/authorizer.ts`): a graph can never execute
 * what a hook would deny. Jev node outputs are evidence, never
 * authorization. A shell node dispatched on a Jev decision is a protected
 * (consequential) successor: it additionally requires a verifier-attested
 * consequential-routing qualification bound to the actual deployment and
 * live judgment, provisioned by the operator (see
 * `resolveRoutingAdmission`). Without one the branch is refused and the
 * node settles `skipped`, however permissive the shell policy. Review nodes
 * consume complete diffs and return typed review lanes; dependent shell
 * nodes must require `MERGE` and still pass deterministic authorization.
 */

import { z } from "zod";
import { questionSchema } from "./shared.js";

export const name = "jev_execute_graph";

export const description = [
  "Run bounded DAGs of shell, Jev, and review nodes with dependency ordering, conditional branches, loops, dynamic expansion, and retries.",
  "Shell nodes execute commands on this machine and may change files or cause external effects. Each must pass deterministic policy; retries require idempotent:true and operator permission.",
  "Jev answers are advisory evidence and never authorize execution. Named typed questions, bounded json/lines extraction, and confined project/global extractor plugins are supported. Policy-checked extractor ctx.exec runs through the constrained runner; network requires graph policy.",
  "Shells receive dependency data only through bounded JIVE_REF_* bindings, never source interpolation.",
].join("\n");

const graphNodeFields = {
  id: z.string().min(1),
  command: z.string().optional(),
  question: z.string().optional(),
  questions: z.record(z.string().min(1).max(64), questionSchema).optional()
    .describe("Named typed Jev questions evaluated together against this node's dependency evidence."),
  diffFrom: z.string().min(1).optional().describe("For a review node, the declared shell dependency whose complete output is the unified diff."),
  files: z.array(z.string()).optional().describe("Paths associated with the diff; metadata only."),
  bindings: z.array(z.object({
    from: z.string().min(1).describe("Declared dependency whose output supplies the input value."),
    as: z.string().regex(/^[A-Z][A-Z0-9_]{0,60}$/).describe("Name exposed in the sandbox as JIVE_REF_<name>."),
    pointer: z.string().startsWith("/").optional().describe("Optional RFC 6901 JSON pointer into JSON output."),
  })).max(32).optional().describe("Explicit output references passed as bounded environment data; never interpolated into shell source."),
  extractors: z.array(z.object({
    from: z.string().min(1).describe("Declared dependency whose complete output is transformed."),
    as: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/).describe("Field name in the extracted Jev state."),
    extractor: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).describe("Built-in json/lines extractor or installed project/global plugin name."),
    config: z.record(z.string(), z.unknown()).optional().describe("JSON configuration passed to the named extractor plugin."),
    pointer: z.string().startsWith("/").optional().describe("Optional RFC 6901 pointer for JSON extraction."),
    maxItems: z.number().int().min(1).max(256).optional().describe("Maximum non-empty lines for the lines extractor."),
  })).max(16).optional().describe("Ordered extraction steps that provide structured data to Jev; modules run in a read-only OS sandbox."),
  dependsOn: z.array(z.string()).optional(),
  maxAttempts: z.number().int().min(1).max(3).optional(),
  parallel: z.boolean().optional(),
  when: z.boolean().optional(),
  whenAll: z.array(z.string().min(1)).optional().describe("Run only if every listed dependency succeeded; otherwise skip. Entries must name declared dependsOn."),
  whenAny: z.array(z.string().min(1)).optional().describe("Run if at least one listed dependency succeeded; otherwise skip. Entries must name declared dependsOn."),
  condition: z.discriminatedUnion("field", [
    z.object({
      node: z.string().min(1),
      field: z.literal("decision.verdict"),
      equals: z.enum(["yes", "no", "unknown"]),
      minConfidence: z.number().gt(0).lt(1).optional(),
    }),
    z.object({
      node: z.string().min(1),
      field: z.literal("decision.choice"),
      question: z.string().min(1).max(64),
      equals: z.string(),
      minConfidence: z.number().gt(0).lt(1).optional(),
    }),
    z.object({
      node: z.string().min(1),
      field: z.literal("decision.score"),
      question: z.string().min(1).max(64),
      operator: z.enum(["gte", "lte"]),
      value: z.number().finite(),
      minConfidence: z.number().gt(0).lt(1).optional(),
    }),
    z.object({
      node: z.string().min(1),
      field: z.literal("review.lane"),
      equals: z.enum(["BLOCK", "SECURITY REVIEW", "NITS", "MERGE", "UNAVAILABLE"]),
    }),
  ]).optional().describe("Branch on typed Jev verdict/choice/score answers or review lanes. A shell node depending on review must require MERGE; deterministic authorization still runs before execution."),
  repeat: z.number().int().min(1).max(3).optional(),
  idempotent: z.boolean().optional(),
  captureOutput: z.boolean().optional().describe("Persist this node's complete output as a private artifact retrievable with jev_read_graph_output. Explicitly opt in only when the full output is needed."),
};

const templateNodeSchema = z.object({
  ...graphNodeFields,
  kind: z.enum(["shell", "jev", "review"]),
}).strict();

const graphNodeSchema = z.object({
  ...graphNodeFields,
  kind: z.enum(["shell", "jev", "review", "expand"]),
  expansion: z.object({
    itemsFrom: z.string().min(1).describe("Declared dependency whose complete output contains a JSON array."),
    pointer: z.string().startsWith("/").optional().describe("Optional RFC 6901 pointer selecting the array from JSON output."),
    as: z.string().regex(/^[A-Z][A-Z0-9_]{0,60}$/).describe("Dynamic item variable available as JIVE_REF_<name> to shell templates and as expansionItem to Jev templates."),
    maxItems: z.number().int().min(1).max(32),
    nodes: z.array(templateNodeSchema).min(1).max(32).describe("Per-item DAG template. Templates cannot recursively expand."),
  }).optional().describe("Runtime bounded fan-out. The source node must capture output and operator policy must enable artifacts so expansion can recover safely after restart."),
});

const graphSchema = z.object({
  version: z.literal(1),
  nodes: z.array(graphNodeSchema).min(1),
  loops: z.array(z.object({
    id: z.string().min(1).max(40),
    nodes: z.array(z.string().min(1)).min(1).max(64),
    iterations: z.number().int().min(1).max(3),
  })).max(16).optional().describe("Fixed iteration groups. Body nodes expand to stable <loop>/<iteration>/<node> identities; downstream references use the final iteration. Loops cannot branch on model output."),
  parallel: z.boolean().optional(),
});

export const inputShape = {
  graph: graphSchema.describe("The DAG to execute: shell nodes run authorized commands, jev nodes provide advisory judgments, review nodes review a dependency's complete diff, fixed-count loops expand into bounded iterations, and expand nodes instantiate bounded template subgraphs from a dependency's JSON array."),
  source: z
    .string()
    .min(1)
    .max(200)
    .describe(
      "CLAIMED submitter (host, caller, candidate id): descriptive only, never authority. Recorded in the journal as claimedSource; graphs without one are rejected. To impersonate an operator here changes nothing — authorization never reads this field.",
    ),
  runId: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe("To resume, supply a prior runId. Jeverb reads and validates the durable journal itself; caller-supplied node outcomes are never accepted. Omit for a fresh run."),
} as const;

export const inputSchema = z.object(inputShape).strict();
export type ExecuteGraphToolInput = z.infer<typeof inputSchema>;

const nodeResultSchema = z.object({
  nodeId: z.string(),
  ok: z.boolean(),
  output: z.string(),
  attempts: z.number().int(),
  status: z
    .enum(["succeeded", "failed", "skipped", "blocked", "cancelled", "outcome_unknown"])
    .describe("Terminal node state. Only succeeded counts as done."),
  inputHash: z.string().describe("sha256 of the stable node descriptor."),
  outputAvailable: z.boolean().optional().describe("False means the prior run's output content was not persisted and is unavailable as evidence."),
  outputHash: z.string().describe("sha256 of the recorded (possibly truncated) output excerpt."),
  outputDigest: z.string().describe("sha256 of the FULL node output, not the excerpt."),
  outputArtifact: z.string().optional().describe("Opaque id for a private full-output artifact; use jev_read_graph_output to retrieve it."),
  outputArtifactError: z.string().optional().describe("Why a requested full-output artifact could not be persisted."),
  resumed: z.boolean().optional().describe("True when this record reuses a prior run's succeeded outcome (restart after crash) instead of executing now. A resumed record never re-ran the command."),
  jev: z.object({
    answers: z.record(z.string(), z.discriminatedUnion("type", [
      z.object({ type: z.literal("choice"), choice: z.string(), probabilities: z.record(z.string(), z.number().finite().min(0).max(1)), confidence: z.number().finite().min(0).max(1) }),
      z.object({ type: z.literal("score"), score: z.number().finite(), legend: z.record(z.string(), z.string()), probabilities: z.record(z.string(), z.number().finite().min(0).max(1)).optional(), confidence: z.number().finite().min(0).max(1) }),
      z.object({ type: z.literal("noul"), noul: z.number().finite().min(0).max(1) }),
    ])).optional(),
    provider: z.string(),
    questionHash: z.string(),
    calibrated: z.boolean(),
    verdict: z.enum(["yes", "no", "unknown"]).optional(),
    noul: z.number().finite().min(0).max(1).optional(),
  }).optional().describe("Typed Jev answers and provider/question provenance. These are advisory evidence, never authorization."),
  review: z.object({
    lane: z.enum(["BLOCK", "SECURITY REVIEW", "NITS", "MERGE", "UNAVAILABLE"]),
    source: z.enum(["deterministic", "jev", "combined"]),
    findings: z.array(z.object({
      id: z.string(), severity: z.string(), message: z.string(), path: z.string().optional(), line: z.number().optional(),
    })),
    probabilities: z.record(z.string(), z.number()).optional(),
    policyVersion: z.string(),
    calibration: z.object({
      provider: z.string(), model: z.string(), modelVersion: z.string(), questionHash: z.string(),
      calibrationVersion: z.string(), calibrated: z.boolean(), advisory: z.boolean(), reason: z.string().optional(),
    }).optional(),
  }).optional().describe("Typed review result. A MERGE lane is evidence only; shell authorization remains separate."),
});

export const outputShape = {
  results: z.array(nodeResultSchema).describe("One entry per settled node, in execution order."),
  succeeded: z.number().int().describe("Nodes that ran successfully (skips, blocks, cancellations excluded)."),
  failed: z.number().int().describe("Nodes that failed, were denied, blocked, cancelled, or have an unknown side-effect outcome."),
  skipped: z.number().int().describe("Nodes skipped by a false `when` condition."),
  source: z.string().describe("The declared submitter this run is attributed to."),
  policyHash: z.string().describe("sha256 of the canonical execution policy: node input hashes already mix this in, so identical commands under different policies never share a hash."),
  runId: z.string().describe("Stable run identifier; every journal event carries it."),
  principal: z.string().describe("Authenticated principal for this run (unverified:mcp-stdio on this transport). The claimed source is journaled separately and grants nothing."),
  candidate: z.string().optional().describe("Candidate/operation correlation when supplied out-of-band; absent otherwise."),
  graphHash: z.string().describe("sha256 of the canonical graph: rerunning different graphs under one runId is rejected by reconciliation."),
  journalPath: z.string().describe("Fsync'd per-node journal in the configured plugin data directory: run-started, node-authorized, node-running, node-terminal. A persisted running without a resolving terminal is outcome_unknown; a blocked record from refusing a retry does not resolve it. Reconcile, never blind-retry."),
  evidenceReceipts: z.object({
    status: z.enum(["persisted", "partial", "unavailable"]),
    appended: z.number().int(),
    duplicate: z.number().int(),
    unavailable: z.number().int(),
    conflict: z.number().int(),
    correlationIds: z.array(z.string()),
  }).describe("Compact terminal records projected into the shared evidence ledger. Output text is excluded. An unavailable status means execution results remain in the journal but ledger projection failed."),
} as const;

export const outputSchema = z.object(outputShape);
export type ExecuteGraphToolOutput = z.infer<typeof outputSchema>;

