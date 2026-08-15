"""Persistent localhost daemon lifecycle."""

from __future__ import annotations

import os
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from contextlib import suppress

from .config import DaemonInfo, daemon_file, data_dir, new_token, read_daemon_info


def _healthy(info: DaemonInfo) -> bool:
    request = urllib.request.Request(f"{info.url}/health", headers={"X-OPLOGS-Token": info.token})
    try:
        with urllib.request.urlopen(request, timeout=0.4) as response:
            return response.status == 200
    except (urllib.error.URLError, TimeoutError, ValueError):
        return False


def _available_port() -> int:
    preferred = int(os.environ.get("OPLOGS_PORT", "7437"))
    for port in range(preferred, preferred + 32):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as candidate:
            try:
                candidate.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as candidate:
        candidate.bind(("127.0.0.1", 0))
        return int(candidate.getsockname()[1])


def ensure_daemon(open_browser: bool | None = None) -> tuple[DaemonInfo, bool]:
    existing = read_daemon_info()
    if existing and _healthy(existing):
        return existing, False
    if daemon_file().exists():
        daemon_file().unlink(missing_ok=True)
    port = _available_port()
    token = new_token()
    log_path = data_dir() / "daemon.log"
    log_handle = log_path.open("ab", buffering=0)
    process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "oplogs.daemon",
            "--port",
            str(port),
            "--token",
            token,
        ],
        stdin=subprocess.DEVNULL,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        start_new_session=True,
        close_fds=True,
    )
    deadline = time.monotonic() + 12
    info: DaemonInfo | None = None
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"OPLOGS daemon exited; inspect {log_path}")
        info = read_daemon_info()
        if info and _healthy(info):
            break
        time.sleep(0.1)
    else:
        process.terminate()
        raise RuntimeError(f"OPLOGS daemon did not start; inspect {log_path}")
    should_open = open_browser is not False and bool(
        os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")
    )
    if should_open:
        webbrowser.open(info.url)
    return info, True


def stop_daemon() -> bool:
    info = read_daemon_info()
    if not info:
        return False
    with suppress(ProcessLookupError):
        os.kill(info.pid, signal.SIGTERM)
    daemon_file().unlink(missing_ok=True)
    return True
