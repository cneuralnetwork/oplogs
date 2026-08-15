# Architecture

oplogs uses two processes and one local data root.

```text
training process
  Run.log -> normalize -> redact -> seal -> background queue
      -> localhost capability-token API
          -> append-only checksummed events.jsonl
          -> SQLite query index
          -> SHA-256 content-addressed blobs

browser
  compiled dashboard -> read-only localhost API and event stream
```

## Authority and recovery

Each run owns a manifest, source snapshot, and append-only event journal. SQLite indexes
runs, events, metrics, traces, summaries, and artifacts for queries. Run manifests and
checksummed journals can recreate those indexes after the SQLite file is lost.

Reports, sweep controller records, registry aliases, and alert definitions originate in
SQLite. Include the complete data root in normal backups.

## Write path

`Run.log` places sealed events on a bounded queue. The sender posts up to 128 events at
once. The daemon converts file descriptors into content-addressed artifact records,
syncs one journal append, and indexes the batch in one SQLite transaction.

If the daemon is unavailable, the SDK spools events beside the run and replays them when
a sender reconnects.

## Security boundary

- The daemon binds to `127.0.0.1` and rejects non-loopback clients.
- Mutating requests require a random capability token stored with mode `0600`.
- The dashboard is same-origin and exposes no permissive CORS policy.
- Secret-shaped values are redacted before persistence.

This is a single-user workstation boundary, not multi-tenant authentication. Local
processes can access read endpoints.

## Scale boundary

oplogs targets a high-throughput workstation store, not a distributed database. Metric
charts use bounded per-series downsampling, and identical artifact bytes share one
blob.
