"""Nested local tracing for Python, LLM calls, and agents."""

from __future__ import annotations

import contextlib
import contextvars
import functools
import inspect
import time
import uuid
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from typing import Any, ParamSpec, TypeVar

P = ParamSpec("P")
R = TypeVar("R")
_span_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("oplogs_span", default=None)


@dataclass
class SpanHandle:
    id: str
    output: Any = None

    def set_output(self, value: Any) -> None:
        self.output = _safe(value)


def _safe(value: Any, limit: int = 2000) -> Any:
    if value is None or isinstance(value, (bool, int, float, str)):
        return value[:limit] if isinstance(value, str) else value
    if isinstance(value, dict):
        return {str(key): _safe(item, limit // 2) for key, item in list(value.items())[:50]}
    if isinstance(value, (list, tuple)):
        return [_safe(item, limit // 2) for item in list(value)[:50]]
    return repr(value)[:limit]


@contextlib.contextmanager
def span(
    name: str, attributes: dict[str, Any] | None = None, inputs: Any = None
) -> Iterator[SpanHandle]:
    from .sdk import current_run

    run = current_run()
    identifier = uuid.uuid4().hex
    handle = SpanHandle(identifier)
    parent = _span_id.get()
    token = _span_id.set(identifier)
    started = time.perf_counter()
    if run:
        run._emit(
            "trace.start",
            {
                "id": identifier,
                "parent_id": parent,
                "name": name,
                "attributes": attributes or {},
                "input": _safe(inputs),
            },
        )
    try:
        yield handle
    except BaseException as exc:
        if run:
            run._emit(
                "trace.end",
                {
                    "id": identifier,
                    "status": "error",
                    "duration_ms": (time.perf_counter() - started) * 1000,
                    "error": f"{type(exc).__name__}: {exc}",
                },
            )
        raise
    else:
        if run:
            run._emit(
                "trace.end",
                {
                    "id": identifier,
                    "status": "ok",
                    "duration_ms": (time.perf_counter() - started) * 1000,
                    "output": handle.output,
                },
            )
    finally:
        _span_id.reset(token)


def trace(function: Callable[P, R] | None = None, *, name: str | None = None):
    def decorate(target: Callable[P, R]):
        trace_name = name or f"{target.__module__}.{target.__qualname__}"
        if inspect.iscoroutinefunction(target):

            @functools.wraps(target)
            async def async_wrapper(*args: P.args, **kwargs: P.kwargs):
                with span(
                    trace_name, inputs={"args": _safe(args), "kwargs": _safe(kwargs)}
                ) as active_span:
                    result = await target(*args, **kwargs)
                    active_span.set_output(result)
                    return result

            return async_wrapper

        @functools.wraps(target)
        def wrapper(*args: P.args, **kwargs: P.kwargs):
            with span(
                trace_name, inputs={"args": _safe(args), "kwargs": _safe(kwargs)}
            ) as active_span:
                result = target(*args, **kwargs)
                active_span.set_output(result)
                return result

        return wrapper

    return decorate(function) if function else decorate
