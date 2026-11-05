export function classifyPrompt(prompt: string): { effort: "low" | "standard" | "high"; reason: string } {
  const text = prompt.toLowerCase();
  if (/urgent|blocking|security|incident|outage/.test(text)) return { effort: "high", reason: "advisory: high-effort keywords" };
  if (/refactor|migrate|perf|benchmark/.test(text)) return { effort: "standard", reason: "advisory: medium-scope task" };
  return { effort: "low", reason: "advisory: routine task" };
}

export interface SubagentClassification {
  suitable: boolean;
  reason: string;
}

const TASK_ACTION =
  /\b(?:add|analyze|audit|benchmark|build|change|compare|create|design|document|fix|implement|inspect|investigate|measure|plan|propose|refactor|reproduce|research|review|summarize|test|trace|update|verify|write)\b/i;
const TASK_DELIVERABLE =
  /\b(?:analysis|benchmark|comparison|document(?:ation)?|evidence|findings|fix|implementation|plan|proposal|reproduction|report|results?|summary|test(?:s| case)?|verification)\b/i;
const EFFECTFUL_ACTION =
  /(?:^|[;\n]|\b(?:and|then|finally)\s+)(?:\s*please\s+)?(?:deploy|publish|release|push|merge|delete|destroy|drop|reset|rotate|revoke|grant|send|transfer|charge)\b/i;

/**
 * Deterministic suitability hint for bounded delegation. It never routes or
 * starts an agent: Muse owns that control, so Jeverb only reports whether the
 * captured task has an explicit action and deliverable, and flags direct
 * external or protected actions for primary-agent handling.
 */
export function classifySubagent(task: string): SubagentClassification {
  const text = task.trim();
  if (text.length === 0) return { suitable: false, reason: "task prompt is missing" };
  if (EFFECTFUL_ACTION.test(text)) {
    return { suitable: false, reason: "task requests a protected or externally effectful action" };
  }
  if (!TASK_ACTION.test(text)) {
    return { suitable: false, reason: "task does not name a concrete action" };
  }
  if (!TASK_DELIVERABLE.test(text)) {
    return { suitable: false, reason: "task does not name an expected deliverable" };
  }
  return { suitable: true, reason: "task names an action and an expected deliverable" };
}
