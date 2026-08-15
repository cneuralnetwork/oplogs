# oplogs documentation

The Markdown files in this directory are the authoritative source for the public
guides. `docs-site/build.mjs` renders them and appends source-derived Python API and
command-line reference pages.

Build and validate the site from the repository root:

```bash
node docs-site/build.mjs
node docs-site/check.mjs
```

Set `OPLOGS_BASE_PATH`, `OPLOGS_SITE_URL`, and `OPLOGS_SOURCE_URL` when building for a
different deployment path. The GitHub Pages mirror contains generated output only.
