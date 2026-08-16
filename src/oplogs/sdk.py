"""Non-blocking Python SDK."""

from __future__ import annotations

import atexit
import contextvars
import importlib.util
import json
import os
import queue
import sys
import threading
import time
import traceback
import uuid
from pathlib import Path
from types import TracebackType
from typing import Any, TextIO

import httpx

from .capture import SystemSampler, capture_environment, capture_git, snapshot_workspace
from .models import Event, utc_now
from .process import ensure_daemon
from .redaction import redact_payload
from .types import normalize_value

_current_run: contextvars.ContextVar[Run | None] = contextvars.ContextVar(
    "oplogs_run", default=None
)


def current_run() -> Run | None:
    return _current_run.get()


class _Tee(TextIO):
    def __init__(self, original: TextIO, emit: Any, stream: str) -> None:
        self.original = original
        self.emit = emit
        self.stream = stream
        self._buffer = ""
        self._local = threading.local()

    def write(self, value: str) -> int:
        written = self.original.write(value)
        if getattr(self._local, "active", False):
            return written
        self._local.active = True
        try:
            self._buffer += value
            while "\n" in self._buffer:
                line, self._buffer = self._buffer.split("\n", 1)
                if line:
                    self.emit("log", {"stream": self.stream, "line": line})
        finally:
            self._local.active = False
        return written

    def flush(self) -> None:
        self.original.flush()

    def flush_capture(self) -> None:
        if self._buffer:
            self.emit("log", {"stream": self.stream, "line": self._buffer})
            self._buffer = ""

    def isatty(self) -> bool:
        return self.original.isatty()

    @property
    def encoding(self) -> str | None:
        return self.original.encoding


class _Sender:
    def __init__(self, run_id: str, base_url: str, token: str, spool_path: Path) -> None:
        self.run_id = run_id
        self.base_url = base_url
        self.token = token
        self.spool_path = spool_path
        self.pending: queue.Queue[dict[str, Any] | None] = queue.Queue(maxsize=20000)
        self._thread = threading.Thread(
            target=self._loop, name=f"oplogs-sender-{run_id}", daemon=True
        )
        self._closed = threading.Event()
        self._thread.start()

    def enqueue(self, event: dict[str, Any]) -> None:
        try:
            self.pending.put_nowait(event)
        except queue.Full:
            self._spool([event])

    def flush(self, timeout: float = 10) -> None:
        deadline = time.monotonic() + timeout
        while self.pending.unfinished_tasks and time.monotonic() < deadline:
            time.sleep(0.02)

    def close(self) -> None:
        if self._closed.is_set():
            return
        self.flush()
        self._closed.set()
        self.pending.put(None)
        self._thread.join(timeout=3)

    def _loop(self) -> None:
        client = httpx.Client(
            base_url=self.base_url, headers={"X-OPLOGS-Token": self.token}, timeout=5
        )
        self._replay(client)
        while True:
            first = self.pending.get()
            if first is None:
                self.pending.task_done()
                break
            batch = [first]
            deadline = time.monotonic() + 0.1
            while len(batch) < 128 and time.monotonic() < deadline:
                try:
                    item = self.pending.get_nowait()
                    if item is None:
                        self.pending.task_done()
                        self._closed.set()
                        break
                    batch.append(item)
                except queue.Empty:
                    break
            try:
                response = client.post(f"/api/runs/{self.run_id}/events", json=batch)
                response.raise_for_status()
            except (httpx.HTTPError, OSError):
                self._spool(batch)
            finally:
                for _ in batch:
                    self.pending.task_done()
            if self._closed.is_set():
                            break
                    # A run that spooled events (e.g. because close() drained the queue
                    # while the daemon was unreachable) should not leave them stranded in
                    # spool.jsonl forever: try once more before the sender thread exits,
                    # in case the daemon became reachable again during this run.
        self._replay(client)
        client.close()

    def _spool(self, batch: list[dict[str, Any]]) -> None:
        self.spool_path.parent.mkdir(parents=True, exist_ok=True)
        with self.spool_path.open("a", encoding="utf-8") as handle:
            for event in batch:
                handle.write(json.dumps(event, separators=(",", ":"), default=str) + "\n")

    def _replay(self, client: httpx.Client) -> None:
        if not self.spool_path.exists():
            return
        replay = self.spool_path.with_suffix(".replay")
        self.spool_path.replace(replay)
        events = [
            json.loads(line) for line in replay.read_text(encoding="utf-8").splitlines() if line
        ]
        try:
            for offset in range(0, len(events), 128):
                response = client.post(
                    f"/api/runs/{self.run_id}/events", json=events[offset : offset + 128]
                )
                response.raise_for_status()
        except (httpx.HTTPError, OSError):
            self._spool(events)
        finally:
            replay.unlink(missing_ok=True)


