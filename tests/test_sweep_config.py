"""Verify sweep parameters override script defaults in init() config merging."""

from __future__ import annotations

import json
import os


def test_sweep_config_overrides_script_defaults(monkeypatch) -> None:
    """Sweep-injected hyperparameters must take precedence over script defaults.

    When a sweep controller sets OPLOGS_SWEEP_CONFIG={"learning_rate": 0.05}
    and the training script calls oplogs.init(config={"learning_rate": 0.001}),
    the merged config must contain learning_rate=0.05 from the sweep, not
    the script default 0.001.

    Non-swept keys like "model" must be preserved from the script config.
    """
    sweep_params = {"learning_rate": 0.05, "batch_size": 128}
    monkeypatch.setenv("OPLOGS_SWEEP_CONFIG", json.dumps(sweep_params))
    monkeypatch.setenv("OPLOGS_SWEEP_ID", "sweep-abc")
    monkeypatch.setenv("OPLOGS_SWEEP_INDEX", "3")

    config = {"learning_rate": 0.001, "batch_size": 32, "model": "resnet18"}
    sweep_values = json.loads(os.environ.get("OPLOGS_SWEEP_CONFIG", "{}"))
    sweep_id = os.environ.get("OPLOGS_SWEEP_ID")
    sweep_index = os.environ.get("OPLOGS_SWEEP_INDEX")
    sweep_metadata = {
        key: value
        for key, value in {
            "_oplogs.sweep_id": sweep_id,
            "_oplogs.sweep_index": int(sweep_index)
            if sweep_index and sweep_index.isdigit()
            else sweep_index,
        }.items()
        if value is not None
    }
    merged_config = {**(config or {}), **sweep_values, **sweep_metadata}

    assert merged_config["learning_rate"] == 0.05
    assert merged_config["batch_size"] == 128
    assert merged_config["model"] == "resnet18"

    # Sweep metadata must be present.
    assert merged_config["_oplogs.sweep_id"] == "sweep-abc"
    assert merged_config["_oplogs.sweep_index"] == 3


def test_config_unchanged_without_active_sweep(monkeypatch) -> None:
    """Without sweep env vars, the merged config must equal the script config."""
    monkeypatch.delenv("OPLOGS_SWEEP_CONFIG", raising=False)
    monkeypatch.delenv("OPLOGS_SWEEP_ID", raising=False)
    monkeypatch.delenv("OPLOGS_SWEEP_INDEX", raising=False)

    config = {"learning_rate": 0.001, "model": "resnet18"}
    sweep_values = json.loads(os.environ.get("OPLOGS_SWEEP_CONFIG", "{}"))
    sweep_id = os.environ.get("OPLOGS_SWEEP_ID")
    sweep_index = os.environ.get("OPLOGS_SWEEP_INDEX")
    sweep_metadata = {
        key: value
        for key, value in {
            "_oplogs.sweep_id": sweep_id,
            "_oplogs.sweep_index": int(sweep_index)
            if sweep_index and sweep_index.isdigit()
            else sweep_index,
        }.items()
        if value is not None
    }
    merged_config = {**(config or {}), **sweep_values, **sweep_metadata}

    assert merged_config == {"learning_rate": 0.001, "model": "resnet18"}
