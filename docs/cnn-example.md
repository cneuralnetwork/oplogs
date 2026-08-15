# CNN example

Run a checked-in PyTorch model and inspect metrics, predictions, gradients, images,
system telemetry, and a reloadable checkpoint in the dashboard.

## Run on CPU

```bash
uv pip install --python .venv/bin/python torch \
  --index-url https://download.pytorch.org/whl/cpu
.venv/bin/python examples/simple_cnn.py
```

The example learns from generated stripe images, so it requires no dataset download.

## Run the small GPU example

```bash
.venv/bin/python examples/tiny_gpu_cnn.py
```

The CUDA example enforces a 500 MiB process VRAM ceiling by default and prints the
exact run URL before training starts. Use `--no-open-dashboard` in a remote session.

## Inspect the result

Open the printed run URL to inspect live batch and epoch metrics, prediction samples,
sampled gradients, process VRAM, and the retained model checkpoint.
