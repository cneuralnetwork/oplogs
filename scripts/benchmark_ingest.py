"""Reproducible local ingestion and chart-query benchmark."""

from __future__ import annotations

import argparse
import tempfile
import time
from pathlib import Path

from oplogs.models import Event
from oplogs.storage import Storage


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--events", type=int, default=100_000)
    parser.add_argument("--batch", type=int, default=256)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="oplogs-benchmark-") as temporary:
        store = Storage(Path(temporary))
        run = store.create_run("benchmark", "ingestion", run_id="benchmark")
        started = time.perf_counter()
        for offset in range(0, args.events, args.batch):
            batch = [
                Event(
                    run.id,
                    sequence,
                    "metric",
                    {
                        "values": {
                            "loss": 1 / (sequence + 1),
                            "accuracy": sequence / max(1, args.events - 1),
                            "throughput": 1000 + sequence % 200,
                        }
                    },
                    step=sequence,
                )
                for sequence in range(offset, min(offset + args.batch, args.events))
            ]
            store.append_events(batch)
        elapsed = time.perf_counter() - started
        query_started = time.perf_counter()
        history = store.history(run.id, limit=2500)
        query_elapsed = time.perf_counter() - query_started
        journal = store.runs_dir / run.id / "events.jsonl"
        print(f"events={args.events}")
        print(f"seconds={elapsed:.3f}")
        print(f"events_per_second={args.events / elapsed:.0f}")
        print(f"chart_query_ms={query_elapsed * 1000:.1f}")
        print(f"chart_points={sum(len(points) for points in history.values())}")
        print(f"journal_mib={journal.stat().st_size / 1024**2:.2f}")


if __name__ == "__main__":
    main()
