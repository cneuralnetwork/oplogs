# Metrics and values

`Run.log` records scalar and structured values through one method. Values are
normalized by type, recursively redacted, sealed as events, and queued without a
network wait.

## Log scalars and text

```python
run.log(
    {
        "train/loss": 0.184,
        "train/accuracy": 0.93,
        "phase": "fine-tuning",
        "healthy": True,
    },
    step=400,
)
```

Numbers and booleans become metric points. Strings become text events. Use stable
metric names across steps to produce one chart series.

## Log JSON

```python
run.log({
    "evaluation": oplogs.Json({
        "split": "held-out",
        "classes": ["cat", "dog"],
        "macro_f1": 0.912,
    })
})
```

Plain dictionaries and sequences are also accepted as JSON. Use `oplogs.Json` when you
want to make the intended representation explicit.

## Log tables and CSV files

```python
import csv
import oplogs

with open("predictions.csv", newline="") as handle:
    rows = list(csv.DictReader(handle))

run.log({
    "predictions": oplogs.Table(rows),
    "raw_csv": oplogs.File("predictions.csv", mime_type="text/csv"),
})
```

`oplogs.Table` accepts records, pandas dataframes, and Polars dataframes. Logging the
source file as well retains its exact bytes.

## Set a step or timestamp

```python
run.log(
    {"queue/depth": 12},
    step=processor_offset,
    timestamp="2026-08-15T12:30:00+00:00",
)
```

> [!NOTE] Completed runs are sealed
> Calling `run.log` after `run.finish()` raises `RuntimeError`.
