"""Self-contained local report rendering and PDF export."""

from __future__ import annotations

import html
import json
import shutil
import subprocess
from pathlib import Path
from typing import Any


def render_report(report: dict[str, Any], destination: str | Path) -> Path:
    target = Path(destination).expanduser().resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    blocks = "\n".join(_render_block(block) for block in report.get("blocks", []))
    document = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>{html.escape(report.get("title", "oplogs report"))}</title>
<style>
@page{{size:A4;margin:18mm 15mm}}
:root{{color-scheme:light;--ink:#151816;--quiet:#667069;--line:#dfe6e1;--green:#215c3a}}
*{{box-sizing:border-box}}body{{margin:0;color:var(--ink);background:#fff;font:16px/1.6 system-ui,sans-serif}}
main{{max-width:920px;margin:0 auto;padding:72px 48px 120px}}header{{margin-bottom:64px}}
h1{{font-size:42px;letter-spacing:-.035em;margin:0 0 8px}}h2{{margin:48px 0 12px;font-size:24px}}
p{{max-width:72ch}}pre,table,.metric{{border:1px solid var(--line);border-radius:8px;padding:18px;background:#fbfdfb}}
table{{width:100%;border-collapse:collapse}}th,td{{padding:10px;text-align:left;border-bottom:1px solid var(--line)}}
.metric strong{{font-size:34px;display:block}}.quiet{{color:var(--quiet)}}img,video{{max-width:100%;height:auto;border-radius:8px}}
@media print{{main{{max-width:none;padding:0}}header{{margin-bottom:36px}}}}
</style></head><body><main><header><div class="quiet">oplogs local report</div>
<h1>{html.escape(report.get("title", "untitled report"))}</h1></header>{blocks}</main></body></html>"""
    target.write_text(document, encoding="utf-8")
    return target


def _render_block(block: dict[str, Any]) -> str:
    kind = block.get("type", "text")
    if kind == "heading":
        return f"<h2>{html.escape(str(block.get('text', '')))}</h2>"
    if kind in {"text", "markdown"}:
        paragraphs = "".join(
            f"<p>{html.escape(line)}</p>" for line in str(block.get("text", "")).split("\n\n")
        )
        return paragraphs
    if kind == "metric":
        return f"<div class='metric'><span class='quiet'>{html.escape(str(block.get('label', 'metric')))}</span><strong>{html.escape(str(block.get('value', '-')))}</strong></div>"
    if kind == "table":
        rows = block.get("rows", [])
        columns = block.get("columns") or sorted({key for row in rows for key in row})
        head = "".join(f"<th>{html.escape(str(column))}</th>" for column in columns)
        body = "".join(
            "<tr>"
            + "".join(f"<td>{html.escape(str(row.get(column, '')))}</td>" for column in columns)
            + "</tr>"
            for row in rows
        )
        return f"<table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>"
    if kind == "media" and block.get("src"):
        source = html.escape(str(block["src"]), quote=True)
        return f"<figure><img src='{source}' alt='{html.escape(str(block.get('alt', 'experiment output')), quote=True)}'></figure>"
    return f"<pre>{html.escape(json.dumps(block, indent=2, default=str))}</pre>"


def export_pdf(html_path: str | Path, destination: str | Path) -> Path:
    source = Path(html_path).expanduser().resolve()
    target = Path(destination).expanduser().resolve()
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        executable = next(
            (
                value
                for value in (
                    shutil.which("google-chrome"),
                    shutil.which("chromium"),
                    shutil.which("chromium-browser"),
                )
                if value
            ),
            None,
        )
        if not executable:
            raise RuntimeError(
                "PDF export requires a system Chrome/Chromium or `pip install 'oplogs[reports]'`"
            ) from None
        subprocess.run(
            [
                executable,
                "--headless=new",
                "--disable-gpu",
                "--no-sandbox",
                "--no-pdf-header-footer",
                f"--print-to-pdf={target}",
                source.as_uri(),
            ],
            check=True,
            timeout=60,
            capture_output=True,
        )
    else:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            page = browser.new_page()
            page.goto(source.as_uri(), wait_until="domcontentloaded")
            page.pdf(
                path=str(target),
                format="A4",
                print_background=True,
                margin={"top": "18mm", "bottom": "18mm", "left": "15mm", "right": "15mm"},
            )
            browser.close()
    return target
