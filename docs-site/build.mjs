import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { apiSymbols, cliCommands } from "./reference-data.mjs";

const sourceRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(sourceRoot, "..");
const fontRoot = path.join(repositoryRoot, "web", "src", "assets", "fonts");
const requestedOutput = process.argv[2] || path.join(sourceRoot, "_site");
const outputRoot = path.resolve(requestedOutput);
const basePath = normalizeBase(process.env.OPLOGS_BASE_PATH || "/oplogs/");
const siteUrl = normalizeSiteUrl(
  process.env.OPLOGS_SITE_URL || "https://cneuralnetwork.github.io/oplogs/",
);
const sourceUrl =
  process.env.OPLOGS_SOURCE_URL || "https://github.com/cneuralnetwork/oplogs";
const stylesSource = await readFile(path.join(sourceRoot, "styles.css"));
const runtimeSource = await readFile(path.join(sourceRoot, "runtime.js"));
const assetVersion = createHash("sha256")
  .update(stylesSource)
  .update(runtimeSource)
  .digest("hex")
  .slice(0, 10);

if (!outputRoot.startsWith(repositoryRoot + path.sep)) {
  throw new Error(`refusing to build outside the repository: ${outputRoot}`);
}

function normalizeBase(value) {
  return `/${value.replace(/^\/+|\/+$/g, "")}/`.replace("//", "/");
}

