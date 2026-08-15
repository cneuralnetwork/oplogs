from __future__ import annotations

from pathlib import Path

from oplogs import tracing
from oplogs.sdk import _current_run
from oplogs.types import Artifact, File, Histogram, Json, Table, normalize_value


class FakeRun:
    def __init__(self) -> None:
        self.events = []

    def _emit(self, kind, payload, **kwargs) -> None:
        self.events.append((kind, payload, kwargs))


def test_type_inference_and_file_description(tmp_path: Path) -> None:
    source = tmp_path / "rows.json"
    source.write_text("{}")
    assert normalize_value(1.25) == ("scalar", 1.25)
    assert normalize_value(Json({"ok": True}))[0] == "json"
    assert normalize_value(Table([{"a": 1}]))[1]["columns"] == ["a"]
    assert normalize_value(File(source))[1]["name"] == "rows.json"
    assert (
        normalize_value(Artifact(source, artifact_type="dataset"))[1]["artifact_type"] == "dataset"
    )
    assert normalize_value(Histogram([0, 1, 1], bins=2))[1]["counts"] == [1, 2]


def test_trace_decorator_records_success_and_error() -> None:
    run = FakeRun()
    token = _current_run.set(run)
    try:

        @tracing.trace(name="math.double")
        def double(value: int) -> int:
            return value * 2

        assert double(4) == 8
        assert [event[0] for event in run.events] == ["trace.start", "trace.end"]
        assert run.events[-1][1]["status"] == "ok"
        assert run.events[-1][1]["output"] == 8
    finally:
        _current_run.reset(token)
