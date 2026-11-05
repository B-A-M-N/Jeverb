/**
 * Stop: enforce the stop-short and mission-verification lifecycle.
 *
 * The completion classifier sees the final message. For an explicit mission,
 * the separate host closure runner evaluates trusted contract, graph, and
 * verifier evidence; registered probes and corrective work are dispatched by
 * that runner and returned here as bounded agent-facing obligations.
 *
 * At most one block per user prompt, counted in code. A stop hook that can
 * argue is a stop hook that loops.
 */

import type { EvaluateResult, NoulAnswer, Question } from "../../decision/types.js";
import { createHash } from "node:crypto";
import { runVerifyCore, type ClaimResult } from "../../tools/verify-core.js";
import { checkReferences, extractClaims, stopClaimsPolicy, type StopClaimsResult } from "../claims.js";
import { redactAndClamp } from "../redact.js";
import { modelCost } from "../store.js";
import { EMPTY_LEDGER, verificationKindsClaimed, verificationPolicy } from "../verification.js";
import type { Deps, HookInput, HookOutput } from "../types.js";
import { claimsBlockText } from "../wording.js";
import { gitDiffHead, gitNameStatus, projectFileExists, readProjectFile } from "../workspace.js";
import { createSessionMissionClosureSource } from "../../mission/session-source.js";
import { directMissionControl } from "../../decision/loop.js";
import type { CorrectiveAction, CorrectiveStep } from "../../decision/control.js";
import type { SessionState } from "../store.js";
import { endsWithQuestion, MAX_CLAIM_PIECES, MAX_MESSAGE_CHARS, MAX_STOP_BLOCKS, MAX_STOP_BLOCKS_PER_PROMPT, MAX_VERIFIED_CLAIMS, MIN_MESSAGE_CHARS, stopPolicy, stopRequestOf, unfinishedClause, type StopSignals } from "./stop-policy.js";
export { endsWithQuestion, MAX_CLAIM_PIECES, MAX_MESSAGE_CHARS, MAX_REQUEST_CHARS, MAX_STOP_BLOCKS, MAX_STOP_BLOCKS_PER_PROMPT, MAX_VERIFIED_CLAIMS, MIN_MESSAGE_CHARS, STOP_QUESTIONS, stopPolicy, stopRequestOf, unfinishedClause, UNFINISHED_REASONS, type StopPolicyResult, type StopSignals, type UnfinishedReason } from "./stop-policy.js";

/** Avoid starting serial mission closure when less than 200 ms remain. */
const MIN_CLOSURE_BUDGET_MS = 200;

const DIRECTIVE_ACTIONS: ReadonlySet<CorrectiveStep> = new Set(["REPAIR", "VERIFY", "RECONCILE", "CHANGE_APPROACH"]);

/**
 * Render a typed host control-loop correction as Stop response text: one
 * concrete, evidence-backed action the agent can perform, never
 * model-authored instructions.
 */
export function formatCorrectionDirective(correction: CorrectiveAction): string {
  return (
    `[jev] Mission closure needs one correction before completion can be established. ` +
    `Next action: ${correction.action} criterion "${correction.criterionId}" — produce: ${correction.requiredOutcome} ` +
    `(at most ${correction.maxAttempts} attempts, evidence rev ${correction.baseEvidenceRevision}). ` +
    `Only this correction is authorized; gather the new evidence before any further assessment.`
  );
}

/**
 * Convert a current host control-loop correction into the Stop response.
 * Mission lookup and persistence belong to this orchestration layer, not to
 * the leaf policy module.
 */
export async function currentCorrectionDirective(
  sessionId: string,
  session: SessionState,
  deps: Deps,
  evidenceRevision: string | undefined,
): Promise<string | undefined> {
  const contract = session.mission_contract;
  if (contract === undefined || evidenceRevision === undefined || deps.ledger === undefined) return undefined;
  let correction: CorrectiveAction | undefined;
  try {
    const source = createSessionMissionClosureSource({ store: deps.store, dataDir: deps.config.dataDir, now: deps.now });
    const outcome = await directMissionControl({
      ledger: deps.ledger,
      sessionId,
      source,
      missionId: contract.missionId,
      ...(session.verification === undefined ? {} : { verification: session.verification }),
    });
    correction = outcome.decision.correction;
  } catch {
    return undefined;
  }
  if (correction === undefined) return undefined;
  if (!DIRECTIVE_ACTIONS.has(correction.action)) return undefined;
  if (correction.baseEvidenceRevision !== evidenceRevision) return undefined;
  return formatCorrectionDirective(correction);
}

