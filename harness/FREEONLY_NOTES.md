# Free-only live testing — configuration notes

Running log of verified configurations. Updated as each piece is proven.
Key material is NEVER recorded here — only paths, model IDs, and shapes.

## Credentials (paths only)

- Throwaway OpenRouter key file: `/home/bamn/.config/jeverb/or-throwaway.key`
  (mode 0600, expires ~1 day). All spends attributable to this key.
- Operator ambient `OPENROUTER_API_KEY` is a DIFFERENT key (fingerprint
  `f945bc2f...`, throwaway is `683b59dc...`). Every subject/supervisor/relay
  invocation MUST `env -u OPENROUTER_API_KEY` first, then use only the
  throwaway (relay holds it; subjects never see it).
- Operator `~/.config/muse/auth.json` (OAuth, Meta) exists but its token
  lives in OS keyring — not extracted, not used.

## Verified free models (via GET /api/v1/models + live probes)

Zero-price (prompt == completion == "0"), tools + tool_choice supported:

| model | ctx | role |
|---|---|---|
| `poolside/laguna-s-2.1:free` | 262k | subject coding (verified live: replies, cost 0) |
| `cohere/north-mini-code:free` | 256k | supervisor (verified live: reasoning model, cost 0) |
| `google/gemma-4-26b-a4b-it:free` | 131k | Jev-backend candidate (response_format supported) |
| `google/gemma-4-12b-a4b-it:free` | 131k | Jev-backend fallback |

NOT available (despite being suggested): `minimax/minimax-m2.5:free`,
`openai/gpt-oss-120b:free`, `nvidia/nemotron-3-super-120b-a12b:free`
— all absent from the live model list.

## Free-only relay (`harness/freeonly-relay.py`)

- Listens 127.0.0.1:18789. Holds the throwaway key (OR_KEY_FILE).
- `GET /muse-code/models` → filtered 4-row free-only catalog.
- Everything else → proxied to `https://openrouter.ai/api/v1` ONLY if
  `body.model` is in ALLOWLIST, else HTTP 403 (nothing forwarded).
