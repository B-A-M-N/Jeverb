/**
 * UserPromptSubmit: bookkeeping, and optionally a task classification.
 *
 * The bookkeeping is the important half and always runs, even with
 * `route_prompts` off and even with no API key. It is how every other hook
 * learns what the user asked for: a PreToolUse hook is handed a tool call, not
 * a request, and the transcript file has no documented format and lags the
 * conversation. Recording the prompt here is the supported way to know it.
 *
 * It also resets the stop-block counter, which is what makes "one block per
 * user prompt" mean what it says.
 */

import { levelMass } from "../../decision/policy.js";
import { enforceEvidenceRetention } from "../maintenance.js";
import type { ChoiceAnswer, Question, ScoreAnswer } from "../../decision/types.js";
import { MAX_PROMPT_CHARS, SHORT_PROMPT_CHARS, modelCost, nextPrompts } from "../store.js";
import { redactAndClamp } from "../redact.js";
import type { Deps, HookInput, HookOutput } from "../types.js";
import { addMissionAttestations, deriveProvisionalChecklist, parseMissionAttestation, parseMissionContract } from "../../mission/contract.js";

/** Below this, a prompt is an acknowledgement and not worth classifying. */
export const MIN_PROMPT_CHARS = 40;
/**
 * The top `ambiguity` level: "something is open that changes the result".
 *
 * The line fires on that level's own probability, not on the expectation.
 * `score >= 1.5` was reachable by a 50/50 split between "nothing important is
 * open" and "a wrong guess wastes the work" — two readings that disagree
 * completely — and printing the advisory for that is printing it for a model
 * that has not decided.
 */
const AMBIGUOUS_LEVEL = 2;
/** The 0.4.x rule, kept for an answer that carries no per-level probabilities. */
const AMBIGUOUS_SCORE = 1.5;

const KINDS: Record<string, string> = {
  question: "The user is asking for an explanation or an answer, not for a change to the code.",
  small_mechanical_edit:
    "The user is asking for a change whose shape is already decided: a rename, a flag, a config value, a copied pattern.",
  multi_file_implementation: "The user is asking for a feature or change that spans several files.",
  debugging_unknown_cause: "The user reports something broken and the cause is not yet known.",
  design_or_planning: "The user is asking how to approach something, or for a plan, not for the change itself.",
  risky_change:
    "The user is asking for something hard to undo: deleting data, rewriting history, deploying, migrating, changing auth or money handling.",
  review_or_audit: "The user is asking for existing code or work to be checked.",
  other: "None of the above fits.",
};

export const PROMPT_CLASSIFICATION_QUESTIONS: Record<string, Question> = {
  kind: { type: "choice", instructions: "What kind of task is `prompt` asking for?", criteria: KINDS },
  ambiguity: {
    type: "score",
    instructions: "How much of `prompt` would have to be guessed at before work could start?",
    criteria: [
      "`prompt` says what to do and where; nothing important is left open.",
      "`prompt` leaves a detail open that a reasonable default covers.",
      "`prompt` leaves something open that changes the result, and a wrong guess would waste the work.",
    ],
  },
};

