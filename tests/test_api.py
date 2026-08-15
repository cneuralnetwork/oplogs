from __future__ import annotations

import httpx
import pytest

from oplogs.daemon import create_app
from oplogs.models import Event
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

        finished = Event(
            "api-run", 1, "run.finished", {"state": "finished"}
        ).seal()
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
