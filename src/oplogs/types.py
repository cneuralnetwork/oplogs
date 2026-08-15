"""Typed values accepted by :meth:`Run.log`."""

from __future__ import annotations

import base64
import io
import json
import mimetypes
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass(slots=True)
class File:
    path: str | Path
    name: str | None = None
    mime_type: str | None = None

    def describe(self) -> dict[str, Any]:
        path = Path(self.path).expanduser().resolve()
        if not path.is_file():
            raise FileNotFoundError(path)
        return {
            "path": str(path),
            "name": self.name or path.name,
            "mime_type": self.mime_type
            or mimetypes.guess_type(path.name)[0]
            or "application/octet-stream",
            "size": path.stat().st_size,
        }


@dataclass(slots=True)
class Artifact(File):
    artifact_type: str = "file"
    aliases: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    def describe(self) -> dict[str, Any]:
        value = File.describe(self)
        value.update(
            artifact_type=self.artifact_type,
            aliases=self.aliases,
            metadata=self.metadata,
        )
        return value


@dataclass(slots=True)
class Image:
    value: Any
    caption: str | None = None
    format: str = "png"

    def encode(self) -> dict[str, Any]:
        if isinstance(self.value, (str, Path)):
            return {
                "file": File(self.value).describe(),
                "caption": self.caption,
                "media_type": "image",
            }
        buffer = io.BytesIO()
        if hasattr(self.value, "save"):
            self.value.save(buffer, format=self.format.upper())
        else:
            try:
                import numpy as np
                from PIL import Image as PilImage

                array = np.asarray(self.value)
                if array.dtype != np.uint8:
                    array = (array.clip(0, 1) * 255).astype("uint8")
                PilImage.fromarray(array).save(buffer, format=self.format.upper())
            except ImportError as exc:
                raise TypeError("in-memory images require Pillow and NumPy") from exc
        return {
            "data": base64.b64encode(buffer.getvalue()).decode(),
            "mime_type": f"image/{self.format.lower()}",
            "caption": self.caption,
            "media_type": "image",
        }


@dataclass(slots=True)
class Audio(File):
    caption: str | None = None

    def describe(self) -> dict[str, Any]:
        value = File.describe(self)
        value.update(media_type="audio", caption=self.caption)
        return value


@dataclass(slots=True)
class Video(File):
    caption: str | None = None

    def describe(self) -> dict[str, Any]:
        value = File.describe(self)
        value.update(media_type="video", caption=self.caption)
        return value


@dataclass(slots=True)
class Table:
    value: Any

    def encode(self) -> dict[str, Any]:
        if hasattr(self.value, "to_dict"):
            try:
                records = self.value.to_dict(orient="records")
            except TypeError:
                records = self.value.to_dicts()
        elif isinstance(self.value, list):
            records = self.value
        else:
            raise TypeError("table must be a pandas/Polars frame or list of records")
        columns = sorted({key for row in records if isinstance(row, dict) for key in row})
        return {"columns": columns, "rows": records, "media_type": "table"}


@dataclass(slots=True)
class Json:
    value: Any

    def encode(self) -> dict[str, Any]:
        json.dumps(self.value, default=str)
        return {"value": self.value, "media_type": "json"}


@dataclass(slots=True)
class Histogram:
    values: Any
    bins: int = 30

    def encode(self) -> dict[str, Any]:
        if self.bins < 1:
            raise ValueError("histogram bins must be positive")
        numeric = [float(value) for value in self.values]
        if not numeric:
            return {"edges": [], "counts": [], "media_type": "histogram"}
        minimum = min(numeric)
        maximum = max(numeric)
        if minimum == maximum:
            return {
                "edges": [minimum, maximum],
                "counts": [len(numeric)],
                "media_type": "histogram",
            }
        width = (maximum - minimum) / self.bins
        counts = [0] * self.bins
        for value in numeric:
            index = min(self.bins - 1, int((value - minimum) / width))
            counts[index] += 1
        edges = [minimum + width * index for index in range(self.bins + 1)]
        return {"edges": edges, "counts": counts, "media_type": "histogram"}


def normalize_value(value: Any) -> tuple[str, Any]:
    if isinstance(value, Artifact):
        return "artifact", value.describe()
    if isinstance(value, Image):
        return "media", value.encode()
    if isinstance(value, (Audio, Video, File)):
        return "artifact", value.describe()
    if isinstance(value, Path):
        return "artifact", File(value).describe()
    if isinstance(value, Table):
        return "table", value.encode()
    if isinstance(value, Json):
        return "json", value.encode()
    if isinstance(value, Histogram):
        return "histogram", value.encode()
    if value is None or isinstance(value, (bool, int, float, str)):
        return "scalar" if isinstance(value, (bool, int, float)) else "text", value
    if hasattr(value, "ndim") and getattr(value, "ndim", 1) == 0 and hasattr(value, "item"):
        return "scalar", value.item()
    if isinstance(value, dict):
        return "json", value
    if isinstance(value, (list, tuple)):
        return "json", list(value)
    if hasattr(value, "to_dict") or hasattr(value, "to_dicts"):
        return "table", Table(value).encode()
    raise TypeError(
        f"unsupported log value {type(value).__name__}; wrap rich values with an OPLOGS type"
    )
