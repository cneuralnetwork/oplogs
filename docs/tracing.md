# LLM and agent traces

Trace model calls, tools, retrieval, and agent operations as a nested causal tree next
to the metrics and artifacts they produced.

## Trace a function

```python
import oplogs

@oplogs.trace(name="agent.plan")
def plan(request):
    return planner(request)
```

The span retains parentage, duration, status, truncated inputs and outputs, and raised
errors. Synchronous and asynchronous functions are supported.

## Capture provider calls

Autologging covers OpenAI, Anthropic, LiteLLM, LangChain, and LlamaIndex when those
libraries are present. Wrappers resolve the active run at call time, so sequential
runs in one process do not leak traces into a finished run.

## Review redacted data

Secret-shaped keys, bearer tokens, provider keys, private-key markers, and nested
request fields are redacted before events leave the SDK process.

```python
run.log({
    "request": {
        "model": "example-model",
        "api_key": "will-not-be-persisted",
    }
})
```

> [!WARNING] Review before sharing
> Redaction is a safety layer. Review source snapshots, console text, and retained
> files before sharing an exported data directory.

## Enable OpenTelemetry

```bash
python -m pip install -e '.[otel]'
```

```python
import oplogs

oplogs.enable_otel()
```
