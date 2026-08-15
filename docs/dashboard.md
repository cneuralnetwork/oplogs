# Inspect runs

The dashboard ships in the Python wheel and reads the localhost API and event stream.
There is no hosted dashboard service.

## Open a run

```bash
oplogs open
oplogs open RUN_ID
```

Project filters and search narrow the run table. A run page keeps state, summary,
configuration, source, and machine identity together.

## Inspect retained evidence

| View | Evidence |
| --- | --- |
| Overview | State, duration, key metrics, host, accelerator, and recent events |
| Charts | Downsampled metric histories |
| Samples | Images, audio, video, text, JSON, tables, and histograms |
| Console | Standard output, errors, and retained exceptions |
| Traces | Nested LLM, tool, and agent spans |
| Artifacts | Digests, aliases, metadata, size, and producer identity |
| System | CPU, memory, process, and accelerator histories |

Metric queries use endpoint-preserving SQL downsampling per series. The browser does
not load every indexed point to draw a chart.

## Export a report

```bash
oplogs report-export REPORT_ID report.html
oplogs report-export REPORT_ID report.pdf --pdf
```

HTML exports are self-contained. PDF export requires the reports extra or a compatible
Chrome or Chromium executable.
