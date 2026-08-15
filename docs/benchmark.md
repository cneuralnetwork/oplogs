# Ingestion benchmark

The benchmark uses a fresh temporary oplogs store and records three numeric metrics per
event. The retained script is the authority.

```bash
.venv/bin/python scripts/benchmark_ingest.py --events 100000
```

The development workstation result retained on 2026-08-15 was:

```text
events=100000
seconds=10.510
events_per_second=9514
chart_query_ms=651.1
chart_points=7698
journal_mib=33.72
```

The result is not a portable hardware guarantee. Run the script on the target
workstation before setting ingestion or dashboard latency expectations.
