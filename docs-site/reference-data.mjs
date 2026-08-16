export const apiSymbols = [
  {
    slug: "init",
    name: "oplogs.init",
    group: "run lifecycle",
    kind: "function",
    summary: "Start or discover the local daemon, create a run, and enable capture surfaces.",
    signature: `oplogs.init(
    project: str = "uncategorized",
    *,
    name: str | None = None,
    config: dict[str, Any] | None = None,
    tags: list[str] | None = None,
    resume: str = "auto",
    autolog: bool = True,
    open: bool | None = None,
    capture_console: bool = True,
    capture_source: bool = True,
) -> Run`,
    source: "src/oplogs/sdk.py",
    parameters: [
      ["project", "str", '"uncategorized"', "Project used to group runs in the dashboard."],
      ["name", "str | None", "None", "Human-readable run name. The daemon assigns one when omitted."],
      ["config", "dict[str, Any] | None", "None", "Base run configuration. An active sweep overrides matching keys."],
      ["tags", "list[str] | None", "None", "Run tags. An active sweep adds its own sweep tag."],
      ["resume", "str", '"auto"', "Reserved for compatibility. Version 0.1.0 accepts this value but does not resume an earlier run."],
      ["autolog", "bool", "True", "Discover supported libraries already imported by the process and install their capture hooks."],
      ["open", "bool | None", "None", "Set False to suppress opening a newly started daemon in a desktop browser."],
      ["capture_console", "bool", "True", "Mirror stdout and stderr into the run journal while preserving terminal output."],
      ["capture_source", "bool", "True", "Capture git state and a workspace source snapshot in a background thread."],
    ],
    returns: ["Run", "A live run handle connected to the localhost daemon."],
    sections: [
      {
        id: "behavior",
        title: "behavior",
        paragraphs: [
          "The call reuses a healthy daemon when one is already running. Otherwise it starts a daemon bound to <code>127.0.0.1</code>, creates a capability token, and waits for the health endpoint before creating the run.",
          "System sampling and lifecycle capture always start. Console, source, and framework capture follow the corresponding arguments.",
        ],
      },
      {
        id: "example",
        title: "example",
        code: {
          language: "python",
          source: `import oplogs

with oplogs.init(
    project="vision",
    name="small-cnn",
    config={"learning_rate": 3e-4},
    tags=["baseline"],
) as run:
    run.log({"train/loss": 0.42}, step=0)

print(run.url)`,
        },
      },
      {
        id: "errors",
        title: "errors",
        paragraphs: [
          "The call raises when the daemon exits during startup, does not become healthy within 12 seconds, or rejects the run creation request. Inspect <code>daemon.log</code> under the oplogs data root when startup fails.",
        ],
      },
    ],
    related: ["run", "run-log", "run-finish"],
  },
  {
    slug: "run",
    name: "oplogs.Run",
    group: "run lifecycle",
    kind: "class",
    summary: "A live handle for logging, model inspection, run identity, and finalization.",
    signature: `class oplogs.Run`,
    source: "src/oplogs/sdk.py",
    returns: null,
    sections: [
      {
        id: "construction",
        title: "construction",
        paragraphs: [
          "Create runs with <code>oplogs.init()</code>. The initializer supplies daemon connection details and starts the sender, sampler, console hooks, source capture, and optional framework capture.",
        ],
      },
      {
        id: "attributes",
        title: "attributes",
        table: {
          columns: ["attribute", "type", "meaning"],
          rows: [
            ["id", "str", "Twelve-character run identifier assigned during initialization."],
            ["project", "str", "Project name stored with the run."],
            ["name", "str", "Resolved human-readable run name."],
            ["url", "str", "Local dashboard URL for this exact run."],
          ],
        },
      },
      {
        id: "context-manager",
        title: "context manager",
        paragraphs: [
          "<code>Run</code> implements the synchronous context manager protocol. A normal exit calls <code>finish()</code>. An exception is recorded, the run is finished with state <code>failed</code>, and the original exception continues to propagate.",
        ],
        code: {
          language: "python",
          source: `with oplogs.init(project="evaluation") as run:
    run.log({"accuracy": 0.94})`,
        },
      },
      {
        id: "lifecycle",
        title: "lifecycle",
        paragraphs: [
          "A run owns a non-blocking sender queue, a system sampler, and process-level console and exception hooks. Finish the run before creating overlapping runs in the same process because console hooks are process-global.",
        ],
      },
    ],
    related: ["init", "run-log", "run-watch", "run-finish"],
  },
  {
    slug: "run-log",
    name: "Run.log",
    group: "logging and tracing",
    kind: "method",
    summary: "Normalize, redact, seal, and enqueue metrics or rich values for the active run.",
    signature: `Run.log(
    values: dict[str, Any],
    *,
    step: int | float | None = None,
    timestamp: str | None = None,
) -> None`,
    source: "src/oplogs/sdk.py",
    parameters: [
      ["values", "dict[str, Any]", "required", "Named values to record in one call."],
      ["step", "int | float | None", "None", "Optional logical step attached to each event produced by the call."],
      ["timestamp", "str | None", "None", "Optional timestamp string. The current UTC timestamp is used when omitted."],
    ],
    returns: ["None", "The event queue is updated before the method returns."],
    sections: [
      {
        id: "accepted-values",
        title: "accepted values",
        table: {
          columns: ["input", "journal kind"],
          rows: [
            ["bool, int, float, scalar tensor or array", "metric"],
            ["str or None", "text"],
            ["dict, list, tuple, Json", "json"],
            ["Table or dataframe-like object", "table"],
            ["Image, Audio, or Video", "media or artifact"],
            ["Path, File, or Artifact", "artifact"],
            ["Histogram", "histogram"],
          ],
        },
      },
      {
        id: "example",
        title: "example",
        code: {
          language: "python",
          source: `run.log(
    {
        "train/loss": 0.184,
        "phase": "fine-tuning",
        "samples": oplogs.Image("sample-grid.png", caption="held-out batch"),
    },
    step=400,
)`,
        },
      },
      {
        id: "queue-and-redaction",
        title: "queue and redaction",
        paragraphs: [
          "Values are grouped by journal kind, recursively redacted, assigned increasing per-run sequence numbers, and checksummed before they enter the bounded sender queue. A full queue writes the event to the run spool on disk.",
          "The method raises <code>RuntimeError</code> after the run is finished and <code>TypeError</code> for unsupported values that are not wrapped in an oplogs value type.",
        ],
      },
    ],
    related: ["run", "image", "artifact", "table", "json", "histogram"],
  },
  {
    slug: "run-watch",
    name: "Run.watch",
    group: "logging and tracing",
    kind: "method",
    summary: "Record a PyTorch model and optionally sample parameter gradients.",
    signature: `Run.watch(
    model: Any,
    *,
    gradients: bool = True,
    every: int = 100,
) -> None`,
    source: "src/oplogs/sdk.py",
    parameters: [
      ["model", "Any", "required", "PyTorch module exposing named_parameters()."],
      ["gradients", "bool", "True", "Enable sampled gradient mean, standard deviation, and norm metrics."],
      ["every", "int", "100", "Positive interval measured in parameter-gradient hook calls."],
    ],
    returns: ["None", "Model metadata is queued and gradient hooks remain attached to the parameters."],
    sections: [
      {
        id: "captured-fields",
        title: "captured fields",
        paragraphs: [
          "The model event includes the fully qualified class name, total parameter count, trainable parameter count, and string representation. Gradient metrics use keys such as <code>gradients.layer.weight.norm</code>.",
        ],
      },
      {
        id: "example",
        title: "example",
        code: {
          language: "python",
          source: `model = TinyCNN().cuda()
run.watch(model, gradients=True, every=100)

loss = objective(model(batch), targets)
loss.backward()`,
        },
      },
      {
        id: "boundaries",
        title: "boundaries",
        paragraphs: [
          "The method requires PyTorch in the current environment. It does not infer loss, accuracy, batches, epochs, or validation boundaries. Log those values with <code>Run.log</code>.",
          "The sampling counter advances once per parameter hook, not once per optimizer step. Models with many trainable parameters can therefore emit more often than an optimizer-step interpretation would suggest. Use a positive <code>every</code> value; zero fails when a gradient hook runs.",
        ],
      },
    ],
    related: ["run", "run-log", "run-finish"],
  },
  {
    slug: "run-finish",
    name: "Run.finish",
    group: "run lifecycle",
    kind: "method",
    summary: "Stop capture, flush pending events, and close the run with a terminal state.",
    signature: `Run.finish(state: str | None = None) -> None`,
    source: "src/oplogs/sdk.py",
    parameters: [
      ["state", "str | None", "None", "Terminal state. Defaults to finished, or failed after an unhandled exception."],
    ],
    returns: ["None", "Repeated calls return without changing the completed run."],
    sections: [
      {
        id: "behavior",
        title: "behavior",
        paragraphs: [
          "Finishing stops system sampling, waits briefly for source capture, flushes partial console lines, restores process hooks, emits <code>run.finished</code>, flushes the sender, and posts the terminal state to the daemon.",
          "If the final daemon request fails, local shutdown still completes. Queued batches use the sender's disk spool behavior.",
        ],
      },
      {
        id: "example",
        title: "example",
        code: {
          language: "python",
          source: `run = oplogs.init(project="ablation")
try:
    train(run)
except KeyboardInterrupt:
    run.finish("cancelled")
    raise
else:
    run.finish()`,
        },
      },
      {
        id: "after-finish",
        title: "after finish",
        paragraphs: [
          "Calls to <code>Run.log</code> after completion raise <code>RuntimeError</code>. Use a new <code>oplogs.init()</code> call for additional evidence.",
        ],
      },
    ],
    related: ["run", "init", "run-log"],
  },
  {
    slug: "trace",
    name: "oplogs.trace",
    group: "logging and tracing",
    kind: "decorator",
    summary: "Record synchronous or asynchronous function calls as nested local spans.",
    signature: `oplogs.trace(
    function: Callable[P, R] | None = None,
    *,
    name: str | None = None,
)`,
    source: "src/oplogs/tracing.py",
    parameters: [
      ["function", "Callable[P, R] | None", "None", "Function supplied by bare decorator syntax."],
      ["name", "str | None", "None", "Explicit span name. Defaults to the function's module and qualified name."],
    ],
    returns: ["Callable", "A wrapper that preserves the original function metadata and return value."],
    sections: [
      {
        id: "recorded-data",
        title: "recorded data",
        paragraphs: [
          "Each call records parentage, name, safe arguments, duration, status, and a truncated safe result. Raised exceptions produce an error span and continue to propagate.",
          "Nested decorated calls inherit the active span id through a context variable. Calls made without an active oplogs run execute normally and emit no events.",
        ],
      },
      {
        id: "examples",
        title: "examples",
        code: {
          language: "python",
          source: `@oplogs.trace
def retrieve(query: str) -> list[str]:
    return index.search(query)

@oplogs.trace(name="agent.respond")
async def respond(prompt: str) -> str:
    context = retrieve(prompt)
    return await model.generate(prompt, context)`,
        },
      },
      {
        id: "capture-limits",
        title: "capture limits",
        paragraphs: [
          "Strings and representations are truncated to 2,000 characters. Dictionaries and sequences retain at most 50 entries at each normalization boundary. Review trace inputs before sharing an exported store.",
        ],
      },
    ],
    related: ["init", "run", "enable-otel"],
  },
  {
    slug: "enable-otel",
    name: "oplogs.enable_otel",
    group: "logging and tracing",
    kind: "function",
    summary: "Attach an oplogs exporter to the active OpenTelemetry tracer provider.",
    signature: `oplogs.enable_otel() -> Any`,
    source: "src/oplogs/otel.py",
    returns: ["SpanExporter", "The exporter instance installed through a SimpleSpanProcessor."],
    sections: [
      {
        id: "requirements",
        title: "requirements",
        paragraphs: [
          "Install the <code>otel</code> optional dependency, initialize an oplogs run first, and configure an OpenTelemetry tracer provider that accepts span processors.",
        ],
        code: { language: "bash", source: `pip install -e '.[otel]'` },
      },
      {
        id: "example",
        title: "example",
        code: {
          language: "python",
          source: `import oplogs

run = oplogs.init(project="agents")
exporter = oplogs.enable_otel()`,
        },
      },
      {
        id: "exported-fields",
        title: "exported fields",
        paragraphs: [
          "Completed OpenTelemetry spans become paired <code>trace.start</code> and <code>trace.end</code> events with span ids, parent ids, attributes, timestamps, duration, status, event names, and any error description.",
        ],
      },
      {
        id: "errors",
        title: "errors",
        paragraphs: [
          "The call raises <code>RuntimeError</code> when the optional dependency is missing, no oplogs run is active, or the current tracer provider cannot accept span processors.",
        ],
      },
    ],
    related: ["trace", "init", "run-finish"],
  },
  {
    slug: "sweep-config",
    name: "oplogs.sweep_config",
    group: "logging and tracing",
    kind: "function",
    summary: "Read the parameter mapping injected into a local sweep trial.",
    signature: `oplogs.sweep_config() -> dict[str, Any]`,
    source: "src/oplogs/sweeps.py",
    returns: ["dict[str, Any]", "The decoded OPLOGS_SWEEP_CONFIG value, or an empty dictionary outside a sweep."],
    sections: [
      {
        id: "behavior",
        title: "behavior",
        paragraphs: [
          "The sweep controller serializes one trial's parameters into <code>OPLOGS_SWEEP_CONFIG</code>. <code>oplogs.init()</code> also merges those values into the run config and adds the sweep id and trial index metadata.",
        ],
      },
      {
        id: "example",
        title: "example",
        code: {
          language: "python",
          source: `import oplogs

trial = oplogs.sweep_config()
learning_rate = trial.get("learning_rate", 3e-4)

with oplogs.init(project="search") as run:
    train(learning_rate=learning_rate, run=run)`,
        },
      },
      {
        id: "errors",
        title: "errors",
        paragraphs: [
          "Malformed JSON in <code>OPLOGS_SWEEP_CONFIG</code> raises <code>json.JSONDecodeError</code>. The function does not validate parameter names or types.",
        ],
      },
    ],
    related: ["init"],
  },
  {
    slug: "file",
    name: "oplogs.File",
    group: "rich values",
    kind: "class",
    summary: "Describe an ordinary local file for content-addressed retention.",
    signature: `oplogs.File(
    path: str | Path,
    name: str | None = None,
    mime_type: str | None = None,
)`,
    source: "src/oplogs/types.py",
    parameters: [
      ["path", "str | Path", "required", "Readable local file path. User-home markers are expanded and the path is resolved."],
      ["name", "str | None", "None", "Display name. Defaults to the source filename."],
      ["mime_type", "str | None", "None", "Explicit MIME type. Defaults to filename inference, then application/octet-stream."],
    ],
    returns: null,
    sections: [
      {
        id: "example",
        title: "example",
        code: {
          language: "python",
          source: `run.log({
    "predictions_csv": oplogs.File(
        "outputs/predictions.csv",
        mime_type="text/csv",
    )
})`,
        },
      },
      {
        id: "behavior",
        title: "behavior",
        paragraphs: [
          "Logging resolves the file immediately and records its path, display name, MIME type, and byte size. The daemon copies the bytes into the content-addressed blob store and links them to the run.",
          "A missing path or a directory raises <code>FileNotFoundError</code> during <code>Run.log</code> normalization.",
        ],
      },
    ],
    related: ["artifact", "audio", "video", "run-log"],
  },
  {
    slug: "artifact",
    name: "oplogs.Artifact",
    group: "rich values",
    kind: "class",
    summary: "Retain a typed file with aliases and structured metadata.",
    signature: `oplogs.Artifact(
    path: str | Path,
    name: str | None = None,
    mime_type: str | None = None,
    artifact_type: str = "file",
    aliases: list[str] = [],
    metadata: dict[str, Any] = {},
)`,
    source: "src/oplogs/types.py",
    parameters: [
      ["path", "str | Path", "required", "Readable local artifact file."],
      ["name", "str | None", "None", "Display name. Defaults to the source filename."],
      ["mime_type", "str | None", "None", "Explicit or inferred MIME type."],
      ["artifact_type", "str", '"file"', "Logical type such as model, dataset, or checkpoint."],
      ["aliases", "list[str]", "new empty list", "Registry aliases to associate with this artifact version."],
      ["metadata", "dict[str, Any]", "new empty dict", "Structured metadata stored with the artifact record."],
    ],
    returns: null,
    sections: [
      {
        id: "example",
        title: "example",
        code: {
          language: "python",
          source: `run.log({
    "checkpoint": oplogs.Artifact(
        "checkpoints/model.pt",
        artifact_type="model",
        aliases=["latest", "candidate"],
        metadata={"validation_accuracy": 0.947},
    )
})`,
        },
      },
      {
        id: "identity",
        title: "identity and aliases",
        paragraphs: [
          "Artifact bytes are identified by SHA-256. Repeated identical bytes reuse the same blob. The artifact record retains its producing run, type, aliases, metadata, MIME type, size, and digest.",
        ],
      },
    ],
    related: ["file", "image", "run-log"],
  },
  {
    slug: "image",
    name: "oplogs.Image",
    group: "rich values",
    kind: "class",
    summary: "Log an image path, Pillow image, or array with an optional caption.",
    signature: `oplogs.Image(
    value: Any,
    caption: str | None = None,
    format: str = "png",
)`,
    source: "src/oplogs/types.py",
    parameters: [
      ["value", "Any", "required", "Path, Pillow-compatible image object, or array-like image."],
      ["caption", "str | None", "None", "Text shown with the sample in the dashboard."],
      ["format", "str", '"png"', "Encoding format for in-memory values."],
    ],
    returns: null,
    sections: [
      {
        id: "path-example",
        title: "path example",
        code: {
          language: "python",
          source: `run.log({
    "samples": oplogs.Image(
        "outputs/sample-grid.png",
        caption="held-out generations",
    )
}, step=400)`,
        },
      },
      {
        id: "in-memory-values",
        title: "in-memory values",
        paragraphs: [
          "Objects with a <code>save</code> method are encoded directly. Other in-memory values require Pillow and NumPy. Non-<code>uint8</code> arrays are clipped to the range 0 through 1, scaled to 8-bit values, and encoded in the requested format.",
          "A path is retained as a file artifact. An in-memory image is base64-encoded into the media event.",
        ],
      },
    ],
    related: ["audio", "video", "artifact", "run-log"],
  },
  {
    slug: "audio",
    name: "oplogs.Audio",
    group: "rich values",
    kind: "class",
    summary: "Retain an audio file with an optional dashboard caption.",
    signature: `oplogs.Audio(
    path: str | Path,
    name: str | None = None,
    mime_type: str | None = None,
    caption: str | None = None,
)`,
    source: "src/oplogs/types.py",
    parameters: [
      ["path", "str | Path", "required", "Readable local audio file."],
      ["name", "str | None", "None", "Display name. Defaults to the filename."],
      ["mime_type", "str | None", "None", "Explicit or inferred audio MIME type."],
      ["caption", "str | None", "None", "Text shown beside the native audio player."],
    ],
    returns: null,
    sections: [
      {
        id: "example",
        title: "example",
        code: {
          language: "python",
          source: `run.log({
    "decoded_speech": oplogs.Audio(
        "outputs/answer.wav",
        caption="temperature 0.2",
    )
})`,
        },
      },
      {
        id: "behavior",
        title: "behavior",
        paragraphs: [
          "Audio uses the same resolved file descriptor as <code>File</code> and adds <code>media_type=audio</code> plus the caption. The dashboard renders a native player when the retained MIME type is supported by the browser.",
        ],
      },
    ],
    related: ["video", "image", "file", "run-log"],
  },
  {
    slug: "video",
    name: "oplogs.Video",
    group: "rich values",
    kind: "class",
    summary: "Retain a video file with an optional dashboard caption.",
    signature: `oplogs.Video(
    path: str | Path,
    name: str | None = None,
    mime_type: str | None = None,
    caption: str | None = None,
)`,
    source: "src/oplogs/types.py",
    parameters: [
      ["path", "str | Path", "required", "Readable local video file."],
      ["name", "str | None", "None", "Display name. Defaults to the filename."],
      ["mime_type", "str | None", "None", "Explicit or inferred video MIME type."],
      ["caption", "str | None", "None", "Text shown beside the native video player."],
    ],
    returns: null,
    sections: [
      {
        id: "example",
        title: "example",
        code: {
          language: "python",
          source: `run.log({
    "best_rollout": oplogs.Video(
        "outputs/episode.mp4",
        caption="highest return",
    )
})`,
        },
      },
      {
        id: "behavior",
        title: "behavior",
        paragraphs: [
          "Video uses the same resolved file descriptor as <code>File</code> and adds <code>media_type=video</code> plus the caption. Browser codec support determines whether the dashboard can play a retained file inline.",
        ],
      },
    ],
    related: ["audio", "image", "file", "run-log"],
  },
  {
    slug: "table",
    name: "oplogs.Table",
    group: "rich values",
    kind: "class",
    summary: "Normalize records, pandas frames, or Polars frames into a dashboard table.",
    signature: `oplogs.Table(value: Any)`,
    source: "src/oplogs/types.py",
    parameters: [
      ["value", "Any", "required", "List of record dictionaries, pandas DataFrame, or Polars DataFrame."],
    ],
    returns: null,
    sections: [
      {
        id: "example",
        title: "example",
        code: {
          language: "python",
          source: `rows = [
    {"label": "cat", "prediction": "cat", "confidence": 0.97},
    {"label": "dog", "prediction": "cat", "confidence": 0.54},
]
run.log({"predictions": oplogs.Table(rows)}, step=400)`,
        },
      },
      {
        id: "normalization",
        title: "normalization",
        paragraphs: [
          "Pandas-style objects use <code>to_dict(orient=\"records\")</code>. When that call rejects the orient argument, oplogs calls <code>to_dicts()</code> for Polars-style frames. Columns are the sorted union of keys across dictionary rows.",
          "Other values raise <code>TypeError</code>. Rows that are not dictionaries remain in the row list but do not contribute columns.",
        ],
      },
    ],
    related: ["json", "file", "run-log"],
  },
  {
    slug: "json",
    name: "oplogs.Json",
    group: "rich values",
    kind: "class",
    summary: "Mark a value as structured JSON evidence.",
    signature: `oplogs.Json(value: Any)`,
    source: "src/oplogs/types.py",
    parameters: [
      ["value", "Any", "required", "Structured value to retain under one log key."],
    ],
    returns: null,
    sections: [
      {
        id: "example",
        title: "example",
        code: {
          language: "python",
          source: `run.log({
    "evaluation": oplogs.Json({
        "split": "held-out",
        "classes": ["cat", "dog"],
        "macro_f1": 0.912,
    })
})`,
        },
      },
      {
        id: "behavior",
        title: "behavior",
        paragraphs: [
          "The wrapper checks that Python's JSON encoder can traverse the value with fallback string rendering, then records the original value as JSON evidence. Use JSON-native leaf values for reliable transport because the wrapper does not replace custom objects with those fallback strings. Plain dictionaries, lists, and tuples are also normalized as JSON without the wrapper.",
        ],
      },
    ],
    related: ["table", "run-log"],
  },
  {
    slug: "histogram",
    name: "oplogs.Histogram",
    group: "rich values",
    kind: "class",
    summary: "Reduce numeric values into deterministic equal-width histogram bins.",
    signature: `oplogs.Histogram(values: Any, bins: int = 30)`,
    source: "src/oplogs/types.py",
    parameters: [
      ["values", "Any", "required", "Iterable whose entries can be converted to float."],
      ["bins", "int", "30", "Positive number of equal-width bins."],
    ],
    returns: null,
    sections: [
      {
        id: "example",
        title: "example",
        code: {
          language: "python",
          source: `run.log({
    "confidence": oplogs.Histogram(confidences, bins=20)
}, step=400)`,
        },
      },
      {
        id: "binning",
        title: "binning",
        paragraphs: [
          "The encoded value contains bin edges and counts. Empty input produces empty arrays. Constant input produces one count with identical minimum and maximum edges. The maximum value is always included in the last bin.",
          "A bin count below one raises <code>ValueError</code>. A non-numeric entry raises during float conversion.",
        ],
      },
    ],
    related: ["run-log", "table"],
  },
];

