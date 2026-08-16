"""FastAPI localhost service for ingestion and the dashboard."""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
from contextlib import asynccontextmanager
from dataclasses import asdict
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .alerts import AlertEngine
from .config import DaemonInfo, daemon_file, read_daemon_info, write_daemon_info
from .importer import import_wandb
from .models import Event, utc_now
from .reports import export_pdf, render_report
from .storage import Storage, derive_artifact_id


def create_app(storage: Storage | None = None, token: str | None = None) -> FastAPI:
    store = storage or Storage()
    alert_engine = AlertEngine(store)
    write_token = token or os.environ.get("OPLOGS_TOKEN", "development")
    subscribers: set[asyncio.Queue[dict[str, Any]]] = set()

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        yield

    app = FastAPI(title="oplogs", version="0.1.0", lifespan=lifespan)

    async def authorize(x_oplogs_token: str | None = Header(default=None)) -> None:
        if x_oplogs_token != write_token:
            raise HTTPException(status_code=403, detail="invalid local capability token")

    async def publish(message: dict[str, Any]) -> None:
        for queue in list(subscribers):
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                subscribers.discard(queue)

    @app.middleware("http")
    async def local_only(request: Request, call_next):
        client_host = request.client.host if request.client else ""
        requested_host = request.url.hostname or ""
        if client_host not in {"127.0.0.1", "::1", "testclient"} or requested_host not in {
            "127.0.0.1",
            "localhost",
            "::1",
            "testserver",
        }:
            return HTMLResponse("oplogs is localhost-only", status_code=403)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
            "media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; "
            "frame-ancestors 'none'"
        )
        return response

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {"status": "ok", "version": "0.1.0"}

    @app.get("/api/info")
    async def info() -> dict[str, Any]:
        return {
            "name": "oplogs",
            "version": "0.1.0",
            "local": True,
            "storage": store.storage_usage(),
            "write_token": write_token,
        }

    @app.get("/api/projects")
    async def projects() -> list[dict[str, Any]]:
        return store.list_projects()

    @app.get("/api/runs")
    async def runs(
        project: str | None = None, limit: int = Query(default=200, le=5000)
    ) -> list[dict[str, Any]]:
        return store.list_runs(project=project, limit=limit)

    @app.post("/api/runs", dependencies=[Depends(authorize)])
    async def create_run(payload: dict[str, Any]) -> dict[str, Any]:
        record = store.create_run(
            project=payload["project"],
            name=payload.get("name"),
            config=payload.get("config"),
            tags=payload.get("tags"),
            run_id=payload.get("id"),
        )
        await publish({"type": "run.created", "run_id": record.id})
        return {**asdict(record), "url": f"/runs/{record.id}"}

    @app.get("/api/runs/{run_id}")
    async def run(run_id: str) -> dict[str, Any]:
        value = store.get_run(run_id)
        if not value:
            raise HTTPException(status_code=404, detail="run not found")
        return value

    @app.post("/api/runs/{run_id}/events", dependencies=[Depends(authorize)])
    async def append_events(run_id: str, payload: list[dict[str, Any]]) -> dict[str, int]:
        pending: list[Event] = []
        for raw in payload:
            raw["run_id"] = run_id
            event = Event.from_dict(raw) if raw.get("checksum") else Event(**raw).seal()
            if event.kind in {"artifact", "media"}:
                values = event.payload.get("values", {})
                indexed: dict[str, Any] = {}
                for key, descriptor in values.items():
                                    if not isinstance(descriptor, dict):
                                        indexed[key] = descriptor
                                        continue
                                    # Deterministic from (run, sequence, key) so a resent batch
                                    # (SDK retry/spool replay) reuses the same artifact id
                                    # instead of minting a new row before dedup runs below.
                                    artifact_id = derive_artifact_id(run_id, event.sequence, key)
                                    if "path" in descriptor:
                                        artifact_descriptor = dict(descriptor)
                                        if descriptor.get("caption"):
                                            artifact_descriptor["metadata"] = {
                                                **descriptor.get("metadata", {}),
                                                "caption": descriptor["caption"],
                                            }
                                        indexed[key] = store.add_artifact(
                                            run_id, artifact_descriptor, artifact_id=artifact_id
                                        )
                                    elif "file" in descriptor and "path" in descriptor["file"]:
                                        artifact_descriptor = {
                                            **descriptor["file"],
                                            "artifact_type": descriptor.get("media_type", "file"),
                                            "metadata": {
                                                **descriptor["file"].get("metadata", {}),
                                                **(
                                                    {"caption": descriptor["caption"]}
                                                    if descriptor.get("caption")
                                                    else {}
                                                ),
                                            },
                                        }
                                        indexed[key] = store.add_artifact(
                                            run_id, artifact_descriptor, artifact_id=artifact_id
                                        )
                                    elif "data" in descriptor:
                                        data = base64.b64decode(descriptor["data"], validate=True)
                                        extension = descriptor.get("mime_type", "application/octet-stream").split(
                                            "/"
                                        )[-1]
                                        indexed[key] = store.add_bytes(
                                            run_id,
                                            data,
                                            f"{key}-{event.sequence}.{extension}",
                                            descriptor.get("mime_type", "application/octet-stream"),
                                            descriptor.get("media_type", "media"),
                                            {"caption": descriptor.get("caption")},
                                            artifact_id=artifact_id,
                                        )
                                    else:
                                        indexed[key] = descriptor
                event.payload["values"] = indexed
                event.seal()
            pending.append(event)
        accepted = store.append_events(pending)
        for event in pending:
            alert_engine.evaluate(event)
        await publish({"type": "events.appended", "run_id": run_id, "count": accepted})
        return {"accepted": accepted}

    @app.post("/api/runs/{run_id}/finish", dependencies=[Depends(authorize)])
    async def finish(run_id: str, payload: dict[str, Any] | None = None) -> dict[str, bool]:
        store.finish_run(run_id, (payload or {}).get("state", "finished"))
        await publish({"type": "run.finished", "run_id": run_id})
        return {"ok": True}

    @app.get("/api/runs/{run_id}/history")
    async def history(
        run_id: str, keys: str | None = None, limit: int = Query(default=2500, le=20000)
    ):
        return store.history(run_id, keys.split(",") if keys else None, limit)

    @app.get("/api/runs/{run_id}/history.jsonl")
    async def history_jsonl(run_id: str):
        if not store.get_run(run_id):
            raise HTTPException(status_code=404, detail="run not found")
        rows = store.metric_rows(run_id)

        async def generate():
            for row in rows:
                yield json.dumps(row, separators=(",", ":")) + "\n"

        return StreamingResponse(
            generate(),
            media_type="application/x-ndjson",
            headers={"Content-Disposition": 'attachment; filename="metrics.jsonl"'},
        )

    @app.get("/api/runs/{run_id}/events")
    async def events(
        run_id: str,
        kind: str | None = None,
        limit: int = Query(default=1000, le=10000),
        compact: bool = False,
    ):
        kinds = kind.split(",") if kind and "," in kind else kind
        result = store.events(run_id, kinds, limit)
        if compact:
            return [{**event, "payload": {}} for event in result]
        return result

    @app.get("/api/runs/{run_id}/artifacts")
    async def run_artifacts(run_id: str):
        return store.artifacts(run_id)

    @app.get("/api/artifacts")
    async def all_artifacts():
        return store.artifacts()

    @app.get("/api/traces")
    async def all_traces(run_id: str | None = None, limit: int = Query(default=5000, le=50000)):
        return store.traces(run_id, limit)

    @app.get("/api/reports")
    async def reports():
        return store.reports()

    @app.post("/api/reports", dependencies=[Depends(authorize)])
    async def create_report(payload: dict[str, Any]):
        return store.create_report(
            payload["title"], payload.get("project"), payload.get("blocks", [])
        )

    @app.get("/api/reports/{report_id}/export.html")
    async def export_report(report_id: str):
        report = next((item for item in store.reports() if item["id"] == report_id), None)
        if not report:
            raise HTTPException(status_code=404, detail="report not found")
        output = store.root / "reports" / f"{report_id}.html"
        render_report(report, output)
        return FileResponse(output, media_type="text/html", filename=f"{report['title']}.html")

    @app.get("/api/reports/{report_id}/export.pdf")
    async def export_report_pdf(report_id: str):
        report = next((item for item in store.reports() if item["id"] == report_id), None)
        if not report:
            raise HTTPException(status_code=404, detail="report not found")
        html_output = store.root / "reports" / f"{report_id}.html"
        pdf_output = store.root / "reports" / f"{report_id}.pdf"
        render_report(report, html_output)
        try:
            await asyncio.to_thread(export_pdf, html_output, pdf_output)
        except (RuntimeError, OSError) as exc:
            raise HTTPException(status_code=501, detail=str(exc)) from exc
        return FileResponse(
            pdf_output, media_type="application/pdf", filename=f"{report['title']}.pdf"
        )

    @app.put("/api/reports/{report_id}", dependencies=[Depends(authorize)])
    async def update_report(report_id: str, payload: dict[str, Any]):
        try:
            return store.update_report(report_id, payload["title"], payload.get("blocks", []))
        except KeyError:
            raise HTTPException(status_code=404, detail="report not found") from None

    @app.get("/api/sweeps")
    async def sweeps():
        return store.sweeps()

    @app.get("/api/registry")
    async def registry():
        return store.registry()

    @app.post("/api/registry", dependencies=[Depends(authorize)])
    async def register(payload: dict[str, Any]):
        return store.register_artifact(
            payload["artifact_id"],
            payload["collection"],
            payload.get("aliases"),
            payload.get("notes", ""),
        )

    @app.get("/api/alerts")
    async def alerts():
        return store.alerts()

    @app.post("/api/alerts", dependencies=[Depends(authorize)])
    async def create_alert(payload: dict[str, Any]):
        return store.create_alert(payload.get("project"), payload["rule"])

    @app.post("/api/import/wandb", dependencies=[Depends(authorize)])
    async def import_wandb_export(payload: dict[str, Any]):
        return import_wandb(payload["path"], store, payload.get("project"))

    @app.get("/api/artifacts/{artifact_id}/content")
    async def artifact_content(artifact_id: str):
        artifacts = [item for item in store.artifacts() if item["id"] == artifact_id]
        if not artifacts:
            raise HTTPException(status_code=404, detail="artifact not found")
        artifact = artifacts[0]
        path = store.artifact_path(artifact["digest"])
        return FileResponse(path, media_type=artifact["mime_type"], filename=artifact["name"])

    @app.get("/api/storage")
    async def storage_usage():
        return store.storage_usage()

    @app.post("/api/rebuild", dependencies=[Depends(authorize)])
    async def rebuild():
        return store.rebuild()

    @app.get("/api/stream")
    async def stream(request: Request):
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=100)
        subscribers.add(queue)

        async def generate():
            try:
                yield "event: ready\ndata: {}\n\n"
                while not await request.is_disconnected():
                    try:
                        message = await asyncio.wait_for(queue.get(), timeout=15)
                        yield f"data: {json.dumps(message)}\n\n"
                    except TimeoutError:
                        yield ": keepalive\n\n"
            finally:
                subscribers.discard(queue)

        return StreamingResponse(generate(), media_type="text/event-stream")

    static_dir = Path(__file__).with_name("static")
    if static_dir.exists() and (static_dir / "index.html").exists():
        app.mount("/assets", StaticFiles(directory=static_dir / "assets"), name="assets")

        @app.get("/{path:path}")
        async def application(path: str):
            requested = (static_dir / path).resolve()
            if path and requested.is_file() and static_dir.resolve() in requested.parents:
                return FileResponse(requested)
            return FileResponse(static_dir / "index.html")
    else:

        @app.get("/", response_class=HTMLResponse)
        async def fallback():
            return "<main style='font:16px system-ui;padding:48px'><h1>oplogs</h1><p>dashboard assets are not built yet.</p></main>"

    return app


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--token", required=True)
    args = parser.parse_args()
    info = DaemonInfo(os.getpid(), args.port, args.token, utc_now())
    write_daemon_info(info)
    try:
        uvicorn.run(
            create_app(token=args.token), host="127.0.0.1", port=args.port, log_level="warning"
        )
    finally:
            # Only remove daemon.json if it still describes *this* process. A
            # stale daemon that is slow to exit could otherwise unlink the
            # record written by a newer daemon that started concurrently.
            current = read_daemon_info()
            if current is not None and current.pid == info.pid:
                daemon_file().unlink(missing_ok=True)


if __name__ == "__main__":
    main()
