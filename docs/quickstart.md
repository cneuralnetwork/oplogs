# Quickstart

Install oplogs, record a run, and open it in the local dashboard. oplogs requires
Python 3.10 or newer.

## Install

```bash
git clone https://github.com/cneuralnetwork/oplogs.git
cd oplogs
python -m pip install -e .
```

The dashboard ships inside the Python package. There is no separate frontend service
to install.

## Record a run

```python
import oplogs

with oplogs.init(
    project="first-project",
    name="baseline",
    config={"learning_rate": 3e-4},
    tags=["local", "baseline"],
) as run:
    for step in range(10):
        run.log({"train/loss": 1 / (step + 1)}, step=step)

print(run.url)
```

The context manager finishes the run after a normal exit. An unhandled exception is
retained and marks the run as failed.

## Open the dashboard

```bash
oplogs open
oplogs open RUN_ID
```

The daemon continues running after the training process exits. `oplogs stop` stops the
daemon without deleting retained runs.
