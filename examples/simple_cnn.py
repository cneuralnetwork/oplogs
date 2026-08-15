"""Train a real PyTorch CNN and retain the complete run in OPLOGS.

Install the optional demo dependency with:

    uv pip install --python .venv/bin/python torch \
        --index-url https://download.pytorch.org/whl/cpu

The dataset is generated locally so the example works without downloading data.
"""

from __future__ import annotations

import argparse
import struct
import time
import zlib
from pathlib import Path

import torch
from torch import Tensor, nn

import oplogs


class TinyCNN(nn.Module):
    """A two-convolution classifier for 16 x 16 grayscale images."""

    def __init__(self, image_size: int = 16) -> None:
        super().__init__()
        self.features = nn.Sequential(
            nn.Conv2d(1, 8, kernel_size=3, padding=1),
            nn.ReLU(),
            nn.MaxPool2d(2),
            nn.Conv2d(8, 16, kernel_size=3, padding=1),
            nn.ReLU(),
            nn.MaxPool2d(2),
        )
        feature_width = image_size // 4
        self.classifier = nn.Linear(16 * feature_width * feature_width, 2)

    def forward(self, images: Tensor) -> Tensor:
        return self.classifier(self.features(images).flatten(1))


def make_dataset(samples: int, image_size: int, seed: int) -> tuple[Tensor, Tensor]:
    """Create noisy vertical-versus-horizontal stripe images."""
    generator = torch.Generator().manual_seed(seed)
    labels = torch.randint(0, 2, (samples,), generator=generator)
    images = torch.rand((samples, 1, image_size, image_size), generator=generator) * 0.18
    for index, label in enumerate(labels.tolist()):
        offset = int(torch.randint(-3, 4, (1,), generator=generator).item())
        center = image_size // 2 + offset
        if label == 0:
            images[index, 0, 2:-2, center - 1 : center + 1] += 0.82
        else:
            images[index, 0, center - 1 : center + 1, 2:-2] += 0.82
    return images.clamp_(0, 1), labels


@torch.inference_mode()
def evaluate(model: nn.Module, images: Tensor, labels: Tensor) -> dict[str, object]:
    model.eval()
    logits = model(images)
    probabilities = logits.softmax(dim=1)
    predictions = probabilities.argmax(dim=1)
    return {
        "loss": nn.functional.cross_entropy(logits, labels).item(),
        "accuracy": predictions.eq(labels).float().mean().item(),
        "predictions": predictions,
        "confidences": probabilities.max(dim=1).values,
    }


@oplogs.trace(name="cnn.final_summary")
def final_summary(loss: float, accuracy: float, samples: int) -> dict[str, float | int]:
    return {"loss": loss, "accuracy": accuracy, "samples": samples}


def write_grayscale_grid(images: Tensor, destination: Path, columns: int = 4) -> Path:
    """Write a dependency-free grayscale PNG containing the first sample images."""
    images = images.detach().cpu().squeeze(1).clamp(0, 1)
    rows = (len(images) + columns - 1) // columns
    image_height, image_width = images.shape[-2:]
    canvas_width = columns * image_width
    canvas_height = rows * image_height
    raw = bytearray()
    for canvas_y in range(canvas_height):
        raw.append(0)
        source_row = canvas_y % image_height
        image_row = canvas_y // image_height
        for column in range(columns):
            image_index = image_row * columns + column
            if image_index >= len(images):
                raw.extend(bytes(image_width))
                continue
            pixels = images[image_index, source_row].mul(255).to(torch.uint8).tolist()
            raw.extend(pixels)

    def chunk(kind: bytes, payload: bytes) -> bytes:
        checksum = zlib.crc32(kind + payload) & 0xFFFFFFFF
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", checksum)

    header = struct.pack(">IIBBBBB", canvas_width, canvas_height, 8, 0, 0, 0, 0)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(bytes(raw), level=9))
        + chunk(b"IEND", b"")
    )
    return destination


