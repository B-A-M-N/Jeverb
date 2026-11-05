import { inspectGraphToolCall } from "../enforcement/deterministic.js";
import type { ExecutionPolicy } from "./policy.js";
import { isPrivilegedCommand } from "./policy.js";
import type { Authorizer, GraphNode } from "./executor.js";

/**
 * The Authorizer every in-repo graph runner must use.
 *
 * This authorizer is mandatory: there is no default-permit path, and no
 * Jev judgment, confidence value, or model-supplied identity can substitute
 * for it. `AUTHORIZER_KIND` records the decision family so journal and
 * control records can show the grant came from the authorization boundary.
 *
 * Order matters: the policy switch first, then privilege denial, then
 * pattern-based risk detection. A command that passes screening is *not*
 * thereby authorized — screening only detects known-bad shapes. Authority
 * is the conjunction of: the host approved this tool call, the policy
 * permits shell execution, and no rule denied this node. Jev nodes perform
 * no host action (a Jev call is evidence, never authorization), so they
 * are always allowed to run; their *outputs* never authorize either.
 */

/** Decision family this authorizer records under. */
export const AUTHORIZER_KIND = "authorization" as const;

export function makeDeterministicAuthorizer(policy: ExecutionPolicy): Authorizer {
  return {
    authorize: async (node: GraphNode) => {
      if (node.kind === "shell") {
        if (typeof node.command !== "string" || node.command.length === 0) {
          return { allowed: false, reason: `shell node ${node.id} missing command` };
        }
        if (!policy.allowShell) {
          return {
            allowed: false,
            reason: `shell node ${node.id} denied: shell execution is disabled (JEV_GRAPH_SHELL=deny)`,
          };
        }
        if (policy.denyPrivileged && isPrivilegedCommand(node.command)) {
          return {
            allowed: false,
            reason: `shell node ${node.id} denied: privilege escalation is never permitted in graphs`,
          };
        }
        const verdict = inspectGraphToolCall({
          tool_name: "Bash",
          tool_input: { command: node.command },
        });
        if (verdict.enforcement === "deny") {
          return { allowed: false, reason: verdict.reason ?? "denied by deterministic policy" };
        }
      }
      return { allowed: true };
    },
  };
}
