# Media and artifacts

Rich values stay attached to the run and step that produced them. Files are stored by
SHA-256, so repeated bytes are not duplicated.

## Log images

```python
run.log({
    "samples": oplogs.Image(
        "outputs/sample-grid.png",
        caption="16 held-out generations at step 400",
    )
}, step=400)
```

`oplogs.Image` accepts a path, Pillow image, or array when Pillow and NumPy are
installed.

## Log audio and video

```python
run.log({
    "speech": oplogs.Audio("sample.wav", caption="decoded response"),
    "rollout": oplogs.Video("episode.mp4", caption="best episode"),
})
```

The dashboard uses the retained MIME type to render native playback controls.

## Log histograms

```python
run.log({
    "confidence": oplogs.Histogram(confidences, bins=20)
})
```

## Retain versioned artifacts

```python
run.log({
    "checkpoint": oplogs.Artifact(
        "model.pt",
        artifact_type="model",
        aliases=["latest", "candidate"],
        metadata={"validation_accuracy": 0.947},
    )
})
```

Aliases are local registry pointers. The artifact record retains its digest, size,
type, metadata, and producing run.
