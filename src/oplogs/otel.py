"""Optional OpenTelemetry bridge for completed local spans."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


def enable_otel() -> Any:
    """Attach an OPLOGS exporter to the current OpenTelemetry tracer provider."""
    try:
        from opentelemetry import trace as otel_trace
        from opentelemetry.sdk.trace.export import (
            SimpleSpanProcessor,
            SpanExporter,
            SpanExportResult,
        )
    except ImportError as exc:
        raise RuntimeError("OpenTelemetry support requires `pip install 'oplogs[otel]'`") from exc

    from .sdk import current_run

    run = current_run()
    if not run:
        raise RuntimeError("call oplogs.init() before enable_otel()")

    class OplogsExporter(SpanExporter):
        def export(self, spans):
            for completed in spans:
                context = completed.context
                identifier = f"{context.span_id:016x}"
                parent = f"{completed.parent.span_id:016x}" if completed.parent else None
                started_at = datetime.fromtimestamp(
                    completed.start_time / 1e9, timezone.utc
                ).isoformat()
                ended_at = datetime.fromtimestamp(
                    completed.end_time / 1e9, timezone.utc
                ).isoformat()
                run._emit(
                    "trace.start",
                    {
                        "id": identifier,
                        "parent_id": parent,
                        "name": completed.name,
                        "attributes": dict(completed.attributes or {}),
                    },
                    timestamp=started_at,
                )
                status = "error" if str(completed.status.status_code).endswith("ERROR") else "ok"
                run._emit(
                    "trace.end",
                    {
                        "id": identifier,
                        "status": status,
                        "duration_ms": (completed.end_time - completed.start_time) / 1e6,
                        "output": {"events": [event.name for event in completed.events]},
                        "error": completed.status.description if status == "error" else None,
                    },
                    timestamp=ended_at,
                )
            return SpanExportResult.SUCCESS

    provider = otel_trace.get_tracer_provider()
    add_processor = getattr(provider, "add_span_processor", None)
    if not callable(add_processor):
        raise RuntimeError("the active OpenTelemetry provider does not accept span processors")
    exporter = OplogsExporter()
    add_processor(SimpleSpanProcessor(exporter))
    return exporter
