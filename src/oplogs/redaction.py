"""Conservative local secret redaction."""

from __future__ import annotations

import re
from typing import Any

SECRET_KEY = re.compile(
    r"(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|private[_-]?key|secret|cookie)",
    re.IGNORECASE,
)
SECRET_VALUE_PATTERNS = [
    re.compile(r"\b(?:sk|pk|rk|ghp|github_pat|xox[baprs])-[-A-Za-z0-9_]{12,}\b"),
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b", re.IGNORECASE),
    re.compile(r"https?://[^/@\s]+@", re.IGNORECASE),
]


def redact_value(key: str, value: Any) -> tuple[Any, bool]:
    if SECRET_KEY.search(key):
        return "[REDACTED]", True
    if not isinstance(value, str):
        return value, False
    redacted = value
    changed = False
    for pattern in SECRET_VALUE_PATTERNS:
        replaced = pattern.sub("[REDACTED]", redacted)
        changed = changed or replaced != redacted
        redacted = replaced
    return redacted, changed


def redact_mapping(values: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    safe: dict[str, Any] = {}
    redacted_keys: list[str] = []
    for key, value in values.items():
        replacement, changed = redact_value(key, value)
        safe[key] = replacement
        if changed:
            redacted_keys.append(key)
    return safe, sorted(redacted_keys)


def redact_payload(value: Any, key: str = "") -> tuple[Any, list[str]]:
    """Recursively redact structured event data before it leaves the SDK process."""
    if SECRET_KEY.search(key):
        return "[REDACTED]", [key or "value"]
    if isinstance(value, dict):
        safe: dict[str, Any] = {}
        redacted: list[str] = []
        for child_key, child_value in value.items():
            path = f"{key}.{child_key}" if key else str(child_key)
            safe_value, child_redactions = redact_payload(child_value, path)
            safe[str(child_key)] = safe_value
            redacted.extend(child_redactions)
        return safe, sorted(set(redacted))
    if isinstance(value, (list, tuple)):
        safe_items: list[Any] = []
        redacted = []
        for index, item in enumerate(value):
            path = f"{key}[{index}]" if key else f"[{index}]"
            safe_item, child_redactions = redact_payload(item, path)
            safe_items.append(safe_item)
            redacted.extend(child_redactions)
        return safe_items, sorted(set(redacted))
    replacement, changed = redact_value(key, value)
    return replacement, [key or "value"] if changed else []


def redact_text(text: str) -> tuple[str, int]:
    result = text
    count = 0
    for pattern in SECRET_VALUE_PATTERNS:
        result, substitutions = pattern.subn("[REDACTED]", result)
        count += substitutions
    return result, count
