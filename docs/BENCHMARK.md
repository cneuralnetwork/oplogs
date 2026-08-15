# Ingestion benchmark

The benchmark is executable and uses a fresh temporary OPLOGS store. It records three
numeric metrics per event, so 100,000 events produce 300,000 indexed metric points.

Command run on 2026-08-15:

```bash
.venv/bin/python scripts/benchmark_ingest.py --events 100000
```

Observed result on the development workstation:

```text
events=100000
seconds=10.510
events_per_second=9514
chart_query_ms=651.1
chart_points=7698
journal_mib=33.72
```

The journal and SQLite index are written to the same local filesystem. Results are not
a portable hardware guarantee. The retained script is the authority and should be run
on the target workstation before setting ingestion or dashboard latency expectations.

The chart query returns an endpoint-preserving downsample for each metric series. It
does not load the full 300,000-point history into the browser.
