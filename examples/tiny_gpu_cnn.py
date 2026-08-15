"""Train a very small CNN on CUDA and stream the run to the oplogs dashboard.

The dataset is generated locally. No download, account, or cloud service is used.
The default CUDA path caps PyTorch's allocator at 96 MiB and fails closed if
``nvidia-smi`` reports that this process is using more than 500 MiB of VRAM.
"""

from __future__ import annotations

import argparse
import os
import shutil
import struct
import subprocess
import time
import webbrowser
import zlib
from dataclasses import dataclass
from pathlib import Path

import torch
from torch import Tensor, nn

import oplogs

MIB = 1024**2
CLASS_NAMES = ("vertical", "horizontal")


class VerySmallCNN(nn.Module):
    """A 1,122-parameter classifier for 28 x 28 grayscale images."""

    def __init__(self, image_size: int = 28) -> None:
        super().__init__()
        if image_size < 8 or image_size % 4:
            raise ValueError("image size must be at least 8 and divisible by 4")
        self.features = nn.Sequential(
            nn.Conv2d(1, 4, kernel_size=3, padding=1),
            nn.ReLU(),
            nn.MaxPool2d(2),
            nn.Conv2d(4, 8, kernel_size=3, padding=1),
            nn.ReLU(),
            nn.MaxPool2d(2),
        )
        feature_width = image_size // 4
        self.classifier = nn.Linear(8 * feature_width * feature_width, len(CLASS_NAMES))

    def forward(self, images: Tensor) -> Tensor:
        return self.classifier(self.features(images).flatten(1))


@dataclass(frozen=True, slots=True)
class Evaluation:
    loss: float
    accuracy: float
    predictions: Tensor
    confidences: Tensor


@dataclass(frozen=True, slots=True)
class MemorySnapshot:
    process_mb: float
    allocated_mb: float
    reserved_mb: float
    peak_allocated_mb: float
    peak_reserved_mb: float

    def metrics(self) -> dict[str, float]:
        return {
            "gpu/process_vram_mb": self.process_mb,
            "gpu/torch_allocated_mb": self.allocated_mb,
            "gpu/torch_reserved_mb": self.reserved_mb,
            "gpu/torch_peak_allocated_mb": self.peak_allocated_mb,
            "gpu/torch_peak_reserved_mb": self.peak_reserved_mb,
        }