function normalizeSiteUrl(value) {
  return `${value.replace(/\/+$/g, "")}/`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function route(slug = "") {
  return `${basePath}${slug ? `${slug}/` : ""}`;
}

function githubSource(file) {
  return `${sourceUrl.replace(/\/+$/g, "")}/blob/main/${String(file).replace(/^\/+/, "")}`;
}

function headingCase(value) {
  if (value === "oplogs") return value;
  let result = value.charAt(0).toUpperCase() + value.slice(1);
  const technicalTerms = new Map([
    ["api", "API"],
    ["cli", "CLI"],
    ["cnn", "CNN"],
    ["cpu", "CPU"],
    ["csv", "CSV"],
    ["cuda", "CUDA"],
    ["gpu", "GPU"],
    ["html", "HTML"],
    ["json", "JSON"],
    ["llm", "LLM"],
    ["otel", "OTel"],
    ["pdf", "PDF"],
    ["pytorch", "PyTorch"],
    ["sdk", "SDK"],
    ["sql", "SQL"],
    ["sqlite", "SQLite"],
    ["tpe", "TPE"],
    ["vram", "VRAM"],
  ]);
  for (const [term, replacement] of technicalTerms) {
    result = result.replace(new RegExp(`\\b${term}\\b`, "gi"), replacement);
  }
  return result.replace(/w&amp;b/gi, "W&amp;B");
}

function polishHeadings(fragment) {
  return fragment.replace(
    /<(h1|h2|h3)([^>]*)>([^<]+)<\/\1>/g,
    (_match, tag, attributes, label) => `<${tag}${attributes}>${headingCase(label)}</${tag}>`,
  );
}

function displayPageTitle(page) {
  return page.slug.startsWith("reference/api/") || page.slug.startsWith("reference/cli/")
    ? page.title
    : headingCase(page.title);
}

function code(language, source, label = language) {
  return `<div class="code-block" data-code-block>
    <div class="code-meta"><span>${escapeHtml(label)}</span><button type="button" data-copy-code>copy</button></div>
    <pre><code class="language-${escapeHtml(language)}">${escapeHtml(source.trim())}</code></pre>
  </div>`;
}

function note(title, body) {
  return `<aside class="note"><strong>${escapeHtml(title)}</strong><div>${body}</div></aside>`;
}

function dataTable(columns, rows) {
  return `<div class="table-scroll" data-columns="${columns.length}"><table><thead><tr>${columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr></thead><tbody>${rows
    .map(
      (row) =>
        `<tr>${row
          .map(
            (value, index) =>
              `<td data-label="${escapeHtml(columns[index])}">${index === 0 ? `<code>${escapeHtml(value)}</code>` : escapeHtml(value)}</td>`,
          )
          .join("")}</tr>`,
    )
    .join("")}</tbody></table></div>`;
}

function renderReferenceSections(sections = []) {
  return sections
    .map((section) => {
      const paragraphs = (section.paragraphs || []).map((value) => `<p>${value}</p>`).join("");
      const table = section.table ? dataTable(section.table.columns, section.table.rows) : "";
      const snippet = section.code
        ? code(section.code.language, section.code.source, section.code.label || section.code.language)
        : "";
      return `<h2 id="${escapeHtml(section.id)}">${escapeHtml(section.title)}</h2>${paragraphs}${table}${snippet}`;
    })
    .join("");
}

function relatedReferences(items, lookup, baseSlug) {
  if (!items?.length) return "";
  return `<h2 id="related">related</h2><div class="related-reference">${items
    .map((slug) => {
      const target = lookup.get(slug);
      if (!target) throw new Error(`reference links to missing entry: ${slug}`);
      return `<a href="${route(`${baseSlug}/${target.slug}`)}"><code>${escapeHtml(target.name)}</code><span>${escapeHtml(target.summary)}</span></a>`;
    })
    .join("")}</div>`;
}

const apiBySlug = new Map(apiSymbols.map((item) => [item.slug, item]));
const cliBySlug = new Map(cliCommands.map((item) => [item.slug, item]));

function apiReferencePage(item) {
  const parameters = item.parameters?.length
    ? `<h2 id="parameters">parameters</h2>${dataTable(
        ["parameter", "type", "default", "description"],
        item.parameters,
      )}`
    : "";
  const returns = item.returns
    ? `<h2 id="returns">returns</h2>${dataTable(["type", "description"], [item.returns])}`
    : "";
  return {
    slug: `reference/api/${item.slug}`,
    title: item.name,
    description: item.summary,
    body: `<div class="symbol-page">
      <h1 class="symbol-title"><code>${escapeHtml(item.name)}</code></h1>
      <p class="lead">${escapeHtml(item.summary)}</p>
      <div class="symbol-meta"><span>${escapeHtml(item.kind)}</span><a href="${githubSource(item.source)}">Source on GitHub</a></div>
      <h2 id="signature">signature</h2>
      ${code("python", item.signature, item.kind)}
${parameters}
${returns}
${renderReferenceSections(item.sections)}
${relatedReferences(item.related, apiBySlug, "reference/api")}
    </div>`,
  };
}

function cliReferencePage(item) {
  const inputs = item.inputs.length
    ? `<h2 id="arguments-and-options">arguments and options</h2>${dataTable(
        ["name", "kind", "default", "description"],
        item.inputs,
      )}`
    : "";
  const related = cliCommands.filter((candidate) => candidate.slug !== item.slug).slice(0, 3);
  return {
    slug: `reference/cli/${item.slug}`,
    title: item.name,
    description: item.summary,
    body: `<div class="symbol-page command-page">
      <h1 class="symbol-title"><code>${escapeHtml(item.name)}</code></h1>
      <p class="lead">${escapeHtml(item.summary)}</p>
      <div class="symbol-meta"><span>command</span><a href="${githubSource(item.source)}">Source on GitHub</a></div>
      <h2 id="usage">usage</h2>
      ${code("bash", item.usage, "shell")}
${inputs}
${renderReferenceSections(item.sections)}
${relatedReferences(
        related.map((candidate) => candidate.slug),
        cliBySlug,
        "reference/cli",
      )}
    </div>`,
  };
}

function referenceDirectory(items, baseSlug) {
  const grouped = new Map();
  for (const item of items) {
    const group = item.group || "commands";
    if (!grouped.has(group)) grouped.set(group, []);
    grouped.get(group).push(item);
  }
  return `<div class="reference-directory">${[...grouped.entries()]
    .map(
      ([group, entries]) => `<section class="reference-cluster">
        <h2 id="${group.replace(/[^a-z0-9]+/g, "-")}">${escapeHtml(group)}</h2>
        <div>${entries
          .map(
            (item) => `<a class="reference-entry" href="${route(`${baseSlug}/${item.slug}`)}">
              <strong><code>${escapeHtml(item.name)}</code></strong>
              <small>${escapeHtml(item.summary)}</small>
            </a>`,
          )
          .join("")}</div>
      </section>`,
    )
    .join("")}</div>`;
}

const apiIndexPage = {
  slug: "reference/api",
  title: "api directory",
  description: "Complete symbol-by-symbol reference for the public oplogs Python API.",
  body: `
    <h1>api directory</h1>
    <p class="lead">Every stable symbol exported from <code>oplogs</code>, plus the three public <code>Run</code> operations used during an experiment. Signatures and defaults match version 0.1.0.</p>
    ${referenceDirectory(apiSymbols, "reference/api")}
    ${note("version boundary", "<p>The directory covers the package-root surface in <code>oplogs.__all__</code> and the public methods on <code>Run</code>. Internal storage, daemon, capture, and normalization helpers are not compatibility promises.</p>")}
  `,
};

const apiReferencePages = apiSymbols.map(apiReferencePage);
const cliReferencePages = cliCommands.map(cliReferencePage);

const groups = [
  {
    title: "Start",
    pages: [
      ["", "Overview"],
      ["getting-started", "Quickstart"],
      ["guides/cnn", "Train a CNN"],
    ],
  },
  {
    title: "Guides",
    pages: [
      ["guides/logging", "Log data"],
      ["guides/media", "Media and artifacts"],
      ["guides/frameworks", "Frameworks"],
      ["guides/tracing", "LLM and agent traces"],
      ["guides/dashboard", "Inspect runs"],
      ["guides/sweeps", "Run sweeps"],
      ["guides/migration", "Migrate from W&B"],
      ["troubleshooting", "Troubleshooting"],
    ],
  },
  {
    title: "Reference",
    pages: [
      ["reference/api", "Python API"],
      ["reference/cli", "Command line"],
      ["architecture", "Architecture"],
    ],
  },
];

const pages = [
  {
    slug: "",
    title: "overview",
    description: "Local-first experiment tracking for models, agents, and generated media.",
    body: `
      <h1>oplogs</h1>
      <p class="lead"><code>oplogs</code> records an experiment as durable local evidence: metrics, console output, source state, media, traces, artifacts, and machine telemetry. The dashboard runs on your workstation. No account, api key, or hosted service is required.</p>

      <h2 id="start-a-run">start a run</h2>
      <p>Install from the repository while the package is not yet published to pypi, then initialize once at the top of your experiment.</p>
      ${code("bash", "pip install -e .")}
      ${code("python", `import oplogs

run = oplogs.init(project="vision-lab")
run.log({"train/loss": 0.184}, step=400)`, "python")}
      <p>The first run starts the persistent local daemon and opens the dashboard when a desktop session is available. The run URL is also available as <code>run.url</code>.</p>

      <h2 id="what-is-recorded">what is recorded</h2>
      <table>
        <thead><tr><th>without extra calls</th><th>through <code>run.log</code></th></tr></thead>
        <tbody>
          <tr><td>environment, packages, source, and git state</td><td>scalars, text, json, and sequences</td></tr>
          <tr><td>stdout, stderr, exceptions, and final state</td><td>images, audio, video, tables, and histograms</td></tr>
          <tr><td>process, host, accelerator, and framework metadata</td><td>files, checkpoints, aliases, and artifact metadata</td></tr>
        </tbody>
      </table>
      ${note("local by construction", "<p>The dashboard and write api are compiled into the python package. Runs stay under one local data root, and oplogs never deletes them automatically.</p>")}

    `,
  },
  {
    slug: "getting-started",
    title: "quickstart",
    description: "Install oplogs, start a run, and inspect it in the local dashboard.",
    body: `
      <h1>quickstart</h1>
      <p class="lead">Open a run, log your first semantic value, and keep the complete experiment record with three calls.</p>
      <h2 id="install">install</h2>
      ${code("bash", `git clone https://github.com/cneuralnetwork/oplogs.git
cd oplogs
python -m pip install -e .`)}
      <p>Python 3.11 or newer is required. The dashboard ships inside the package, so there is no separate frontend service to install.</p>
      <h2 id="run">run</h2>
      ${code("python", `import oplogs

with oplogs.init(
    project="first-project",
    name="baseline",
    config={"learning_rate": 3e-4},
    tags=["local", "baseline"],
) as run:
    for step in range(10):
        run.log({"train/loss": 1 / (step + 1)}, step=step)

print(run.url)`)}
      <p>The context manager finishes the run even when your training body raises. Unhandled exceptions are retained and the run is marked failed.</p>
      <h2 id="open-the-dashboard">open the dashboard</h2>
      ${code("bash", `oplogs open
oplogs open RUN_ID`)}
      <p>The daemon persists after the training process exits. Stop it without removing data with <code>oplogs stop</code>.</p>
      <h2 id="data-location">choose the data location</h2>
      <p>Set <code>OPLOGS_HOME</code> before the first run to move the complete local store.</p>
      ${code("bash", `export OPLOGS_HOME=/mnt/experiments/oplogs
python train.py`)}
      ${note("no silent cloud fallback", "<p>If the local daemon cannot accept an event batch, the sdk spools it beside the run and replays it later. It does not transmit the batch to another service.</p>")}
      <h2 id="development-check">check the installation</h2>
      ${code("bash", `oplogs doctor
oplogs storage`)}
    `,
  },
  {
    slug: "guides/cnn",
    title: "train a cnn",
    description: "Run the checked-in PyTorch CNN examples and inspect real training evidence.",
    body: `
      <h1>train a cnn</h1>
      <p class="lead">The repository includes two real PyTorch proofs. Both learn from generated stripe images, perform backpropagation, log held-out evaluation, and retain a reloadable checkpoint.</p>
      <h2 id="cpu-proof">cpu proof</h2>
      ${code("bash", `uv pip install --python .venv/bin/python torch \\
  --index-url https://download.pytorch.org/whl/cpu
.venv/bin/python examples/simple_cnn.py`)}
      <p>The two-layer model records epoch metrics, optimizer learning rate, sampled gradients, console output, process telemetry, prediction rows, a confidence histogram, an image grid, a trace, and the final checkpoint. No dataset download is required.</p>
      <h2 id="gpu-proof">tiny gpu proof</h2>
      ${code("bash", `.venv/bin/python examples/tiny_gpu_cnn.py`)}
      <p>The cuda-first model has 1,122 trainable parameters. By default it caps PyTorch's caching allocator at 96 mib and checks this process with <code>nvidia-smi</code>. The run fails closed if measured process vram exceeds 500 mib.</p>
      ${note("driver memory is real memory", "<p>A cuda context consumes memory outside tensor allocation. The example verifies the complete process total reported by the driver instead of treating allocator statistics as the whole vram footprint.</p>")}
      <h2 id="live-dashboard">watch it live</h2>
      <p>The gpu example prints and opens the exact run page before training begins. Batch metrics, epoch evaluation, gradients, and memory readings arrive while the process is still active.</p>
      ${code("bash", `.venv/bin/python examples/tiny_gpu_cnn.py \\
  --epochs 4 \\
  --vram-limit-mb 500 \\
  --allocator-limit-mb 96`)}
      <p>Use <code>--no-open-dashboard</code> on a remote machine. The command still prints the local URL.</p>
      <h2 id="retained-output">retained output</h2>
      <p>The demo keeps its image grid and checkpoint under <code>./oplogs-cnn-output/&lt;run-id&gt;/</code>. The same bytes are content-addressed in the oplogs blob store and linked from the run's artifacts view.</p>
    `,
  },
  {
    slug: "guides/frameworks",
    title: "framework autologging",
    description: "Understand what oplogs discovers from supported ML and LLM frameworks.",
    body: `
      <h1>framework autologging</h1>
      <p class="lead">Autologging is enabled by default and activates only for libraries already imported by your process. It records what a framework exposes and does not invent task semantics.</p>
      <h2 id="supported-frameworks">supported frameworks</h2>
      <table><thead><tr><th>family</th><th>captured evidence</th></tr></thead><tbody>
        <tr><td>PyTorch</td><td>optimizer learning rates, cuda metadata, model structure, and optional sampled gradients</td></tr>
        <tr><td>Keras and Lightning</td><td>epoch and callback metrics</td></tr>
        <tr><td>Hugging Face Trainer</td><td>trainer logs and framework metadata</td></tr>
        <tr><td>scikit-learn</td><td>fitted estimator class and parameters</td></tr>
        <tr><td>JAX</td><td>device and runtime metadata</td></tr>
        <tr><td>OpenAI, Anthropic, LiteLLM, LangChain, LlamaIndex</td><td>provider and agent call traces with recursive secret redaction</td></tr>
      </tbody></table>
      <h2 id="watch-pytorch">watch a pytorch model</h2>
      ${code("python", `with oplogs.init(project="vision") as run:
    model = MyModel()
    run.watch(model, gradients=True, every=100)
    train(model)`)}
      <p><code>watch</code> counts parameters and registers gradient hooks. It does not guess your loss, accuracy, or validation boundary. Log those explicitly.</p>
      <h2 id="disable-autolog">disable autologging</h2>
      ${code("python", `run = oplogs.init(
    project="controlled-capture",
    autolog=False,
    capture_console=False,
    capture_source=False,
)`)}
      <p>System telemetry and run lifecycle events remain active. The flags only narrow the named capture surfaces.</p>
    `,
  },
  {
    slug: "guides/logging",
    title: "metrics and values",
    description: "Log metrics, text, JSON, CSV content, dataframes, and custom values.",
    body: `
      <h1>metrics and values</h1>
      <p class="lead"><code>Run.log</code> is the single semantic logging method. Values are normalized by type, recursively redacted, sealed as events, and queued without a network wait.</p>
      <h2 id="scalars-and-text">scalars and text</h2>
      ${code("python", `run.log(
    {
        "train/loss": 0.184,
        "train/accuracy": 0.93,
        "phase": "fine-tuning",
        "healthy": True,
    },
    step=400,
)`)}
      <p>Numbers and booleans become metric points. Strings become text events. Use stable metric names across steps to produce one chart series.</p>
      <h2 id="json">json</h2>
      ${code("python", `run.log({
    "evaluation": oplogs.Json({
        "split": "held-out",
        "classes": ["cat", "dog"],
        "macro_f1": 0.912,
    })
})`)}
      <p>Plain dictionaries and sequences are also accepted as json. The wrapper is useful when you want the intent to be explicit at the call site.</p>
      <h2 id="tables-and-csv">tables and csv</h2>
      ${code("python", `import csv
import oplogs

with open("predictions.csv", newline="") as handle:
    rows = list(csv.DictReader(handle))

run.log({
    "predictions": oplogs.Table(rows),
    "raw_csv": oplogs.File("predictions.csv", mime_type="text/csv"),
})`)}
      <p><code>Table</code> accepts a list of records plus pandas and Polars frames. Logging the source file as well retains its exact bytes.</p>
      <h2 id="timestamps">steps and timestamps</h2>
      ${code("python", `run.log(
    {"queue/depth": 12},
    step=processor_offset,
    timestamp="2026-08-15T12:30:00+00:00",
)`)}
      ${note("finished means sealed", "<p>Calling <code>run.log</code> after <code>run.finish()</code> raises. This protects a completed run from accidental mutation.</p>")}
    `,
  },
  {
    slug: "guides/media",
    title: "media and artifacts",
    description: "Log generated images, audio, video, histograms, files, and model checkpoints.",
    body: `
      <h1>media and artifacts</h1>
      <p class="lead">Rich values stay attached to the step and run that produced them. Files are stored by sha-256, so repeated bytes are not duplicated.</p>
      <h2 id="images">images</h2>
      ${code("python", `run.log({
    "samples": oplogs.Image(
        "outputs/sample-grid.png",
        caption="16 held-out generations at step 400",
    )
}, step=400)`)}
      <p><code>Image</code> accepts a path, a Pillow image, or an array when Pillow and NumPy are installed.</p>
      <h2 id="audio-and-video">audio and video</h2>
      ${code("python", `run.log({
    "speech": oplogs.Audio("sample.wav", caption="decoded response"),
    "rollout": oplogs.Video("episode.mp4", caption="best episode"),
})`)}
      <p>The dashboard uses the retained mime type to render native playback controls.</p>
      <h2 id="histograms">histograms</h2>
      ${code("python", `run.log({
    "confidence": oplogs.Histogram(confidences, bins=20)
})`)}
      <h2 id="artifacts">versioned artifacts</h2>
      ${code("python", `run.log({
    "checkpoint": oplogs.Artifact(
        "model.pt",
        artifact_type="model",
        aliases=["latest", "candidate"],
        metadata={"validation_accuracy": 0.947},
    )
})`)}
      <p>Aliases are local registry pointers. The artifact record keeps its digest, size, type, metadata, and producing run.</p>
    `,
  },
  {
    slug: "guides/tracing",
    title: "llm and agent traces",
    description: "Trace nested functions and provider calls while redacting secrets.",
    body: `
      <h1>llm and agent traces</h1>
      <p class="lead">Trace model calls, tools, retrieval, and agent operations as one nested causal tree next to the metrics and artifacts they produced.</p>
      <h2 id="trace-a-function">trace a function</h2>
      ${code("python", `import oplogs

@oplogs.trace(name="agent.plan")
def plan(request):
    return planner(request)`)}
      <p>The span keeps parentage, duration, status, truncated inputs and outputs, and raised errors. Synchronous and asynchronous functions are supported.</p>
      <h2 id="provider-calls">provider calls</h2>
      <p>Autologging covers OpenAI, Anthropic, LiteLLM, LangChain, and LlamaIndex when those libraries are present. Wrappers resolve the active run at call time, so sequential runs in one process do not leak traces into a finished run.</p>
      <h2 id="redaction">redaction</h2>
      <p>Secret-shaped keys, bearer tokens, provider keys, private-key markers, and nested request fields are redacted before events leave the sdk process.</p>
      ${code("python", `run.log({
    "request": {
        "model": "example-model",
        "api_key": "will-not-be-persisted",
    }
})`)}
      ${note("inspect before sharing", "<p>Redaction is a safety layer, not a substitute for reviewing an exported run. Check source snapshots, console text, and uploaded files before sharing a data directory.</p>")}
      <h2 id="opentelemetry">opentelemetry</h2>
      ${code("bash", `pip install -e '.[otel]'`)}
      ${code("python", `import oplogs

oplogs.enable_otel()`)}
    `,
  },
  {
    slug: "guides/dashboard",
    title: "inspect runs",
    description: "Use the local dashboard to inspect metrics, samples, traces, artifacts, and system evidence.",
    body: `
      <h1>inspect runs</h1>
      <p class="lead">The dashboard is a compiled part of the python wheel. It reads the localhost api and event stream; there is no separate hosted dashboard.</p>
      <h2 id="open-a-run">open a run</h2>
      ${code("bash", `oplogs open
oplogs open RUN_ID`)}
      <p>Project filters and search narrow the run table. A run page keeps its live state, summary, tags, configuration, source and machine identity together.</p>
      <h2 id="views">views</h2>
      <table><thead><tr><th>view</th><th>what to inspect</th></tr></thead><tbody>
        <tr><td>overview</td><td>state, duration, key metrics, host, accelerator, and recent evidence</td></tr>
        <tr><td>charts</td><td>downsampled metric histories built for long runs</td></tr>
        <tr><td>samples</td><td>images, audio, video, text, json, tables, and histograms</td></tr>
        <tr><td>console</td><td>stdout, stderr, and retained exceptions</td></tr>
        <tr><td>traces</td><td>nested llm, tool, and agent spans</td></tr>
        <tr><td>artifacts</td><td>digests, aliases, metadata, size, and producer identity</td></tr>
        <tr><td>system</td><td>cpu, memory, process, and accelerator histories</td></tr>
      </tbody></table>
      <h2 id="long-histories">long histories</h2>
      <p>Metric queries use endpoint-preserving SQL downsampling per series. The browser does not load every indexed point simply to draw a chart.</p>
      <h2 id="reports">reports</h2>
      <p>Reports can combine retained runs and export as self-contained html. PDF export is optional and requires a compatible browser engine.</p>
      ${code("bash", `oplogs report-export REPORT_ID report.html
oplogs report-export REPORT_ID report.pdf --pdf`)}
    `,
  },
  {
    slug: "guides/sweeps",
    title: "run sweeps",
    description: "Run local grid, random, or Optuna TPE sweeps with isolated subprocesses.",
    body: `
      <h1>run sweeps</h1>
      <p class="lead">A sweep launches isolated local training subprocesses and retains every trial as an ordinary oplogs run.</p>
      <h2 id="configuration">configuration</h2>
      ${code("yaml", `project: vision-lab
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
    values: [16, 32, 64]`)}
      <h2 id="launch">launch</h2>
      ${code("bash", `oplogs sweep sweep.yaml python train.py`)}
      <p>The controller injects the selected configuration, sweep id, trial index, and optional gpu assignment into the child environment.</p>
      <h2 id="methods">methods</h2>
      <table><thead><tr><th>method</th><th>behavior</th></tr></thead><tbody>
        <tr><td>grid</td><td>enumerates the declared finite combinations</td></tr>
        <tr><td>random</td><td>samples the declared ranges and value sets</td></tr>
        <tr><td>bayesian</td><td>uses real Optuna TPE ask and tell batches</td></tr>
      </tbody></table>
      <p>The configured objective is read from the retained run summary. Missing or failed objectives remain visible rather than being silently imputed.</p>
    `,
  },
  {
    slug: "guides/migration",
    title: "migrate from w&b",
    description: "Import portable W&B exports and ordinary run directories into oplogs.",
    body: `
      <h1>migrate from w&amp;b</h1>
      <p class="lead">Import an existing export without running a W&amp;B service. The resulting run is ordinary local oplogs data.</p>
      <h2 id="import">import</h2>
      ${code("bash", `oplogs import-wandb ./wandb/run-20260815 --project migrated`)}
      <p>The importer accepts portable json exports and ordinary W&amp;B run directories.</p>
      <h2 id="preserved">preserved fields</h2>
      <ul>
        <li>configuration and numeric history</li>
        <li>summary values and tags</li>
        <li>files below the run's <code>files</code> tree</li>
        <li>media that can be identified from the retained file type</li>
      </ul>
      <p>Imported media appears in samples and artifacts immediately. The original source directory is not modified.</p>
      ${note("portable boundary", "<p>Provider-specific workspace objects that are not present in the export cannot be reconstructed. The importer preserves the evidence available on disk and reports what it created.</p>")}
    `,
  },
  {
    slug: "troubleshooting",
    title: "troubleshooting",
    description: "Diagnose the local daemon, data store, framework capture, and dashboard.",
    body: `
      <h1>troubleshooting</h1>
      <p class="lead">Start with the retained state. Most failures can be separated into daemon health, data-root access, framework availability, or browser reachability.</p>
      <h2 id="doctor">run doctor</h2>
      ${code("bash", `oplogs doctor
oplogs storage`)}
      <h2 id="dashboard-did-not-open">dashboard did not open</h2>
      <p>Remote shells and headless sessions may not have a desktop display. The run is still active. Print <code>run.url</code> or run <code>oplogs open RUN_ID</code> on the workstation with a browser.</p>
      <h2 id="daemon-is-stopped">daemon is stopped</h2>
      <p>The next <code>oplogs.init</code> or <code>oplogs open</code> starts it again. A deliberate <code>oplogs stop</code> never removes retained data.</p>
      <h2 id="events-were-spooled">events were spooled</h2>
      <p>The sdk writes failed batches to <code>runs/&lt;run-id&gt;/spool.jsonl</code>. A sender replays that file when it can reach the daemon again.</p>
      <h2 id="rebuild-indexes">rebuild indexes</h2>
      ${code("bash", `oplogs rebuild`)}
      <p>Rebuild verifies canonical run manifests and checksummed event journals before recreating the query indexes.</p>
      <h2 id="watch-requires-pytorch">watch requires pytorch</h2>
      <p><code>run.watch(model)</code> checks for PyTorch and raises a direct error when it is unavailable. Install the framework in the same Python environment as oplogs.</p>
    `,
  },
  apiIndexPage,
  ...apiReferencePages,
  {
    slug: "reference/cli",
    title: "command line",
    description: "Complete command directory for opening, diagnosing, moving, repairing, and automating oplogs.",
    body: `
      <h1>command line</h1>
      <p class="lead">All 11 commands operate on the same local data root and daemon as the Python SDK. Open a command for exact arguments, options, defaults, output, and failure boundaries.</p>
      ${referenceDirectory(cliCommands, "reference/cli")}
      ${note("data root", "<p>Commands resolve the same <code>OPLOGS_HOME</code> override as the SDK. Destructive retention commands are deliberately absent; <code>oplogs stop</code> stops the process but keeps data.</p>")}
    `,
  },
  ...cliReferencePages,
  {
    slug: "architecture",
    title: "architecture",
    description: "Understand the local write path, authority boundary, recovery model, and security boundary.",
    body: `
      <h1>architecture</h1>
      <p class="lead">Two processes share one local data root. The training process emits sealed events; the localhost daemon journals and indexes them for the browser.</p>
      <div class="architecture-map" role="img" aria-label="Training process sends a queued batch to the localhost daemon, which writes a checksummed journal, SQLite index, and content-addressed blobs. The browser reads the local API.">
        <div><strong>training process</strong><span>normalize → redact → seal → queue</span></div>
        <b>batch</b>
        <div><strong>localhost daemon</strong><span>journal sync + sqlite transaction</span></div>
        <b>read</b>
        <div><strong>browser</strong><span>compiled dashboard + event stream</span></div>
        <i></i>
        <div class="storage-node"><span>events.jsonl</span><span>sqlite index</span><span>sha-256 blobs</span></div>
      </div>
      <h2 id="authority-and-recovery">authority and recovery</h2>
      <p>Each run owns a manifest, source snapshot, and append-only checksummed journal. SQLite is a rebuildable query index for runs, events, metrics, traces, summaries, and artifacts.</p>
      <p>Reports, sweep controller records, registry aliases, and alert definitions originate in SQLite. Include the complete data root in normal backups.</p>
      <h2 id="write-path">write path</h2>
      <p><code>Run.log</code> puts events on a bounded queue. The sender posts batches of up to 128 events. The daemon transforms file descriptors into content-addressed records, syncs one journal append, then indexes the batch in one SQLite transaction.</p>
      <h2 id="security-boundary">security boundary</h2>
      <ul>
        <li>the daemon binds only to <code>127.0.0.1</code></li>
        <li>mutating requests require a random capability token stored with mode <code>0600</code></li>
        <li>the dashboard is same-origin and exposes no permissive cors policy</li>
        <li>secret-shaped values are redacted before persistence</li>
      </ul>
      ${note("single-user workstation boundary", "<p>This is not multi-tenant authentication. Any local process can access read endpoints. Treat the workstation account and data directory as the trust boundary.</p>")}
      <h2 id="scale-boundary">scale boundary</h2>
      <p>The intended boundary is a high-throughput workstation store. oplogs does not claim distributed database scale. Metric charts use bounded per-series downsampling, and identical artifact bytes share one blob.</p>
    `,
  },
];

const pageBySlug = new Map(pages.map((page) => [page.slug, page]));
if (pageBySlug.size !== pages.length) throw new Error("documentation contains duplicate routes");
for (const group of groups) {
  for (const [slug] of group.pages) {
    if (!pageBySlug.has(slug)) throw new Error(`navigation references missing page: ${slug}`);
  }
}

function cleanText(fragment) {
  return fragment
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replace(/\s+/g, " ")
    .trim();
}

function tableOfContents(body) {
  const headings = [];
  for (const match of body.matchAll(/<(h2|h3) id="([^"]+)">([\s\S]*?)<\/\1>/g)) {
    headings.push({ level: match[1], id: match[2], label: cleanText(match[3]) });
  }
  return headings;
}

