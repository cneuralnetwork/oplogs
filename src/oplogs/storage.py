"""Durable append-only journals with rebuildable SQLite indexes."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import threading
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from .config import data_dir
from .models import Event, RunRecord, utc_now

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS projects (
  name TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL REFERENCES projects(name),
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  tags_json TEXT NOT NULL DEFAULT '[]',
  source_json TEXT NOT NULL DEFAULT '{}',
  summary_json TEXT NOT NULL DEFAULT '{}',
  last_sequence INTEGER NOT NULL DEFAULT -1
);
CREATE INDEX IF NOT EXISTS runs_project_updated ON runs(project, updated_at DESC);
CREATE TABLE IF NOT EXISTS events (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  step REAL,
  timestamp TEXT NOT NULL,
  monotonic_ns INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  process_id INTEGER,
  rank INTEGER,
  PRIMARY KEY(run_id, sequence)
);
CREATE INDEX IF NOT EXISTS events_run_kind_step ON events(run_id, kind, step);
CREATE TABLE IF NOT EXISTS metrics (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  metric_key TEXT NOT NULL,
  value REAL NOT NULL,
  step REAL,
  timestamp TEXT NOT NULL,
  rank INTEGER,
  PRIMARY KEY(run_id, sequence, metric_key)
);
CREATE INDEX IF NOT EXISTS metrics_lookup ON metrics(run_id, metric_key, step);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  digest TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  source_path TEXT
);
CREATE INDEX IF NOT EXISTS artifacts_run_created ON artifacts(run_id, created_at DESC);
CREATE TABLE IF NOT EXISTS traces (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  parent_id TEXT,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms REAL,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  input_json TEXT,
  output_json TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS traces_run_started ON traces(run_id, started_at DESC);
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  project TEXT,
  blocks_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sweeps (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS registry (
  id TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  version INTEGER NOT NULL,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(collection, version)
);
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  project TEXT,
  rule_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
"""


