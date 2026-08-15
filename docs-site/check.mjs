import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { apiSymbols, cliCommands } from "./reference-data.mjs";

const siteRoot = path.resolve(process.argv[2] || "docs-site/_site");
const projectBase = `/${(process.env.OPLOGS_BASE_PATH || "/oplogs/").replace(/^\/+|\/+$/g, "")}/`;
const failures = [];

async function filesBelow(directory) {
  const values = [];
  for (const name of await readdir(directory)) {
    const entry = path.join(directory, name);
    if ((await stat(entry)).isDirectory()) values.push(...(await filesBelow(entry)));
    else values.push(entry);
  }
  return values;
}

const files = await filesBelow(siteRoot);
const allHtmlFiles = files.filter((file) => file.endsWith(".html") && !file.endsWith("404.html"));
const htmlWithSource = await Promise.all(
  allHtmlFiles.map(async (file) => ({ file, html: await readFile(file, "utf8") })),
);
const redirectFiles = htmlWithSource.filter(({ html }) =>
  html.includes('name="oplogs-docs-redirect"'),
);
const contentFiles = htmlWithSource.filter(({ html }) =>
  !html.includes('name="oplogs-docs-redirect"'),
);
const index = JSON.parse(await readFile(path.join(siteRoot, "search-index.json"), "utf8"));
const stylesheet = await readFile(path.join(siteRoot, "styles.css"), "utf8");
const expectedPageCount = 14 + apiSymbols.length;
const expectedRedirectCount = 2 + cliCommands.length;

if (contentFiles.length !== expectedPageCount) {
  failures.push(`expected ${expectedPageCount} content pages, found ${contentFiles.length}`);
}
if (redirectFiles.length !== expectedRedirectCount) {
  failures.push(`expected ${expectedRedirectCount} redirects, found ${redirectFiles.length}`);
}
if (index.length !== expectedPageCount) {
  failures.push(`expected ${expectedPageCount} search records, found ${index.length}`);
}

for (const match of stylesheet.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
  const value = match[1].split("?")[0];
  if (/^(?:data:|https?:)/.test(value)) continue;
  const target = path.resolve(siteRoot, value);
  if (!target.startsWith(`${siteRoot}${path.sep}`)) {
    failures.push(`styles.css: asset escapes site root ${value}`);
    continue;
  }
  try {
    await stat(target);
  } catch {
    failures.push(`styles.css: missing asset ${value}`);
  }
}

function targetPath(rawUrl) {
  const url = new URL(rawUrl, `https://cneuralnetwork.github.io${projectBase}`);
  if (url.origin !== "https://cneuralnetwork.github.io") return null;
  if (!url.pathname.startsWith(projectBase)) return `outside project base: ${url.pathname}`;
  const relative = url.pathname.slice(projectBase.length);
  if (!relative || relative.endsWith("/")) return path.join(siteRoot, relative, "index.html");
  return path.join(siteRoot, relative);
}

for (const { file, html } of contentFiles) {
  const relative = path.relative(siteRoot, file);
  if (!html.includes('<html lang="en"')) failures.push(`${relative}: missing language`);
  if (!html.includes("<main")) failures.push(`${relative}: missing main landmark`);
  if (!html.includes('class="sidebar"')) failures.push(`${relative}: missing documentation navigation`);
  if (!html.includes('class="toc"')) failures.push(`${relative}: missing page table of contents`);
  if (/\b(?:OPLOGS|OpLogs|OPLogs)\b/.test(html.replace(/OPLOGS_[A-Z0-9_]+/g, ""))) {
    failures.push(`${relative}: uppercase oplogs branding`);
  }

  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  if (new Set(ids).size !== ids.length) failures.push(`${relative}: duplicate id`);

  for (const match of html.matchAll(/<(?:a|link)[^>]+href="([^"]+)"/g)) {
    const value = match[1];
    if (value.startsWith("#")) {
      if (!ids.includes(value.slice(1))) failures.push(`${relative}: missing fragment target ${value}`);
      continue;
    }
    const target = targetPath(value);
    if (!target || target.startsWith("outside project base:")) continue;
    try {
      await stat(target);
    } catch {
      failures.push(`${relative}: missing link target ${value}`);
    }
  }

  for (const match of html.matchAll(/<(?:img|script)[^>]+src="([^"]+)"/g)) {
    const target = targetPath(match[1]);
    if (!target || target.startsWith("outside project base:")) continue;
    try {
      await stat(target);
    } catch {
      failures.push(`${relative}: missing asset ${match[1]}`);
    }
  }
}

const home = await readFile(path.join(siteRoot, "index.html"), "utf8");
for (const required of [
  "data-search",
  "data-theme-toggle",
  "data-menu-toggle",
  "data-copy-markdown",
  'href="https://github.com/cneuralnetwork/oplogs">GitHub</a>',
  'href="https://github.com/cneuralnetwork/oplogs/blob/main/docs/overview.md">View Markdown source</a>',
]) {
  if (!home.includes(required)) failures.push(`overview: missing ${required}`);
}

const renderedHtml = contentFiles.map(({ html }) => html);
for (const removed of [
  "data-copy-link",
  "data-journal-lab",
  "reference-count",
  'href="/reference/sdk/"',
  'href="/benchmark/"',
]) {
  if (renderedHtml.some((html) => html.includes(removed))) {
    failures.push(`documentation retained removed element ${removed}`);
  }
}
if (renderedHtml.some((html) => html.includes("oplogs-journal-field.webp"))) {
  failures.push("documentation retained the removed decorative journal artwork");
}

