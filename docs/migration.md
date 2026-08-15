# Migrate from W&B

Import a portable W&B export or ordinary run directory without running a W&B service.
The result is an ordinary local oplogs run.

## Import a run

```bash
oplogs import-wandb ./wandb/run-20260815 --project migrated
```

The importer preserves available configuration, numeric history, summary values, tags,
and files under the run's `files` tree. Recognized media appears in samples and
artifacts. The source directory is not modified.

> [!NOTE] Portable boundary
> Provider-specific workspace objects that are absent from the export cannot be
> reconstructed. The importer reports the evidence it created from local files.
