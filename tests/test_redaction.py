from __future__ import annotations

from oplogs.redaction import redact_mapping, redact_payload, redact_text


def test_redacts_secret_keys_and_token_patterns() -> None:
    safe, keys = redact_mapping(
        {
            "PATH": "/usr/bin",
            "OPENAI_API_KEY": "sk-supersecret0123456789",
            "note": "Bearer abcdefghijklmnopqrstuvwxyz",
        }
    )
    assert safe["PATH"] == "/usr/bin"
    assert safe["OPENAI_API_KEY"] == "[REDACTED]"
    assert "[REDACTED]" in safe["note"]
    assert keys == ["OPENAI_API_KEY", "note"]


def test_redacts_private_key_marker() -> None:
    value, count = redact_text("-----BEGIN PRIVATE KEY-----\nabc")
    assert count == 1
    assert value.startswith("[REDACTED]")


def test_redacts_credentials_embedded_in_git_urls() -> None:
    value, count = redact_text("https://user:token@example.com/repository.git")
    assert count == 1
    assert "user:token" not in value


def test_recursively_redacts_nested_payloads() -> None:
    safe, paths = redact_payload(
        {"request": {"api_key": "plain-secret", "headers": ["Bearer abcdefghijklmnop"]}}
    )
    assert safe["request"]["api_key"] == "[REDACTED]"
    assert safe["request"]["headers"] == ["[REDACTED]"]
    assert paths == ["request.api_key", "request.headers[0]"]
