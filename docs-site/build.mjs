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

function headingId(value) {
  return value
    .toLocaleLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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
  return page.slug.startsWith("reference/api/") ? page.title : headingCase(page.title);
}

function code(language, source, label = language || "text") {
  const normalizedLanguage = language || "text";
  return `<div class="code-block" data-code-block>
    <div class="code-meta"><span>${escapeHtml(label || normalizedLanguage)}</span><button type="button" data-copy-code>copy</button></div>
    <pre><code class="language-${escapeHtml(normalizedLanguage)}">${escapeHtml(source.trim())}</code></pre>
  </div>`;
}

function note(title, body, kind = "note") {
  return `<aside class="note" data-kind="${escapeHtml(kind)}"><strong>${escapeHtml(title)}</strong><div>${body}</div></aside>`;
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

const authoredPageSpecs = [
  {
    slug: "",
    title: "overview",
    description: "Local-first experiment tracking for metrics, media, traces, artifacts, and system evidence.",
    source: "docs/overview.md",
  },
  {
    slug: "getting-started",
    title: "quickstart",
    description: "Install oplogs, record a run, and open the localhost dashboard.",
    source: "docs/quickstart.md",
  },
  {
    slug: "guides/logging",
    title: "metrics and values",
    description: "Log scalars, text, JSON, tables, and CSV files with Run.log.",
    source: "docs/logging.md",
  },
  {
    slug: "guides/media",
    title: "media and artifacts",
    description: "Retain images, audio, video, histograms, files, and versioned artifacts.",
    source: "docs/media.md",
  },
  {
    slug: "guides/frameworks",
    title: "framework autologging",
    description: "Understand framework capture and explicitly watch a PyTorch model.",
    source: "docs/frameworks.md",
  },
  {
    slug: "guides/tracing",
    title: "LLM and agent traces",
    description: "Trace model calls, tools, retrieval, and agent operations as one causal tree.",
    source: "docs/tracing.md",
  },
  {
    slug: "guides/dashboard",
    title: "inspect runs",
    description: "Read retained experiment evidence in the local dashboard and export reports.",
    source: "docs/dashboard.md",
  },
  {
    slug: "guides/sweeps",
    title: "run sweeps",
    description: "Launch isolated local trials with grid, random, or Bayesian search.",
    source: "docs/sweeps.md",
  },
  {
    slug: "guides/migration",
    title: "migrate from W&B",
    description: "Import a portable W&B run directory into the local oplogs store.",
    source: "docs/migration.md",
  },
  {
    slug: "troubleshooting",
    title: "troubleshooting",
    description: "Diagnose the daemon, local store, event spool, and query indexes.",
    source: "docs/troubleshooting.md",
  },
  {
    slug: "guides/cnn",
    title: "CNN example",
    description: "Run the checked-in CNN example and inspect its retained training evidence.",
    source: "docs/cnn-example.md",
  },
  {
    slug: "architecture",
    title: "architecture",
    description: "The write path, recovery model, security boundary, and scale boundary.",
    source: "docs/architecture.md",
  },
];

const routeByMarkdownName = new Map(
  authoredPageSpecs.map((page) => [path.basename(page.source), page.slug]),
);

function markdownHref(value) {
  const [pathname, hash = ""] = value.split("#", 2);
  if (!pathname.endsWith(".md")) return value;
  const slug = routeByMarkdownName.get(path.basename(pathname));
  if (slug === undefined) return githubSource(path.join("docs", pathname));
  return `${route(slug)}${hash ? `#${hash}` : ""}`;
}

function inlineMarkdown(value) {
  const tokens = [];
  const hold = (html) => {
    const marker = `\u0000${tokens.length}\u0000`;
    tokens.push(html);
    return marker;
  };
  let rendered = String(value)
    .replace(/`([^`]+)`/g, (_match, source) => hold(`<code>${escapeHtml(source)}</code>`))
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) =>
      hold(`<a href="${escapeHtml(markdownHref(href))}">${escapeHtml(label)}</a>`),
    );
  rendered = escapeHtml(rendered)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return rendered.replace(/\u0000(\d+)\u0000/g, (_match, index) => tokens[Number(index)]);
}

function markdownTable(lines) {
  const cells = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
  const columns = cells(lines[0]);
  const rows = lines.slice(2).map(cells);
  return `<div class="table-scroll" data-columns="${columns.length}"><table><thead><tr>${columns.map((column) => `<th>${inlineMarkdown(column)}</th>`).join("")}</tr></thead><tbody>${rows
    .map(
      (row) => `<tr>${columns
        .map((column, index) => `<td data-label="${escapeHtml(column)}">${inlineMarkdown(row[index] || "")}</td>`)
        .join("")}</tr>`,
    )
    .join("")}</tbody></table></div>`;
}

function renderMarkdown(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const output = [];
  let paragraph = [];
  let firstParagraph = true;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    output.push(`<p${firstParagraph ? ' class="lead"' : ""}>${inlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph = [];
    firstParagraph = false;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      flushParagraph();
      const language = trimmed.slice(3).trim() || "text";
      const source = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        source.push(lines[index]);
        index += 1;
      }
      output.push(code(language, source.join("\n"), language === "bash" ? "shell" : language));
      continue;
    }

    const callout = trimmed.match(/^> \[!(NOTE|WARNING)\]\s*(.*)$/);
    if (callout) {
      flushParagraph();
      const body = [];
      index += 1;
      while (index < lines.length && lines[index].trim().startsWith(">")) {
        body.push(lines[index].trim().replace(/^>\s?/, ""));
        index += 1;
      }
      index -= 1;
      output.push(
        note(
          callout[2] || (callout[1] === "WARNING" ? "warning" : "note"),
          `<p>${inlineMarkdown(body.join(" "))}</p>`,
          callout[1].toLocaleLowerCase(),
        ),
      );
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      const id = level === 1 ? "" : ` id="${headingId(heading[2])}"`;
      output.push(`<h${level}${id}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    if (
      trimmed.includes("|") &&
      index + 1 < lines.length &&
      /^\s*\|?\s*:?-{3,}/.test(lines[index + 1])
    ) {
      flushParagraph();
      const tableLines = [line, lines[index + 1]];
      index += 2;
      while (index < lines.length && lines[index].trim().includes("|")) {
        tableLines.push(lines[index]);
        index += 1;
      }
      index -= 1;
      output.push(markdownTable(tableLines));
      continue;
    }

    const listItem = trimmed.match(/^([-*]|\d+\.)\s+(.+)$/);
    if (listItem) {
      flushParagraph();
      const ordered = /\d+\./.test(listItem[1]);
      const items = [listItem[2]];
      while (index + 1 < lines.length) {
        const candidate = lines[index + 1].trim().match(/^([-*]|\d+\.)\s+(.+)$/);
        if (!candidate || /\d+\./.test(candidate[1]) !== ordered) break;
        items.push(candidate[2]);
        index += 1;
      }
      const tag = ordered ? "ol" : "ul";
      output.push(`<${tag}>${items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</${tag}>`);
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      continue;
    }
    paragraph.push(trimmed);
  }
  flushParagraph();
  return output.join("\n");
}

const authoredPages = await Promise.all(
  authoredPageSpecs.map(async (page) => ({
    ...page,
    body: renderMarkdown(await readFile(path.join(repositoryRoot, page.source), "utf8")),
  })),
);

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
    source: item.source,
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

function referenceDirectory(items, baseSlug) {
  const grouped = new Map();
  for (const item of items) {
    const group = item.group || "symbols";
    if (!grouped.has(group)) grouped.set(group, []);
    grouped.get(group).push(item);
  }
  return `<div class="reference-directory">${[...grouped.entries()]
    .map(
      ([group, entries]) => `<section class="reference-cluster">
        <h2 id="${headingId(group)}">${escapeHtml(group)}</h2>
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
  title: "API directory",
  description: "Complete symbol-by-symbol reference for the public oplogs Python API.",
  source: "src/oplogs/__init__.py",
  body: `
    <h1>api directory</h1>
    <p class="lead">Every stable package export and public <code>Run</code> operation, with signatures and defaults for version 0.1.0.</p>
    <div class="symbol-meta"><span>${apiSymbols.length} symbols</span><a href="${githubSource("src/oplogs/__init__.py")}">Source on GitHub</a></div>
    ${referenceDirectory(apiSymbols, "reference/api")}
    ${note("version boundary", "<p>Internal storage, daemon, capture, and normalization helpers are not compatibility promises.</p>")}
  `,
};

const cliGroups = [
  ["Dashboard and health", ["open", "doctor", "storage", "stop"]],
  ["Data and recovery", ["rebuild", "export", "import-wandb"]],
  ["Automation", ["sweep", "alert", "report-export"]],
  ["Development", ["server"]],
];
const cliBySlug = new Map(cliCommands.map((item) => [item.slug, item]));

function renderCliCommand(item) {
  const inputs = item.inputs.length
    ? `<h4>Arguments and options</h4>${dataTable(
        ["name", "kind", "default", "description"],
        item.inputs,
      )}`
    : "";
  const sections = item.sections
    .map((section) => {
      const paragraphs = (section.paragraphs || []).map((value) => `<p>${value}</p>`).join("");
      const table = section.table ? dataTable(section.table.columns, section.table.rows) : "";
      const snippet = section.code
        ? code(section.code.language, section.code.source, section.code.label || section.code.language)
        : "";
      return `<h4>${escapeHtml(headingCase(section.title))}</h4>${paragraphs}${table}${snippet}`;
    })
    .join("");
  return `<section class="command-reference" aria-labelledby="${escapeHtml(item.slug)}">
    <h3 id="${escapeHtml(item.slug)}"><code>${escapeHtml(item.name)}</code></h3>
    <p>${escapeHtml(item.summary)}</p>
    ${code("bash", item.usage, "shell")}
    ${inputs}
    ${sections}
  </section>`;
}

const cliIndexPage = {
  slug: "reference/cli",
  title: "command line",
  description: "Task-oriented reference for every oplogs command.",
  source: "src/oplogs/cli.py",
  body: `<h1>command line</h1>
    <p class="lead">Use these commands to open and diagnose the local service, recover data, automate trials, and export retained evidence.</p>
    <div class="symbol-meta"><span>${cliCommands.length} commands</span><a href="${githubSource("src/oplogs/cli.py")}">Source on GitHub</a></div>
    ${cliGroups
      .map(([title, slugs]) => {
        const commands = slugs.map((slug) => cliBySlug.get(slug));
        if (commands.some((item) => !item)) throw new Error(`CLI group references a missing command: ${title}`);
        return `<section class="command-group"><h2 id="${headingId(title)}">${escapeHtml(title)}</h2>${commands.map(renderCliCommand).join("")}</section>`;
      })
      .join("")}`,
};

const groups = [
  {
    title: "Start",
    pages: [
      ["", "Overview"],
      ["getting-started", "Quickstart"],
    ],
  },
  {
    title: "Log data",
    pages: [
      ["guides/logging", "Metrics and values"],
      ["guides/media", "Media and artifacts"],
      ["guides/frameworks", "Framework autologging"],
      ["guides/tracing", "LLM and agent traces"],
    ],
  },
  {
    title: "Operate",
    pages: [
      ["guides/dashboard", "Inspect runs"],
      ["guides/sweeps", "Run sweeps"],
      ["guides/migration", "Migrate from W&B"],
      ["troubleshooting", "Troubleshooting"],
    ],
  },
  {
    title: "Examples",
    pages: [["guides/cnn", "CNN example"]],
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

const authoredBySlug = new Map(authoredPages.map((page) => [page.slug, page]));
const pages = [
  authoredBySlug.get(""),
  authoredBySlug.get("getting-started"),
  authoredBySlug.get("guides/logging"),
  authoredBySlug.get("guides/media"),
  authoredBySlug.get("guides/frameworks"),
  authoredBySlug.get("guides/tracing"),
  authoredBySlug.get("guides/dashboard"),
  authoredBySlug.get("guides/sweeps"),
  authoredBySlug.get("guides/migration"),
  authoredBySlug.get("troubleshooting"),
  authoredBySlug.get("guides/cnn"),
  apiIndexPage,
  ...apiSymbols.map(apiReferencePage),
  cliIndexPage,
  authoredBySlug.get("architecture"),
];

if (pages.some((page) => !page)) throw new Error("documentation page ordering contains a missing page");
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

function pageTools(page) {
  if (!page.source.startsWith("docs/")) return "";
  const copy = `<button type="button" data-copy-markdown="${basePath}raw/${escapeHtml(page.source)}">Copy as Markdown</button>`;
  return `<div class="page-tools"><strong>Source</strong>${copy}<a href="${githubSource(page.source)}">View Markdown source</a></div>`;
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
  <meta property="og:image" content="${siteUrl}assets/oplogs-banner.png">
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
  <aside id="documentation-sidebar" class="sidebar" aria-label="Documentation navigation">${navigation(page.slug)}<button class="sidebar-theme" type="button" data-theme-toggle>Light mode</button></aside>
  <button class="sidebar-backdrop" type="button" aria-label="Close documentation navigation" data-sidebar-backdrop></button>
  <main class="page-layout" id="main-content">
    <div class="content-grid">
      <article class="article">${pageBody}${pager}</article>
      <aside class="toc" aria-label="On this page">
        <strong>On this page</strong>
        <ul>${toc.map((item) => `<li><a href="#${item.id}" data-level="${item.level.slice(1)}">${escapeHtml(item.label)}</a></li>`).join("")}</ul>
        ${pageTools(page)}
      </aside>
    </div>
  </main>
  <script src="${basePath}runtime.js?v=${assetVersion}" defer></script>
</body>
</html>`;
}

function renderRedirect(target) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="oplogs-docs-redirect" content="true"><meta http-equiv="refresh" content="0;url=${escapeHtml(target)}"><meta name="robots" content="noindex"><title>Redirecting · oplogs</title></head><body><script>location.replace(${JSON.stringify(target)})</script><a href="${escapeHtml(target)}">Continue to the current documentation</a></body></html>`;
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(path.join(outputRoot, "assets"), { recursive: true });
await mkdir(path.join(outputRoot, "fonts"), { recursive: true });
await mkdir(path.join(outputRoot, "raw", "docs"), { recursive: true });
await cp(path.join(sourceRoot, "assets", "oplogs-mark.png"), path.join(outputRoot, "assets", "oplogs-mark.png"));
await cp(path.join(repositoryRoot, "assets", "oplogs-banner.png"), path.join(outputRoot, "assets", "oplogs-banner.png"));
await cp(path.join(fontRoot, "Geist-Variable.woff2"), path.join(outputRoot, "fonts", "Geist-Variable.woff2"));
await cp(path.join(fontRoot, "GeistMono-Variable.woff2"), path.join(outputRoot, "fonts", "GeistMono-Variable.woff2"));
await cp(path.join(repositoryRoot, "web", "public", "fonts", "Geist-OFL.txt"), path.join(outputRoot, "fonts", "Geist-OFL.txt"));
await writeFile(path.join(outputRoot, "styles.css"), stylesSource);
await writeFile(path.join(outputRoot, "runtime.js"), runtimeSource);

for (const page of authoredPages) {
  await cp(path.join(repositoryRoot, page.source), path.join(outputRoot, "raw", page.source));
}

for (const [index, page] of pages.entries()) {
  const destination = page.slug ? path.join(outputRoot, page.slug) : outputRoot;
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, "index.html"), render(page, index));
}

const redirects = [
  ["reference/sdk", route("reference/api")],
  ["benchmark", githubSource("docs/benchmark.md")],
  ...cliCommands.map((item) => [`reference/cli/${item.slug}`, `${route("reference/cli")}#${item.slug}`]),
];
for (const [slug, target] of redirects) {
  const destination = path.join(outputRoot, slug);
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, "index.html"), renderRedirect(target));
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

console.log(`built ${pages.length} pages and ${redirects.length} redirects at ${outputRoot} for ${basePath}`);
