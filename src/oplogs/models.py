"""Canonical event and run models."""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import asdict, dataclass, field
from typing import Any


def utc_now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


@dataclass(slots=True)
class Event:
    run_id: str
    sequence: int
    kind: str
    payload: dict[str, Any]
    step: float | int | None = None
    timestamp: str = field(default_factory=utc_now)
    monotonic_ns: int = field(default_factory=time.monotonic_ns)
    process_id: int | None = None
    rank: int | None = None
    checksum: str = ""

    def canonical_payload(self) -> bytes:
        body = asdict(self)
        body["checksum"] = ""
        return json.dumps(body, sort_keys=True, separators=(",", ":"), default=str).encode()

    def seal(self) -> Event:
        self.checksum = hashlib.sha256(self.canonical_payload()).hexdigest()
        return self

    def to_dict(self) -> dict[str, Any]:
        if not self.checksum:
            self.seal()
        return asdict(self)

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> Event:
        event = cls(**value)
        expected = event.checksum
        actual = hashlib.sha256(event.canonical_payload()).hexdigest()
        if expected and expected != actual:
            raise ValueError(f"event checksum mismatch at sequence {event.sequence}")
        event.checksum = actual
        return event


@dataclass(slots=True)
class RunRecord:
    id: str
    project: str
    name: str
    state: str
    created_at: str
    updated_at: str
    config: dict[str, Any]
    tags: list[str]
    url: str | None = None