class Run:
    def __init__(
        self,
        run_id: str,
        project: str,
        name: str,
        base_url: str,
        token: str,
        capture_console: bool = True,
        capture_source: bool = True,
        autolog: bool = True,
    ) -> None:
        self.id = run_id
        self.project = project
        self.name = name
        self.url = f"{base_url}/runs/{run_id}"
        self._base_url = base_url
        self._token = token
        self._sequence = 0
        self._sequence_lock = threading.Lock()
        self._finished = False
        self._terminal_state = "finished"
        from .config import data_dir

        self._sender = _Sender(
            run_id, base_url, token, data_dir() / "runs" / run_id / "spool.jsonl"
        )
        self._sampler = SystemSampler(self._emit)
        self._sampler.start()
        self._stdout = sys.stdout
        self._stderr = sys.stderr
        self._source_thread: threading.Thread | None = None
        if capture_console:
            sys.stdout = _Tee(sys.stdout, self._emit, "stdout")
            sys.stderr = _Tee(sys.stderr, self._emit, "stderr")
        self._original_excepthook = sys.excepthook
        self._original_threading_excepthook = threading.excepthook

        def exception_hook(exception_type, exception, trace) -> None:
            if not self._finished:
                self._record_exception(exception_type, exception, trace)
                self._terminal_state = "failed"
                self.finish()
            self._original_excepthook(exception_type, exception, trace)

        def thread_exception_hook(arguments) -> None:
            if not self._finished:
                self._record_exception(
                    arguments.exc_type, arguments.exc_value, arguments.exc_traceback
                )
            self._original_threading_excepthook(arguments)

        self._excepthook = exception_hook
        self._threading_excepthook = thread_exception_hook
        sys.excepthook = exception_hook
        threading.excepthook = thread_exception_hook
        _current_run.set(self)
        self._emit("run.started", {"process_id": os.getpid(), "url": self.url})
        environment = capture_environment()
        self._emit("environment", environment)
        if capture_source:
            self._source_thread = threading.Thread(
                target=self._capture_source, name="oplogs-source", daemon=True
            )
            self._source_thread.start()
        if autolog:
            from .integrations import enable_autolog

            enable_autolog(self)
        atexit.register(self.finish)

    def log(
        self,
        values: dict[str, Any],
        *,
        step: int | float | None = None,
        timestamp: str | None = None,
    ) -> None:
        if self._finished:
            raise RuntimeError("cannot log to a finished oplogs run")
        grouped: dict[str, dict[str, Any]] = {}
        for key, value in values.items():
            kind, normalized = normalize_value(value)
            event_kind = "metric" if kind == "scalar" else kind
            grouped.setdefault(event_kind, {})[key] = normalized
        for kind, items in grouped.items():
            self._emit(kind, {"values": items}, step=step, timestamp=timestamp)

    def _next_sequence(self) -> int:
        with self._sequence_lock:
            value = self._sequence
            self._sequence += 1
            return value

    def _emit(
        self,
        kind: str,
        payload: dict[str, Any],
        *,
        step: int | float | None = None,
        timestamp: str | None = None,
    ) -> None:
        safe_payload, redactions = redact_payload(payload)
        if redactions and isinstance(safe_payload, dict):
            safe_payload = {**safe_payload, "_redacted": redactions}
        rank_raw = os.environ.get("RANK") or os.environ.get("LOCAL_RANK")
        event = Event(
            run_id=self.id,
            sequence=self._next_sequence(),
            kind=kind,
            payload=safe_payload,
            step=step,
            timestamp=timestamp or utc_now(),
            process_id=os.getpid(),
            rank=int(rank_raw) if rank_raw and rank_raw.lstrip("-").isdigit() else None,
        ).seal()
        self._sender.enqueue(event.to_dict())

    def _capture_source(self) -> None:
        try:
            workspace = Path.cwd()
            self._emit(
                "source",
                {
                    "git": capture_git(workspace),
                    "snapshot": snapshot_workspace(self.id, workspace),
                },
            )
        except Exception as exc:
            self._emit("capture.error", {"area": "source", "error": str(exc)})

    def watch(self, model: Any, *, gradients: bool = True, every: int = 100) -> None:
        """Watch a raw PyTorch model without guessing semantic loss values."""
        if importlib.util.find_spec("torch") is None:
            raise RuntimeError("Run.watch requires PyTorch")
        counter = {"backwards": 0}

        def capture_gradient(name: str):
            def hook(gradient: Any) -> None:
                counter["backwards"] += 1
                if not gradients or counter["backwards"] % every:
                    return
                tensor = gradient.detach()
                self.log(
                    {
                        f"gradients.{name}.mean": tensor.float().mean().item(),
                        f"gradients.{name}.std": tensor.float().std().item()
                        if tensor.numel() > 1
                        else 0.0,
                        f"gradients.{name}.norm": tensor.float().norm().item(),
                    },
                    step=counter["backwards"],
                )

            return hook

        parameters = 0
        trainable = 0
        for name, parameter in model.named_parameters():
            parameters += parameter.numel()
            if parameter.requires_grad:
                trainable += parameter.numel()
                parameter.register_hook(capture_gradient(name))
        self._emit(
            "model",
            {
                "framework": "pytorch",
                "class": f"{model.__class__.__module__}.{model.__class__.__qualname__}",
                "parameters": parameters,
                "trainable_parameters": trainable,
                "representation": str(model),
            },
        )

    def _record_exception(
        self,
        exception_type: type[BaseException] | None,
        exception: BaseException,
        trace: TracebackType | None,
    ) -> None:
        self._emit(
            "exception",
            {
                "type": exception_type.__name__ if exception_type else type(exception).__name__,
                "message": str(exception),
                "traceback": "".join(traceback.format_exception(exception_type, exception, trace)),
            },
        )

    def finish(self, state: str | None = None) -> None:
        if self._finished:
            return
        state = state or self._terminal_state
        self._finished = True
        self._sampler.stop()
        if self._source_thread and self._source_thread.is_alive():
            self._source_thread.join(timeout=5)
        if isinstance(sys.stdout, _Tee) and sys.stdout.original is self._stdout:
            sys.stdout.flush_capture()
            sys.stdout = self._stdout
        if isinstance(sys.stderr, _Tee) and sys.stderr.original is self._stderr:
            sys.stderr.flush_capture()
            sys.stderr = self._stderr
        if sys.excepthook is self._excepthook:
            sys.excepthook = self._original_excepthook
        if threading.excepthook is self._threading_excepthook:
            threading.excepthook = self._original_threading_excepthook
        self._emit("run.finished", {"state": state})
        self._sender.flush()
        try:
            with httpx.Client(
                base_url=self._base_url, headers={"X-OPLOGS-Token": self._token}, timeout=5
            ) as client:
                client.post(f"/api/runs/{self.id}/finish", json={"state": state}).raise_for_status()
        except httpx.HTTPError:
            pass
        self._sender.close()
        if current_run() is self:
            _current_run.set(None)

    def __enter__(self) -> Run:
        return self

    def __exit__(
        self,
        exception_type: type[BaseException] | None,
        exception: BaseException | None,
        trace: TracebackType | None,
    ) -> None:
        if exception:
            self._record_exception(exception_type, exception, trace)
            self.finish("failed")
        else:
            self.finish()