def train(args: argparse.Namespace) -> dict[str, object]:
    torch.manual_seed(args.seed)
    torch.set_num_threads(args.threads)
    train_images, train_labels = make_dataset(args.train_samples, args.image_size, args.seed)
    validation_images, validation_labels = make_dataset(
        args.validation_samples, args.image_size, args.seed + 1
    )
    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    with oplogs.init(
        project="cnn-demo",
        name="tiny-pytorch-cnn",
        config={
            "architecture": "Conv2d(1,8) -> Conv2d(8,16) -> Linear(256,2)",
            "dataset": "synthetic-stripes",
            "device": "cpu",
            "epochs": args.epochs,
            "batch_size": args.batch_size,
            "learning_rate": args.learning_rate,
            "train_samples": args.train_samples,
            "validation_samples": args.validation_samples,
            "seed": args.seed,
        },
        tags=["cnn", "pytorch", "real-training", "offline-data"],
        open=False,
    ) as run:
        model = TinyCNN(args.image_size)
        run.watch(model, gradients=True, every=32)
        optimizer = torch.optim.Adam(model.parameters(), lr=args.learning_rate)
        criterion = nn.CrossEntropyLoss()
        parameter_count = sum(parameter.numel() for parameter in model.parameters())
        started = time.perf_counter()

        print(
            f"training TinyCNN with {parameter_count:,} parameters on "
            f"{args.train_samples} generated images"
        )
        for epoch in range(args.epochs):
            epoch_started = time.perf_counter()
            model.train()
            permutation = torch.randperm(args.train_samples)
            loss_total = 0.0
            correct = 0
            for start in range(0, args.train_samples, args.batch_size):
                indexes = permutation[start : start + args.batch_size]
                images = train_images[indexes]
                labels = train_labels[indexes]
                optimizer.zero_grad(set_to_none=True)
                logits = model(images)
                loss = criterion(logits, labels)
                loss.backward()
                optimizer.step()
                loss_total += loss.item() * len(indexes)
                correct += logits.argmax(dim=1).eq(labels).sum().item()

            validation = evaluate(model, validation_images, validation_labels)
            epoch_metrics = {
                "train/loss": loss_total / args.train_samples,
                "train/accuracy": correct / args.train_samples,
                "validation/loss": float(validation["loss"]),
                "validation/accuracy": float(validation["accuracy"]),
                "epoch/seconds": time.perf_counter() - epoch_started,
            }
            run.log(epoch_metrics, step=epoch + 1)
            print(
                f"epoch {epoch + 1:02d}/{args.epochs}: "
                f"loss={epoch_metrics['train/loss']:.4f} "
                f"val_accuracy={epoch_metrics['validation/accuracy']:.3f}"
            )

        final = evaluate(model, validation_images, validation_labels)
        summary = final_summary(
            float(final["loss"]), float(final["accuracy"]), args.validation_samples
        )
        sample_path = write_grayscale_grid(validation_images[:16], output_dir / "samples.png")
        checkpoint_path = output_dir / "tiny_cnn.pt"
        torch.save(
            {
                "model_state_dict": model.state_dict(),
                "image_size": args.image_size,
                "classes": ["vertical", "horizontal"],
            },
            checkpoint_path,
        )
        predictions = final["predictions"]
        confidences = final["confidences"]
        rows = [
            {
                "sample": index,
                "target": ["vertical", "horizontal"][validation_labels[index].item()],
                "prediction": ["vertical", "horizontal"][predictions[index].item()],
                "confidence": round(confidences[index].item(), 5),
            }
            for index in range(16)
        ]
        run.log(
            {
                "final/evaluation": oplogs.Json(summary),
                "final/predictions": oplogs.Table(rows),
                "final/confidence_distribution": oplogs.Histogram(confidences.tolist(), bins=20),
                "final/sample_images": oplogs.Image(
                    sample_path,
                    caption="16 held-out stripe images used by the final CNN evaluation",
                ),
                "model/checkpoint": oplogs.Artifact(
                    checkpoint_path,
                    mime_type="application/octet-stream",
                    artifact_type="model",
                    aliases=["latest", "cnn-proof"],
                    metadata={
                        "framework": "pytorch",
                        "parameters": parameter_count,
                        "validation_accuracy": float(final["accuracy"]),
                    },
                ),
                "training/seconds": time.perf_counter() - started,
                "training/parameter_count": parameter_count,
            },
            step=args.epochs,
        )
        result = {
            "run_id": run.id,
            "run_url": run.url,
            "validation_accuracy": float(final["accuracy"]),
            "validation_loss": float(final["loss"]),
            "checkpoint": str(checkpoint_path),
        }
        print(f"completed: validation_accuracy={result['validation_accuracy']:.3f}")
        print(f"OPLOGS run: {run.url}")
        return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--epochs", type=int, default=6)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--learning-rate", type=float, default=0.01)
    parser.add_argument("--train-samples", type=int, default=768)
    parser.add_argument("--validation-samples", type=int, default=192)
    parser.add_argument("--image-size", type=int, default=16)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--output-dir", default="/tmp/oplogs-cnn-output")
    return parser.parse_args()


if __name__ == "__main__":
    train(parse_args())
