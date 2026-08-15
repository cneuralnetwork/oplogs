"""Automatic process, environment, source, and hardware capture."""

from __future__ import annotations

import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

import psutil

from .config import data_dir
from .redaction import redact_mapping, redact_text

EXCLUDED_DIRECTORIES = {
    ".git",
    ".hg",
    ".svn",
    ".venv",
    "venv",
    "env",
    "node_modules",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    "dist",
    "build",
    ".oplogs",
}
SOURCE_SUFFIXES = {
    ".py",
    ".ipynb",
    ".toml",
    ".yaml",
    ".yml",
    ".json",
    ".ini",
    ".cfg",
    ".md",
    ".txt",
    ".sh",
    ".fish",
    ".rs",
    ".go",
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".sql",
}
MAX_COPY_BYTES = 10 * 1024 * 1024


def _command(command: list[str], cwd: Path) -> str | None:
    try:
        return subprocess.run(
            command,
            cwd=cwd,
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        ).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return None


def capture_environment() -> dict[str, Any]:
    environment, redacted = redact_mapping(dict(os.environ))
    packages = _command(
        [sys.executable, "-m", "pip", "freeze", "--disable-pip-version-check"], Path.cwd()
    )
    return {
        "python": sys.version,
        "executable": sys.executable,
        "platform": platform.platform(),
        "machine": platform.machine(),
        "hostname": platform.node(),
        "argv": sys.argv,
        "cwd": str(Path.cwd()),
        "environment": environment,
        "redacted_keys": redacted,
        "packages": packages.splitlines() if packages else [],
    }


def capture_git(workspace: Path) -> dict[str, Any]:
    root = _command(["git", "rev-parse", "--show-toplevel"], workspace)
    if not root:
        return {"repository": False}
    root_path = Path(root)
    diff = _command(["git", "diff", "--binary", "--no-ext-diff"], root_path) or ""
    safe_diff, redactions = redact_text(diff)
    return {
        "repository": True,
        "root": root,
        "commit": _command(["git", "rev-parse", "HEAD"], root_path),
        "branch": _command(["git", "branch", "--show-current"], root_path),
        "remote": _command(["git", "remote", "get-url", "origin"], root_path),
        "status": (_command(["git", "status", "--short"], root_path) or "").splitlines(),
        "diff": safe_diff,
        "redactions": redactions,
    }


def snapshot_workspace(run_id: str, workspace: Path | None = None) -> dict[str, Any]:
    workspace = (workspace or Path.cwd()).resolve()
    target_root = data_dir() / "runs" / run_id / "snapshot"
    target_root.mkdir(parents=True, exist_ok=True)
    manifest: list[dict[str, Any]] = []
    copied = 0
    hashed = 0
    for root, directories, files in os.walk(workspace):
        root_path = Path(root)
        directories[:] = [
            name
            for name in directories
            if name not in EXCLUDED_DIRECTORIES and not (root_path / name).is_symlink()
        ]
        for filename in files:
            source = root_path / filename
            if source.is_symlink() or not source.is_file():
                continue
            try:
                relative = source.relative_to(workspace)
                size = source.stat().st_size
            except (OSError, ValueError):
                continue
            digest = hashlib.sha256()
            try:
                with source.open("rb") as handle:
                    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                        digest.update(chunk)
            except OSError:
                continue
            item = {
                "path": str(relative),
                "size": size,
                "sha256": digest.hexdigest(),
                "copied": False,
            }
            should_copy = size <= MAX_COPY_BYTES and (
                source.suffix.lower() in SOURCE_SUFFIXES or source.name.startswith(".")
            )
            if should_copy:
                destination = target_root / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                try:
                    if source.suffix.lower() in SOURCE_SUFFIXES and size <= 2 * 1024 * 1024:
                        text = source.read_text(encoding="utf-8")
                        safe, redactions = redact_text(text)
                        destination.write_text(safe, encoding="utf-8")
                        item["redactions"] = redactions
                    else:
                        shutil.copyfile(source, destination)
                    item["copied"] = True
                    copied += 1
                except (OSError, UnicodeDecodeError):
                    pass
            else:
                hashed += 1
            manifest.append(item)
    (target_root / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return {
        "workspace": str(workspace),
        "manifest": str(target_root / "manifest.json"),
        "files": len(manifest),
        "copied": copied,
        "hashed_only": hashed,
    }


def system_values() -> dict[str, float | int | str]:
    process = psutil.Process()
    memory = psutil.virtual_memory()
    disk = psutil.disk_usage(str(Path.cwd().anchor or "/"))
    values: dict[str, float | int | str] = {
        "system.cpu_percent": psutil.cpu_percent(interval=None),
        "system.memory_percent": memory.percent,
        "system.memory_used_gb": round(memory.used / 1024**3, 3),
        "system.disk_percent": disk.percent,
        "process.cpu_percent": process.cpu_percent(interval=None),
        "process.memory_rss_mb": round(process.memory_info().rss / 1024**2, 3),
        "process.threads": process.num_threads(),
    }
    try:
        import pynvml

        pynvml.nvmlInit()
        for index in range(pynvml.nvmlDeviceGetCount()):
            handle = pynvml.nvmlDeviceGetHandleByIndex(index)
            utilization = pynvml.nvmlDeviceGetUtilizationRates(handle)
            gpu_memory = pynvml.nvmlDeviceGetMemoryInfo(handle)
            values[f"gpu.{index}.utilization"] = utilization.gpu
            values[f"gpu.{index}.memory_percent"] = round(
                gpu_memory.used / gpu_memory.total * 100, 3
            )
            values[f"gpu.{index}.memory_used_gb"] = round(gpu_memory.used / 1024**3, 3)
            values[f"gpu.{index}.temperature_c"] = pynvml.nvmlDeviceGetTemperature(
                handle, pynvml.NVML_TEMPERATURE_GPU
            )
    except (ImportError, Exception):
        pass
    return values


class SystemSampler:
    def __init__(self, emit: Callable[[str, dict[str, Any]], None], interval: float = 2.0) -> None:
        self.emit = emit
        self.interval = interval
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, name="oplogs-system", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=self.interval + 1)

    def _loop(self) -> None:
        psutil.cpu_percent(interval=None)
        while not self._stop.wait(self.interval):
            self.emit("system", {"values": system_values()})