/**
 * Resolve the current mission evidence revision used to key Stop's finite
 * reassessment budget. An unresolvable revision suppresses reassessment.
 */
export async function currentInterventionRevisionKey(
  sessionId: string,
  session: SessionState,
  deps: Deps,
): Promise<string | undefined> {
  const contract = session.mission_contract;
  if (contract === undefined) return undefined;
  try {
    const source = createSessionMissionClosureSource({ store: deps.store, dataDir: deps.config.dataDir, now: deps.now });
    const evidence = await source.load(sessionId, contract.missionId);
    return `mission:${evidence.missionId}:${evidence.evidenceRevision}`;
  } catch {
    return undefined;
  }
}

export async function handleStop(input: HookInput, deps: Deps): Promise<HookOutput | undefined> {
  const { config, store } = deps;
  if (!config.stopCheck) return undefined;
  if (input.stop_hook_active === true) return undefined;

  const sessionId = input.session_id ?? "unknown";
  if (store.isDisabled(sessionId)) return undefined;

  const eventName = input.hook_event_name === "SubagentStop" ? "SubagentStop" : "Stop";
  // A subagent is judged against the task its parent gave it, not against the
  // user's last prompt — the user never saw the task. Read it before dropping
  // it: this is the event that says the subagent is done with it.
  const subagent = input.agent_type;
  const childIdentity = input.subagent_id ?? input.child_session_id ?? input.agent_id;
  const task = subagent === undefined ? undefined : store.takeSubagentTask(sessionId, subagent, deps.now(), childIdentity);
  if (eventName === "SubagentStop" && subagent !== undefined) {
    store.dropSubagentTask(sessionId, subagent, deps.now(), childIdentity);
  }

  // A session with work in flight is paused, not finished.
  if ((input.background_tasks ?? []).length > 0) return undefined;
  if ((input.session_crons ?? []).length > 0) return undefined;

  const sessionHealth = store.readSessionDetailed(sessionId);
  const session = sessionHealth.session;
  const hasMissionContract = session.mission_contract !== undefined;
  const message = input.last_assistant_message ?? "";
  // A degraded session read must never produce a silent allow: without a
  // trace, "the store is down" is indistinguishable from "nothing was ever
  // recorded". Normal silent paths stay silent; only the degraded case logs.
  const degradedAllow = (reason: string): undefined => {
    if (!sessionHealth.degraded) return undefined;
    store.append({
      ts: new Date(deps.now()).toISOString(),
      session_id: sessionId,
      event: eventName,
      subject: redactAndClamp(message.slice(-300), 300),
      decision: "unavailable",
      reasons: [reason],
      storeDegraded: true,
      storeDegradedReason: sessionHealth.reason ?? "unknown",
    });
    return undefined;
  };
  // Lightweight formatting heuristics keep ordinary chatter cheap, but an
  // active explicit mission contract always gets its authoritative
  // assessment: a short "Done" must not bypass mission closure.
  if (!hasMissionContract) {
    if (message.trim().length < MIN_MESSAGE_CHARS) {
      return degradedAllow("session store unreadable; short message not assessed");
    }
    if (endsWithQuestion(message)) {
      return degradedAllow("session store unreadable; question not assessed");
    }
  }

  if (task === undefined && session.prompts.length === 0) {
    return degradedAllow("session store unreadable; no prompts on record");
  }
  // Hard cycle cap first: Jeverb never traps an agent indefinitely.
  if (session.stop_blocks >= MAX_STOP_BLOCKS_PER_PROMPT) return undefined;
  if (session.stop_blocks >= MAX_STOP_BLOCKS) {
    // One block per prompt by default; a materially changed evidence revision
    // may qualify for reassessment within the overall budget. Without a
    // contract there is no evidence revision to advance, so the cap stands.
    const revisionKey = await currentInterventionRevisionKey(sessionId, session, deps);
    const seen = session.stop_block_revisions ?? [];
    if (revisionKey === undefined || seen.includes(revisionKey)) return undefined;
  }
  // No inference available: fail open, but leave a trace. A silent allow is
  // indistinguishable from a disabled hook in the decision log. The trace
  // below does not return: the deterministic workspace stage still runs,
  // and a hard evidence failure blocks through the same combination path
  // with zero model signals instead of being discarded with the model.
  const model = deps.model;
  if (model === null) {
    store.append({
      ts: new Date(deps.now()).toISOString(),
      session_id: sessionId,
      event: eventName,
      subject: redactAndClamp(message.slice(-300), 300),
      decision: "unavailable",
      reasons: ["no decision model is configured; nothing was judged"],
    });
  }

  const base = {
    ts: new Date(deps.now()).toISOString(),
    session_id: sessionId,
    event: eventName,
    subject: redactAndClamp(message.slice(-300), 300),
  };

  const rawRequest =
    task !== undefined
      ? { latest: task.prompt, previous: [] as string[] }
      : {
          latest: session.prompts[session.prompts.length - 1] ?? "",
          previous: session.prompts.slice(0, -1),
        };

  const thresholds = { auto: config.autoThreshold, review: config.reviewThreshold };
  const cwd = input.cwd;
  // Phased inference budgets inside one total deadline: classification first,
  // then mission closure on the remainder with its own usable signal. The two
  // serial model calls never share a single already-spent abort signal.
  const startedAt = deps.now();
  const totalBudgetMs = config.timeoutMs;
  const classifyController = new AbortController();
  const classifyTimer = setTimeout(() => classifyController.abort(), totalBudgetMs);
  try {
    // Deterministic evidence first: the workspace claim check needs no
    // inference for fabricated references, so evaluating it before (and
    // independently of) the model means a dead or missing model cannot
    // discard what git already proves. Only the verify refinement — judging
    // diff support for extracted claims — requires the model.
    let claimsPolicy: StopClaimsResult | undefined;
    let claimsTimedOut = false;
    const extracted = cwd === undefined ? undefined : extractClaims(message);
    // Only touch the workspace when the message actually names a file or an
    // identifier: a message with nothing to check has nothing to verify, and
    // skipping the git reads keeps the common case free.
    if (cwd !== undefined && extracted !== undefined && (extracted.files.length > 0 || extracted.idents.length > 0)) {
      try {
        const [nameStatus, headDiff] = await Promise.all([gitNameStatus(cwd), gitDiffHead(cwd)]);
        const stage1 = checkReferences(extracted, {
          fileExists: (rel) => projectFileExists(cwd, rel),
          readFile: (rel) => readProjectFile(cwd, rel),
          nameStatus,
          diffText: headDiff?.text ?? "",
        });
        let verifiedClaims: ClaimResult[] | undefined;
        if (model !== null && config.verifyClaims && extracted.claims.length > 0 && headDiff !== undefined) {
          try {
            const verify = await runVerifyCore(
              model,
              {
                claims: extracted.claims.map((claim) => claim.text).slice(0, MAX_VERIFIED_CLAIMS),
                evidence: headDiff.text,
                thresholds,
                maxPieces: MAX_CLAIM_PIECES,
              },
              { maxConcurrency: MAX_CLAIM_PIECES },
              classifyController.signal,
            );
            verifiedClaims = verify.claims;
          } catch {
            // A slow diff or a timed-out verify degrades to stage 1, logged.
            claimsTimedOut = true;
          }
        }
        claimsPolicy = stopClaimsPolicy(stage1, verifiedClaims, config.autoThreshold);
      } catch {
        // Any workspace read failure: fail open, no claim block.
        claimsPolicy = undefined;
      }
    }

    // Inference is best-effort: a failed classification leaves zero signals,
    // so the combination below judges workspace evidence only instead of
    // discarding it. A missing model skips this section outright.
    let result: EvaluateResult<Record<string, Question>> | undefined;
    let modelFailed = false;
    let signals: StopSignals = {
      claims_complete: 0,
      says_part_not_done: 0,
      says_step_deferred: 0,
      says_check_failing: 0,
      asks_user: 0,
      addresses_request: 0,
      claims_verified: 0,
    };
    if (model !== null) {
      const stopRequest = model.evaluate({
        ...stopRequestOf(rawRequest, message),
        signal: classifyController.signal,
      });
      try {
        result = await stopRequest;
      } catch {
        modelFailed = true;
      } finally {
        clearTimeout(classifyTimer);
      }
    } else {
      clearTimeout(classifyTimer);
    }
    if (result !== undefined) {
      const answers = result.answers as Record<string, NoulAnswer | undefined>;
      const noul = (key: string): number => (typeof answers[key]?.noul === "number" ? (answers[key] as NoulAnswer).noul : 0);
      signals = {
        claims_complete: noul("claims_complete"),
        says_part_not_done: noul("says_part_not_done"),
        says_step_deferred: noul("says_step_deferred"),
        says_check_failing: noul("says_check_failing"),
        asks_user: noul("asks_user"),
        addresses_request: noul("addresses_request"),
        claims_verified: noul("claims_verified"),
      };
    }

    const policy = stopPolicy(signals, config.autoThreshold);
    // The second rule, and the only one with evidence behind it: the message
    // says the checks pass, and the ledger says the last one did not.
    const verified = verificationPolicy(
      signals.claims_verified,
      session.verification ?? EMPTY_LEDGER,
      config.autoThreshold,
      deps.now(),
      verificationKindsClaimed(message),
      { cwd: input.cwd },
    );

    const claimsBlock = claimsPolicy?.block ?? false;
    const baseBlocked = policy.block || verified.block || claimsBlock;
    // Mission closure applies only to an explicit, session-bound contract.
    // Merely having the production adapter available must never turn an
    // ordinary completion claim into a closure check or Stop intervention.
    const closureRequested =
      hasMissionContract &&
      !baseBlocked &&
      signals.claims_complete >= config.autoThreshold;
    const closureCandidate = closureRequested && deps.missionClosure !== undefined;
    let closureResult: Awaited<ReturnType<NonNullable<Deps["missionClosure"]>>> | undefined;
    let closureFailed = false;
    let closureTimedOut = false;
    if (closureCandidate && deps.missionClosure !== undefined) {
      // Closure runs on the remainder of the total Stop budget with its own
      // abort signal — never on a signal the classification phase consumed.
      const elapsedMs = Math.max(0, deps.now() - startedAt);
      const closureBudgetMs = totalBudgetMs - elapsedMs;
      if (closureBudgetMs < MIN_CLOSURE_BUDGET_MS) {
        closureTimedOut = true;
      } else {
        const closureController = new AbortController();
        const closureTimer = setTimeout(() => closureController.abort(), closureBudgetMs);
        try {
          closureResult = await deps.missionClosure(sessionId, closureController.signal, {
            backgroundTasks: (input.background_tasks ?? []).length,
            sessionCrons: (input.session_crons ?? []).length,
          });
        } catch {
          if (closureController.signal.aborted) closureTimedOut = true;
          else closureFailed = true;
        } finally {
          clearTimeout(closureTimer);
        }
      }
    }
    const closureDecision = closureResult !== undefined && "decision" in closureResult ? closureResult.decision : undefined;
    const closureNotApplicable = closureResult !== undefined && "outcome" in closureResult;
    const receiptDurable =
      closureResult !== undefined &&
      "receipt" in closureResult &&
      (closureResult.receipt.status === "appended" || closureResult.receipt.status === "duplicate");
    const closureTerminal =
      closureDecision !== undefined &&
      receiptDurable &&
      ((closureDecision.status === "COMPLETE" && closureResult !== undefined && "terminalComplete" in closureResult && closureResult.terminalComplete) ||
        closureDecision.status === "BLOCKED");
    // A missing optional verifier or infrastructure failure is diagnostic,
    // not an instruction to continue working. Only an explicit contract
    // result with unresolved evidence can request a bounded intervention.
    // A closure timeout is explicitly attributed, never folded into the
    // generic unavailable outcome: it establishes nothing either way.
    const closureBlocks = closureCandidate && !closureFailed && !closureTimedOut && closureDecision !== undefined && !closureTerminal;
    // Deterministic mission-contract enforcement, independent of the
    // completion classifier: an explicit session contract with a
    // deterministic defect blocks even when a healthy model reports no
    // completion claim (the closure gate above only runs on a positive
    // vote). The typed control decision needs no model: a correction
    // blocks through the same finite intervention budget below, while
    // READY/COMPLETE and unavailable evidence allow with a trace instead
    // of being discarded. This never applies to SubagentStop: a child is
    // judged against its own taken task, not the parent session's
    // remaining criteria.
    const contract = session.mission_contract;
    let deterministicControl: Awaited<ReturnType<typeof directMissionControl>> | undefined;
    if (
      eventName === "Stop" && contract !== undefined && !baseBlocked && !closureCandidate &&
      deps.ledger !== undefined
    ) {
      try {
        const source = createSessionMissionClosureSource({ store: deps.store, dataDir: deps.config.dataDir, now: deps.now });
        deterministicControl = await directMissionControl({
          ledger: deps.ledger,
          sessionId,
          source,
          missionId: contract.missionId,
          ...(session.verification === undefined ? {} : { verification: session.verification }),
        });
      } catch {
        deterministicControl = undefined;
      }
    }
    const deterministicBlock = deterministicControl !== undefined &&
      !deterministicControl.decision.complete &&
      deterministicControl.decision.action !== "READY_FOR_CLOSURE" &&
      deterministicControl.decision.action !== "INSUFFICIENT_EVIDENCE" &&
      deterministicControl.persisted !== "unavailable";
    const blocked = baseBlocked || closureBlocks || deterministicBlock;
    const decision = closureTerminal
      ? `mission-closure-${closureDecision?.status.toLowerCase()}`
      : blocked
      ? policy.block || verified.block
        ? "block"
        : claimsBlock
          ? "claims-block"
          : deterministicBlock
            ? "mission-control-block"
            : closureFailed
            ? "mission-closure-error"
            : closureTimedOut
              ? "mission-closure-timeout"
              : `mission-closure-${closureDecision?.status.toLowerCase() ?? (closureNotApplicable ? "not-applicable" : "unavailable")}`
      : verified.logOnly
        ? "unverified-claim"
        : closureRequested && (!closureCandidate || closureFailed || closureTimedOut || closureNotApplicable || closureDecision === undefined)
          ? closureTimedOut ? "mission-closure-timeout" : "mission-closure-unavailable"
        : claimsTimedOut
          ? "claims-timeout"
          : claimsPolicy !== undefined
            ? "claims-clean"
            : "allow";
    // The intervention is keyed by mission and evidence revision plus the
    // finding identity: an unchanged finding never re-blocks, while a
    // genuinely changed evidence revision may reassess within the budget.
    const revisionKey = blocked ? await currentInterventionRevisionKey(sessionId, session, deps) : undefined;
    if (blocked) {
      const eventKey = createHash("sha256")
        .update(JSON.stringify({
          event: eventName,
          revision: session.prompt_revision ?? 0,
          mission: hasMissionContract && session.mission_contract !== undefined
            ? {
                missionId: session.mission_contract.missionId,
                missionRevision: session.mission_contract.missionRevision,
                evidenceRevision: closureDecision?.evidenceRevision ?? revisionKey ?? null,
              }
            : null,
          message: message.slice(-MAX_MESSAGE_CHARS),
          decision,
          signals,
          verification: session.verification?.last?.ts ?? null,
        }))
        .digest("hex");
      if (store.tryClaimStopIntervention(sessionId, eventKey, MAX_STOP_BLOCKS_PER_PROMPT, deps.now(), revisionKey) !== "claimed") {
        return undefined;
      }
    }

    store.append({
      ...base,
      decision,
      // A failed session read degrades verification to an empty ledger. The
      // allow/block that follows is unchanged, but the record says so, so a
      // logOnly allow under store failure is distinguishable from "nothing
      // was ever recorded".
      ...(sessionHealth.degraded
        ? { storeDegraded: true, storeDegradedReason: sessionHealth.reason ?? "unknown" }
        : {}),
      signals: { ...signals },
      policy: { auto: config.autoThreshold },
      thresholds: {
        auto: config.autoThreshold,
        review: config.reviewThreshold,
        confidence: config.confidenceThreshold,
      },
      ...(policy.unfinished_by !== undefined ? { unfinished_by: policy.unfinished_by } : {}),
      ...(subagent !== undefined ? { subagent } : {}),
      ...(claimsPolicy !== undefined
        ? { claims: { ...claimsPolicy.counts, items: claimsPolicy.items.slice(0, 5) } }
        : {}),
      reasons: [
        ...policy.reasons,
        ...verified.reasons,
        ...(deterministicControl?.decision.reasons ?? []),
        ...(closureDecision?.reasons ?? []),
        ...(closureDecision?.repairTask === undefined
          ? []
          : [`repair ${closureDecision.repairTask.criterionId}: ${closureDecision.repairTask.finding}; produce: ${closureDecision.repairTask.requiredEvidence}`]),
        ...(closureFailed ? ["mission closure host integration failed"] : []),
        ...(closureTimedOut ? ["mission closure exceeded its inference budget; completion not established"] : []),
        ...(modelFailed ? ["stop classification exceeded its inference budget; judged on workspace evidence only"] : []),
      ],
      ...(result === undefined ? {} : modelCost(result)),
    });

    if (closureTerminal && closureDecision !== undefined && closureResult !== undefined && "receipt" in closureResult) {
      return {
        terminalOutcome: {
          status: closureDecision.status as "COMPLETE" | "BLOCKED",
          missionId: closureDecision.missionId,
          missionRevision: closureDecision.missionRevision,
          evidenceRevision: closureDecision.evidenceRevision,
          receiptCorrelationId: closureResult.receipt.correlationId,
        },
        ...(closureDecision.model === undefined
          ? {}
          : { jev: { model: closureDecision.model, ...(closureDecision.probabilities === undefined ? {} : { probabilities: closureDecision.probabilities }) } }),
      };
    }

    if (!blocked) return undefined;

    // Precedence: stop-short (oldest, broadest) speaks first, then the
    // verification ledger, then the workspace claim check.
    if (policy.block && policy.unfinished_by !== undefined) {
      const reason = policy.unfinished_by;
      return {
        decision: "block",
        reason:
          `[jev] Your final message ${unfinishedClause(reason, signals[reason])} and is not waiting on the ` +
          `user. Continue with the remaining work, or state explicitly what blocks you.`,
      };
    }

    if (verified.block) return { decision: "block", reason: verified.reason as string };

    if (closureCandidate) {
      const status = closureDecision?.status ?? "INSUFFICIENT_EVIDENCE";
      // The typed correction controller directs this block when it has a
      // valid current correction: one concrete, evidence-backed action the
      // agent can perform, never model-authored instructions. Anything else
      // falls back to the generic evidence-gathering text below.
      const directive = await currentCorrectionDirective(sessionId, session, deps, closureDecision?.evidenceRevision);
      if (directive !== undefined) return { decision: "block", reason: directive };
      if (closureDecision?.repairTask !== undefined) {
        const repair = closureDecision.repairTask;
        return {
          decision: "block",
          reason: repair.defectKind === "unresolved-requirement"
            ? `[jev] Probe evidence for criterion "${repair.criterionId}" remains unresolved: ${repair.finding}. ` +
              `Do not treat uncertainty as a code defect. Next action: ${repair.requiredEvidence} ` +
              `(evidence rev ${repair.evidenceRevision}).`
            : `[jev] Independent probe found a gap in criterion "${repair.criterionId}": ${repair.finding}. ` +
              `Next action: repair only this criterion through the existing authorized graph path, then rerun ` +
              `${repair.requiredEvidence} (at most ${repair.maxAttempts} repair attempt; evidence rev ${repair.evidenceRevision}).`,
        };
      }
      return {
        decision: "block",
        reason:
          `[jev] Mission closure is ${status}; Muse cannot receive TOTAL_MISSION_COMPLETE without a durable, evidence-backed terminal verdict. ` +
          `Gather current verification evidence or report the unresolved dependency.`,
      };
    }

    if (deterministicBlock && deterministicControl !== undefined) {
      const correction = deterministicControl.decision.correction;
      // The typed correction controller directs this block when it has a
      // valid current correction, exactly as on the closure path above.
      // Anything else falls back to generic evidence-gathering text.
      if (correction !== undefined && DIRECTIVE_ACTIONS.has(correction.action)) {
        return { decision: "block", reason: formatCorrectionDirective(correction) };
      }
      return {
        decision: "block",
        reason:
          `[jev] Mission control deterministically rejects completion (${deterministicControl.decision.action}); ` +
          `Muse cannot receive TOTAL_MISSION_COMPLETE without a durable, evidence-backed terminal verdict. ` +
          `Gather current verification evidence or report the unresolved dependency.`,
      };
    }

    return { decision: "block", reason: claimsBlockText((claimsPolicy as StopClaimsResult).items) };
  } catch (error) {
    store.append({
      ...base,
      decision: "error",
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
    return undefined;
  } finally {
    clearTimeout(classifyTimer);
  }
}
