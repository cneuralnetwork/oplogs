# Architecture

OPLOGS has two processes and one local data root.

```text
training process
  Run.log -> type normalization -> recursive redaction -> background batch queue
      -> localhost capability-token API
          -> append-only checksummed events.jsonl
          -> SQLite query index
          -> SHA-256 content-addressed blobs

browser
  compiled React dashboard -> read-only localhost API and event stream
```

## Authority and recovery

Each run owns a manifest, a source snapshot, and an append-only event journal. SQLite
indexes runs, events, metrics, traces, artifacts, reports, sweeps, registry entries, and
alerts for fast queries. Run manifests plus checksummed journals can recreate run,
event, metric, trace, summary, and artifact indexes after the SQLite file is lost.

Reports, sweep controller records, registry aliases, and alert definitions originate in
SQLite and should be included in normal directory backups. `oplogs export` copies the
complete data root when no run ID is supplied.

## Write path

The SDK never waits for a network round trip on `Run.log`. It places sealed events on a
bounded queue. The sender posts up to 128 events at once. The daemon transforms file
descriptors into content-addressed artifact records, syncs the batch to one journal,
and indexes the batch in one SQLite transaction. If the daemon is unreachable, the SDK
spools events beside the run and replays them when a sender starts again.

## Security boundary

The server binds to `127.0.0.1`, rejects non-loopback clients, and has no permissive
CORS policy. Every mutating request requires the random token in `daemon.json`, whose
mode is `0600`. Read endpoints are available to local processes. This is an intentional
single-user workstation boundary, not multi-tenant authentication.

## Scale boundary

Canonical data remains append-only JSONL for inspectability. Metric charts use bounded,
endpoint-preserving SQL downsampling per series. Artifacts are never duplicated when
their bytes share a digest. OPLOGS does not currently claim distributed database scale;
the retained benchmark covers the intended high-throughput workstation path.
