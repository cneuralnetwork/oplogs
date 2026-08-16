"""Verify sweep parameters override script defaults in sdk.init() config merging."""

from __future__ import annotations

import json
from typing import Any

import oplogs
from oplogs.config import DaemonInfo


def _mock_init_environment(monkeypatch) -> dict[str, Any]:
    payload: dict[str, Any] = {}

    class FakeResponse:
        status_code = 200

        def raise_for_status(self) -> None:
            pass

        def json(self) -> dict[str, Any]:
            return {"id": "test-run", "project": "test", "name": "test"}

    class FakeClient:
        def __init__(self, *args, **kwargs) -> None:
            pass

        def __enter__(self) -> FakeClient:
            return self

        def __exit__(self, *args) -> None:
            pass

        def post(self, url: str, json: dict[str, Any] | None = None, **kwargs) -> FakeResponse:
            payload.update(json or {})
            return FakeResponse()

    monkeypatch.setattr(
        "oplogs.sdk.ensure_daemon",
        lambda **kwargs: (DaemonInfo(1, 7437, "token", "2026-08-16T00:00:00Z"), False),
    )
    monkeypatch.setattr("oplogs.sdk.httpx.Client", FakeClient)
    monkeypatch.setattr("oplogs.sdk.Run", lambda *args, **kwargs: None)
    return payload


def test_sweep_config_overrides_script_defaults(monkeypatch) -> None:
    """Sweep-injected hyperparameters must take precedence over script defaults in sdk.init()."""
    payload = _mock_init_environment(monkeypatch)

    sweep_params = {"learning_rate": 0.05, "batch_size": 128}
    monkeypatch.setenv("OPLOGS_SWEEP_CONFIG", json.dumps(sweep_params))
    monkeypatch.setenv("OPLOGS_SWEEP_ID", "sweep-abc")
    monkeypatch.setenv("OPLOGS_SWEEP_INDEX", "3")

    oplogs.init(
        config={"learning_rate": 0.001, "batch_size": 32, "model": "resnet18"},
        open=False,
    )

    merged_config = payload.get("config", {})

    # Sweep parameters must override script defaults.
    assert merged_config["learning_rate"] == 0.05
    assert merged_config["batch_size"] == 128

    # Non-swept script parameters must be preserved.
    assert merged_config["model"] == "resnet18"

    # Sweep metadata must be present.
    assert merged_config["_oplogs.sweep_id"] == "sweep-abc"
    assert merged_config["_oplogs.sweep_index"] == 3


def test_config_unchanged_without_active_sweep(monkeypatch) -> None:
    """Without sweep env vars, sdk.init() submitted config equals script config."""
    payload = _mock_init_environment(monkeypatch)

    monkeypatch.delenv("OPLOGS_SWEEP_CONFIG", raising=False)
    monkeypatch.delenv("OPLOGS_SWEEP_ID", raising=False)
    monkeypatch.delenv("OPLOGS_SWEEP_INDEX", raising=False)

    oplogs.init(
        config={"learning_rate": 0.001, "model": "resnet18"},
        open=False,
    )

    merged_config = payload.get("config", {})
    assert merged_config == {"learning_rate": 0.001, "model": "resnet18"}
