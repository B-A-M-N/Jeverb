# ORX → Jeverb → Veyrict integration contract

This contract defines how ORX submits bounded work to Jeverb and how Veyrict consumes the resulting evidence. It does not grant Jeverb acceptance, deployment, or permission authority.

## ORX submits work

Call the native `jev_execute_graph` MCP tool with a graph that fits Jeverb's published limits. Omit `runId` for a fresh execution; Jeverb mints and returns the identifier. Supplying a `runId` requests resume of an existing journal and fails when no matching journal exists. Supply `source` as a descriptive submitter identity. That string is recorded as a claim and never grants authority. Every shell node is checked against the operator-owned Jeverb execution policy before the constrained runner starts it.

For recovery, retain the returned `runId`, `graphHash`, and `policyHash`. Resume with `jev_resume_graph` using the returned `runId`; Jeverb reloads the journal and rejects graph or policy mismatches. Never replay caller-supplied node outcomes. An interrupted running node is `outcome_unknown` and must be reconciled before a new side-effect attempt.

The graph response carries per-node status, output digests, optional private artifact IDs, and `evidenceReceipts` with full ledger correlation IDs. The MCP principal is `unverified:mcp-stdio` unless the host provides a separately authenticated identity. `source` is not an authenticated principal.

## Veyrict retrieves evidence

Call `jev_observations` with `operationId` set to the returned graph `runId`; optional `sessionId` and `candidate` filters further narrow results. Jeverb returns observations carrying:

- `operationId`: the graph run ID (`turnId` from the backing receipt).
- `outputDigest` and `executionStatus`: typed graph-node output fingerprint and terminal status, when present.
- `correlationId`: the full opaque receipt correlation ID. Match it against `evidenceReceipts.correlationIds` from the graph response.
- `evidence.receiptDigest`: a digest of the canonical receipt, and `evidence.subjectHash`: a fingerprint of the judged subject.
- `deterministicFindings`, `advice`, model/policy metadata, uncertainty band, disposition, and observation time.

Veyrict must validate schema version, `operationId`, `correlationId`, expected session/candidate when available, and the receipt digest before consuming an observation. A digest proves which bytes back the observation; it is not a signature or caller identity. Veyrict must treat Jev advice as advisory and must not infer authorization, acceptance, or deployment readiness from an observation or a high confidence value.

## Failure and uncertainty

Graph responses distinguish succeeded, failed/blocked/cancelled/unknown, and skipped nodes, and report whether receipt projection was persisted, partial, or unavailable. `jev_observations` reports `ok`, `empty`, `truncated`, `corrupt`, or `unavailable`; a truncated page must be followed using `nextCursor`. Missing or corrupt evidence is not success. An unknown graph side effect is not retried automatically.

## Trust and configuration

Muse owns plugin capability review and activation. Jeverb does not self-approve its hooks or MCP server. An operator must approve the exact Muse capability IDs required by the deployment. The operator also configures the backend, credentials, review calibration, and graph execution policy in the Jeverb plugin data directory. Keep credentials out of graph input, correlation IDs, artifacts, and observations.

Muse starts plugin stdio servers with a cleared environment; arbitrary environment variables and provider keys do not pass through. Configure the plugin's host-provided `MUSE_PLUGIN_DATA_DIR` instead:

- `config.json`: non-secret settings such as `backend`, `base_url`, `model`, `allow_custom_relay`, `timeout_ms`, `max_retries`, and thresholds.
- `credentials`: a JSON object containing only the matching backend key (`TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`), with file mode `0600` or stricter.

Explicit environment values still take precedence when a standalone host provides them. A non-default OpenRouter-compatible gateway requires `backend: "openrouter"` and `allow_custom_relay: true`; a TypeSafe-compatible endpoint uses `backend: "typesafe"`. Other gateway protocols are not inferred from the URL and need an explicit adapter.

The local MCP transport does not authenticate ORX callers. Deployments that need caller authorization must enforce it in the host/transport boundary and provide an authenticated principal out of band; a model-supplied graph `source`, `candidate`, or `runId` is correlation metadata, not authentication.
