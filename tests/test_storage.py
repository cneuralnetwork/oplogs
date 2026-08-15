from __future__ import annotations

from pathlib import Path

from oplogs.models import Event
from oplogs.storage import Storage


def test_journal_is_idempotent_and_rebuildable(store: Storage) -> None:
    run = store.create_run("vision", "baseline", {"lr": 0.1}, ["test"], run_id="run1")
    event = Event(run.id, 0, "metric", {"values": {"loss": 0.8, "label": "train"}}, step=1)
    store.append_event(event)
    store.append_event(event)

    journal = store.runs_dir / run.id / "events.jsonl"
    assert len(journal.read_text().splitlines()) == 1
    assert store.history(run.id)["loss"][0]["value"] == 0.8
    assert store.get_run(run.id)["summary"]["loss"] == 0.8

    rebuilt = store.rebuild()
    assert rebuilt == {"rebuilt": 1, "invalid": 0}
    assert store.history(run.id)["loss"][0]["step"] == 1.0
    assert store.get_run(run.id)["summary"]["loss"] == 0.8
    assert store.get_run(run.id)["last_sequence"] == 0


def test_history_downsamples_each_metric_independently(store: Storage) -> None:
    run = store.create_run("scale", run_id="many-points")
    for sequence in range(100):
        store.append_event(
            Event(
                run.id,
                sequence,
                "metric",
                {"values": {"loss": 100 - sequence, "accuracy": sequence}},
                step=sequence,
            )
        )
    history = store.history(run.id, limit=10)
    assert set(history) == {"accuracy", "loss"}
    assert all(2 <= len(points) <= 12 for points in history.values())
    assert history["loss"][0]["step"] == 0
    assert history["loss"][-1]["step"] == 99


def test_run_index_can_be_recreated_from_manifest_and_journal(tmp_path: Path) -> None:
    root = tmp_path / "recovery"
    store = Storage(root)
    run = store.create_run("recovery", "lost-index", {"lr": 0.01}, ["proof"], run_id="recover")
    store.append_event(Event(run.id, 0, "metric", {"values": {"loss": 0.4}}, step=4))
    store.finish_run(run.id)
    store.database_path.unlink()
    Path(f"{store.database_path}-wal").unlink(missing_ok=True)
    Path(f"{store.database_path}-shm").unlink(missing_ok=True)

    recovered = Storage(root)
    assert recovered.rebuild() == {"rebuilt": 1, "invalid": 0}
    restored = recovered.get_run(run.id)
    assert restored["project"] == "recovery"
    assert restored["config"] == {"lr": 0.01}
    assert restored["tags"] == ["proof"]
    assert restored["state"] == "finished"
    assert restored["summary"] == {"loss": 0.4}


def test_artifact_content_addressing_and_registry(store: Storage, tmp_path: Path) -> None:
    run = store.create_run("vision", run_id="run2")
    source = tmp_path / "model.bin"
    source.write_bytes(b"weights")
    first = store.add_artifact(
        run.id,
        {
            "path": str(source),
            "name": "model.bin",
            "mime_type": "application/octet-stream",
            "artifact_type": "model",
            "aliases": ["candidate"],
        },
    )
    second = store.add_artifact(run.id, {"path": str(source), "name": "copy.bin"})
    assert first["digest"] == second["digest"]
    assert store.artifact_path(first["digest"]).read_bytes() == b"weights"

    registered = store.register_artifact(first["id"], "vision-model", ["latest", "candidate"])
    assert registered["version"] == 0
    assert store.registry()[0]["artifact_name"] == "model.bin"


def test_traces_reports_sweeps_and_alerts(store: Storage) -> None:
    run = store.create_run("agents", run_id="run3")
    store.append_event(
        Event(run.id, 0, "trace.start", {"id": "span1", "name": "agent.plan", "attributes": {}})
    )
    store.append_event(
        Event(run.id, 1, "trace.end", {"id": "span1", "status": "ok", "duration_ms": 12.5})
    )
    assert store.traces(run.id)[0]["duration_ms"] == 12.5

    report = store.create_report("Findings", "agents", [{"type": "text", "text": "Good run"}])
    assert store.reports()[0]["id"] == report["id"]
    sweep = store.create_sweep("agents", "learning-rate", {"method": "grid"})
    store.update_sweep(sweep["id"], "running")
    assert store.sweeps()[0]["state"] == "running"
    alert = store.create_alert("agents", {"event": "exception"})
    assert store.alerts()[0]["id"] == alert["id"]