const authoredSources = [
  "overview.md",
  "quickstart.md",
  "logging.md",
  "media.md",
  "frameworks.md",
  "tracing.md",
  "dashboard.md",
  "sweeps.md",
  "migration.md",
  "troubleshooting.md",
  "cnn-example.md",
  "architecture.md",
];
for (const source of authoredSources) {
  const sourceLink = `https://github.com/cneuralnetwork/oplogs/blob/main/docs/${source}`;
  const authoredHtml = contentFiles.find(({ html }) => html.includes(`href="${sourceLink}"`))?.html;
  if (
    !authoredHtml ||
    !authoredHtml.includes('class="page-tools"') ||
    !authoredHtml.includes("data-copy-markdown")
  ) {
    failures.push(`docs/${source}: missing Markdown source tools`);
  }
}
for (const source of authoredSources) {
  const raw = path.join(siteRoot, "raw", "docs", source);
  try {
    const markdown = await readFile(raw, "utf8");
    if (!markdown.startsWith("# ")) failures.push(`raw docs/${source}: missing title`);
  } catch {
    failures.push(`raw docs/${source}: missing Markdown source`);
  }
}

const apiIndex = await readFile(path.join(siteRoot, "reference", "api", "index.html"), "utf8");
const apiEntries = [...apiIndex.matchAll(/class="reference-entry"/g)].length;
if (apiEntries !== apiSymbols.length) {
  failures.push(`api directory: expected ${apiSymbols.length} entries, found ${apiEntries}`);
}
if (!apiIndex.includes('href="https://github.com/cneuralnetwork/oplogs/blob/main/src/oplogs/__init__.py">Source on GitHub</a>')) {
  failures.push("api directory: missing GitHub source link");
}

for (const item of apiSymbols) {
  const page = await readFile(path.join(siteRoot, "reference", "api", item.slug, "index.html"), "utf8");
  const expected = `https://github.com/cneuralnetwork/oplogs/blob/main/${item.source}`;
  if (!page.includes(`href="${expected}">Source on GitHub</a>`)) {
    failures.push(`api ${item.name}: missing GitHub source link ${expected}`);
  }
}

const cliIndex = await readFile(path.join(siteRoot, "reference", "cli", "index.html"), "utf8");
for (const item of cliCommands) {
  if (!cliIndex.includes(`id="${item.slug}"`)) {
    failures.push(`command line: missing anchor for ${item.name}`);
  }
  if (!cliIndex.includes(escapeForHtml(item.usage.trim()))) {
    failures.push(`command line: missing usage for ${item.name}`);
  }
  const redirect = await readFile(
    path.join(siteRoot, "reference", "cli", item.slug, "index.html"),
    "utf8",
  );
  if (!redirect.includes(`${projectBase}reference/cli/#${item.slug}`)) {
    failures.push(`command line: stale route does not redirect to ${item.slug}`);
  }
}
if (!cliIndex.includes('href="https://github.com/cneuralnetwork/oplogs/blob/main/src/oplogs/cli.py">Source on GitHub</a>')) {
  failures.push("command line: missing GitHub source link");
}

const sdkRedirect = await readFile(path.join(siteRoot, "reference", "sdk", "index.html"), "utf8");
if (!sdkRedirect.includes(`${projectBase}reference/api/`)) {
  failures.push("SDK overview: stale route does not redirect to the Python API");
}
const benchmarkRedirect = await readFile(path.join(siteRoot, "benchmark", "index.html"), "utf8");
if (!benchmarkRedirect.includes("https://github.com/cneuralnetwork/oplogs/blob/main/docs/benchmark.md")) {
  failures.push("benchmark: stale route does not redirect to its repository source");
}

const packageSource = await readFile(path.resolve("src/oplogs/__init__.py"), "utf8");
const exportBlock = packageSource.match(/__all__\s*=\s*\[([\s\S]*?)\]/)?.[1] || "";
const packageExports = [...exportBlock.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
const documentedNames = new Set(
  apiSymbols
    .filter((item) => item.name.startsWith("oplogs."))
    .map((item) => item.name.slice("oplogs.".length)),
);
for (const name of packageExports) {
  if (!documentedNames.has(name)) failures.push(`api directory: missing package export ${name}`);
}

for (const method of ["log", "watch", "finish"]) {
  if (!apiSymbols.some((item) => item.name === `Run.${method}`)) {
    failures.push(`api directory: missing public Run.${method} method`);
  }
}

const cliSource = await readFile(path.resolve("src/oplogs/cli.py"), "utf8");
const implementedCommands = [
  ...cliSource.matchAll(/@app\.command\((?:"([^"]+)")?\)\s*\ndef ([a-z_]+)\(/g),
].map((match) => match[1] || match[2].replaceAll("_", "-"));
const documentedCommands = new Set(cliCommands.map((item) => item.slug));
for (const name of implementedCommands) {
  if (!documentedCommands.has(name)) failures.push(`command line: missing command ${name}`);
}
for (const name of documentedCommands) {
  if (!implementedCommands.includes(name)) failures.push(`command line: unknown command ${name}`);
}

function escapeForHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `checked ${contentFiles.length} pages, ${redirectFiles.length} redirects, ${index.length} search records, and all local links`,
  );
}
