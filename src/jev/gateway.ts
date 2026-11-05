/**
 * Typed Jev Decisions adapter for the local gateway's named `jev` slot.
 *
 * The gateway owns its upstream TypeSafe/OpenRouter credential. This client
 * sends no provider key; the gateway's model slot chooses the upstream. It
 * authenticates the loopback caller with the gateway's local client identity.
 * The slot's local request contract uses a list of identified questions and
 * an object state, while the upstream Jev response remains the typed
 * Decisions response parsed by JevDecisionModel.
 */
import { randomUUID } from "node:crypto";
import type { EvaluateRequest, EvaluateResult, Question, State } from "../decision/types.js";
import { PROVIDER_JEV_GATEWAY } from "../decision/types.js";
import { JevDecisionModel, type JevDecisionModelOptions } from "./client.js";

export const DEFAULT_JEV_GATEWAY_BASE_URL = "http://127.0.0.1:18769/jev";
export const DEFAULT_JEV_GATEWAY_MODEL = "typesafe/jev-latest";

export class JevGatewayDecisionModel extends JevDecisionModel {
  constructor(options: Omit<JevDecisionModelOptions, "apiKey">) {
    super({
      ...options,
      endpointPath: "/api/alpha/decisions",
      provider: PROVIDER_JEV_GATEWAY,
      requestHeaders: { "X-Locus-Local-Client": "muse-code" },
    });
  }

  override evaluate<Q extends Record<string, Question>>(request: EvaluateRequest<Q>): Promise<EvaluateResult<Q>> {
    return super.evaluate({
      ...request,
      correlationId: request.correlationId ?? randomUUID(),
    });
  }

  protected override requestPayload(state: State, model: string, questions: Record<string, Question>): unknown {
    const objectState =
      typeof state === "object" && state !== null && !Array.isArray(state)
        ? state
        : { input: state };
    return {
      model,
      state: objectState,
      questions: Object.entries(questions).map(([id, question]) => ({ id, ...question })),
    };
  }
}
