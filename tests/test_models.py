from __future__ import annotations

import pytest

from oplogs.models import Event


def test_event_checksum_roundtrip_and_tamper_detection() -> None:
    event = Event("run1", 0, "metric", {"values": {"loss": 0.5}}, step=1).seal()
    restored = Event.from_dict(event.to_dict())
    assert restored.checksum == event.checksum

    tampered = event.to_dict()
    tampered["payload"] = {"values": {"loss": 9.0}}
    with pytest.raises(ValueError, match="checksum mismatch"):
        Event.from_dict(tampered)
