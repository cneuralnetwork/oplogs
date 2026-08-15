# Run sweeps

A sweep launches isolated local training subprocesses and retains each trial as an
ordinary oplogs run.

## Configure a sweep

```yaml
project: vision-lab
name: learning-rate
method: bayesian
count: 20
concurrency: 2
gpus: [0, 1]
metric:
  name: validation/loss
  goal: minimize
parameters:
  learning_rate:
    min: 0.00001
    max: 0.01
    log: true
  batch_size:
    values: [16, 32, 64]
```

## Launch the training command

```bash
oplogs sweep sweep.yaml python train.py
```

The controller injects the selected configuration, sweep ID, trial index, and optional
GPU assignment into the child environment.

## Choose a method

| Method | Behavior |
| --- | --- |
| `grid` | Enumerates the declared finite combinations |
| `random` | Samples the declared ranges and value sets |
| `bayesian` | Uses Optuna TPE ask and tell batches |

The configured objective is read from the retained run summary. Missing or failed
objectives remain visible rather than being silently imputed.