class VramGuard:
    """Enforce an allocator cap and verify total process VRAM through nvidia-smi."""

    def __init__(
        self,
        device: torch.device,
        *,
        process_limit_mb: float,
        allocator_limit_mb: float,
    ) -> None:
        self.device = device
        self.process_limit_mb = process_limit_mb
        self.allocator_limit_mb = allocator_limit_mb
        self.nvidia_smi = shutil.which("nvidia-smi")
        self.max_process_mb = 0.0

    def start(self) -> MemorySnapshot:
        if self.nvidia_smi is None:
            raise RuntimeError(
                "nvidia-smi is required for the strict 500 MB process-VRAM check"
            )
        torch.cuda.set_device(self.device)
        properties = torch.cuda.get_device_properties(self.device)
        total_mb = properties.total_memory / MIB
        if self.allocator_limit_mb >= self.process_limit_mb:
            raise ValueError("allocator limit must be lower than the process VRAM limit")
        fraction = min(self.allocator_limit_mb / total_mb, 0.95)
        torch.cuda.set_per_process_memory_fraction(fraction, self.device)
        torch.cuda.init()

        # Make the CUDA context visible to nvidia-smi before taking the baseline.
        probe = torch.empty(1, device=self.device)
        del probe
        torch.cuda.synchronize(self.device)
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats(self.device)
        return self.check("CUDA startup", wait_for_process=True)

    def check(self, stage: str, *, wait_for_process: bool = False) -> MemorySnapshot:
        torch.cuda.synchronize(self.device)
        process_mb = self._wait_for_process_memory() if wait_for_process else self._process_memory()
        if process_mb is None:
            raise RuntimeError(
                "nvidia-smi did not report this Python process, so the 500 MB limit "
                "cannot be verified"
            )
        snapshot = MemorySnapshot(
            process_mb=process_mb,
            allocated_mb=torch.cuda.memory_allocated(self.device) / MIB,
            reserved_mb=torch.cuda.memory_reserved(self.device) / MIB,
            peak_allocated_mb=torch.cuda.max_memory_allocated(self.device) / MIB,
            peak_reserved_mb=torch.cuda.max_memory_reserved(self.device) / MIB,
        )
        self.max_process_mb = max(self.max_process_mb, process_mb)
        if snapshot.process_mb > self.process_limit_mb:
            raise RuntimeError(
                f"VRAM limit exceeded during {stage}: {snapshot.process_mb:.1f} MB used, "
                f"limit is {self.process_limit_mb:.1f} MB"
            )
        if snapshot.reserved_mb > self.allocator_limit_mb + 1:
            raise RuntimeError(
                f"PyTorch allocator exceeded its cap during {stage}: "
                f"{snapshot.reserved_mb:.1f} MB reserved"
            )
        return snapshot

    def _wait_for_process_memory(self) -> float | None:
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            measured = self._process_memory()
            if measured is not None:
                return measured
            time.sleep(0.1)
        return None

    def _process_memory(self) -> float | None:
        assert self.nvidia_smi is not None
        result = subprocess.run(
            [
                self.nvidia_smi,
                "--query-compute-apps=pid,used_memory",
                "--format=csv,noheader,nounits",
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode:
            return None
        used_mb = 0.0
        found = False
        for line in result.stdout.splitlines():
            fields = [field.strip() for field in line.split(",")]
            if len(fields) < 2:
                continue
            try:
                process_id = int(fields[0])
                memory_mb = float(fields[1])
            except ValueError:
                continue
            if process_id == os.getpid():
                used_mb += memory_mb
                found = True
        return used_mb if found else None


def make_dataset(samples: int, image_size: int, seed: int) -> tuple[Tensor, Tensor]:
    """Create noisy vertical-versus-horizontal stripe images on the CPU."""
    generator = torch.Generator().manual_seed(seed)
    labels = torch.randint(0, len(CLASS_NAMES), (samples,), generator=generator)
    images = torch.rand((samples, 1, image_size, image_size), generator=generator) * 0.16
    for index, label in enumerate(labels.tolist()):
        offset = int(torch.randint(-4, 5, (1,), generator=generator).item())
        center = image_size // 2 + offset
        if label == 0:
            images[index, 0, 3:-3, center - 1 : center + 1] += 0.84
        else:
            images[index, 0, center - 1 : center + 1, 3:-3] += 0.84
    return images.clamp_(0, 1), labels


@torch.inference_mode()
def evaluate(
    model: nn.Module,
    images: Tensor,
    labels: Tensor,
    *,
    device: torch.device,
    batch_size: int,
) -> Evaluation:
    model.eval()
    loss_total = 0.0
    predictions: list[Tensor] = []
    confidences: list[Tensor] = []
    for start in range(0, len(images), batch_size):
        batch_images = images[start : start + batch_size].to(device)
        batch_labels = labels[start : start + batch_size].to(device)
        logits = model(batch_images)
        probabilities = logits.softmax(dim=1)
        loss_total += nn.functional.cross_entropy(logits, batch_labels).item() * len(batch_images)
        predictions.append(probabilities.argmax(dim=1).cpu())
        confidences.append(probabilities.max(dim=1).values.cpu())
    all_predictions = torch.cat(predictions)
    return Evaluation(
        loss=loss_total / len(images),
        accuracy=all_predictions.eq(labels).float().mean().item(),
        predictions=all_predictions,
        confidences=torch.cat(confidences),
    )


def write_grayscale_grid(images: Tensor, destination: Path, columns: int = 4) -> Path:
    """Write a dependency-free PNG grid for the oplogs samples tab."""
    images = images.detach().cpu().squeeze(1).clamp(0, 1)
    rows = (len(images) + columns - 1) // columns
    image_height, image_width = images.shape[-2:]
    raw = bytearray()
    for canvas_y in range(rows * image_height):
        raw.append(0)
        image_row = canvas_y // image_height
        source_row = canvas_y % image_height
        for column in range(columns):
            image_index = image_row * columns + column
            if image_index >= len(images):
                raw.extend(bytes(image_width))
            else:
                raw.extend(
                    images[image_index, source_row].mul(255).to(torch.uint8).tolist()
                )

    def chunk(kind: bytes, payload: bytes) -> bytes:
        checksum = zlib.crc32(kind + payload) & 0xFFFFFFFF
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", checksum)

    header = struct.pack(">IIBBBBB", columns * image_width, rows * image_height, 8, 0, 0, 0, 0)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(bytes(raw), level=9))
        + chunk(b"IEND", b"")
    )
    return destination


def open_run_dashboard(url: str, enabled: bool) -> None:
    print(f"oplogs live dashboard: {url}", flush=True)
    if not enabled:
        return
    if not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
        print("No desktop display detected. Open the URL above in your browser.", flush=True)
        return
    if not webbrowser.open(url, new=2):
        print("The browser did not open automatically. Open the URL above manually.", flush=True)