export async function handleUserPromptSubmit(input: HookInput, deps: Deps): Promise<HookOutput | undefined> {
  const { config, store } = deps;
  // Master gate precedes parsing, attestation, prompt capture, session writes,
  // pruning, and ledger writes.
  if (store.isDisabled(input.session_id ?? "unknown")) return undefined;
  const sessionId = input.session_id ?? "unknown";
  const prompt = input.prompt ?? "";
  const hostEventId = input.event_id ?? input.turn_id;
  const now = deps.now();
  const safePrompt = redactAndClamp(prompt, MAX_PROMPT_CHARS);
  if (prompt.trim() === "") return undefined;
  const missionContract = parseMissionContract(sessionId, prompt, now);
  let recordedAttestationIds: string[] = [];

  // Bookkeeping: unconditional, no network, no model.
  //
  // The note budget resets here, which is what "at most five notes per user
  // prompt" means. Open tripwires deliberately do NOT reset: a trip issued a
  // moment before the user types "yes, do that" must still be answerable, and
  // clearing them on every prompt would make a marker a no-op after any
  // interleaved message.
  const session = store.updateSession(
    sessionId,
    (state) => {
      const isDuplicateEvent = hostEventId !== undefined
        ? state.last_prompt_event_id === hostEventId
        : state.prompts[state.prompts.length - 1] === safePrompt;
      const isNewTurn = safePrompt !== "" && !isDuplicateEvent;
      const next = {
        ...state,
        prompts: isDuplicateEvent ? state.prompts : nextPrompts(state.prompts, safePrompt),
        ...(hostEventId === undefined ? {} : { last_prompt_event_id: hostEventId }),
        ...(isNewTurn
          ? {
              stop_blocks: 0,
              prompt_revision: (state.prompt_revision ?? 0) + 1,
              stop_interventions: [],
              stop_block_revisions: [],
            }
          : {}),
        ...(isNewTurn ? { pending_reissues: [], notes_this_prompt: 0 } : {}),
      };
      if (missionContract !== undefined) {
        next.mission_contract = missionContract;
        // An explicit user-authored contract supersedes provisional guidance.
        delete next.routine_checklist;
      } else if (state.mission_contract !== undefined) {
        const attestations = parseMissionAttestation(sessionId, prompt, state.mission_contract, now);
        if (attestations !== undefined) {
          recordedAttestationIds = attestations.map(({ criterionId }) => criterionId);
          next.mission_contract = addMissionAttestations(state.mission_contract, attestations);
        } else if (prompt.trim().length >= SHORT_PROMPT_CHARS) {
          delete next.mission_contract;
        }
      }
      // Routine coverage for ordinary work without an explicit contract:
      // derived, provisional, and never closure evidence.
      if (missionContract === undefined && isNewTurn && prompt.trim().length >= SHORT_PROMPT_CHARS) {
        const provisional = deriveProvisionalChecklist(sessionId, prompt, now);
        if (provisional !== undefined) next.routine_checklist = provisional;
        else delete next.routine_checklist;
      }
      return next;
    },
    now,
  );
  // Operator-signed independent verifications land here: the hook, not the
  // agent, copies service records into the contract. Fail-open: without a
  // reachable service nothing is merged and nothing else changes.
  const updated = store.readSession(sessionId);
  const contract = updated?.mission_contract;
  if (contract !== undefined) {
    const { mergeServiceAttestations, readServiceAttestations } = await import("../../control/attestations.js");
    const merged = mergeServiceAttestations(contract, await readServiceAttestations(contract.missionId));
    if (merged !== undefined) {
      store.updateSession(sessionId, (state) => ({ ...state, mission_contract: merged }), now);
    }
  }
  if (store.isDisabled(sessionId)) return undefined;
  store.pruneSessions(deps.now());
  // Daily evidence maintenance runs beside session pruning: bound ledger
  // growth, reap crash-orphaned atomic-write temps and dead graph journals.
  // Best effort by construction; it never affects this hook's verdict.
  enforceEvidenceRetention({
    ledger: deps.ledger,
    dataDir: deps.config.dataDir,
    retentionDays: deps.config.evidenceRetentionDays,
    maxRecords: deps.config.evidenceMaxRecords,
    // Store holds the per-session lock across both the mission check and
    // journal removal, so a new contract cannot race the retention decision.
    removeGraphJournalIfMissionInactive: (graphSessionId, remove) =>
      store.withInactiveMissionSession(graphSessionId, remove),
    now: deps.now(),
  });

  // One line per prompt, with no prompt text in it. It is the only way
  // `/jev:calibrate` can report notes *per user prompt*: the counter that
  // enforces the five-note cap lives in the session file, and a report over the
  // log alone cannot otherwise tell where one prompt's window ends.
  store.append({
    ts: new Date(deps.now()).toISOString(),
    session_id: sessionId,
    event: "UserPromptSubmit",
    decision: "prompt",
  });

  const missionNotice = recordedAttestationIds.length === 0
    ? undefined
    : `[jev] Recorded your explicit verification for ${recordedAttestationIds.join(", ")} against mission ${session.mission_contract?.missionId ?? "unknown"}. Independent checks and semantic review are still required.`;
  const missionOutput: HookOutput | undefined = missionNotice === undefined
    ? undefined
    : { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: missionNotice } };

  if (!config.routePrompts) return missionOutput;
  if (store.isDisabled(sessionId)) return missionOutput;
  if (prompt.trim().length < MIN_PROMPT_CHARS) return missionOutput;
  if (deps.model === null) return missionOutput;

  const base = {
    ts: new Date(deps.now()).toISOString(),
    session_id: sessionId,
    event: "UserPromptSubmit",
    subject: redactAndClamp(session.prompts[session.prompts.length - 1] ?? prompt, 300),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const result = await deps.model.evaluate({
      state: { prompt: redactAndClamp(prompt, MAX_PROMPT_CHARS) },
      questions: PROMPT_CLASSIFICATION_QUESTIONS,
      signal: controller.signal,
    });
    if (store.isDisabled(sessionId)) return undefined;

    const kind = result.answers.kind as ChoiceAnswer | undefined;
    const ambiguity = result.answers.ambiguity as ScoreAnswer | undefined;
    const confidence = typeof kind?.confidence === "number" ? kind.confidence : 0;
    const ambiguousMass = ambiguity === undefined ? undefined : levelMass(ambiguity, [AMBIGUOUS_LEVEL]);

    const signals: Record<string, number> = { kind_confidence: confidence };
    if (typeof ambiguity?.score === "number") signals.ambiguity = ambiguity.score;
    if (ambiguousMass !== undefined) signals.ambiguity_p_high = ambiguousMass;

    const logged = {
      signals,
      policy: { confidence_threshold: config.confidenceThreshold },
      thresholds: {
        auto: config.autoThreshold,
        review: config.reviewThreshold,
        confidence: config.confidenceThreshold,
      },
    };

    // A Choice's `confidence` is a peakedness statistic over the options, not
    // the probability of a binary event, so it has its own bar.
    if (kind === undefined || confidence < config.confidenceThreshold) {
      store.append({ ...base, decision: "low-confidence", ...logged, ...modelCost(result) });
      return missionOutput;
    }

    const lines = [
      ...(missionNotice === undefined ? [] : [missionNotice]),
      `[jev] task kind: ${kind.choice} (conf ${confidence.toFixed(2)})`,
    ];
    const ambiguous =
      ambiguousMass !== undefined
        ? ambiguousMass >= config.autoThreshold
        : typeof ambiguity?.score === "number" && ambiguity.score >= AMBIGUOUS_SCORE;
    if (ambiguous) {
      lines.push("[jev] the request is ambiguous — consider asking one clarifying question before starting.");
    }

    store.append({
      ...base,
      decision: kind.choice,
      ...logged,
      ...modelCost(result),
    });

    return {
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: lines.join("\n") },
    };
  } catch (error) {
    if (store.isDisabled(sessionId)) return undefined;
    store.append({
      ...base,
      decision: "error",
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
    return missionOutput;
  } finally {
    clearTimeout(timer);
  }
}
