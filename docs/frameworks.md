# Framework autologging

Autologging activates for supported libraries already imported by your process. It
records framework evidence without inventing task-specific loss, accuracy, or
validation semantics.

## Supported frameworks

| Family | Captured evidence |
| --- | --- |
| PyTorch | Optimizer learning rates, CUDA metadata, model structure, and optional sampled gradients |
| Keras and Lightning | Epoch and callback metrics |
| Hugging Face Trainer | Trainer logs and framework metadata |
| scikit-learn | Fitted estimator class and parameters |
| JAX | Device and runtime metadata |
| OpenAI, Anthropic, LiteLLM, LangChain, and LlamaIndex | Provider and agent call traces with recursive secret redaction |

## Watch a PyTorch model

```python
with oplogs.init(project="vision") as run:
    model = MyModel()
    run.watch(model, gradients=True, every=100)
    train(model)
```

`Run.watch` counts parameters and registers gradient hooks. Log loss, accuracy, and
validation boundaries explicitly with `Run.log`.

## Disable autologging

```python
run = oplogs.init(
    project="controlled-capture",
    autolog=False,
    capture_console=False,
    capture_source=False,
)
```

System telemetry and lifecycle events remain active. These flags only narrow the named
capture surfaces.