- Forces `provider.max_price = {prompt: 0, completion: 0}` upstream.
- Logs every upstream call to OR_USAGE_LOG with model + cost + tokens.
- Account check: key `limit_remaining` stays 0.1 (free calls don't decrement).
- Request diagnostics must redact `Authorization`, cookies, API keys, and
  token-like headers before writing `OR_REQUEST_LOG`. The current relay now
  does this and `harness/test_freeonly_relay.py` covers it. Older retained
  `relay-requests.log` files were found with unredacted Authorization values;
  treat those files as credential exposure and rotate any still-active key
  represented there before reusing it. Preserve the original evidence until
  the operator decides how to handle those files.

## Muse subject configuration

- Isolated `HOME/XDG_DATA_HOME/XDG_CONFIG_HOME` per run.
- `$XDG_CONFIG_HOME/muse/settings.json`:
  `{"schema_version": 1, "endpoint_transport": {"base_url":
  "http://127.0.0.1:18789", "auth": "bearer"}}`
- `META_API_KEY=local-relay-only` (dummy; relay ignores bearer, localhost).
- Launch: `muse exec --json "<prompt>"` (default provider meta resolves
  through the pinned endpoint transport).

## Catalog: SOLVED via seeded cache (2026-10-29)

- Muse parses the **wire** catalog as CatalogV1 `{manifest_digest,
  source_digest, entries}`; the on-disk cache shape (`schema_version 2 +
  rows`) is the PROCESSED form and is rejected on the wire with
  `meta model catalog parse failed during default-model resolution:
  no visible models` → `Provider returned malformed response data.`
  (confirmed via binary strings + byte-identical serve test).
- Bypass: seed `$XDG_DATA_HOME/muse/model-catalog/6d657461__p746268.json`
  (filename = hex("meta")+"__p"+hex("tbh")) with the valid cache shape and
  free-model rows (all 18 row keys, `visibility: visible`, one
  `is_default+is_current` row, zero-string cost). Muse retains the cache
  when refresh fails and proceeds. Generator: inline python in run log;
  canonical copy: `/tmp/freeonly-seed-catalog.json` (regenerate per run).
- Inference transport: `POST /responses` (Meta Responses API, SSE) to the
  same base URL. Relay proxies path-verbatim to OpenRouter
  (`/api/v1/responses`), which accepts it. Body `model` MUST be the
  allowlisted free ID — pass `--model <free-id>` to every `muse exec`.
- Overhead: each turn also fires ~3 reminder subagent calls
  (skill/goal/verify-reminder) through the same model — budget ×4.
- Key account check: `GET /api/v1/auth/key` → `usage: 0,
  limit_remaining: 0.1` after all runs. Zero charge confirmed.

## Catalog problem (SOLVED — see above)

- Muse 1.4.14 fetches `{base}/muse-code/models` at startup.
- OpenRouter has no such route → Ori's `ori muse` fails with 404 HTML.
- Ori seeds a schema_version **1** cache (424 rows); real Meta caches are
  schema_version **2** (18 keys/row incl. background_agent_model,
  reasoning_effort_variants, supports_image_generation, supports_video).
- Relay serving v2-shaped catalog (even byte-identical real rows) is still
  rejected as malformed → shape is NOT the (only) cause. Suspect transport
  framing or an additional required field. Bisect in progress.
- Real Meta catalog reference:
  `/home/bamn/.local/share/muse/model-catalog/6d657461__p746268.json`
  (operator's own cache; product names only, no secrets).

## 2026-10-30 live-02 resolution (bisect closed)

- v2 catalog shape is CORRECT and sufficient: serving the sibling relay's
  exact v2 bytes (schema 2, 18-key rows) + v2-seeded on-disk cache →
  `muse exec` exit 0, real poolside:free session, hooks firing.
- The earlier "malformed response data" failures were NOT the shape. Three
  compounding causes, all environmental/procedural:
  1. Hand-written `settings.json` with only `endpoint_transport` CLOBBERED
     the `runtime_capabilities` hook grants (same file). No grants → hooks
     never execute, silently. Never replace settings.json wholesale; merge.
  2. Rebuilding the plugin (new dist bytes) invalidates the installed
     package digest → all capabilities go `review_needed` and
     `muse plugins approve` refuses until reinstall. Reinstall + approve
     after every rebuild before a live session.
  3. The sibling harness plant (older copy) omits `allow_custom_relay`, so
     a JEV_BACKEND=openrouter + relay run fails closed at model
     construction (MODEL_INITIALIZATION_ERROR receipts — the fail-closed
     path itself proven live). This tree's plant already includes it.
- Working invocation (no settings.json override): `--provider meta
  --model <free-id> --base-url http://127.0.0.1:PORT --api-key-stdin`
  (dummy bearer; relay replaces upstream from OR_KEY_FILE).
- live-02 evidence (`/home/bamn/jeverb-evidence/live-02/`, candidate
  f1bce02e…+dirty:4f68c663): 35 relay upstream calls, all
  poolside/laguna-s-2.1:free, 30×200 + 5×429 shared-tier rate limits, zero
  nonzero-cost rows; relay forces `provider.max_price={0,0}` on every
  proxied call. Hook receipts: DETERMINISTIC_DENY (new stamp, live),
  RATE_LIMITED×3, INVALID_MODEL_RESPONSE×2 (free chat model, expected),
  JUDGMENT_TIMEOUT×1 (free latency > hook budget — calibration constraint).
- Disqualified session note: one earlier live-benign run exited 0 with task
  done but zero hook receipts and zero relay calls (grants clobbered by a
  hand-written settings.json; model traffic likely bypassed the relay via
  keyring auth). Exit 0 + artifact alone is NOT qualification — receipts
  and relay usage are required. That session's spend, if any, is unattributed.
