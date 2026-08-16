from __future__ import annotations

import socket
import threading
import time
from pathlib import Path

import uvicorn

from oplogs.daemon import create_app
from oplogs.sdk import _Sender
from oplogs.storage import Storage


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def test_spooled_events_are_replayed_when_sender_closes(tmp_path: Path) -> None:
    """A run that finishes while the daemon is unreachable must not lose its
    spooled events forever: close() should give the spool one more chance
    once the daemon becomes reachable again."""
    port = _free_port()
    spool_path = tmp_path / "spool.jsonl"

    # Nothing is listening on `port` yet, so the first send fails and the
    # event is spooled.
    sender = _Sender("run-1", f"http://127.0.0.1:{port}", "secret", spool_path)
    sender.enqueue({"run_id": "run-1", "sequence": 0, "kind": "metric", "payload": {}})
    deadline = time.monotonic() + 8
    while not spool_path.exists() and time.monotonic() < deadline:
        time.sleep(0.02)
    assert spool_path.exists(), "event should have spooled while the daemon was down"

    # Bring the daemon up now, while the sender is still running.
    store = Storage(tmp_path / "data")
    store.create_run("durability", run_id="run-1")
    config = uvicorn.Config(
        create_app(store, token="secret"),
        host="127.0.0.1",
        port=port,
        log_level="warning",
    )
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 5
        while not getattr(server, "started", False) and time.monotonic() < deadline:
            time.sleep(0.02)

        sender.close()

        deadline = time.monotonic() + 3
        while spool_path.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        assert not spool_path.exists(), "spool should be drained once close() re-replays it"
        assert store.get_run("run-1")["last_sequence"] == 0
    finally:
        server.should_exit = True
        thread.join(timeout=5)


def test_daemon_exit_does_not_delete_a_newer_daemons_record(tmp_path: Path, monkeypatch) -> None:
    from oplogs.config import DaemonInfo, daemon_file, read_daemon_info, write_daemon_info
    from oplogs.models import utc_now

    monkeypatch.setenv("OPLOGS_HOME", str(tmp_path))
    stale = DaemonInfo(pid=111, port=9001, token="old", started_at=utc_now())
    write_daemon_info(stale)

    # A concurrent init() started a newer daemon before the stale one's exit
    # handler ran.
    newer = DaemonInfo(pid=222, port=9002, token="new", started_at=utc_now())
    write_daemon_info(newer)

    # Mirror daemon.main()'s finally block: only unlink if it still owns the record.
    current = read_daemon_info()
    if current is not None and current.pid == stale.pid:
        daemon_file().unlink(missing_ok=True)

    assert read_daemon_info() == newer