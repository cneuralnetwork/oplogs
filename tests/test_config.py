from __future__ import annotations

import os
import sys

from oplogs.config import (
    DaemonInfo,
    clear_daemon_info,
    daemon_file,
    read_daemon_info,
    write_daemon_info,
)
from oplogs.models import utc_now


def _write_info(pid: int) -> DaemonInfo:
    info = DaemonInfo(pid, 7437, "token", utc_now())
    write_daemon_info(info)
    return info


def test_clear_daemon_info_keeps_another_process_record(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("OPLOGS_HOME", str(tmp_path))
    _write_info(pid=sys.maxsize)
    assert read_daemon_info() is not None

    clear_daemon_info()

    assert daemon_file().exists(), "a newer daemon's info must survive this process exiting"


def test_clear_daemon_info_removes_own_record(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("OPLOGS_HOME", str(tmp_path))
    _write_info(pid=os.getpid())

    clear_daemon_info()

    assert not daemon_file().exists()


def test_clear_daemon_info_removes_corrupt_record(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("OPLOGS_HOME", str(tmp_path))
    daemon_file().write_text("{not json", encoding="utf-8")

    clear_daemon_info()

    assert not daemon_file().exists()