def init(
    project: str = "uncategorized",
    *,
    name: str | None = None,
    config: dict[str, Any] | None = None,
    tags: list[str] | None = None,
    resume: str = "auto",
    autolog: bool = True,
    open: bool | None = None,
    capture_console: bool = True,
    capture_source: bool = True,
) -> Run:
    del resume
    daemon, _started = ensure_daemon(open_browser=open)
    sweep_values = json.loads(os.environ.get("OPLOGS_SWEEP_CONFIG", "{}"))
    sweep_id = os.environ.get("OPLOGS_SWEEP_ID")
    sweep_index = os.environ.get("OPLOGS_SWEEP_INDEX")
    sweep_metadata = {
        key: value
        for key, value in {
            "_oplogs.sweep_id": sweep_id,
            "_oplogs.sweep_index": int(sweep_index)
            if sweep_index and sweep_index.isdigit()
            else sweep_index,
        }.items()
        if value is not None
    }
    merged_config = {**sweep_values, **sweep_metadata, **(config or {})}
    merged_tags = [*(tags or []), *([f"sweep:{sweep_id}"] if sweep_id else [])]
    payload = {
        "project": project,
        "name": name,
        "config": merged_config,
        "tags": merged_tags,
        "id": uuid.uuid4().hex[:12],
    }
    with httpx.Client(
        base_url=daemon.url, headers={"X-OPLOGS-Token": daemon.token}, timeout=10
    ) as client:
        response = client.post("/api/runs", json=payload)
        response.raise_for_status()
        record = response.json()
    return Run(
        record["id"],
        record["project"],
        record["name"],
        daemon.url,
        daemon.token,
        capture_console=capture_console,
        capture_source=capture_source,
        autolog=autolog,
    )
