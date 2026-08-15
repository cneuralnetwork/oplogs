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
const htmlFiles = files.filter((file) => file.endsWith(".html") && !file.endsWith("404.html"));
const index = JSON.parse(await readFile(path.join(siteRoot, "search-index.json"), "utf8"));
const expectedPageCount = 15 + 1 + apiSymbols.length + cliCommands.length;

if (htmlFiles.length !== expectedPageCount) {
  failures.push(`expected ${expectedPageCount} html pages, found ${htmlFiles.length}`);
}
if (index.length !== expectedPageCount) {
  failures.push(`expected ${expectedPageCount} search records, found ${index.length}`);
}

function targetPath(rawUrl) {
  const url = new URL(rawUrl, `https://cneuralnetwork.github.io${projectBase}`);
  if (url.origin !== "https://cneuralnetwork.github.io") return null;
  if (!url.pathname.startsWith(projectBase)) return `outside project base: ${url.pathname}`;
  const relative = url.pathname.slice(projectBase.length);
  if (!relative || relative.endsWith("/")) return path.join(siteRoot, relative, "index.html");
  return path.join(siteRoot, relative);
}

for (const file of htmlFiles) {
  const html = await readFile(file, "utf8");
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
  "oplogs-journal-field.webp",
  "data-journal-kind=\"metric\"",
  "data-search",
  "data-theme-toggle",
  "data-menu-toggle",
]) {
  if (!home.includes(required)) failures.push(`overview: missing ${required}`);
}

const apiIndex = await readFile(path.join(siteRoot, "reference", "api", "index.html"), "utf8");
const apiEntries = [...apiIndex.matchAll(/class="reference-entry"/g)].length;
if (apiEntries !== apiSymbols.length) {
  failures.push(`api directory: expected ${apiSymbols.length} entries, found ${apiEntries}`);
}

const cliIndex = await readFile(path.join(siteRoot, "reference", "cli", "index.html"), "utf8");
const cliEntries = [...cliIndex.matchAll(/class="reference-entry"/g)].length;
if (cliEntries !== cliCommands.length) {
  failures.push(`cli directory: expected ${cliCommands.length} entries, found ${cliEntries}`);
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
  if (!documentedCommands.has(name)) failures.push(`cli directory: missing command ${name}`);
}
for (const name of documentedCommands) {
  if (!implementedCommands.includes(name)) failures.push(`cli directory: unknown command ${name}`);
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`checked ${htmlFiles.length} pages, ${index.length} search records, and all local links`);
}
