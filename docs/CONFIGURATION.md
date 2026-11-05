# Configuration

Configuration is read by the MCP process and hook processes. Native Muse sanitizes process environment, so install-scoped files in its plugin data directory are supported. Environment variables take precedence where the host passes them through; plugin option values are also mapped into the loader.

## Jev backend

`JEV_BACKEND` selects `typesafe` (default), `openrouter`, or `jev-gateway`.

| Setting | Default / meaning |
|---|---|
| `JEV_MODEL` | TypeSafe backend defaults to pinned `jev-1.14.0`; `JEV_MODEL=jev-latest` follows the TypeSafe alias. |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` when OpenRouter is selected. |
| OpenRouter model | `typesafe/jev-latest` when OpenRouter is selected and no model override is set. |
| `JEV_GATEWAY_BASE_URL` | `http://127.0.0.1:18769/jev` for `jev-gateway`. |
| Gateway model | `typesafe/jev-latest` by default. The gateway must be available and configured separately. |
| `TYPESAFE_API_KEY` | Credential for native TypeSafe. |
| `OPENROUTER_API_KEY` | Credential for OpenRouter. |
| `JEV_TIMEOUT_MS` | 30,000 ms. |
| `JEV_MAX_RETRIES` | 3; use `0` for experiments that require zero retries. |
| `JEV_AUTO_THRESHOLD` / `JEV_REVIEW_THRESHOLD` | 0.85 / 0.60; review must not exceed auto. These are not calibrated correctness probabilities. |
| `JEV_ALLOW_CUSTOM_RELAY` | Defaults false. Required to use a non-official OpenRouter-compatible relay URL. |

The provider key is read from the selected provider's environment variable or the install-scoped credentials file. Do not place credentials in `config.json`, source code, or benchmark artifacts. The credential file is expected to be private (`0600`). Alias selection is not proof of the concrete model served; retain provider responses/model identity in evaluation evidence.

## Install-scoped files

For Muse's plugin data directory, `config.json` holds non-secret settings and the separate `credentials` JSON file holds provider keys. Example `config.json`:

```json
{
  "backend": "openrouter",
  "model": "typesafe/jev-latest",
  "base_url": "https://openrouter.ai/api/v1",
  "allow_custom_relay": false,
  "auto_threshold": 0.85,
  "review_threshold": 0.6
}
```

`credentials` example (keep the actual file private and out of version control):

```json
{"OPENROUTER_API_KEY":"<your key>"}
```

Consult `src/config.ts` and `src/hooks/config.ts` for the accepted option names and precedence. Invalid settings generate sanitized warnings or fail config construction where the value is unsafe/malformed.

## Graph execution

Graph execution is effectful and default-deny. In Muse, operator-owned `config.json` may explicitly set `"graph_shell":"allow"`; this is only one required policy input and does not replace deterministic authorization, Bubblewrap confinement, or the protected master switch. `graph_network`, `graph_retry`, and `graph_capture_output` are separately opt-in. Optional settings include `graph_profile` (`inspect`, `implement`, `networked`), `graph_readonly`, `graph_max_parallel`, `graph_node_timeout_ms`, and `graph_timeout_ms`. Environment overrides include `JEV_GRAPH_SHELL`, `JEV_GRAPH_NETWORK`, `JEV_GRAPH_RETRY`, `JEV_GRAPH_CAPTURE_OUTPUT`, `JEV_GRAPH_PROFILE`, and corresponding read-only/limit settings.

Do not switch on the protected service as part of ordinary setup. See [Control service](CONTROL-SERVICE.md) for owner, installation, and qualification boundaries.
