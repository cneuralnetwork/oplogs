"""Explicit local notifications and hooks."""

from __future__ import annotations

import shutil
import subprocess
import threading
from contextlib import suppress
from typing import Any

import httpx

from .models import Event
from .storage import Storage


class AlertEngine:
    def __init__(self, storage: Storage) -> None:
        self.storage = storage

    def evaluate(self, event: Event) -> None:
        run = self.storage.get_run(event.run_id)
        for alert in self.storage.alerts():
            if not alert["enabled"] or (
                alert["project"] and run and alert["project"] != run["project"]
            ):
                continue
            if self._matches(alert["rule"], event):
                threading.Thread(
                    target=self._deliver,
                    args=(alert["rule"], run or {"name": event.run_id}, event),
                    daemon=True,
                ).start()

    @staticmethod
    def _matches(rule: dict[str, Any], event: Event) -> bool:
        if rule.get("event") and rule["event"] != event.kind:
            return False
        if event.kind == "metric" and rule.get("metric"):
            value = event.payload.get("values", {}).get(rule["metric"])
            if not isinstance(value, (int, float)):
                return False
            threshold = float(rule.get("threshold", 0))
            operator = rule.get("operator", ">")
            return value > threshold if operator == ">" else value < threshold
        return True

    @staticmethod
    def _deliver(rule: dict[str, Any], run: dict[str, Any], event: Event) -> None:
        title = f"OPLOGS: {run.get('name', event.run_id)}"
        message = rule.get("message") or f"Alert matched {event.kind}"
        if rule.get("desktop", True) and shutil.which("notify-send"):
            subprocess.run(["notify-send", title, message], check=False, timeout=5)
        command = rule.get("command")
        if (
            isinstance(command, list)
            and command
            and all(isinstance(value, str) for value in command)
        ):
            subprocess.run(command, check=False, timeout=float(rule.get("timeout", 30)))
        webhook = rule.get("webhook")
        if isinstance(webhook, str) and webhook.startswith(
            ("http://127.0.0.1", "http://localhost", "https://")
        ):
            with suppress(httpx.HTTPError):
                httpx.post(
                    webhook,
                    json={"title": title, "message": message, "event": event.to_dict()},
                    timeout=5,
                )
