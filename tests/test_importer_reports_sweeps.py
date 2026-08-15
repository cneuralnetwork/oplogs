from __future__ import annotations

import json
import sys
from pathlib import Path

from oplogs.importer import import_wandb
from oplogs.reports import render_report
from oplogs.storage import Storage
from oplogs.sweeps import SweepController, generate_trials


def test_wandb_json_import(store: Storage, tmp_path: Path) -> None:
    export = tmp_path / "wandb.json"
    export.write_text(
        json.dumps(
            {
                "project": "legacy",
                "name": "old-run",
                "config": {"lr": 0.2},
                "history": [{"_step": 0, "loss": 1.0}, {"_step": 1, "loss": 0.5}],
            }
        )
    )
    result = import_wandb(export, store)
    run_id = result["runs"][0]["id"]
    assert store.get_run(run_id)["state"] == "imported"
    assert [point["value"] for point in store.history(run_id)["loss"]] == [1.0, 0.5]


def test_wandb_directory_imports_media(store: Storage, tmp_path: Path) -> None:
    export = tmp_path / "wandb" / "run-1"
    files = export / "files"
    files.mkdir(parents=True)
    (export / "wandb-metadata.json").write_text(json.dumps({"project": "legacy", "name": "media"}))
    (files / "sample.png").write_bytes(b"fake-png")
    result = import_wandb(export, store)
    run_id = result["runs"][0]["id"]
    assert result["runs"][0]["artifacts"] == 1
    assert store.artifacts(run_id)[0]["artifact_type"] == "image"


def test_report_is_self_contained_and_escaped(tmp_path: Path) -> None:
    target = render_report(
        {
            "title": "Results <one>",
            "blocks": [{"type": "text", "text": "<script>alert(1)</script>"}],
        },
        tmp_path / "report.html",
    )
    content = target.read_text()
    assert "Results &lt;one&gt;" in content
    assert "<script>alert(1)</script>" not in content


def test_local_sweep_trials_and_execution(store: Storage) -> None:
    config = {
        "project": "sweeps",
        "name": "grid",
        "method": "grid",
        "count": 4,
        "concurrency": 2,
        "parameters": {"lr": {"values": [0.1, 0.01]}, "batch": {"values": [8, 16]}},
    }
    assert len(generate_trials(config)) == 4
    result = SweepController(config, [sys.executable, "-c", "import sys; sys.exit(0)"], store).run()
    assert result["state"] == "finished"
    assert all(trial["state"] == "finished" for trial in result["trials"])


def test_bayesian_sweep_executes_real_optuna_trials(store: Storage) -> None:
    config = {
        "project": "sweeps",
        "name": "bayesian",
        "method": "bayesian",
        "count": 3,
        "parameters": {"lr": {"min": 0.0001, "max": 0.1, "log": True}},
    }
    result = SweepController(config, [sys.executable, "-c", "import sys; sys.exit(0)"], store).run()
    assert result["method"] == "bayesian"
    assert len(result["trials"]) == 3
    assert result["best_value"] == 0.0