class Storage:
    def __init__(self, root: Path | None = None) -> None:
        self.root = root or data_dir()
        self.root.mkdir(parents=True, exist_ok=True)
        self.runs_dir = self.root / "runs"
        self.blobs_dir = self.root / "blobs" / "sha256"
        self.runs_dir.mkdir(parents=True, exist_ok=True)
        self.blobs_dir.mkdir(parents=True, exist_ok=True)
        self.database_path = self.root / "metadata.db"
        self._lock = threading.RLock()
        with self.connection() as connection:
            connection.executescript(SCHEMA)

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.database_path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=30000")
        connection.execute("PRAGMA synchronous=NORMAL")
        try:
            yield connection
            connection.commit()
        finally:
            connection.close()

    def create_run(
        self,
        project: str,
        name: str | None = None,
        config: dict[str, Any] | None = None,
        tags: list[str] | None = None,
        run_id: str | None = None,
    ) -> RunRecord:
        now = utc_now()
        run_id = run_id or uuid.uuid4().hex[:12]
        name = name or f"run-{run_id[:6]}"
        with self._lock, self.connection() as connection:
            connection.execute(
                "INSERT INTO projects(name, created_at, updated_at) VALUES(?,?,?) "
                "ON CONFLICT(name) DO UPDATE SET updated_at=excluded.updated_at",
                (project, now, now),
            )
            connection.execute(
                "INSERT INTO runs(id, project, name, state, created_at, updated_at, config_json, tags_json) "
                "VALUES(?,?,?,?,?,?,?,?)",
                (
                    run_id,
                    project,
                    name,
                    "running",
                    now,
                    now,
                    json.dumps(config or {}),
                    json.dumps(tags or []),
                ),
            )
        run_path = self.runs_dir / run_id
        run_path.mkdir(parents=True, exist_ok=True)
        self._write_manifest(
            run_id,
            {
                "id": run_id,
                "project": project,
                "name": name,
                "state": "running",
                "created_at": now,
                "updated_at": now,
                "config": config or {},
                "tags": tags or [],
            },
        )
        return RunRecord(run_id, project, name, "running", now, now, config or {}, tags or [])

    def _write_manifest(self, run_id: str, value: dict[str, Any]) -> None:
        path = self.runs_dir / run_id / "manifest.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(value, indent=2, default=str), encoding="utf-8")
        temporary.replace(path)

    def append_event(self, event: Event) -> None:
        self.append_events([event])

    def append_events(self, events: list[Event]) -> int:
        """Append a same-run batch with one journal sync and one index transaction."""
        if not events:
            return 0
        run_ids = {event.run_id for event in events}
        if len(run_ids) != 1:
            raise ValueError("append_events requires a single run")
        run_id = events[0].run_id
        journal = self.runs_dir / run_id / "events.jsonl"
        journal.parent.mkdir(parents=True, exist_ok=True)
        with self._lock:
            with self.connection() as connection:
                unique_sequences = sorted({event.sequence for event in events})
                placeholders = ",".join("?" for _ in unique_sequences)
                existing = {
                    row[0]
                    for row in connection.execute(
                        f"SELECT sequence FROM events WHERE run_id=? AND sequence IN ({placeholders})",
                        [run_id, *unique_sequences],
                    ).fetchall()
                }
            accepted: list[Event] = []
            seen = set(existing)
            for event in events:
                if event.sequence in seen:
                    continue
                event.seal()
                accepted.append(event)
                seen.add(event.sequence)
            if not accepted:
                return 0
            with journal.open("a", encoding="utf-8") as handle:
                handle.writelines(
                    json.dumps(event.to_dict(), separators=(",", ":"), default=str) + "\n"
                    for event in accepted
                )
                handle.flush()
                os.fsync(handle.fileno())
            with self.connection() as connection:
                for event in accepted:
                    self._index_event(connection, event)
            for event in accepted:
                self._sync_terminal_manifest(event)
        return len(accepted)

    def _index_event(self, connection: sqlite3.Connection, event: Event) -> None:
        connection.execute(
            "INSERT OR IGNORE INTO events VALUES(?,?,?,?,?,?,?,?,?,?)",
            (
                event.run_id,
                event.sequence,
                event.kind,
                event.step,
                event.timestamp,
                event.monotonic_ns,
                json.dumps(event.payload, default=str),
                event.checksum,
                event.process_id,
                event.rank,
            ),
        )
        if event.kind in {"metric", "system"}:
            values = event.payload.get("values", event.payload)
            for key, value in values.items():
                if isinstance(value, bool):
                    value = int(value)
                if isinstance(value, (int, float)):
                    connection.execute(
                        "INSERT OR IGNORE INTO metrics VALUES(?,?,?,?,?,?,?)",
                        (
                            event.run_id,
                            event.sequence,
                            key,
                            float(value),
                            event.step,
                            event.timestamp,
                            event.rank,
                        ),
                    )
        summary = self._summary_update(connection, event)
        self._index_trace(connection, event)
        self._index_artifact_records(connection, event)
        self._update_run_from_event(connection, event, summary)

    @staticmethod
    def _terminal_state(event: Event) -> str | None:
        if event.kind != "run.finished":
            return None
        state = event.payload.get("state", "finished")
        return state if isinstance(state, str) and state else "finished"

    def _update_run_from_event(
        self, connection: sqlite3.Connection, event: Event, summary: dict[str, Any]
    ) -> None:
        terminal_state = self._terminal_state(event)
        if terminal_state:
            connection.execute(
                "UPDATE runs SET state=?, updated_at=?, finished_at=?, "
                "last_sequence=MAX(last_sequence, ?), summary_json=? WHERE id=?",
                (
                    terminal_state,
                    event.timestamp,
                    event.timestamp,
                    event.sequence,
                    json.dumps(summary),
                    event.run_id,
                ),
            )
        else:
            connection.execute(
                "UPDATE runs SET updated_at=?, last_sequence=MAX(last_sequence, ?), "
                "summary_json=? WHERE id=?",
                (event.timestamp, event.sequence, json.dumps(summary), event.run_id),
            )
        connection.execute(
            "UPDATE projects SET updated_at=? WHERE name=(SELECT project FROM runs WHERE id=?)",
            (event.timestamp, event.run_id),
        )

    def _sync_terminal_manifest(self, event: Event) -> None:
        terminal_state = self._terminal_state(event)
        if not terminal_state:
            return
        manifest_path = self.runs_dir / event.run_id / "manifest.json"
        if not manifest_path.exists():
            return
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest.update(
            state=terminal_state,
            updated_at=event.timestamp,
            finished_at=event.timestamp,
        )
        self._write_manifest(event.run_id, manifest)

    @staticmethod
    def _index_trace(connection: sqlite3.Connection, event: Event) -> None:
        payload = event.payload
        if event.kind == "trace.start":
            connection.execute(
                "INSERT OR REPLACE INTO traces(id, run_id, parent_id, name, status, started_at, attributes_json, input_json) "
                "VALUES(?,?,?,?,?,?,?,?)",
                (
                    payload["id"],
                    event.run_id,
                    payload.get("parent_id"),
                    payload.get("name", "span"),
                    "running",
                    event.timestamp,
                    json.dumps(payload.get("attributes", {}), default=str),
                    json.dumps(payload.get("input"), default=str),
                ),
            )
        elif event.kind == "trace.end":
            connection.execute(
                "UPDATE traces SET status=?, ended_at=?, duration_ms=?, output_json=?, error=? WHERE id=?",
                (
                    payload.get("status", "ok"),
                    event.timestamp,
                    payload.get("duration_ms"),
                    json.dumps(payload.get("output"), default=str),
                    payload.get("error"),
                    payload["id"],
                ),
            )

    @staticmethod
    def _index_artifact_records(connection: sqlite3.Connection, event: Event) -> None:
        if event.kind not in {"artifact", "media"}:
            return
        for value in event.payload.get("values", {}).values():
            if not isinstance(value, dict) or not {"id", "digest", "name", "size"}.issubset(value):
                continue
            connection.execute(
                "INSERT OR IGNORE INTO artifacts VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (
                    value["id"],
                    event.run_id,
                    value["name"],
                    value.get("artifact_type", "file"),
                    value.get("mime_type", "application/octet-stream"),
                    value["digest"],
                    value["size"],
                    value.get("created_at", event.timestamp),
                    json.dumps(value.get("aliases", [])),
                    json.dumps(value.get("metadata", {})),
                    value.get("source_path"),
                ),
            )

    def _summary_update(self, connection: sqlite3.Connection, event: Event) -> dict[str, Any]:
        row = connection.execute(
            "SELECT summary_json FROM runs WHERE id=?", (event.run_id,)
        ).fetchone()
        summary = json.loads(row[0]) if row else {}
        if event.kind == "metric":
            for key, value in event.payload.get("values", {}).items():
                if isinstance(value, (bool, int, float, str)):
                    summary[key] = value
        return summary

    def finish_run(self, run_id: str, state: str = "finished") -> None:
        now = utc_now()
        with self._lock:
            with self.connection() as connection:
                connection.execute(
                    "UPDATE runs SET state=?, updated_at=?, finished_at=? WHERE id=?",
                    (state, now, now, run_id),
                )
                connection.execute(
                    "UPDATE projects SET updated_at=? "
                    "WHERE name=(SELECT project FROM runs WHERE id=?)",
                    (now, run_id),
                )
            manifest_path = self.runs_dir / run_id / "manifest.json"
            if manifest_path.exists():
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                manifest.update(state=state, updated_at=now, finished_at=now)
                self._write_manifest(run_id, manifest)

    def add_artifact(self, run_id: str, descriptor: dict[str, Any]) -> dict[str, Any]:
        source = Path(descriptor["path"]).expanduser().resolve()
        if not source.is_file():
            raise FileNotFoundError(source)
        digest = hashlib.sha256()
        with source.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        hexdigest = digest.hexdigest()
        target = self.blobs_dir / hexdigest[:2] / hexdigest[2:]
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            temporary = target.with_suffix(".tmp")
            shutil.copyfile(source, temporary)
            temporary.replace(target)
        artifact_id = uuid.uuid4().hex
        now = utc_now()
        record = {
            "id": artifact_id,
            "run_id": run_id,
            "name": descriptor.get("name") or source.name,
            "artifact_type": descriptor.get("artifact_type", descriptor.get("media_type", "file")),
            "mime_type": descriptor.get("mime_type", "application/octet-stream"),
            "digest": hexdigest,
            "size": source.stat().st_size,
            "created_at": now,
            "aliases": descriptor.get("aliases", []),
            "metadata": descriptor.get("metadata", {}),
            "source_path": str(source),
        }
        with self.connection() as connection:
            connection.execute(
                "INSERT INTO artifacts VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (
                    artifact_id,
                    run_id,
                    record["name"],
                    record["artifact_type"],
                    record["mime_type"],
                    hexdigest,
                    record["size"],
                    now,
                    json.dumps(record["aliases"]),
                    json.dumps(record["metadata"]),
                    str(source),
                ),
            )
        return record

    def add_bytes(
        self,
        run_id: str,
        data: bytes,
        name: str,
        mime_type: str,
        artifact_type: str = "media",
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        hexdigest = hashlib.sha256(data).hexdigest()
        target = self.blobs_dir / hexdigest[:2] / hexdigest[2:]
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            temporary = target.with_suffix(".tmp")
            temporary.write_bytes(data)
            temporary.replace(target)
        artifact_id = uuid.uuid4().hex
        now = utc_now()
        record = {
            "id": artifact_id,
            "run_id": run_id,
            "name": name,
            "artifact_type": artifact_type,
            "mime_type": mime_type,
            "digest": hexdigest,
            "size": len(data),
            "created_at": now,
            "aliases": [],
            "metadata": metadata or {},
            "source_path": None,
        }
        with self.connection() as connection:
            connection.execute(
                "INSERT INTO artifacts VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (
                    artifact_id,
                    run_id,
                    name,
                    artifact_type,
                    mime_type,
                    hexdigest,
                    len(data),
                    now,
                    "[]",
                    json.dumps(metadata or {}),
                    None,
                ),
            )
        return record

    def artifact_path(self, digest: str) -> Path:
        return self.blobs_dir / digest[:2] / digest[2:]

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        with self.connection() as connection:
            row = connection.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
        return self._run_row(row) if row else None

    def list_runs(self, project: str | None = None, limit: int = 200) -> list[dict[str, Any]]:
        query = "SELECT * FROM runs"
        values: list[Any] = []
        if project:
            query += " WHERE project=?"
            values.append(project)
        query += " ORDER BY updated_at DESC LIMIT ?"
        values.append(limit)
        with self.connection() as connection:
            rows = connection.execute(query, values).fetchall()
        return [self._run_row(row) for row in rows]

    def list_projects(self) -> list[dict[str, Any]]:
        with self.connection() as connection:
            rows = connection.execute(
                "SELECT p.name, p.created_at, p.updated_at, COUNT(r.id) run_count "
                "FROM projects p LEFT JOIN runs r ON r.project=p.name GROUP BY p.name ORDER BY p.updated_at DESC"
            ).fetchall()
        return [dict(row) for row in rows]

    def history(
        self, run_id: str, keys: list[str] | None = None, limit: int = 5000
    ) -> dict[str, list[dict[str, Any]]]:
        key_filter = ""
        values: list[Any] = [run_id]
        if keys:
            placeholders = ",".join("?" for _ in keys)
            key_filter = f" AND metric_key IN ({placeholders})"
            values.extend(keys)
        query = f"""
        WITH bounds AS (
          SELECT metric_key, MIN(sequence) AS first_sequence, MAX(sequence) AS last_sequence,
                 COUNT(*) AS point_count
          FROM metrics WHERE run_id=? {key_filter}
          GROUP BY metric_key
        )
        SELECT metrics.metric_key, metrics.value, metrics.step, metrics.timestamp, metrics.rank
        FROM metrics JOIN bounds ON bounds.metric_key=metrics.metric_key
        WHERE metrics.run_id=? AND (
          bounds.point_count <= ?
          OR metrics.sequence = bounds.first_sequence
          OR metrics.sequence = bounds.last_sequence
          OR (metrics.sequence - bounds.first_sequence) %
             MAX(1, CAST((bounds.last_sequence - bounds.first_sequence) / ? AS INTEGER)) = 0
        )
        ORDER BY metrics.metric_key, metrics.sequence ASC
        """
        values.extend((run_id, limit, limit))
        result: dict[str, list[dict[str, Any]]] = {}
        with self.connection() as connection:
            rows = connection.execute(query, values).fetchall()
        for row in rows:
            result.setdefault(row["metric_key"], []).append(
                {
                    "value": row["value"],
                    "step": row["step"],
                    "timestamp": row["timestamp"],
                    "rank": row["rank"],
                }
            )
        return result

    def metric_rows(self, run_id: str) -> list[dict[str, Any]]:
        """Return lossless metric events as one JSON-ready row per sequence."""
        query = """
        SELECT sequence, metric_key, value, step, timestamp, rank
        FROM metrics
        WHERE run_id=?
        ORDER BY sequence ASC, metric_key ASC
        """
        with self.connection() as connection:
            records = connection.execute(query, (run_id,)).fetchall()
        rows: list[dict[str, Any]] = []
        current_sequence: int | None = None
        current: dict[str, Any] = {}
        for record in records:
            if record["sequence"] != current_sequence:
                if current:
                    rows.append(current)
                current_sequence = record["sequence"]
                current = {
                    "sequence": record["sequence"],
                    "step": record["step"],
                    "timestamp": record["timestamp"],
                    "rank": record["rank"],
                }
            current[record["metric_key"]] = record["value"]
        if current:
            rows.append(current)
        return rows

    def events(
        self, run_id: str, kind: str | list[str] | None = None, limit: int = 1000
    ) -> list[dict[str, Any]]:
        query = "SELECT * FROM events WHERE run_id=?"
        values: list[Any] = [run_id]
        if isinstance(kind, list) and kind:
            placeholders = ",".join("?" for _ in kind)
            query += f" AND kind IN ({placeholders})"
            values.extend(kind)
        elif kind:
            query += " AND kind=?"
            values.append(kind)
        query += " ORDER BY sequence DESC LIMIT ?"
        values.append(limit)
        with self.connection() as connection:
            rows = connection.execute(query, values).fetchall()
        result = []
        for row in rows:
            value = dict(row)
            value["payload"] = json.loads(value.pop("payload_json"))
            result.append(value)
        return result

    def artifacts(self, run_id: str | None = None) -> list[dict[str, Any]]:
        query = "SELECT * FROM artifacts"
        values: tuple[Any, ...] = ()
        if run_id:
            query += " WHERE run_id=?"
            values = (run_id,)
        query += " ORDER BY created_at DESC"
        with self.connection() as connection:
            rows = connection.execute(query, values).fetchall()
        return [
            {
                **dict(row),
                "aliases": json.loads(row["aliases_json"]),
                "metadata": json.loads(row["metadata_json"]),
            }
            for row in rows
        ]

    def traces(self, run_id: str | None = None, limit: int = 5000) -> list[dict[str, Any]]:
        query = "SELECT * FROM traces"
        values: list[Any] = []
        if run_id:
            query += " WHERE run_id=?"
            values.append(run_id)
        query += " ORDER BY started_at DESC LIMIT ?"
        values.append(limit)
        with self.connection() as connection:
            rows = connection.execute(query, values).fetchall()
        return [
            {
                **dict(row),
                "attributes": json.loads(row["attributes_json"]),
                "input": json.loads(row["input_json"]) if row["input_json"] else None,
                "output": json.loads(row["output_json"]) if row["output_json"] else None,
            }
            for row in rows
        ]

    def create_report(
        self, title: str, project: str | None, blocks: list[dict[str, Any]]
    ) -> dict[str, Any]:
        identifier = uuid.uuid4().hex
        now = utc_now()
        with self.connection() as connection:
            connection.execute(
                "INSERT INTO reports VALUES(?,?,?,?,?,?)",
                (identifier, title, project, json.dumps(blocks), now, now),
            )
        return {
            "id": identifier,
            "title": title,
            "project": project,
            "blocks": blocks,
            "created_at": now,
            "updated_at": now,
        }

    def update_report(
        self, report_id: str, title: str, blocks: list[dict[str, Any]]
    ) -> dict[str, Any]:
        now = utc_now()
        with self.connection() as connection:
            connection.execute(
                "UPDATE reports SET title=?, blocks_json=?, updated_at=? WHERE id=?",
                (title, json.dumps(blocks), now, report_id),
            )
            row = connection.execute("SELECT * FROM reports WHERE id=?", (report_id,)).fetchone()
        if not row:
            raise KeyError(report_id)
        return {**dict(row), "blocks": json.loads(row["blocks_json"])}

    def reports(self) -> list[dict[str, Any]]:
        with self.connection() as connection:
            rows = connection.execute("SELECT * FROM reports ORDER BY updated_at DESC").fetchall()
        return [{**dict(row), "blocks": json.loads(row["blocks_json"])} for row in rows]

    def create_sweep(self, project: str, name: str, config: dict[str, Any]) -> dict[str, Any]:
        identifier = uuid.uuid4().hex[:12]
        now = utc_now()
        with self.connection() as connection:
            connection.execute(
                "INSERT INTO sweeps VALUES(?,?,?,?,?,?,?)",
                (identifier, project, name, "pending", json.dumps(config), now, now),
            )
        return {
            "id": identifier,
            "project": project,
            "name": name,
            "state": "pending",
            "config": config,
            "created_at": now,
            "updated_at": now,
        }

    def update_sweep(self, sweep_id: str, state: str) -> None:
        with self.connection() as connection:
            connection.execute(
                "UPDATE sweeps SET state=?, updated_at=? WHERE id=?", (state, utc_now(), sweep_id)
            )

    def sweeps(self) -> list[dict[str, Any]]:
        with self.connection() as connection:
            rows = connection.execute("SELECT * FROM sweeps ORDER BY updated_at DESC").fetchall()
        return [{**dict(row), "config": json.loads(row["config_json"])} for row in rows]

    def register_artifact(
        self,
        artifact_id: str,
        collection: str,
        aliases: list[str] | None = None,
        notes: str = "",
    ) -> dict[str, Any]:
        with self.connection() as connection:
            maximum = connection.execute(
                "SELECT COALESCE(MAX(version), -1) FROM registry WHERE collection=?", (collection,)
            ).fetchone()[0]
            version = int(maximum) + 1
            identifier = uuid.uuid4().hex
            now = utc_now()
            aliases = aliases or ["latest"]
            if "latest" in aliases:
                rows = connection.execute(
                    "SELECT id, aliases_json FROM registry WHERE collection=?", (collection,)
                ).fetchall()
                for row in rows:
                    existing = [
                        alias for alias in json.loads(row["aliases_json"]) if alias != "latest"
                    ]
                    connection.execute(
                        "UPDATE registry SET aliases_json=? WHERE id=?",
                        (json.dumps(existing), row["id"]),
                    )
            connection.execute(
                "INSERT INTO registry VALUES(?,?,?,?,?,?,?)",
                (identifier, collection, version, artifact_id, json.dumps(aliases), notes, now),
            )
        return {
            "id": identifier,
            "collection": collection,
            "version": version,
            "artifact_id": artifact_id,
            "aliases": aliases,
            "notes": notes,
            "created_at": now,
        }

    def registry(self) -> list[dict[str, Any]]:
        with self.connection() as connection:
            rows = connection.execute(
                "SELECT r.*, a.name artifact_name, a.artifact_type, a.size, a.digest FROM registry r "
                "JOIN artifacts a ON a.id=r.artifact_id ORDER BY r.collection, r.version DESC"
            ).fetchall()
        return [{**dict(row), "aliases": json.loads(row["aliases_json"])} for row in rows]

    def create_alert(self, project: str | None, rule: dict[str, Any]) -> dict[str, Any]:
        identifier = uuid.uuid4().hex
        now = utc_now()
        with self.connection() as connection:
            connection.execute(
                "INSERT INTO alerts VALUES(?,?,?,?,?)",
                (identifier, project, json.dumps(rule), 1, now),
            )
        return {
            "id": identifier,
            "project": project,
            "rule": rule,
            "enabled": True,
            "created_at": now,
        }

    def alerts(self) -> list[dict[str, Any]]:
        with self.connection() as connection:
            rows = connection.execute("SELECT * FROM alerts ORDER BY created_at DESC").fetchall()
        return [
            {**dict(row), "rule": json.loads(row["rule_json"]), "enabled": bool(row["enabled"])}
            for row in rows
        ]

    def storage_usage(self) -> dict[str, Any]:
        def directory_size(path: Path) -> int:
            return sum(item.stat().st_size for item in path.rglob("*") if item.is_file())

        with self.connection() as connection:
            counts = {
                "projects": connection.execute("SELECT COUNT(*) FROM projects").fetchone()[0],
                "runs": connection.execute("SELECT COUNT(*) FROM runs").fetchone()[0],
                "events": connection.execute("SELECT COUNT(*) FROM events").fetchone()[0],
                "artifacts": connection.execute("SELECT COUNT(*) FROM artifacts").fetchone()[0],
            }
        return {"root": str(self.root), "bytes": directory_size(self.root), **counts}

    def rebuild(self) -> dict[str, int]:
        rebuilt = 0
        invalid = 0
        with self.connection() as connection:
            connection.execute("DELETE FROM traces")
            connection.execute("DELETE FROM metrics")
            connection.execute("DELETE FROM events")
            connection.execute("UPDATE runs SET last_sequence=-1, summary_json='{}'")
        for run_path in self.runs_dir.iterdir():
            if not run_path.is_dir():
                continue
            manifest_path = run_path / "manifest.json"
            if manifest_path.exists():
                try:
                    self._restore_run_manifest(
                        json.loads(manifest_path.read_text(encoding="utf-8"))
                    )
                except (KeyError, TypeError, json.JSONDecodeError):
                    invalid += 1
            journal = run_path / "events.jsonl"
            if not journal.exists():
                continue
            for line in journal.read_text(encoding="utf-8").splitlines():
                try:
                    event = Event.from_dict(json.loads(line))
                    self._index_existing_event(event)
                    rebuilt += 1
                except (ValueError, TypeError, json.JSONDecodeError):
                    invalid += 1
        return {"rebuilt": rebuilt, "invalid": invalid}

    def _restore_run_manifest(self, manifest: dict[str, Any]) -> None:
        run_id = str(manifest["id"])
        project = str(manifest["project"])
        created_at = str(manifest.get("created_at") or utc_now())
        updated_at = str(manifest.get("updated_at") or created_at)
        with self.connection() as connection:
            connection.execute(
                "INSERT INTO projects(name, created_at, updated_at) VALUES(?,?,?) "
                "ON CONFLICT(name) DO UPDATE SET updated_at=MAX(updated_at, excluded.updated_at)",
                (project, created_at, updated_at),
            )
            connection.execute(
                "INSERT INTO runs(id, project, name, state, created_at, updated_at, finished_at, config_json, tags_json) "
                "VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET "
                "project=excluded.project, name=excluded.name, state=excluded.state, created_at=excluded.created_at, "
                "updated_at=excluded.updated_at, finished_at=excluded.finished_at, "
                "config_json=excluded.config_json, tags_json=excluded.tags_json",
                (
                    run_id,
                    project,
                    manifest.get("name") or f"run-{run_id[:6]}",
                    manifest.get("state", "running"),
                    created_at,
                    updated_at,
                    manifest.get("finished_at"),
                    json.dumps(manifest.get("config", {})),
                    json.dumps(manifest.get("tags", [])),
                ),
            )

    def _index_existing_event(self, event: Event) -> None:
        with self.connection() as connection:
            connection.execute(
                "INSERT OR IGNORE INTO events VALUES(?,?,?,?,?,?,?,?,?,?)",
                (
                    event.run_id,
                    event.sequence,
                    event.kind,
                    event.step,
                    event.timestamp,
                    event.monotonic_ns,
                    json.dumps(event.payload, default=str),
                    event.checksum,
                    event.process_id,
                    event.rank,
                ),
            )
            self._index_trace(connection, event)
            self._index_artifact_records(connection, event)
            if event.kind in {"metric", "system"}:
                for key, value in event.payload.get("values", event.payload).items():
                    if isinstance(value, (int, float)):
                        connection.execute(
                            "INSERT OR IGNORE INTO metrics VALUES(?,?,?,?,?,?,?)",
                            (
                                event.run_id,
                                event.sequence,
                                key,
                                float(value),
                                event.step,
                                event.timestamp,
                                event.rank,
                            ),
                        )
            summary = self._summary_update(connection, event)
            self._update_run_from_event(connection, event, summary)
        self._sync_terminal_manifest(event)

    @staticmethod
    def _run_row(row: sqlite3.Row) -> dict[str, Any]:
        value = dict(row)
        value["config"] = json.loads(value.pop("config_json"))
        value["tags"] = json.loads(value.pop("tags_json"))
        value["source"] = json.loads(value.pop("source_json"))
        value["summary"] = json.loads(value.pop("summary_json"))
        return value
