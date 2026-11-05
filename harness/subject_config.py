"""Build install-scoped hook configuration for an isolated Muse subject."""

from urllib.parse import urlsplit, urlunsplit


OPENROUTER_DEFAULT = "https://openrouter.ai/api/v1"


def normalize_openrouter_base(base: str) -> str:
    """Give a relay root the OpenRouter API prefix; preserve explicit paths."""
    value = base.strip()
    if not value:
        return ""
    parts = urlsplit(value)
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        raise ValueError("OpenRouter base URL must be an absolute HTTP(S) URL")
    if parts.username is not None or parts.password is not None:
        raise ValueError("OpenRouter credentials must not be embedded in the base URL")
    if parts.path in {"", "/"}:
        parts = parts._replace(path="/api/v1")
    return urlunsplit(parts)


def subject_hook_config(env: dict[str, str]) -> tuple[dict, list[str]]:
    """Return only operator-supplied policy, plus the relay root correction."""
    config: dict = {}
    backend = env.get("JEV_BACKEND", "").strip().lower()
    if backend:
        config["backend"] = backend
    model = env.get("JEV_MODEL", "").strip()
    if model:
        config["model"] = model
    base = (env.get("OPENROUTER_BASE_URL", "") if backend == "openrouter"
            else env.get("TYPESAFE_BASE_URL", "")).strip()
    if base:
        if backend == "openrouter":
            base = normalize_openrouter_base(base)
        config["base_url"] = base
    if backend == "openrouter" and base and base.rstrip("/") != OPENROUTER_DEFAULT:
        config["allow_custom_relay"] = True
    warnings: list[str] = []
    timeout = env.get("JEV_HOOK_TIMEOUT_MS", "").strip()
    if timeout:
        try:
            config["timeout_ms"] = int(timeout)
        except ValueError:
            warnings.append(f"ignoring non-numeric JEV_HOOK_TIMEOUT_MS={timeout!r}")
    return config, warnings
