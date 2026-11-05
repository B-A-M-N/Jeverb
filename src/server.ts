/**
 * MCP wiring.
 *
 * The server owns transport concerns only: schema registration, turning a
 * thrown error into an `isError` result, and emitting both a structured result
 * and a text rendering of it (clients differ in which they show). All behavior
 * lives in `src/tools/*`, which know nothing about MCP.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { missingApiKeyMessage, type Config } from "./config.js";
import { resolveExecutionPolicy } from "./graph/policy.js";
import type { DecisionModel } from "./decision/types.js";
import { describeError } from "./jev/errors.js";
import { resolveDataDir } from "./hooks/config.js";
import { environmentDisableOverride, isGloballyDisabled, readMasterSwitch } from "./hooks/store.js";
import { PROTECTED_MASTER_SWITCH_PATH, REQUIRE_ROOT_OWNED_SWITCH } from "./control/constants.js";
import { ReviewService } from "./review/service.js";
import { loadReviewConfig } from "./review/load-config.js";
import * as evaluateTool from "./tools/evaluate.js";
import * as executeGraphTool from "./tools/execute-graph.js";
import * as editGraphTool from "./tools/edit-graph.js";
import * as readGraphOutputTool from "./tools/read-graph-output.js";
import * as graphHistoryTool from "./tools/graph-history.js";
import * as resumeGraphTool from "./tools/resume-graph.js";
import * as observationsTool from "./tools/observations.js";
import * as gateActionTool from "./tools/gate-action.js";
import * as listModelsTool from "./tools/list-models.js";
import * as nextStepTool from "./tools/next-step.js";
import * as pickTool from "./tools/pick.js";
import * as rankTool from "./tools/rank.js";
import * as verifyTool from "./tools/verify.js";
import type { ToolConfig } from "./tools/shared.js";

export const SERVER_NAME = "jevwire";
export const SERVER_VERSION = "0.6.3";

/** Read-only, but every tool reaches an external API. */
const READ_ONLY_ANNOTATIONS = { readOnlyHint: true, openWorldHint: true } as const;

/**
 * Graph execution runs shell commands on this machine: destructive and
 * externally effectful. It must never be advertised as read-only, or a host
 * may invoke it under a harmless-operation permission grant.
 */
const EXECUTE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

function ok(output: object): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
    structuredContent: output as { [key: string]: unknown },
  };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Build the server. `model` is `null` when no API key was configured: the
 * server still starts and every tool answers with an actionable `isError`,
 * because an MCP client that cannot start the server shows a transport failure
 * instead of the explanation the user needs.
 */
