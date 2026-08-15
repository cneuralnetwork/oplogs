# Troubleshooting

Start with `oplogs doctor` and the retained local state.

```bash
oplogs doctor
oplogs storage
```

## Common symptoms

| Symptom | Check | Next action |
| --- | --- | --- |
| The dashboard did not open | Confirm whether the process runs in a remote or headless session | Print `run.url`, or run `oplogs open RUN_ID` on a workstation with a browser |
| The daemon is stopped | Run `oplogs doctor` | Call `oplogs.init` or `oplogs open` to start it again |
| Events were spooled | Inspect `runs/<run-id>/spool.jsonl` | Start or reconnect the daemon; the sender replays the spool |
| `Run.watch` cannot find PyTorch | Check the Python environment used to run the experiment | Install PyTorch in that same environment |

## Rebuild query indexes

```bash
oplogs rebuild
```

Rebuild verifies run manifests and checksummed event journals before recreating the
derived indexes. Back up the complete data root first because reports, sweep controller
records, registry aliases, and alert definitions originate in SQLite.
