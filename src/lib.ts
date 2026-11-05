/**
 * Public library entry.
 *
 * MCP is one way to reach the decision layer; embedding it directly is the
 * other, and for mandatory checks the better one. Import `JevDecisionModel`
 * plus the `run*` functions and call them at your harness's boundaries — a
 * check an agent can decline to call is not a check.
 */

// The contract.
export type {
  Answer,
  AnswerFor,
  ChoiceAnswer,
  ChoiceQuestion,
  DecisionEvidence,
  DecisionKind,
  DecisionModel,
  EvaluateRequest,
  EvaluateResult,
  Gate,
  GateThresholds,
  Instructions,
  Json,
  NoulAnswer,
  NoulQuestion,
  Question,
  RoutingMode,
  ScoreAnswer,
  ScoreQuestion,
  State,
  Usage,
  VerificationDecision,
} from "./decision/types.js";
export type { ListModelsResult, ModelCatalog, ModelInfo } from "./decision/models.js";
export { isModelCatalog } from "./decision/models.js";

// Policy, budget, validation.
export {
  DEFAULT_THRESHOLDS,
  gate,
  gateChoice,
  gateNoul,
  gateScore,
  isUncertain,
  lean,
  resolveThresholds,
  type Lean,
  type NoulDirection,
  type NoulGate,
} from "./decision/policy.js";
export {
  BudgetError,
  CHARS_PER_TOKEN,
  checkBudget,
  DEFAULT_BUDGET_LIMITS,
  estimateBudget,
  estimateQuestionTokens,
  estimateTokens,
  fitsBudget,
  type BudgetEstimate,
  type BudgetLimitName,
  type BudgetLimits,
} from "./decision/budget.js";
export { validateQuestions, ValidationError } from "./decision/validate.js";

// The Jev implementation.
export { computeBackoffMs, JevDecisionModel, parseRetryAfter, type JevDecisionModelOptions } from "./jev/client.js";
export { DEFAULT_JEV_GATEWAY_BASE_URL, DEFAULT_JEV_GATEWAY_MODEL, JevGatewayDecisionModel } from "./jev/gateway.js";
export {
  describeError,
  JevAuthError,
  JevConnectionError,
  JevError,
  JevOverloadedError,
  JevProtocolError,
  JevRateLimitError,
  JevTimeoutError,
  JevValidationError,
  type JevErrorOptions,
} from "./jev/errors.js";

