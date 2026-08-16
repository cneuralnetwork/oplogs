from __future__ import annotations

import http.server
import json
import socket
import threading
import time
from pathlib import Path

import httpx
import pytest

from oplogs.daemon import create_app
from oplogs.models import Event
from oplogs.sdk import _Sender
from oplogs.storage import Storage


@pytest.mark.asyncio
async def test_full_ingestion_and_query_flow(store: Storage) -> None:
    transport = httpx.ASGITransport(app=create_app(store, token="secret"))
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        assert (await client.get("/health")).json()["status"] == "ok"
        info = (await client.get("/api/info")).json()
        assert info["name"] == "oplogs"
        assert info["write_token"] == "secret"

        response = await client.post(
            "/api/runs",
            headers={"X-OPLOGS-Token": "secret"},
            json={"id": "api-run", "project": "api", "name": "test", "config": {"lr": 0.01}},
        )
        assert response.status_code == 200
        event = Event("api-run", 0, "metric", {"values": {"loss": 0.25}}, step=2).seal()
        response = await client.post(
            "/api/runs/api-run/events",
            headers={"X-OPLOGS-Token": "secret"},
            json=[event.to_dict()],
        )
        assert response.json() == {"accepted": 1}
        assert (await client.get("/api/runs/api-run/history")).json()["loss"][0]["value"] == 0.25
        assert (await client.get("/api/runs")).json()[0]["summary"]["loss"] == 0.25
        metrics_export = await client.get("/api/runs/api-run/history.jsonl")
        assert metrics_export.headers["content-type"].startswith("application/x-ndjson")
        assert (
            metrics_export.headers["content-disposition"] == 'attachment; filename="metrics.jsonl"'
        )
        assert metrics_export.json() == {
            "sequence": 0,
            "step": 2.0,
            "timestamp": event.timestamp,
            "rank": None,
            "loss": 0.25,
        }

        finished = Event("api-run", 1, "run.finished", {"state": "finished"}).seal()
        response = await client.post(
            "/api/runs/api-run/events",
            headers={"X-OPLOGS-Token": "secret"},
            json=[finished.to_dict()],
        )
        assert response.json() == {"accepted": 1}
        retained = (await client.get("/api/runs")).json()
        assert retained[0]["state"] == "finished"
        assert retained[0]["finished_at"] == finished.timestamp


@pytest.mark.asyncio
async def test_writes_require_local_capability(store: Storage) -> None:
    transport = httpx.ASGITransport(app=create_app(store, token="secret"))
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post("/api/runs", json={"project": "blocked"})
        assert response.status_code == 403


@pytest.mark.asyncio
async def test_rejects_dns_rebinding_host_headers(store: Storage) -> None:
    transport = httpx.ASGITransport(app=create_app(store, token="secret"))
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get("/api/info", headers={"Host": "attacker.example"})
        assert response.status_code == 403


@pytest.mark.asyncio
async def test_retried_batch_does_not_duplicate_artifacts(store: Storage, tmp_path) -> None:
    transport = httpx.ASGITransport(app=create_app(store, token="secret"))
    source = tmp_path / "model.pt"
    source.write_bytes(b"weights")
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post(
            "/api/runs",
            headers={"X-OPLOGS-Token": "secret"},
            json={"id": "retried", "project": "p", "name": "run"},
        )
        assert response.status_code == 200
        raw = Event(
            "retried",
            0,
            "artifact",
            {
                "values": {
                    "checkpoint": {
                        "path": str(source),
                        "name": "model.pt",
                        "artifact_type": "model",
                    }
                }
            },
        ).to_dict()
        headers = {"X-OPLOGS-Token": "secret"}
        first = await client.post("/api/runs/retried/events", json=[raw], headers=headers)
        retry = await client.post("/api/runs/retried/events", json=[raw], headers=headers)
        assert first.json() == {"accepted": 1}
        assert retry.json() == {"accepted": 0}
        artifacts = store.artifacts("retried")
        assert len(artifacts) == 1
        assert artifacts[0]["name"] == "model.pt"


def test_sender_replays_spooled_events_when_daemon_recovers(tmp_path: Path) -> None:
    received: list[dict] = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            length = int(self.headers["Content-Length"])
            received.extend(json.loads(self.rfile.read(length)))
            self.send_response(200)
            self.end_headers()

        def log_message(self, *args) -> None:
            pass

    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()

    base_url = f"http://127.0.0.1:{port}"
    spool_path = tmp_path / "spool.jsonl"
    sender = _Sender("spool-run", base_url, "token", spool_path)
    try:
        sender.enqueue(
            {"sequence": 0, "kind": "metric", "payload": {"values": {"loss": 1.0}}, "checksum": "a"}
        )
        sender.enqueue(
            {"sequence": 1, "kind": "metric", "payload": {"values": {"loss": 0.5}}, "checksum": "b"}
        )
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not spool_path.exists():
            time.sleep(0.02)
        assert spool_path.exists(), "events should spool while the daemon is down"

        server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            sender.close()
        finally:
            server.shutdown()
            thread.join()
    finally:
        sender.close()

    assert len(received) == 2
    assert not spool_path.exists()


def test_daemon_startup_replays_orphaned_spools(store: Storage, tmp_path: Path) -> None:
    from fastapi.testclient import TestClient

    from oplogs.daemon import create_app

    run = store.create_run("outage", run_id="startup-run")
    metric = Event(run.id, 0, "metric", {"values": {"loss": 2.0}}).to_dict()
    (store.runs_dir / run.id / "spool.jsonl").write_text(
        json.dumps(metric, separators=(",", ":")) + "\n"
    )

    with TestClient(create_app(storage=store, token="secret")) as client:
        assert client.get("/health").json()["status"] == "ok"

    assert store.history(run.id)["loss"][0]["value"] == 2.0
    assert not (store.runs_dir / run.id / "spool.jsonl").exists()
