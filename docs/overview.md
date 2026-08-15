# oplogs

oplogs records metrics, console output, source state, media, traces, artifacts, and
machine telemetry on your workstation. The dashboard runs on localhost and requires no
account, API key, or hosted service.

## Start a run

Install from the repository while the package is not published to PyPI:

```bash
python -m pip install -e .
```

Initialize oplogs once near the start of your experiment:

```python
import oplogs

run = oplogs.init(project="vision-lab")
run.log({"train/loss": 0.184}, step=400)
```

The first run starts the local daemon and opens the dashboard when a desktop session is
available. The exact run URL is also available as `run.url`.

## What oplogs records

| Automatically | Through `run.log` |
| --- | --- |
| Environment, packages, source, and Git state | Scalars, text, JSON, and sequences |
| Standard output, errors, exceptions, and final state | Images, audio, video, tables, and histograms |
| Process, host, accelerator, and framework metadata | Files, checkpoints, aliases, and artifact metadata |

## Continue

- [Quickstart](quickstart.md) covers installation, logging, and opening the dashboard.
- [Metrics and values](logging.md) covers custom scalar, JSON, CSV, and table data.
- [Inspect runs](dashboard.md) explains the evidence available on a run page.
