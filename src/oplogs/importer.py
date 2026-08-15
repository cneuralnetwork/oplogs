"""Import portable W&B run exports into the local OPLOGS model."""

from __future__ import annotations

import json
import mimetypes
from pathlib import Path
from typing import Any

from .models import Event
from .storage import Storage


def _load_mapping(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    if path.suffix == ".json":
        return json.loads(path.read_text(encoding="utf-8"))
    try:
        import yaml
    except ImportError:
        return {}
    value = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return {
        key: item.get("value") if isinstance(item, dict) and "value" in item else item
        for key, item in value.items()
        if not key.startswith("_")
    }


def import_wandb(
    path: str | Path, storage: Storage | None = None, project: str | None = None
) -> dict[str, Any]:
    source = Path(path).expanduser().resolve()
    if not source.exists():
        raise FileNotFoundError(source)
    store = storage or Storage()
    if source.is_file() and source.suffix == ".json":
        payload = json.loads(source.read_text(encoding="utf-8"))
        if isinstance(payload, list):
            return {"runs": [import_wandb_record(item, store, project) for item in payload]}
        return {"runs": [import_wandb_record(payload, store, project)]}
    metadata = _load_mapping(source / "wandb-metadata.json")
    config = _load_mapping(source / "config.yaml") or _load_mapping(source / "config.json")
    summary = _load_mapping(source / "wandb-summary.json")
    metadata_tags = metadata.get("tags", [])
    if not isinstance(metadata_tags, list):
        metadata_tags = [str(metadata_tags)]
    record = store.create_run(
        project=project or metadata.get("project") or source.parent.name or "wandb-import",
        name=metadata.get("name") or source.name,
        config=config,
        tags=["imported", "wandb", *metadata_tags],
    )
    sequence = 0
    history_path = source / "wandb-history.jsonl"
    imported_points = 0
    if history_path.exists():
        for line in history_path.read_text(encoding="utf-8").splitlines():
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            step = row.pop("_step", None)
            timestamp = row.pop("_timestamp", None)
            numeric = {
                key: value for key, value in row.items() if isinstance(value, (bool, int, float))
            }
            if numeric:
                event = Event(record.id, sequence, "metric", {"values": numeric}, step=step)
                if timestamp is not None:
                    from datetime import datetime, timezone

                    event.timestamp = datetime.fromtimestamp(
                        float(timestamp), timezone.utc
                    ).isoformat()
                store.append_event(event)
                sequence += 1
                imported_points += len(numeric)
    if summary:
        store.append_event(Event(record.id, sequence, "metric", {"values": summary}, step=None))
        sequence += 1
    imported_artifacts = 0
    artifact_root = source / "files" if (source / "files").is_dir() else source
    ignored = {
        "config.yaml",
        "config.json",
        "wandb-history.jsonl",
        "wandb-metadata.json",
        "wandb-summary.json",
        "requirements.txt",
    }
    for item in artifact_root.rglob("*"):
        if not item.is_file() or item.name in ignored or item.is_symlink():
            continue
        mime_type = mimetypes.guess_type(item.name)[0] or "application/octet-stream"
        if mime_type.startswith("image/"):
            artifact_type = "image"
        elif mime_type.startswith("audio/"):
            artifact_type = "audio"
        elif mime_type.startswith("video/"):
            artifact_type = "video"
        elif item.suffix.lower() in {".csv", ".json", ".jsonl", ".parquet", ".arrow"}:
            artifact_type = "dataset"
        else:
            artifact_type = "file"
        artifact = store.add_artifact(
            record.id,
            {
                "path": str(item),
                "name": str(item.relative_to(artifact_root)),
                "mime_type": mime_type,
                "artifact_type": artifact_type,
                "metadata": {"imported_from": "wandb"},
            },
        )
        store.append_event(
            Event(record.id, sequence, "artifact", {"values": {artifact["name"]: artifact}})
        )
        sequence += 1
        imported_artifacts += 1
    store.finish_run(record.id, "imported")
    return {
        "runs": [
            {
                "id": record.id,
                "project": record.project,
                "name": record.name,
                "points": imported_points,
                "artifacts": imported_artifacts,
            }
        ]
    }


def import_wandb_record(
    payload: dict[str, Any], store: Storage, project: str | None
) -> dict[str, Any]:
    record = store.create_run(
        project=project or payload.get("project", "wandb-import"),
        name=payload.get("name"),
        config=payload.get("config", {}),
        tags=["imported", "wandb", *payload.get("tags", [])],
    )
    sequence = 0
    points = 0
    for row in payload.get("history", []):
        row = dict(row)
        step = row.pop("_step", row.pop("step", None))
        numeric = {
            key: value for key, value in row.items() if isinstance(value, (bool, int, float))
        }
        if numeric:
            store.append_event(Event(record.id, sequence, "metric", {"values": numeric}, step=step))
            sequence += 1
            points += len(numeric)
    store.finish_run(record.id, "imported")
    return {"id": record.id, "project": record.project, "name": record.name, "points": points}