// Config and MCP assembly, for harnesses that want to expose the same tools.
export {
  DEFAULTS,
  loadConfig,
  missingApiKeyMessage,
  MISSING_API_KEY_MESSAGE,
  OPENROUTER_DEFAULTS,
  JEV_GATEWAY_DEFAULTS,
  type Config,
  type ConfigBackend,
  type Env,
} from "./config.js";
export { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

// Shared tool plumbing.
export { mapWithConcurrency, sumUsage, type ToolConfig } from "./tools/shared.js";

// Each tool's pure `run`, plus its schemas and description.
export {
  augment,
  description as evaluateDescription,
  inputSchema as evaluateInputSchema,
  outputSchema as evaluateOutputSchema,
  run as runEvaluate,
  type EvaluateToolInput,
  type EvaluateToolOutput,
  type GatedAnswer,
} from "./tools/evaluate.js";

export {
  chunkCandidates,
  description as rankDescription,
  inputSchema as rankInputSchema,
  outputSchema as rankOutputSchema,
  run as runRank,
  type RankToolInput,
  type RankToolOutput,
} from "./tools/rank.js";

export {
  description as pickDescription,
  inputSchema as pickInputSchema,
  NONE_KEY as PICK_NONE_KEY,
  outputSchema as pickOutputSchema,
  PickInputError,
  run as runPick,
  type PickToolInput,
  type PickToolOutput,
} from "./tools/pick.js";

export {
  allSupported,
  description as verifyDescription,
  inputSchema as verifyInputSchema,
  outputSchema as verifyOutputSchema,
  run as runVerify,
  VERDICTS,
  type ClaimResult,
  type Verdict,
  type VerifyToolInput,
  type VerifyToolOutput,
} from "./tools/verify.js";

export {
  DECISIONS,
  description as gateActionDescription,
  gateActionPolicy,
  HIGH_BLAST_RADIUS,
  QUESTIONS as GATE_ACTION_QUESTIONS,
  inputSchema as gateActionInputSchema,
  outputSchema as gateActionOutputSchema,
  run as runGateAction,
  type ActionDecision,
  type GateActionCoreInput,
  type GateActionCoreResult,
  type GateActionPolicyInput,
  type GateActionPolicyOptions,
  type GateActionPolicyResult,
  type GateActionRunConfig,
  type GateActionSignals,
  type GateActionToolInput,
  type GateActionToolOutput,
  type UncertainMode,
} from "./tools/gate-action.js";

export {
  description as nextStepDescription,
  inputSchema as nextStepInputSchema,
  MAX_RETRY_ATTEMPTS,
  NEXT_STEP_QUESTIONS,
  NEXT_STEPS,
  nextStepPolicy,
  outputSchema as nextStepOutputSchema,
  run as runNextStep,
  type NextStep,
  type NextStepPolicyInput,
  type NextStepPolicyResult,
  type NextStepSignals,
  type NextStepToolInput,
  type NextStepToolOutput,
} from "./tools/next-step.js";

export {
  CONTROL_ACTIONS,
  decideControlAction,
  MAX_CONTROL_ATTEMPTS,
  type ControlAction,
  type ControlDecision,
  type ControllerInput,
  type CorrectiveAction,
  type CorrectiveDefectKind,
  type CorrectiveStep,
  type ControlModelHint,
  type PriorControlAction,
} from "./decision/control.js";

export {
  description as listModelsDescription,
  inputSchema as listModelsInputSchema,
  outputSchema as listModelsOutputSchema,
  run as runListModels,
  type ListModelsToolInput,
  type ListModelsToolOutput,
} from "./tools/list-models.js";

// Unified Jeverb contracts and subsystems (additive, stable APIs untouched).
export type {
  DecisionSource,
  Enforcement,
  EvidenceRef,
  UnifiedDecision,
} from "./decision/types.js";
export {
  CONSEQUENTIAL_ROUTING_FAMILY,
  admitProtectedSuccessor,
  classifyBranchTarget,
  degradedRoutingFor,
  gateConsequentialRouting,
  type RoutingActiveIdentity,
  type RoutingAdmission,
  type RoutingDisposition,
  type RoutingGateInput,
  type RoutingGateResult,
  type RoutingLiveJudgment,
  type RoutingQualification,
  type VerifiedRoutingQualification,
} from "./decision/routing.js";
export {
  answerSummary,
  buildDecisionJournalEvent,
  type DecisionJournalInput,
} from "./decision/evidence.js";
export { DEFAULT_JEV_MODEL, UNIFIED_POLICY_VERSION } from "./decision/types.js";
export { DEFAULT_JEV_MODEL as JEV_DEFAULT_MODEL } from "./jev/client.js";
export { EvidenceLedger, hashSubject, type EvidenceRecord } from "./evidence/ledger.js";
export {
  applyReviewPolicy,
  type PolicyConfig,
  type ReviewLane,
  type ReviewResult,
} from "./review/policy.js";
export { chunkDiff } from "./review/chunk.js";
export { runDetectors } from "./review/detectors.js";
export { ReviewService } from "./review/service.js";
export { toMuseOutput } from "./hosts/muse/outputs.js";
export { executeGraph, expandGraphLoops, graphDescriptor, graphHash, validateGraph } from "./graph/executor.js";
export { GraphOutputArtifactStore, MAX_GRAPH_ARTIFACT_BYTES, type GraphOutputArtifact } from "./graph/artifact.js";
export { run as runReadGraphOutput, inputSchema as readGraphOutputInputSchema, outputSchema as readGraphOutputOutputSchema } from "./tools/read-graph-output.js";
export { applyGraphEdits, run as runEditGraph, inputSchema as editGraphInputSchema, outputSchema as editGraphOutputSchema } from "./tools/edit-graph.js";
export { listSessionGraphHistory, loadSessionGraphForResume } from "./graph/history.js";
export { run as runGraphHistory, inputSchema as graphHistoryInputSchema, outputSchema as graphHistoryOutputSchema } from "./tools/graph-history.js";
export { run as runResumeGraph, inputSchema as resumeGraphInputSchema, outputSchema as resumeGraphOutputSchema } from "./tools/resume-graph.js";
export type { EditGraphInput } from "./tools/edit-graph.js";
export {
  decideMissionClosure,
  MissionClosureGate,
  MISSION_CLOSURE_CHOICES,
  MISSION_CLOSURE_POLICY_VERSION,
  MISSION_CLOSURE_QUESTION,
  preflightMissionClosure,
  type MissionClosureDecision,
  type MissionClosureEvidence,
  type MissionClosureEvidenceSource,
  type MissionClosureGateResult,
  type MissionClosurePolicy,
  type MissionClosureStatus,
} from "./mission/closure.js";
export {
  type MissionClosureReceiptResult,
} from "./mission/receipt.js";
export {
  deriveProvisionalChecklist,
  MAX_ROUTINE_ITEMS,
  readProvisionalChecklist,
  ROUTINE_GUIDANCE_AUTHORITY,
  summarizeRoutineCoverage,
  type ProvisionalChecklist,
  type ProvisionalChecklistItem,
  type RoutineCoverageItemStatus,
  type RoutineCoverageSummary,
} from "./mission/contract.js";
export { inspectToolCall } from "./enforcement/deterministic.js";
// Read-only observation surface for external consumers (e.g. Veyrict).
// Evidence, never authority: no permission, acceptance, or certification.
export {
  isJeverbObservation,
  JEVERB_OBSERVATION_VERSION,
  observationFromReceipt,
  digestReceipt,
  type ConfidenceBand,
  type JeverbObservation,
  type ObservationDisposition,
  type ObservationHost,
} from "./integrations/veyrict/observation.js";
export {
  description as observationsDescription,
  inputSchema as observationsInputSchema,
  outputSchema as observationsOutputSchema,
  run as runObservations,
  type ObservationsToolInput,
  type ObservationsToolOutput,
} from "./tools/observations.js";
