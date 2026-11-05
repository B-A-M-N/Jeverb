#!/usr/bin/env tsx
/**
 * Offline confidence-gate audit for the frozen mission-closure development
 * split. Threshold sensitivity is computed from development receipts only.
 * The sealed v3 final receipts are used only for a retrospective count of the
 * 49 already-recorded threshold holds against their retained labels; they are
 * never used in the threshold sweep.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseCalibrationDataset } from "../src/jev/calibration.js";
import { lockboxLegacyEvidence } from "../src/jev/lockbox.js";
import { affirmativeRequest } from "../src/mission/closure.js";

type Row = {
  caseId: string;
  dataset: string;
  questionHash: string;
  expected: string;
  preflightReady: boolean;
  integratedComplete: boolean;
  integratedOutcome?: string;
  integratedChoice: string;
  integratedReason: string;
  integratedConfidence?: number;
  integratedProbabilities?: Record<string, number>;
  modelChoice?: string;
  backend: string;
  observedModel: string;
};

const ROOT = process.cwd();
const DEV_DATASET = "bench/datasets/mission-completion-dev-v3.jsonl";
const DEV_HASH = "e91a505a4bb7d2a3665ef00bf5a86285ae76fc4ef255e0dc97ede7c108f7c6e0";
const QUESTION_HASH = "6714d6c0af29dd7eea06eb4b658a686035d96b25b5b03ead11c503507699df63";
const DEV_GATEWAY = "bench/results/mission-completion-dev-v3.jevgateway-3stage-r1.receipts.jsonl";
const DEV_OPENROUTER = "bench/results/mission-completion-dev-v3.openrouter-jev-latest-2026-11-03.receipts.jsonl";
const DEV_GATEWAY_MANIFEST = "bench/results/mission-completion-dev-v3.jevgateway-3stage-r1.manifest.json";
const DEV_OPENROUTER_SUMMARY = "bench/results/mission-completion-dev-v3.openrouter-jev-latest-2026-11-03.summary.json";
const FINAL_RECEIPTS = "bench/results/mission-completion-lockbox-v3.jevgateway-3stage-r1.receipts.jsonl";
const OUTPUT = "bench/analysis/mission-closure-confidence-development-2026-11-03.json";
const THRESHOLDS = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.925, 0.95, 1];

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(`${ROOT}/${path}`, "utf8")) as T;
}

function readRows(path: string): Row[] {
  return readFileSync(`${ROOT}/${path}`, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line) as Row);
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`jev-confidence-audit: ${message}`);
}

function quantiles(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.floor((sorted.length - 1) * p)];
  return {
    n: sorted.length,
    min: sorted[0],
    q1: at(0.25),
    median: at(0.5),
    mean: Number((sorted.reduce((sum, value) => sum + value, 0) / sorted.length).toFixed(4)),
    q3: at(0.75),
    max: sorted.at(-1),
  };
}

function bins(values: number[]) {
  const bounds = [0, 0.5, 0.6, 0.7, 0.8, 0.9, 1.000001];
  return bounds.slice(0, -1).map((low, i) => {
    const high = bounds[i + 1]!;
    return {
      interval: `[${low.toFixed(1)},${Math.min(high, 1).toFixed(1)}${i === bounds.length - 2 ? "]" : ")"}`,
      count: values.filter((value) => value >= low && (i === bounds.length - 2 ? value <= 1 : value < high)).length,
    };
  });
}

function confidenceFormulaAudit(rows: Row[]) {
  const residuals = rows.flatMap((row) => {
    const probabilities = row.integratedProbabilities;
    const confidence = row.integratedConfidence;
    if (probabilities === undefined || confidence === undefined) return [];
    const values = Object.values(probabilities);
    const n = values.length;
    if (n < 2 || !Number.isFinite(confidence)) return [];
    const expected = (Math.max(...values) - 1 / n) / (1 - 1 / n);
    return [Math.abs(confidence - expected)];
  });
  return {
    responses: residuals.length,
    maxAbsoluteDifference: Number(Math.max(...residuals).toFixed(4)),
    meanAbsoluteDifference: Number((residuals.reduce((sum, value) => sum + value, 0) / residuals.length).toFixed(5)),
    withinRoundingTolerance0_01: residuals.filter((value) => value <= 0.01).length,
    formula: "(pMax - 1/n) / (1 - 1/n); four-choice mission closure uses n=4",
    roundingTolerance: 0.01,
  };
}

function rawChoice(row: Row): string | undefined {
  if (row.integratedComplete || row.integratedOutcome === "threshold_hold") return "COMPLETE";
  if (row.integratedOutcome === "semantic_refusal") return row.integratedChoice;
  return undefined;
}

function thresholdSweep(rows: Row[]) {
  const positives = rows.filter((row) => row.expected === "COMPLETE");
  const nonComplete = rows.filter((row) => row.expected !== "COMPLETE");
  const modes = ["confidenceOnly", "completeProbabilityOnly", "both"] as const;
  return modes.map((mode) => ({
    gate: mode,
    results: THRESHOLDS.map((threshold) => {
      const admitted = (row: Row) => {
        const confidence = row.integratedConfidence;
        const pComplete = row.integratedProbabilities?.COMPLETE;
        if (!row.preflightReady || rawChoice(row) !== "COMPLETE" || confidence === undefined || pComplete === undefined) return false;
        if ((mode === "confidenceOnly" || mode === "both") && confidence < threshold) return false;
        if ((mode === "completeProbabilityOnly" || mode === "both") && pComplete < threshold) return false;
        return true;
      };
      const trueLabelComplete = positives.filter(admitted).length;
      const falseLabelComplete = nonComplete.filter(admitted).length;
      return {
        threshold,
        trueLabelCompletions: trueLabelComplete,
        positiveCases: positives.length,
        positiveLiveness: Number((trueLabelComplete / positives.length).toFixed(4)),
        falseLabelCompletions: falseLabelComplete,
        nonCompleteCases: nonComplete.length,
        falseCompleteRate: Number((falseLabelComplete / nonComplete.length).toFixed(4)),
      };
    }),
  }));
}

function outcomeAccounting(rows: Row[]) {
  const held = rows.filter((row) => row.integratedOutcome === "threshold_hold");
  const labels = Object.fromEntries(
    [...new Set(held.map((row) => row.expected))].sort().map((label) => [label, held.filter((row) => row.expected === label).length]),
  );
  const outcomes = Object.fromEntries(
    [...new Set(rows.map((row) => row.integratedOutcome ?? "preflight_stop"))].sort().map((outcome) => [
      outcome,
      rows.filter((row) => (row.integratedOutcome ?? "preflight_stop") === outcome).length,
    ]),
  );
  const completed = rows.filter((row) => row.integratedComplete);
  return {
    integratedOutcomes: outcomes,
    thresholdHoldCount: held.length,
    thresholdHoldLabels: labels,
    thresholdHoldReasonMatches: held.filter((row) => row.integratedReason === "Jev chose COMPLETE below the calibrated confidence or outcome-probability threshold 0.9").length,
    terminalCompleteCount: completed.length,
    terminalCompleteLabels: Object.fromEntries(
      [...new Set(completed.map((row) => row.expected))].sort().map((label) => [label, completed.filter((row) => row.expected === label).length]),
    ),
  };
}

const datasetText = readFileSync(`${ROOT}/${DEV_DATASET}`, "utf8");
const datasetHash = sha256(datasetText);
assert(datasetHash === DEV_HASH, "development dataset hash changed; create a new audit identity");
const cases = parseCalibrationDataset(datasetText);
const devRowsByCase = new Map(cases.map((item) => [item.id, item]));
const baselineManifest = readJson<{ datasetSplit: string; datasetHash: string; questionSetHash: string; thresholds: { minLiveness: number } }>(DEV_GATEWAY_MANIFEST);
const candidateSummary = readJson<{
  datasetHash: string;
  questionHash: string;
  requestedModel: string;
  servedModel: string;
  minConfidence: number;
  metrics: { cases: number; positivesTotal: number; positiveCompletions: number; falseTerminalCompletions: number; thresholdHolds: number };
}>(DEV_OPENROUTER_SUMMARY);
assert(baselineManifest.datasetSplit === "development" && baselineManifest.datasetHash === DEV_HASH, "gateway receipt manifest is not the pinned development split");
assert(candidateSummary.datasetHash === DEV_HASH, "OpenRouter summary does not bind the pinned development split");
assert(candidateSummary.questionHash === QUESTION_HASH, "OpenRouter summary question hash changed");
assert(candidateSummary.requestedModel === "typesafe/jev-latest" && candidateSummary.servedModel === "typesafe/jev-1.14-20261014", "OpenRouter serving identity changed");

// Confirm the development lockbox's model-only request equals the exact
// production affirmative request after evidence mapping, and pins the same
// fixed question; this isolates answer behavior from a state-builder mismatch.
let exactStateMatches = 0;
let exactQuestionMatches = 0;
for (const item of cases) {
  const productionRequest = affirmativeRequest(lockboxLegacyEvidence(item.id, item.state));
  if (JSON.stringify(productionRequest.state) === JSON.stringify(item.state)) exactStateMatches += 1;
  if (JSON.stringify(productionRequest.questions) === JSON.stringify(item.questions)) exactQuestionMatches += 1;
}
assert(exactStateMatches === cases.length && exactQuestionMatches === cases.length, "development state/question differs between model-only and integrated request construction");

const gatewayRows = readRows(DEV_GATEWAY);
const openRouterRows = readRows(DEV_OPENROUTER);
for (const [name, rows] of [["gateway", gatewayRows], ["openrouter", openRouterRows]] as const) {
  assert(rows.length === cases.length, `${name} receipt count differs from development dataset`);
  for (const row of rows) {
    assert(devRowsByCase.has(row.caseId), `${name} receipt contains a case outside the development dataset`);
    assert(row.dataset === DEV_HASH && row.questionHash === QUESTION_HASH, `${name} receipt dataset/question binding mismatch`);
  }
}

const finalRows = readRows(FINAL_RECEIPTS);
const heldFinalAll = finalRows.filter((row) => row.integratedOutcome === "threshold_hold");
const heldFinal = heldFinalAll.filter((row) => row.expected === "COMPLETE");
const heldFinalNonComplete = heldFinalAll.filter((row) => row.expected !== "COMPLETE");
assert(heldFinal.length === 49 && heldFinalNonComplete.length === 7, "retrospective sealed-set threshold-hold counts changed; inspect as a new audit");
const heldFinalNonCompleteLabels = Object.fromEntries(
  [...new Set(heldFinalNonComplete.map((row) => row.expected))].sort().map((label) => [
    label,
    heldFinalNonComplete.filter((row) => row.expected === label).length,
  ]),
);
const finalAccounting = outcomeAccounting(finalRows);
const finalModelOnlyFalseComplete = finalRows.filter((row) => row.expected !== "COMPLETE" && row.modelChoice === "COMPLETE").length;
const finalPositiveOutcomes = Object.fromEntries(
  [...new Set(finalRows.filter((row) => row.expected === "COMPLETE").map((row) => row.integratedOutcome ?? "preflight_stop"))].sort().map((outcome) => [
    outcome,
    finalRows.filter((row) => row.expected === "COMPLETE" && (row.integratedOutcome ?? "preflight_stop") === outcome).length,
  ]),
);
assert(finalAccounting.thresholdHoldCount === 56 && finalAccounting.thresholdHoldReasonMatches === 56, "sealed threshold-hold fields do not match production gate reason");
assert(finalAccounting.terminalCompleteCount === 13 && finalAccounting.terminalCompleteLabels.COMPLETE === 13, "sealed integrated terminal COMPLETE count changed");
assert(JSON.stringify(finalPositiveOutcomes) === JSON.stringify({ completed: 13, semantic_refusal: 2, threshold_hold: 49 }), "sealed positive liveness accounting changed");

const devPositiveReady = openRouterRows.filter((row) => row.expected === "COMPLETE" && row.preflightReady);
const candidateAt09 = thresholdSweep(openRouterRows).find((entry) => entry.gate === "both")!.results.find((row) => row.threshold === 0.9)!;
assert(candidateAt09.trueLabelCompletions === candidateSummary.metrics.positiveCompletions, "offline 0.90 sweep disagrees with the retained OpenRouter summary");
assert(candidateAt09.falseLabelCompletions === candidateSummary.metrics.falseTerminalCompletions, "offline 0.90 false-completion count disagrees with retained summary");
assert(candidateSummary.metrics.thresholdHolds === openRouterRows.filter((row) => row.integratedOutcome === "threshold_hold").length, "threshold-hold count disagrees with retained summary");

const output = {
  schema: "jev-confidence-gate-audit/1",
  generatedAt: new Date().toISOString(),
  decision: "diagnostic-only; no threshold or policy changed",
  confidenceSemantics: {
    source: "TypeSafe Choice confidence formula",
    formula: "(pMax - 1/n) / (1 - 1/n)",
    fourChoiceInterpretation: "confidence >= 0.90 corresponds to pMax >= 0.925",
    implementation: "mission closure requires COMPLETE selected, confidence >= minConfidence, and P(COMPLETE) >= minConfidence; with canonical four-choice confidence and a selected COMPLETE argmax, the confidence gate is the stricter of those two numeric tests.",
  },
  sealedRetrospectiveOnly: {
    receipts: FINAL_RECEIPTS,
    datasetHash: finalRows[0]?.dataset,
    persistedStageAccounting: {
      terminalIntegratedCompletions: finalAccounting.terminalCompleteCount,
      terminalIntegratedCompletionLabels: finalAccounting.terminalCompleteLabels,
      allThresholdHolds: finalAccounting.thresholdHoldCount,
      thresholdHoldReasonMatches: finalAccounting.thresholdHoldReasonMatches,
      thresholdHoldLabels: finalAccounting.thresholdHoldLabels,
      positiveCaseOutcomes: finalPositiveOutcomes,
      modelOnlyFalseCompleteVotesOnNonCompleteLabels: finalModelOnlyFalseComplete,
      meaning: "13/64 counts terminal integrated COMPLETE rows among COMPLETE-labeled cases. 49/64 is the COMPLETE-labeled subset of integrated threshold_hold rows. There are seven additional threshold_hold rows with non-COMPLETE labels. The separate model-only false-COMPLETE count is computed from modelChoice and is a different stage.",
    },
    allIntegratedThresholdHoldRows: heldFinalAll.length,
    retainedLabels: { COMPLETE: heldFinal.length, nonComplete: heldFinalNonComplete.length, nonCompleteByLabel: heldFinalNonCompleteLabels },
    interpretation: "Of 56 integrated threshold_hold rows, 49 have retained COMPLETE labels and 7 have retained non-COMPLETE labels (potential false completions prevented by the gate according to those labels). These are builder-authored labels, not independent truth. They were excluded from every threshold sweep. The two disputed 90-day retention cases were semantic refusals, not members of this held group.",
    integratedConfidence: quantiles(heldFinal.map((row) => row.integratedConfidence!)),
    integratedPComplete: quantiles(heldFinal.map((row) => row.integratedProbabilities!.COMPLETE!)),
    bothConfidenceAndPCompleteBelow0_90: heldFinal.filter((row) => row.integratedConfidence! < 0.9 && row.integratedProbabilities!.COMPLETE! < 0.9).length,
    pCompleteAtLeast0_90ButConfidenceBelow0_90: heldFinal.filter((row) => row.integratedConfidence! < 0.9 && row.integratedProbabilities!.COMPLETE! >= 0.9).length,
    confidenceBins: bins(heldFinal.map((row) => row.integratedConfidence!)),
  },
  developmentOnly: {
    dataset: DEV_DATASET,
    datasetHash,
    questionHash: QUESTION_HASH,
    cases: cases.length,
    positiveCases: cases.filter((item) => item.expected.closure?.choice === "COMPLETE").length,
    nonCompleteCases: cases.filter((item) => item.expected.closure?.choice !== "COMPLETE").length,
    exactProductionRequestParity: { cases: cases.length, stateMatches: exactStateMatches, questionMatches: exactQuestionMatches },
    runs: [
      { provider: "jev-gateway", returnedModel: "typesafe/jev-1.14-20261014", receiptCount: gatewayRows.length, outcomeAccounting: outcomeAccounting(gatewayRows), confidenceFormulaAudit: confidenceFormulaAudit(gatewayRows), thresholdSweeps: thresholdSweep(gatewayRows) },
      { provider: "openrouter", requestedModel: candidateSummary.requestedModel, returnedModel: candidateSummary.servedModel, receiptCount: openRouterRows.length, outcomeAccounting: outcomeAccounting(openRouterRows), modelOnlyFalseCompleteVotesOnNonCompleteLabels: openRouterRows.filter((row) => row.expected !== "COMPLETE" && row.modelChoice === "COMPLETE").length, confidenceFormulaAudit: confidenceFormulaAudit(openRouterRows), thresholdSweeps: thresholdSweep(openRouterRows) },
    ],
    positiveIntegratedConfidence: quantiles(devPositiveReady.map((row) => row.integratedConfidence!)),
    positiveIntegratedPComplete: quantiles(devPositiveReady.map((row) => row.integratedProbabilities!.COMPLETE!)),
    interpretation: "Threshold sweeps are descriptive on 12 positive and 20 non-COMPLETE builder-labeled development cases, clustered into a small number of objective families. They are not threshold-selection evidence or qualification.",
  },
  causeAssessment: {
    confidenceField: "correctly interpreted as TypeSafe distribution concentration, distinct from P(COMPLETE)",
    providerParity: "The retained jev-gateway and native OpenRouter Jev Choice receipts match the documented four-option formula to <=0.01 rounding tolerance.",
    thresholdGate: "No threshold implementation defect explains the 49 holds: the 0.90 confidence requirement is met only when the four-way distribution is concentrated enough (pMax >=0.925). The additional P(COMPLETE)>=0.90 check is not stricter than that when COMPLETE is the selected maximum.",
    evidenceConstruction: "The development-only offline comparison found the model-only state/questions byte-equivalent after lockbox-to-production evidence mapping. No construction mismatch is evidenced. Evidence remains synthetic, summary-level text plus references; independent raters must decide whether the labels and evidence support COMPLETE.",
    questionFormulation: "One unchanged four-option question hash is used in both backends and both lockbox stages. No transport/parser/model-version mismatch is evidenced in the retained runs.",
    correctableCause: "No demonstrated defect in the 49 cases' confidence parsing, threshold arithmetic, state construction, or question binding. Do not weaken the threshold. The observed cause is low four-way confidence on builder-labeled completions; whether that reflects model conservatism, ambiguous/thin evidence, or label defects needs independent adjudication and fresh validation.",
  },
  limitations: [
    "The 49 sealed cases are reported descriptively only; no threshold sweep uses them.",
    "All retained labels are builder-authored and not independently adjudicated.",
    "The development data has only 12 positive and 20 non-COMPLETE cases across clustered objective families.",
    "Confidence is not empirical correctness probability; TypeSafe defines it as a statistic of the option distribution.",
  ],
};

writeFileSync(`${ROOT}/${OUTPUT}`, `${JSON.stringify(output, null, 2)}\n`, { flag: "w", mode: 0o644 });
console.log(`Wrote ${OUTPUT}`);
