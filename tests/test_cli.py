from __future__ import annotations

from typer.testing import CliRunner

from oplogs import cli


def test_doctor_uses_lowercase_storage_units(monkeypatch) -> None:
    class FakeStorage:
        def storage_usage(self) -> dict[str, object]:
            return {"root": "/tmp/oplogs", "runs": 2, "bytes": 4 * 1024**2}

    monkeypatch.setattr(cli, "Storage", FakeStorage)
    monkeypatch.setattr(cli, "read_daemon_info", lambda: None)

    result = CliRunner().invoke(cli.app, ["doctor"])

    assert result.exit_code == 0
    assert "size:   4.00 mib" in result.stdout
    assert "MiB" not in result.stdout
