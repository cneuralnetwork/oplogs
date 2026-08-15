import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

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

if (htmlFiles.length !== 15) failures.push(`expected 15 html pages, found ${htmlFiles.length}`);
if (index.length !== 15) failures.push(`expected 15 search records, found ${index.length}`);

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
  if (/\b(?:OPLOGS|OpLogs|OPLogs)\b/.test(html.replaceAll("OPLOGS_HOME", ""))) {
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

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`checked ${htmlFiles.length} pages, ${index.length} search records, and all local links`);
}