export const cliCommands = [
  {
    slug: "open",
    name: "oplogs open",
    summary: "Open the local dashboard or one run and print the resulting URL.",
    usage: "oplogs open [RUN_ID]",
    source: "src/oplogs/cli.py",
    inputs: [["RUN_ID", "argument", "optional", "Run identifier to open. Omit it for the dashboard home."]],
    sections: [
      { id: "behavior", title: "behavior", paragraphs: ["The command starts or reuses the local daemon, asks the system browser to open the selected URL, and prints that URL to stdout."] },
      { id: "examples", title: "examples", code: { language: "bash", source: `oplogs open
oplogs open a1b2c3d4e5f6` } },
    ],
  },
  {
    slug: "stop",
    name: "oplogs stop",
    summary: "Stop the persistent daemon without deleting retained data.",
    usage: "oplogs stop",
    source: "src/oplogs/cli.py",
    inputs: [],
    sections: [
      { id: "behavior", title: "behavior", paragraphs: ["The command sends SIGTERM to the recorded daemon process, removes the daemon discovery file, and reports whether a running daemon was found. Runs, journals, blobs, and indexes remain on disk."] },
      { id: "restart", title: "restart", paragraphs: ["The next <code>oplogs.init()</code> or <code>oplogs open</code> call starts a new daemon automatically."] },
    ],
  },
  {
    slug: "doctor",
    name: "oplogs doctor",
    summary: "Inspect daemon health, data location, run count, store size, and Python version.",
    usage: "oplogs doctor",
    source: "src/oplogs/cli.py",
    inputs: [],
    sections: [
      { id: "output", title: "output", paragraphs: ["The human-readable report shows daemon state, the resolved data root, retained run count, total size in MiB, and the current Python version. It does not mutate the daemon or data store."] },
      { id: "example", title: "example", code: { language: "bash", source: "oplogs doctor" } },
    ],
  },
  {
    slug: "storage",
    name: "oplogs storage",
    summary: "Print retained local data usage as JSON.",
    usage: "oplogs storage",
    source: "src/oplogs/cli.py",
    inputs: [],
    sections: [
      { id: "fields", title: "fields", table: { columns: ["field", "meaning"], rows: [["root", "Resolved oplogs data directory."], ["bytes", "Total bytes below the data root."], ["projects", "Indexed project count."], ["runs", "Indexed run count."], ["events", "Indexed event count."], ["artifacts", "Indexed artifact count."]] } },
      { id: "retention", title: "retention", paragraphs: ["oplogs does not auto-delete runs. The command only measures the store."] },
    ],
  },
  {
    slug: "rebuild",
    name: "oplogs rebuild",
    summary: "Recreate query indexes from canonical run manifests and checksummed journals.",
    usage: "oplogs rebuild",
    source: "src/oplogs/cli.py",
    inputs: [],
    sections: [
      { id: "behavior", title: "behavior", paragraphs: ["The command clears derived event, metric, and trace indexes, restores run manifests, verifies existing journal events, and indexes valid records again. It prints rebuilt and invalid counts as JSON."] },
      { id: "boundary", title: "boundary", paragraphs: ["Reports, sweeps, registry aliases, and alert definitions originate in SQLite and are not reconstructed from run journals. Back up the complete data root, not only the run directories."] },
    ],
  },
  {
    slug: "alert",
    name: "oplogs alert",
    summary: "Create a local event or metric alert rule.",
    usage: "oplogs alert [OPTIONS]",
    source: "src/oplogs/cli.py",
    inputs: [
      ["--project TEXT", "option", "all projects", "Limit the rule to one project."],
      ["--event TEXT", "option", "unset", "Match one event kind, such as exception."],
      ["--metric TEXT", "option", "unset", "Match one metric key."],
      ["--operator TEXT", "option", ">", "Metric comparison. Only > and < are accepted."],
      ["--threshold FLOAT", "option", "0", "Metric comparison value."],
      ["--message TEXT", "option", "generated", "Notification message."],
      ["--webhook TEXT", "option", "unset", "HTTPS or localhost endpoint that receives the alert payload."],
      ["--command TEXT", "repeatable option", "unset", "Local command argv entries to execute."],
      ["--desktop / --no-desktop", "flag", "--desktop", "Enable or disable notify-send delivery."],
    ],
    sections: [
      { id: "requirements", title: "requirements", paragraphs: ["Set at least one of <code>--event</code> or <code>--metric</code>. Metric rules compare numeric values. Event rules match the exact journal event kind."] },
      { id: "examples", title: "examples", code: { language: "bash", source: `oplogs alert --event exception
oplogs alert --metric validation/loss --operator '>' --threshold 1.0` } },
      { id: "delivery", title: "delivery", paragraphs: ["Matching rules can call <code>notify-send</code>, execute an explicit argv list, or POST the title, message, and event to the configured webhook. Delivery runs in a daemon thread."] },
    ],
  },
  {
    slug: "server",
    name: "oplogs server",
    summary: "Run the localhost daemon in the foreground for development.",
    usage: "oplogs server [--port INTEGER]",
    source: "src/oplogs/cli.py",
    inputs: [["--port INTEGER", "option", "7437", "Requested localhost port."]],
    sections: [
      { id: "behavior", title: "behavior", paragraphs: ["The command creates a fresh capability token and launches <code>python -m oplogs.daemon</code> as a foreground child process. Its exit status is not converted into a separate CLI error."] },
      { id: "example", title: "example", code: { language: "bash", source: "oplogs server --port 7437" } },
    ],
  },
  {
    slug: "export",
    name: "oplogs export",
    summary: "Copy the complete data root or one run into a new portable directory.",
    usage: "oplogs export DESTINATION [--run-id TEXT]",
    source: "src/oplogs/cli.py",
    inputs: [
      ["DESTINATION", "argument", "required", "New directory to create."],
      ["--run-id TEXT", "option", "unset", "Export only the selected run directory."],
    ],
    sections: [
      { id: "behavior", title: "behavior", paragraphs: ["Without <code>--run-id</code>, the command recursively copies the complete oplogs data root. With a run id, it copies only <code>runs/&lt;id&gt;</code>."] },
      { id: "safety", title: "safety", paragraphs: ["The source must exist and the destination must not exist. The command refuses to merge into or overwrite an existing destination. A single-run export contains only that run directory; use a full export when you also need the shared blob store and SQLite records."] },
      { id: "examples", title: "examples", code: { language: "bash", source: `oplogs export ./oplogs-backup
oplogs export ./one-run --run-id a1b2c3d4e5f6` } },
    ],
  },
  {
    slug: "import-wandb",
    name: "oplogs import-wandb",
    summary: "Import a portable W&B JSON export or run directory into the local store.",
    usage: "oplogs import-wandb SOURCE [--project TEXT]",
    source: "src/oplogs/cli.py",
    inputs: [
      ["SOURCE", "argument", "required", "JSON export file or W&B run directory."],
      ["--project TEXT", "option", "source project", "Override the destination project."],
    ],
    sections: [
      { id: "preserved-data", title: "preserved data", paragraphs: ["The importer retains available configuration, tags, numeric history, summary values, and ordinary files. It classifies common image, audio, video, and dataset file types and finishes the created run with state <code>imported</code>."] },
      { id: "example", title: "example", code: { language: "bash", source: "oplogs import-wandb ./wandb/run-20260815 --project migrated" } },
      { id: "boundary", title: "boundary", paragraphs: ["The source is read-only. Provider objects that are absent from the export cannot be reconstructed."] },
    ],
  },
  {
    slug: "sweep",
    name: "oplogs sweep",
    summary: "Run grid, random, or Bayesian local subprocess trials.",
    usage: "oplogs sweep CONFIG COMMAND...",
    source: "src/oplogs/cli.py",
    inputs: [
      ["CONFIG", "argument", "required", "JSON or YAML sweep configuration."],
      ["COMMAND...", "argument", "required", "Training command and all of its arguments."],
    ],
    sections: [
      { id: "behavior", title: "behavior", paragraphs: ["Each trial receives its parameter mapping, sweep id, trial index, and optional CUDA device through environment variables. The controller records trial return codes and reads configured objective metrics from retained run summaries."] },
      { id: "methods", title: "methods", table: { columns: ["method", "implementation"], rows: [["grid", "Finite Cartesian product, truncated by count."], ["random", "Seeded sampling from declared candidate values."], ["bayes or bayesian", "Optuna TPE ask and tell batches."]] } },
      { id: "example", title: "example", code: { language: "bash", source: "oplogs sweep sweep.yaml python train.py" } },
      { id: "dependencies", title: "dependencies", paragraphs: ["YAML and Bayesian sweeps require <code>pip install 'oplogs[sweeps]'</code>. JSON grid or random sweeps use the base installation."] },
    ],
  },
  {
    slug: "report-export",
    name: "oplogs report-export",
    summary: "Write a stored report as self-contained HTML or PDF.",
    usage: "oplogs report-export REPORT_ID DESTINATION [--pdf]",
    source: "src/oplogs/cli.py",
    inputs: [
      ["REPORT_ID", "argument", "required", "Stored report identifier."],
      ["DESTINATION", "argument", "required", "Output HTML or PDF path."],
      ["--pdf / --no-pdf", "flag", "--no-pdf", "Render PDF instead of HTML."],
    ],
    sections: [
      { id: "behavior", title: "behavior", paragraphs: ["HTML export writes one self-contained document. PDF export renders a temporary HTML file, prints it through Playwright or an installed Chrome-compatible browser, and removes the temporary file."] },
      { id: "examples", title: "examples", code: { language: "bash", source: `oplogs report-export report-123 ./report.html
oplogs report-export report-123 ./report.pdf --pdf` } },
      { id: "errors", title: "errors", paragraphs: ["An unknown report id is rejected. PDF export requires the reports extra or a system Chrome/Chromium executable."] },
    ],
  },
];
