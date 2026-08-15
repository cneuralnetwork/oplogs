from __future__ import annotations

from pathlib import Path

import pytest

from oplogs.storage import Storage


@pytest.fixture
def store(tmp_path: Path) -> Storage:
    return Storage(tmp_path / "oplogs")