def train(args: argparse.Namespace) -> dict[str, object]:
    if args.epochs < 1 or args.batch_size < 1 or args.train_samples < 1:
        raise ValueError("epochs, batch size, and sample counts must be positive")
    if args.validation_samples < 1 or args.log_every < 1:
        raise ValueError("validation samples and log interval must be positive")

    torch.manual_seed(args.seed)
    torch.set_num_threads(args.threads)
    device = torch.device(args.device)
    if device.type == "cuda" and not torch.cuda.is_available():
        raise RuntimeError(
            "CUDA is not available in this Python environment. Install a CUDA-enabled "
            "PyTorch build and run this script again."
        )

    guard: VramGuard | None = None
    startup_memory: MemorySnapshot | None = None
    device_name = "CPU"
    if device.type == "cuda":
        guard = VramGuard(
            device,
            process_limit_mb=args.vram_limit_mb,
            allocator_limit_mb=args.allocator_limit_mb,
        )
        # Establish the allocator ceiling before oplogs autologging or model setup
        # can create CUDA allocations in another thread.
        startup_memory = guard.start()
        device_name = torch.cuda.get_device_name(device)

    train_images, train_labels = make_dataset(args.train_samples, args.image_size, args.seed)
    validation_images, validation_labels = make_dataset(
        args.validation_samples, args.image_size, args.seed + 1
    )
    model = VerySmallCNN(args.image_size)
    parameter_count = sum(parameter.numel() for parameter in model.parameters())
    classifier_inputs = 8 * (args.image_size // 4) ** 2

    with oplogs.init(
        project="tiny-gpu-cnn",
        name="very-small-cuda-cnn" if device.type == "cuda" else "very-small-cpu-cnn-smoke",
        config={
            "architecture": f"Conv(1,4) -> Conv(4,8) -> Linear({classifier_inputs},2)",
            "parameters": parameter_count,
            "dataset": "generated-stripes",
            "device": str(device),
            "device_name": device_name,
            "epochs": args.epochs,
            "batch_size": args.batch_size,
            "learning_rate": args.learning_rate,
            "train_samples": args.train_samples,
            "validation_samples": args.validation_samples,
            "vram_process_limit_mb": args.vram_limit_mb if device.type == "cuda" else None,
            "torch_allocator_limit_mb": args.allocator_limit_mb
            if device.type == "cuda"
            else None,
            "seed": args.seed,
        },
        tags=["cnn", "pytorch", "local-data", "gpu" if device.type == "cuda" else "cpu-smoke"],
        open=False,
    ) as run:
        open_run_dashboard(run.url, args.open_dashboard)
        output_dir = Path(args.output_dir).expanduser().resolve() / run.id
        output_dir.mkdir(parents=True, exist_ok=True)

        if startup_memory is not None:
            print(
                f"CUDA device: {device_name} | "
                f"process VRAM at startup: {startup_memory.process_mb:.1f} MB | "
                f"hard limit: {args.vram_limit_mb:.0f} MB",
                flush=True,
            )

        model = model.to(device)
        run.watch(model, gradients=True, every=max(1, args.log_every * 6))
        optimizer = torch.optim.SGD(model.parameters(), lr=args.learning_rate, momentum=0.8)
        criterion = nn.CrossEntropyLoss()
        if guard is not None:
            model_memory = guard.check("model initialization")
            run.log(model_memory.metrics(), step=0)

        print(
            f"Training {parameter_count:,}-parameter CNN on {device} with "
            f"{args.train_samples:,} generated images",
            flush=True,
        )
        started = time.perf_counter()
        global_step = 0
        for epoch in range(1, args.epochs + 1):
            epoch_started = time.perf_counter()
            model.train()
            permutation = torch.randperm(args.train_samples)
            loss_total = 0.0
            correct = 0
            for start in range(0, args.train_samples, args.batch_size):
                indexes = permutation[start : start + args.batch_size]
                batch_images = train_images[indexes].to(device)
                batch_labels = train_labels[indexes].to(device)
                optimizer.zero_grad(set_to_none=True)
                logits = model(batch_images)
                loss = criterion(logits, batch_labels)
                loss.backward()
                optimizer.step()

                global_step += 1
                loss_total += loss.item() * len(indexes)
                correct += logits.argmax(dim=1).eq(batch_labels).sum().item()
                if global_step == 1 or global_step % args.log_every == 0:
                    batch_metrics = {
                        "batch/loss": loss.item(),
                        "batch/accuracy": logits.argmax(dim=1)
                        .eq(batch_labels)
                        .float()
                        .mean()
                        .item(),
                        "optimizer/learning_rate": optimizer.param_groups[0]["lr"],
                    }
                    if guard is not None:
                        batch_metrics.update(guard.check(f"step {global_step}").metrics())
                    run.log(batch_metrics, step=global_step)

            validation = evaluate(
                model,
                validation_images,
                validation_labels,
                device=device,
                batch_size=args.batch_size,
            )
            epoch_metrics = {
                "epoch": epoch,
                "epoch/train_loss": loss_total / args.train_samples,
                "epoch/train_accuracy": correct / args.train_samples,
                "epoch/validation_loss": validation.loss,
                "epoch/validation_accuracy": validation.accuracy,
                "epoch/seconds": time.perf_counter() - epoch_started,
            }
            if guard is not None:
                epoch_metrics.update(guard.check(f"epoch {epoch}").metrics())
            run.log(epoch_metrics, step=global_step)
            print(
                f"epoch {epoch:02d}/{args.epochs}: "
                f"loss={epoch_metrics['epoch/train_loss']:.4f} "
                f"val_accuracy={validation.accuracy:.3f}",
                flush=True,
            )

        final = evaluate(
            model,
            validation_images,
            validation_labels,
            device=device,
            batch_size=args.batch_size,
        )
        final_memory = guard.check("final evaluation") if guard is not None else None
        sample_path = write_grayscale_grid(validation_images[:16], output_dir / "samples.png")
        checkpoint_path = output_dir / "very_small_cnn.pt"
        torch.save(
            {
                "model_state_dict": {
                    name: parameter.detach().cpu() for name, parameter in model.state_dict().items()
                },
                "image_size": args.image_size,
                "classes": list(CLASS_NAMES),
                "parameters": parameter_count,
            },
            checkpoint_path,
        )
        rows = [
            {
                "sample": index,
                "target": CLASS_NAMES[validation_labels[index].item()],
                "prediction": CLASS_NAMES[final.predictions[index].item()],
                "confidence": round(final.confidences[index].item(), 5),
            }
            for index in range(min(32, len(validation_images)))
        ]
        summary = {
            "validation_loss": final.loss,
            "validation_accuracy": final.accuracy,
            "parameters": parameter_count,
            "training_seconds": time.perf_counter() - started,
            "max_process_vram_mb": guard.max_process_mb if guard is not None else None,
            "vram_limit_mb": args.vram_limit_mb if guard is not None else None,
        }
        final_values: dict[str, object] = {
            "final/summary": oplogs.Json(summary),
            "final/predictions": oplogs.Table(rows),
            "final/confidences": oplogs.Histogram(final.confidences.tolist(), bins=20),
            "final/sample_images": oplogs.Image(
                sample_path,
                caption="16 held-out stripe images from the final evaluation",
            ),
            "model/checkpoint": oplogs.Artifact(
                checkpoint_path,
                mime_type="application/octet-stream",
                artifact_type="model",
                aliases=["latest", "tiny-gpu-cnn"],
                metadata=summary,
            ),
            "training/seconds": summary["training_seconds"],
            "training/parameter_count": parameter_count,
        }
        if final_memory is not None:
            final_values.update(final_memory.metrics())
            final_values["gpu/max_observed_process_vram_mb"] = guard.max_process_mb
            final_values["gpu/process_vram_limit_mb"] = args.vram_limit_mb
        run.log(final_values, step=global_step)

        print(f"Completed with validation accuracy {final.accuracy:.3f}", flush=True)
        if guard is not None:
            print(
                f"Maximum observed process VRAM: {guard.max_process_mb:.1f} MB "
                f"of {args.vram_limit_mb:.0f} MB",
                flush=True,
            )
        print(f"Checkpoint: {checkpoint_path}", flush=True)
        print(f"Dashboard retained at: {run.url}", flush=True)
        return {
            "run_id": run.id,
            "run_url": run.url,
            "validation_accuracy": final.accuracy,
            "checkpoint": str(checkpoint_path),
            "max_process_vram_mb": guard.max_process_mb if guard is not None else None,
        }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--learning-rate", type=float, default=0.04)
    parser.add_argument("--train-samples", type=int, default=2048)
    parser.add_argument("--validation-samples", type=int, default=512)
    parser.add_argument("--image-size", type=int, default=28)
    parser.add_argument("--seed", type=int, default=17)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--log-every", type=int, default=8)
    parser.add_argument("--vram-limit-mb", type=float, default=500.0)
    parser.add_argument("--allocator-limit-mb", type=float, default=96.0)
    parser.add_argument("--output-dir", default="./oplogs-cnn-output")
    parser.add_argument(
        "--open-dashboard",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="open the exact run URL in the default browser",
    )
    return parser.parse_args()


if __name__ == "__main__":
    train(parse_args())
