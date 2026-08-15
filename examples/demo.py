"""Generate one populated local run for dashboard evaluation."""

from __future__ import annotations

import math
import time
from pathlib import Path

import oplogs


@oplogs.trace(name="demo.evaluate")
def evaluate(step: int) -> dict[str, float]:
    return {"score": 1 - math.exp(-step / 40)}


def main() -> None:
    with oplogs.init(
        project="oplogs-demo",
        name="local-observability",
        config={"model": "small-transformer", "learning_rate": 0.0003, "batch_size": 64},
        tags=["demo", "local"],
    ) as run:
        for step in range(200):
            run.log(
                {
                    "train/loss": math.exp(-step / 52) + 0.015 * math.sin(step / 4),
                    "validation/loss": math.exp(-step / 61) + 0.03,
                    "tokens/second": 8500 + 450 * math.sin(step / 9),
                },
                step=step,
            )
        result = evaluate(200)
        run.log(
            {
                "summary": "The retained local demo completed successfully.",
                "evaluation": oplogs.Json({"held_out": result, "samples": 2048}),
                "predictions": oplogs.Table(
                    [
                        {"input": "alpha", "prediction": "A", "confidence": 0.94},
                        {"input": "beta", "prediction": "B", "confidence": 0.89},
                    ]
                ),
                "confidence": oplogs.Histogram([index / 100 for index in range(101)], bins=20),
                "generated sample": oplogs.Image(
                    Path(__file__).with_name("sample.svg"),
                    caption="A generated sample retained by content digest",
                ),
                "predictions.csv": oplogs.Artifact(
                    Path(__file__).with_name("predictions.csv"),
                    artifact_type="dataset",
                    aliases=["demo"],
                ),
            },
            step=200,
        )
        print("demo metrics, rich samples, files, and trace recorded")
        time.sleep(2.2)
        print("final console line without a newline", end="")


if __name__ == "__main__":
    main()