export function createServer(model: DecisionModel | null, config: Config): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, logging: {} } },
  );

  // MCP graph review nodes use the same loaded policy and calibration pins
  // as Muse commit review hooks; there is one review authority per process.
  const loadedReview = loadReviewConfig();
  const review = new ReviewService(model, {
    checks: loadedReview.checks,
    policy: loadedReview.policy,
    status: loadedReview.status,
    ...(loadedReview.invalid === undefined ? {} : { invalid: loadedReview.invalid }),
    expectedCalibration: {
      backend: config.backend,
      model: config.model,
      questionHash: loadedReview.questionHash,
      ...(loadedReview.calibration.modelVersion === undefined ? {} : { modelVersion: loadedReview.calibration.modelVersion }),
      ...(loadedReview.calibration.calibrationVersion === undefined
        ? {}
        : { calibrationVersion: loadedReview.calibration.calibrationVersion }),
    },
  });

  const dataDir = resolveDataDir(process.env);
  const museSessionId = process.env.MUSE_SESSION_ID?.trim();
  const toolConfig: ToolConfig = {
    model: config.model,
    thresholds: config.thresholds,
    maxConcurrency: config.maxConcurrency,
    maxConcurrencyExplicit: config.maxConcurrencyExplicit,
    // The one place the file-reading tools learn which directory they are
    // confined to. Everything under `src/files` refuses to leave it.
    files: { root: config.projectRoot },
    // The explicit execution permission boundary for graph shell nodes:
    // master switch, workspace root, parallelism, timeouts. `run()` treats a
    // missing policy as a test-only default; production always sets this.
    execution: resolveExecutionPolicy(process.env, config.projectRoot, dataDir),
    review,
    // Where `jev_observations` finds the evidence ledger. Same resolution
    // as the hook layer, so MCP reads see what hooks recorded.
    dataDir,
    masterSwitchPath: config.masterSwitchPath,
    ...(museSessionId === undefined || museSessionId === "" ? {} : { museSessionId }),
  };

  /** Never let a key reach a client, even if an upstream body echoed it. */
  const redact = (message: string): string =>
    config.apiKey === null || config.apiKey.length < 8
      ? message
      : message.split(config.apiKey).join("[redacted]");

  const masterOff = (): boolean =>
    environmentDisableOverride() || (toolConfig.dataDir !== undefined && isGloballyDisabled(
      toolConfig.dataDir,
      toolConfig.masterSwitchPath ?? PROTECTED_MASTER_SWITCH_PATH,
      REQUIRE_ROOT_OWNED_SWITCH && (toolConfig.masterSwitchPath ?? PROTECTED_MASTER_SWITCH_PATH) === PROTECTED_MASTER_SWITCH_PATH,
    ));
  const masterSwitchStatus = () => readMasterSwitch(
    toolConfig.dataDir ?? "",
    environmentDisableOverride(),
    toolConfig.masterSwitchPath ?? PROTECTED_MASTER_SWITCH_PATH,
    REQUIRE_ROOT_OWNED_SWITCH && (toolConfig.masterSwitchPath ?? PROTECTED_MASTER_SWITCH_PATH) === PROTECTED_MASTER_SWITCH_PATH,
  );
  const disabledResult = (): CallToolResult =>
    fail("Jeverb is disabled for this install (install-wide master switch). Re-enable through the OS-authorized `jev-control on` operation.");

  // Most MCP tools already accept the host's AbortSignal. Give each request a
  // child signal so an install-wide OFF transition can cancel those calls too;
  // if a provider ignores cancellation, the post-await masterOff check still
  // discards its result. Poll only while there is active work.
  const activeCalls = new Map<AbortController, string | null>();
  let switchPoll: ReturnType<typeof setInterval> | undefined;
  const checkForOff = (): void => {
    const current = masterSwitchStatus();
    for (const [controller, generation] of activeCalls) {
      if (current.effective === "OFF" || current.generation !== generation) {
        controller.abort(new Error("Jeverb switch changed during this operation"));
      }
    }
  };
  const trackOperation = (hostSignal?: AbortSignal): { signal: AbortSignal; release: () => void; stillCurrent: () => boolean } => {
    const controller = new AbortController();
    const generation = masterSwitchStatus().generation;
    const forwardHostAbort = (): void => controller.abort(hostSignal?.reason);
    if (hostSignal?.aborted) forwardHostAbort();
    else hostSignal?.addEventListener("abort", forwardHostAbort, { once: true });
    activeCalls.set(controller, generation);
    if (switchPoll === undefined) {
      switchPoll = setInterval(checkForOff, 25);
      switchPoll.unref();
    }
    return {
      signal: controller.signal,
      stillCurrent: () => {
        const current = masterSwitchStatus();
        return !controller.signal.aborted && current.effective === "ON" && current.generation === generation;
      },
      release: () => {
        hostSignal?.removeEventListener("abort", forwardHostAbort);
        activeCalls.delete(controller);
        if (activeCalls.size === 0 && switchPoll !== undefined) {
          clearInterval(switchPoll);
          switchPoll = undefined;
        }
      },
    };
  };

  function wrap<I, O extends object>(
    run: (model: DecisionModel, input: I, config: ToolConfig, signal?: AbortSignal) => Promise<O>,
  ): (input: I, extra: { signal?: AbortSignal }) => Promise<CallToolResult> {
    return async (input, extra) => {
      // The global `/jev:off` stops the entire plugin, MCP tools included.
      // Session-scoped flags stay hooks-only: the server has no reliable
      // session binding for every transport, so only the install-wide file
      // gates it here. Status and tool listing keep working regardless.
      if (masterOff()) return disabledResult();
      if (model === null) return fail(missingApiKeyMessage(config.backend, config.warnings));
      const operation = trackOperation(extra.signal);
      try {
        const result = await run(model, input, toolConfig, operation.signal);
        if (!operation.stillCurrent() || masterOff()) {
          return fail("Jeverb was turned off while this operation was running; its result was suppressed.");
        }
        return ok(result);
      } catch (error) {
        if (masterOff()) return disabledResult();
        return fail(redact(describeError(error)));
      } finally {
        operation.release();
      }
    };
  }

  server.registerTool(
    evaluateTool.name,
    {
      description: evaluateTool.description,
      inputSchema: evaluateTool.inputShape,
      outputSchema: evaluateTool.outputShape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    wrap(evaluateTool.run),
  );

  server.registerTool(
    rankTool.name,
    {
      description: rankTool.description,
      inputSchema: rankTool.inputShape,
      outputSchema: rankTool.outputShape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    wrap(rankTool.run),
  );

  server.registerTool(
    pickTool.name,
    {
      description: pickTool.description,
      inputSchema: pickTool.inputShape,
      outputSchema: pickTool.outputShape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    wrap(pickTool.run),
  );

  server.registerTool(
    verifyTool.name,
    {
      description: verifyTool.description,
      inputSchema: verifyTool.inputShape,
      outputSchema: verifyTool.outputShape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    wrap(verifyTool.run),
  );

  server.registerTool(
    gateActionTool.name,
    {
      description: gateActionTool.description,
      inputSchema: gateActionTool.inputShape,
      outputSchema: gateActionTool.outputShape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    wrap(gateActionTool.run),
  );

  server.registerTool(
    executeGraphTool.name,
    {
      description: executeGraphTool.description,
      inputSchema: executeGraphTool.inputShape,
      outputSchema: executeGraphTool.outputShape,
      annotations: EXECUTE_ANNOTATIONS,
    },
    async (input, extra) => {
      if (masterOff()) return disabledResult();
      // Shell-only graphs stay usable without a key; jev nodes need one.
      const needsKey = input.graph?.nodes?.some((n) => n.kind === "jev") ?? true;
      if (model === null && needsKey) {
        return fail(missingApiKeyMessage(config.backend, config.warnings));
      }
      const operation = trackOperation(extra.signal);
      try {
        const result = await executeGraphTool.run(model, input, toolConfig, operation.signal);
        return masterOff() ? disabledResult() : ok(result);
      } catch (error) {
        if (masterOff()) return disabledResult();
        return fail(redact(describeError(error)));
      } finally {
        operation.release();
      }
    },
  );

  server.registerTool(
    editGraphTool.name,
    {
      description: editGraphTool.description,
      inputSchema: editGraphTool.inputShape,
      outputSchema: editGraphTool.outputShape,
      annotations: EXECUTE_ANNOTATIONS,
    },
    async (input, extra) => {
      if (masterOff()) return disabledResult();
      const operation = trackOperation(extra.signal);
      try {
        const result = await editGraphTool.run(model, input, toolConfig, operation.signal);
        return masterOff() ? disabledResult() : ok(result);
      } catch (error) {
        if (masterOff()) return disabledResult();
        return fail(redact(describeError(error)));
      } finally {
        operation.release();
      }
    },
  );

  server.registerTool(
    readGraphOutputTool.name,
    {
      description: readGraphOutputTool.description,
      inputSchema: readGraphOutputTool.inputShape,
      outputSchema: readGraphOutputTool.outputShape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      if (masterOff()) return disabledResult();
      try {
        return ok(readGraphOutputTool.run(input, toolConfig));
      } catch (error) {
        if (masterOff()) return disabledResult();
        return fail(redact(describeError(error)));
      }
    },
  );

  server.registerTool(
    graphHistoryTool.name,
    {
      description: graphHistoryTool.description,
      inputSchema: graphHistoryTool.inputShape,
      outputSchema: graphHistoryTool.outputShape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      if (masterOff()) return disabledResult();
      try {
        return ok(graphHistoryTool.run(input, toolConfig));
      } catch (error) {
        if (masterOff()) return disabledResult();
        return fail(redact(describeError(error)));
      }
    },
  );

  server.registerTool(
    resumeGraphTool.name,
    {
      description: resumeGraphTool.description,
      inputSchema: resumeGraphTool.inputShape,
      outputSchema: resumeGraphTool.outputShape,
      annotations: EXECUTE_ANNOTATIONS,
    },
    async (input, extra) => {
      if (masterOff()) return disabledResult();
      const operation = trackOperation(extra.signal);
      try {
        const result = await resumeGraphTool.run(model, input, toolConfig, operation.signal);
        return masterOff() ? disabledResult() : ok(result);
      } catch (error) {
        if (masterOff()) return disabledResult();
        return fail(redact(describeError(error)));
      } finally {
        operation.release();
      }
    },
  );

  // Read-only evidence retrieval: no model, no key, no writes. Registered
  // with the read-only annotations so hosts never treat it as effectful.
  // Deliberately outside `wrap()`: there is no inference to gate on a key.
  server.registerTool(
    observationsTool.name,
    {
      description: observationsTool.description,
      inputSchema: observationsTool.inputShape,
      outputSchema: observationsTool.outputShape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      if (masterOff()) return disabledResult();
      try {
        const result = await observationsTool.run(null, input, toolConfig);
        return masterOff() ? disabledResult() : ok(result);
      } catch (error) {
        if (masterOff()) return disabledResult();
        return fail(redact(describeError(error)));
      }
    },
  );

  server.registerTool(
    nextStepTool.name,
    {
      description: nextStepTool.description,
      inputSchema: nextStepTool.inputShape,
      outputSchema: nextStepTool.outputShape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    wrap(nextStepTool.run),
  );

  server.registerTool(
    listModelsTool.name,
    {
      description: listModelsTool.description,
      inputSchema: listModelsTool.inputShape,
      outputSchema: listModelsTool.outputShape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    wrap(listModelsTool.run),
  );

  return server;
}
