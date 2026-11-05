import { describe, expect, it } from "vitest";
import { createGatewayReceiptCorrelator, parseReceiptRequestIds } from "../../src/jev/gateway-receipt-correlation.js";

describe("gateway receipt correlation", () => {
  it("matches request IDs in memory and emits only safe outcome aggregates", () => {
    const secretId = "private-request-id-001";
    const parsed = parseReceiptRequestIds(JSON.stringify({ modelRequestId: secretId, integratedRequestId: null }), "mission-completion-dev-v3-jevgateway-3stage-r1");
    const correlator = createGatewayReceiptCorrelator(parsed.ids);
    correlator.observe({
      incoming_request_id: secretId,
      provider_id: "openrouter_jev",
      endpoint: "/jev/api/alpha/decisions",
      model: "typesafe/jev-1.14",
      timestamp_started: 1793577600,
      http_status: 200,
      upstream_status: 200,
      downstream_status: 200,
      final_gateway_outcome: "success",
    });
    const result = correlator.finish();
    expect(result.matchedRequests["mission-completion-dev-v3-jevgateway-3stage-r1"].model_only).toBe(1);
    expect(result.unmatchedRequests["mission-completion-dev-v3-jevgateway-3stage-r1"].integrated).toBe(0);
    expect(JSON.stringify(result)).not.toContain(secretId);
    expect(result.matchedGatewayOutcomes[0]).toMatchObject({ provider: "openrouter_jev", httpStatus: 200, finalOutcome: "success", requests: 1 });
  });

  it("counts duplicate incoming IDs without counting them as extra matched receipts", () => {
    const parsed = parseReceiptRequestIds(JSON.stringify({ modelRequestId: "private-request-id-002" }), "mission-completion-lockbox-v3-jevgateway-3stage-r1");
    const correlator = createGatewayReceiptCorrelator(parsed.ids);
    const row = { incoming_request_id: "private-request-id-002", http_status: 200, final_gateway_outcome: "success" };
    correlator.observe(row);
    correlator.observe(row);
    const result = correlator.finish();
    expect(result.matchedRequests["mission-completion-lockbox-v3-jevgateway-3stage-r1"].model_only).toBe(1);
    expect(result.duplicateIncomingIds).toBe(1);
  });
});