function navigation(current) {
  return groups
    .map(
      (group) => `<section class="nav-group"><h2>${escapeHtml(group.title)}</h2><ul>${group.pages
        .map(([slug, label]) => `<li><a href="${route(slug)}"${slug === current ? ' aria-current="page"' : ""}>${escapeHtml(label)}</a></li>`)
        .join("")}</ul></section>`,
    )
    .join("");
}

function render(page, index) {
  const pageBody = polishHeadings(page.body);
  const toc = tableOfContents(pageBody);
  const previous = pages[index - 1];
  const next = pages[index + 1];
  const canonical = `${siteUrl}${page.slug ? `${page.slug}/` : ""}`;
  const pager = `<nav class="page-pager" aria-label="Documentation pages">
    ${previous ? `<a href="${route(previous.slug)}"><span>Previous</span><strong>${escapeHtml(displayPageTitle(previous))}</strong></a>` : "<span></span>"}
    ${next ? `<a href="${route(next.slug)}"><span>Next</span><strong>${escapeHtml(displayPageTitle(next))}</strong></a>` : "<span></span>"}
  </nav>`;
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${escapeHtml(page.description)}">
  <meta name="theme-color" content="#0b0d0c">
  <meta property="og:title" content="${escapeHtml(displayPageTitle(page))} · oplogs">
  <meta property="og:description" content="${escapeHtml(page.description)}">
  <meta property="og:image" content="${siteUrl}assets/oplogs-journal-field.webp">
  <link rel="canonical" href="${canonical}">
  <link rel="icon" href="${basePath}assets/oplogs-mark.png" type="image/png">
  <link rel="stylesheet" href="${basePath}styles.css?v=${assetVersion}">
  <title>${escapeHtml(displayPageTitle(page))} · oplogs</title>
  <script>try{document.documentElement.dataset.theme=localStorage.getItem("oplogs-docs-theme")||"dark"}catch(_error){document.documentElement.dataset.theme="dark"}</script>
</head>
<body data-page="${escapeHtml(page.slug || "overview")}" data-search-index="${basePath}search-index.json?v=${assetVersion}">
  <a class="skip-link" href="#main-content">skip to documentation</a>
  <header class="site-header">
    <a class="brand" href="${basePath}" aria-label="oplogs documentation home"><img src="${basePath}assets/oplogs-mark.png" alt=""><span>oplogs</span><b>docs</b></a>
    <div class="search-wrap">
      <label class="visually-hidden" for="docs-search">search documentation</label>
      <input id="docs-search" type="search" placeholder="Search documentation" autocomplete="off" spellcheck="false" aria-expanded="false" aria-controls="search-results" data-search>
      <kbd aria-hidden="true">/</kbd>
      <div id="search-results" class="search-results" role="listbox" hidden data-search-results></div>
    </div>
    <nav class="header-actions" aria-label="Project links">
      <a href="${sourceUrl}">GitHub</a>
      <button type="button" data-theme-toggle>Light mode</button>
      <button class="menu-button" type="button" aria-expanded="false" aria-controls="documentation-sidebar" data-menu-toggle>Menu</button>
    </nav>
  </header>
  <aside id="documentation-sidebar" class="sidebar" aria-label="Documentation navigation">${navigation(page.slug)}</aside>
  <button class="sidebar-backdrop" type="button" aria-label="Close documentation navigation" data-sidebar-backdrop></button>
  <main class="page-layout" id="main-content">
    <div class="content-grid">
      <article class="article">${pageBody}${pager}</article>
      <aside class="toc" aria-label="On this page">
        <strong>On this page</strong>
        <ul>${toc.map((item) => `<li><a href="#${item.id}" data-level="${item.level.slice(1)}">${escapeHtml(item.label)}</a></li>`).join("")}</ul>
      </aside>
    </div>
  </main>
  <script src="${basePath}runtime.js?v=${assetVersion}" defer></script>
</body>
</html>`;
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(path.join(outputRoot, "assets"), { recursive: true });
await mkdir(path.join(outputRoot, "fonts"), { recursive: true });
await cp(path.join(sourceRoot, "assets"), path.join(outputRoot, "assets"), { recursive: true });
await cp(path.join(fontRoot, "Geist-Variable.woff2"), path.join(outputRoot, "fonts", "Geist-Variable.woff2"));
await cp(path.join(fontRoot, "GeistMono-Variable.woff2"), path.join(outputRoot, "fonts", "GeistMono-Variable.woff2"));
await cp(path.join(repositoryRoot, "web", "public", "fonts", "Geist-OFL.txt"), path.join(outputRoot, "fonts", "Geist-OFL.txt"));
await writeFile(path.join(outputRoot, "styles.css"), stylesSource);
await writeFile(path.join(outputRoot, "runtime.js"), runtimeSource);

for (const [index, page] of pages.entries()) {
  const destination = page.slug ? path.join(outputRoot, page.slug) : outputRoot;
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, "index.html"), render(page, index));
}

await writeFile(
  path.join(outputRoot, "search-index.json"),
  JSON.stringify(
    pages.map((page) => ({
      title: displayPageTitle(page),
      url: route(page.slug),
      description: page.description,
      headings: tableOfContents(polishHeadings(page.body)).map((item) => item.label),
      text: cleanText(polishHeadings(page.body)),
    })),
  ),
);
await writeFile(path.join(outputRoot, ".nojekyll"), "");
await writeFile(
  path.join(outputRoot, "404.html"),
  `<!doctype html><meta charset="utf-8"><title>oplogs docs</title><script>location.replace(${JSON.stringify(basePath)})</script><a href="${basePath}">open oplogs documentation</a>`,
);
await writeFile(
  path.join(outputRoot, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages.map((page) => `<url><loc>${siteUrl}${page.slug ? `${page.slug}/` : ""}</loc></url>`).join("")}</urlset>`,
);

console.log(`built ${pages.length} pages at ${outputRoot} for ${basePath}`);
