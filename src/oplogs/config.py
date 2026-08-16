"""Local paths and daemon discovery."""

from __future__ import annotations

import json
import os
import secrets
from dataclasses import asdict, dataclass
from pathlib import Path

from platformdirs import user_data_path


def data_dir() -> Path:
    override = os.environ.get("OPLOGS_HOME")
    root = Path(override).expanduser() if override else user_data_path("oplogs", ensure_exists=True)
    root.mkdir(parents=True, exist_ok=True)
    return root


@dataclass(slots=True)
class DaemonInfo:
    pid: int
    port: int
    token: str
    started_at: str
    browser_opened: bool = False

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"


def daemon_file() -> Path:
    return data_dir() / "daemon.json"


def read_daemon_info() -> DaemonInfo | None:
    try:
        raw = json.loads(daemon_file().read_text(encoding="utf-8"))
        return DaemonInfo(**raw)
    except (FileNotFoundError, json.JSONDecodeError, TypeError, ValueError):
        return None


def write_daemon_info(info: DaemonInfo) -> None:
    target = daemon_file()
    temporary = target.with_suffix(".tmp")
    temporary.write_text(json.dumps(asdict(info), indent=2), encoding="utf-8")
    temporary.replace(target)
    target.chmod(0o600)


def clear_daemon_info() -> None:
    """Remove daemon.json only when it describes this process.

    Concurrent daemons can overwrite the info file; an exiting daemon must not
    unlink the newer daemon's record.
    """
    target = daemon_file()
    if not target.exists():
        return
    info = read_daemon_info()
    if info is None or info.pid == os.getpid():
        target.unlink(missing_ok=True)


def new_token() -> str:
    return secrets.token_urlsafe(32)
