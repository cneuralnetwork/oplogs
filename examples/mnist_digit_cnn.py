"""Train a real MNIST digit CNN with COCO-style telemetry in oplogs.

The default CUDA path fails closed if this process reaches 480 MiB of VRAM,
leaving headroom below the requested 500 MB ceiling. MNIST is downloaded once
from the public PyTorch dataset mirror and cached locally.
"""

from __future__ import annotations

import argparse
import gzip
import math
import os
import shutil
import struct
import subprocess
import time
import urllib.request
import webbrowser
import zlib
from dataclasses import dataclass
from pathlib import Path

import psutil
import torch
from torch import Tensor, nn
from torch.utils.data import DataLoader, Subset, TensorDataset

import oplogs

MIB = 1024**2
GIB = 1024**3
MNIST_BASE_URL = "https://ossci-datasets.s3.amazonaws.com/mnist"
MNIST_FILES = (
    "train-images-idx3-ubyte.gz",
    "train-labels-idx1-ubyte.gz",
    "t10k-images-idx3-ubyte.gz",
    "t10k-labels-idx1-ubyte.gz",
)
MNIST_MEAN = 0.1307
MNIST_STD = 0.3081
DIGIT_NAMES = tuple(str(index) for index in range(10))


class DigitCNN(nn.Module):
    """A compact LeNet-style classifier for 28 x 28 grayscale digits."""

    def __init__(self) -> None:
        super().__init__()
        self.features = nn.Sequential(
            nn.Conv2d(1, 8, kernel_size=3, padding=1),
            nn.ReLU(),
            nn.MaxPool2d(2),
            nn.Conv2d(8, 16, kernel_size=3, padding=1),
            nn.ReLU(),
            nn.MaxPool2d(2),
        )
        self.classifier = nn.Sequential(
            nn.Linear(16 * 7 * 7, 64),
            nn.ReLU(),
            nn.Dropout(0.1),
            nn.Linear(64, len(DIGIT_NAMES)),
        )

    def forward(self, images: Tensor) -> tuple[Tensor, Tensor]:
        latent = self.features(images).flatten(1)
        return self.classifier(latent), latent


@dataclass(frozen=True, slots=True)
class DatasetBundle:
    train: TensorDataset
    test: TensorDataset


@dataclass(frozen=True, slots=True)
class Evaluation:
    loss: float
    accuracy: float
    predictions: Tensor
    confidences: Tensor
    confusion: Tensor


@dataclass(frozen=True, slots=True)
class GpuSnapshot:
    process_vram_mib: float
    utilization_percent: float
    memory_utilization_percent: float
    temperature_c: float
    power_w: float
    allocated_gib: float
    reserved_gib: float
    peak_allocated_gib: float
    peak_reserved_gib: float
    total_gib: float

    def metrics(self) -> dict[str, float]:
        return {
            "gpu_process_vram_mib": self.process_vram_mib,
            "gpu_utilization_percent": self.utilization_percent,
            "gpu_memory_utilization_percent": self.memory_utilization_percent,
            "gpu_temperature_c": self.temperature_c,
            "gpu_power_w": self.power_w,
            "vram_allocated_gib": self.allocated_gib,
            "vram_reserved_gib": self.reserved_gib,
            "vram_peak_allocated_gib": self.peak_allocated_gib,
            "vram_peak_reserved_gib": self.peak_reserved_gib,
            "vram_total_gib": self.total_gib,
        }


class GpuMonitor:
    """Cap PyTorch allocations and enforce total process VRAM with nvidia-smi."""

    def __init__(
        self,
        device: torch.device,
        *,
        process_limit_mib: float,
        allocator_limit_mib: float,
    ) -> None:
        self.device = device
        self.process_limit_mib = process_limit_mib
        self.allocator_limit_mib = allocator_limit_mib
        self.nvidia_smi = shutil.which("nvidia-smi")
        self.max_process_vram_mib = 0.0

    def start(self) -> GpuSnapshot:
        if self.nvidia_smi is None:
            raise RuntimeError("nvidia-smi is required to prove the process stays below 500 MB")
        if self.allocator_limit_mib >= self.process_limit_mib:
            raise ValueError("allocator limit must be lower than the process VRAM limit")
        torch.cuda.set_device(self.device)
        total_mib = torch.cuda.get_device_properties(self.device).total_memory / MIB
        torch.cuda.set_per_process_memory_fraction(
            min(self.allocator_limit_mib / total_mib, 0.95), self.device
        )
        torch.cuda.init()
        probe = torch.empty(1, device=self.device)
        del probe
        torch.cuda.synchronize(self.device)
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats(self.device)
        return self.sample("CUDA startup", wait_for_process=True)

    def sample(self, stage: str, *, wait_for_process: bool = False) -> GpuSnapshot:
        torch.cuda.synchronize(self.device)
        process_mib = self._wait_for_process() if wait_for_process else self._process_vram_mib()
        if process_mib is None:
            raise RuntimeError("nvidia-smi did not report this Python process")
        utilization, memory_utilization, temperature, power, total_gib = self._device_metrics()
        snapshot = GpuSnapshot(
            process_vram_mib=process_mib,
            utilization_percent=utilization,
            memory_utilization_percent=memory_utilization,
            temperature_c=temperature,
            power_w=power,
            allocated_gib=torch.cuda.memory_allocated(self.device) / GIB,
            reserved_gib=torch.cuda.memory_reserved(self.device) / GIB,
            peak_allocated_gib=torch.cuda.max_memory_allocated(self.device) / GIB,
            peak_reserved_gib=torch.cuda.max_memory_reserved(self.device) / GIB,
            total_gib=total_gib,
        )
        self._enforce(stage, snapshot)
        return snapshot

    def _enforce(self, stage: str, snapshot: GpuSnapshot) -> None:
        self.max_process_vram_mib = max(
            self.max_process_vram_mib, snapshot.process_vram_mib
        )
        if snapshot.process_vram_mib >= self.process_limit_mib:
            raise RuntimeError(
                f"VRAM ceiling reached during {stage}: {snapshot.process_vram_mib:.1f} MiB "
                f"used, limit is {self.process_limit_mib:.1f} MiB"
            )
        reserved_mib = snapshot.reserved_gib * 1024
        if reserved_mib > self.allocator_limit_mib + 1:
            raise RuntimeError(
                f"PyTorch allocator exceeded its cap during {stage}: "
                f"{reserved_mib:.1f} MiB reserved"
            )

    def _wait_for_process(self) -> float | None:
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            measured = self._process_vram_mib()
            if measured is not None:
                return measured
            time.sleep(0.1)
        return None

    def _process_vram_mib(self) -> float | None:
        result = self._run_nvidia_smi(
            "--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"
        )
        if result is None:
            return None
        matches = []
        for line in result.splitlines():
            fields = [field.strip() for field in line.split(",")]
            if len(fields) == 2 and fields[0].isdigit() and int(fields[0]) == os.getpid():
                matches.append(float(fields[1]))
        return sum(matches) if matches else None

    def _device_metrics(self) -> tuple[float, float, float, float, float]:
        device_index = self.device.index if self.device.index is not None else 0
        result = self._run_nvidia_smi(
            f"--id={device_index}",
            "--query-gpu=utilization.gpu,utilization.memory,temperature.gpu,power.draw,memory.total",
            "--format=csv,noheader,nounits",
        )
        if result is None:
            raise RuntimeError("nvidia-smi could not read GPU telemetry")
        fields = [float(field.strip()) for field in result.splitlines()[0].split(",")]
        return fields[0], fields[1], fields[2], fields[3], fields[4] / 1024

    def _run_nvidia_smi(self, *arguments: str) -> str | None:
        assert self.nvidia_smi is not None
        result = subprocess.run(
            [self.nvidia_smi, *arguments],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
        return result.stdout if result.returncode == 0 else None


def download_mnist(data_dir: Path) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    for filename in MNIST_FILES:
        destination = data_dir / filename
        if destination.is_file():
            continue
        partial = destination.with_suffix(destination.suffix + ".part")
        request = urllib.request.Request(
            f"{MNIST_BASE_URL}/{filename}", headers={"User-Agent": "oplogs-mnist-example/1"}
        )
        print(f"Downloading {filename} ...", flush=True)
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                partial.write_bytes(response.read())
            partial.replace(destination)
        finally:
            partial.unlink(missing_ok=True)


def read_idx_images(path: Path) -> Tensor:
    payload = bytearray(gzip.decompress(path.read_bytes()))
    magic, count, rows, columns = struct.unpack_from(">IIII", payload)
    if magic != 2051 or len(payload) != 16 + count * rows * columns:
        raise ValueError(f"invalid MNIST image archive: {path}")
    return torch.frombuffer(payload, dtype=torch.uint8, offset=16).clone().reshape(
        count, 1, rows, columns
    )


def read_idx_labels(path: Path) -> Tensor:
    payload = bytearray(gzip.decompress(path.read_bytes()))
    magic, count = struct.unpack_from(">II", payload)
    if magic != 2049 or len(payload) != 8 + count:
        raise ValueError(f"invalid MNIST label archive: {path}")
    return torch.frombuffer(payload, dtype=torch.uint8, offset=8).clone().long()


def load_mnist(data_dir: Path) -> DatasetBundle:
    download_mnist(data_dir)
    train_images = read_idx_images(data_dir / MNIST_FILES[0])
    train_labels = read_idx_labels(data_dir / MNIST_FILES[1])
    test_images = read_idx_images(data_dir / MNIST_FILES[2])
    test_labels = read_idx_labels(data_dir / MNIST_FILES[3])
    if len(train_images) != len(train_labels) or len(test_images) != len(test_labels):
        raise ValueError("MNIST images and labels have different lengths")
    return DatasetBundle(
        train=TensorDataset(train_images, train_labels),
        test=TensorDataset(test_images, test_labels),
    )


def make_loaders(
    dataset: DatasetBundle, args: argparse.Namespace
) -> tuple[DataLoader, DataLoader, DataLoader]:
    generator = torch.Generator().manual_seed(args.seed)
    indices = torch.randperm(len(dataset.train), generator=generator).tolist()
    validation_indices = indices[: args.validation_samples]
    training_indices = indices[args.validation_samples :]
    training = Subset(dataset.train, training_indices)
    validation = Subset(dataset.train, validation_indices)
    common = {
        "batch_size": args.batch_size,
        "num_workers": args.workers,
        "pin_memory": True,
        "persistent_workers": args.workers > 0,
    }
    train_loader = DataLoader(training, shuffle=True, generator=generator, **common)
    validation_loader = DataLoader(validation, shuffle=False, **common)
    test_loader = DataLoader(dataset.test, shuffle=False, **common)
    return train_loader, validation_loader, test_loader


def normalize(images: Tensor, device: torch.device) -> Tensor:
    images = images.to(device, dtype=torch.float32, non_blocking=True).div_(255)
    return images.sub_(MNIST_MEAN).div_(MNIST_STD)


@torch.inference_mode()
def evaluate(model: DigitCNN, loader: DataLoader, device: torch.device) -> Evaluation:
    model.eval()
    loss_total = 0.0
    correct = 0
    predictions: list[Tensor] = []
    confidences: list[Tensor] = []
    confusion = torch.zeros((10, 10), dtype=torch.int64)
    for images, labels in loader:
        labels = labels.to(device, non_blocking=True)
        logits, _latent = model(normalize(images, device))
        probabilities = logits.softmax(dim=1)
        predicted = probabilities.argmax(dim=1)
        loss_total += nn.functional.cross_entropy(logits, labels).item() * len(labels)
        correct += predicted.eq(labels).sum().item()
        predictions.append(predicted.cpu())
        confidences.append(probabilities.max(dim=1).values.cpu())
        for target, prediction in zip(labels.cpu(), predicted.cpu(), strict=True):
            confusion[target, prediction] += 1
    return Evaluation(
        loss=loss_total / len(loader.dataset),
        accuracy=correct / len(loader.dataset),
        predictions=torch.cat(predictions),
        confidences=torch.cat(confidences),
        confusion=confusion,
    )


def cosine_learning_rate(
    base_learning_rate: float, step: int, total_steps: int, warmup_steps: int
) -> float:
    if step < warmup_steps:
        return base_learning_rate * (step + 1) / max(1, warmup_steps)
    progress = (step - warmup_steps) / max(1, total_steps - warmup_steps - 1)
    return base_learning_rate * 0.5 * (1 + math.cos(math.pi * min(progress, 1.0)))


def system_metrics(output_dir: Path) -> dict[str, float]:
    memory = psutil.virtual_memory()
    disk = psutil.disk_usage(output_dir)
    return {
        "system_memory_percent": memory.percent,
        "system_memory_total_gib": memory.total / GIB,
        "process_rss_gib": psutil.Process().memory_info().rss / GIB,
        "disk_used_percent": disk.percent,
        "disk_free_gib": disk.free / GIB,
    }


def write_grayscale_grid(images: Tensor, destination: Path, columns: int = 8) -> Path:
    images = images.detach().cpu().squeeze(1)
    rows = math.ceil(len(images) / columns)
    image_height, image_width = images.shape[-2:]
    raw = bytearray()
    for canvas_y in range(rows * image_height):
        raw.append(0)
        image_row, source_row = divmod(canvas_y, image_height)
        for column in range(columns):
            image_index = image_row * columns + column
            pixels = images[image_index, source_row] if image_index < len(images) else None
            raw.extend(pixels.tolist() if pixels is not None else bytes(image_width))

    def chunk(kind: bytes, payload: bytes) -> bytes:
        checksum = zlib.crc32(kind + payload) & 0xFFFFFFFF
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", checksum)

    header = struct.pack(
        ">IIBBBBB", columns * image_width, rows * image_height, 8, 0, 0, 0, 0
    )
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(bytes(raw), level=9))
        + chunk(b"IEND", b"")
    )
    return destination


def prediction_rows(
    dataset: TensorDataset | Subset, evaluation: Evaluation, count: int = 32
) -> list[dict[str, object]]:
    rows = []
    for index in range(min(count, len(dataset))):
        _image, target = dataset[index]
        rows.append(
            {
                "sample": index,
                "target": int(target),
                "prediction": int(evaluation.predictions[index]),
                "confidence": round(float(evaluation.confidences[index]), 6),
                "correct": int(target) == int(evaluation.predictions[index]),
            }
        )
    return rows


def confusion_rows(confusion: Tensor) -> list[dict[str, int]]:
    return [
        {"target": target, **{f"predicted_{digit}": int(confusion[target, digit]) for digit in range(10)}}
        for target in range(10)
    ]


def save_checkpoint(
    model: DigitCNN,
    destination: Path,
    *,
    epoch: int,
    step: int,
    validation_accuracy: float,
) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    torch.save(
        {
            "model_state_dict": {
                name: value.detach().cpu() for name, value in model.state_dict().items()
            },
            "epoch": epoch,
            "step": step,
            "validation_accuracy": validation_accuracy,
            "classes": list(DIGIT_NAMES),
            "normalization": {"mean": MNIST_MEAN, "std": MNIST_STD},
        },
        destination,
    )
    return destination


def open_dashboard(url: str, enabled: bool) -> None:
    print(f"oplogs live dashboard: {url}", flush=True)
    if not enabled:
        return
    if not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
        print("No desktop display detected. Open the URL above manually.", flush=True)
        return
    if not webbrowser.open(url, new=2):
        print("The browser did not open automatically. Open the URL above manually.", flush=True)


def run_config(
    args: argparse.Namespace,
    *,
    device: torch.device,
    device_name: str,
    train_samples: int,
    validation_samples: int,
    test_samples: int,
    max_steps: int,
    parameter_count: int,
) -> dict[str, object]:
    return {
        "dataset": "MNIST",
        "dataset_source": MNIST_BASE_URL,
        "architecture": "Conv(1,8) -> Conv(8,16) -> Linear(784,64) -> Linear(64,10)",
        "epochs": args.epochs,
        "max_steps": max_steps,
        "learning_rate": args.learning_rate,
        "warmup_steps": args.warmup_steps,
        "weight_decay": args.weight_decay,
        "max_grad_norm": args.max_grad_norm,
        "physical_batch_size": args.batch_size,
        "gradient_accumulation_steps": 1,
        "effective_batch_size": args.batch_size,
        "train_samples": train_samples,
        "validation_samples": validation_samples,
        "test_samples": test_samples,
        "save_every": math.ceil(train_samples / args.batch_size),
        "sample_every": math.ceil(train_samples / args.batch_size),
        "sample_prompt": "held-out MNIST digits with predicted labels and confidence",
        "device": str(device),
        "gpu_name": device_name,
        "torch_version": torch.__version__,
        "trainable_parameters": parameter_count,
        "image_size": 28,
        "seed": args.seed,
        "vram_process_limit_mib": args.vram_limit_mib,
        "torch_allocator_limit_mib": args.allocator_limit_mib,
    }


def coco_style_metrics(
    *,
    epoch: int,
    epoch_progress: float,
    loss: Tensor,
    grad_norm: Tensor,
    learning_rate: float,
    logits: Tensor,
    latent: Tensor,
    elapsed: float,
    interval_seconds: float,
    interval_steps: int,
    remaining_steps: int,
    images_seen: int,
) -> dict[str, float | int]:
    updates_per_second = interval_steps / max(interval_seconds, 1e-9)
    return {
        "epoch": epoch,
        "epoch_progress_percent": epoch_progress,
        "loss": loss.item(),
        "grad_norm": float(grad_norm),
        "learning_rate": learning_rate,
        "latent_std": latent.detach().float().std().item(),
        "score_rms": logits.detach().float().square().mean().sqrt().item(),
        "scaler_scale": 1.0,
        "elapsed_seconds": elapsed,
        "step_seconds": interval_seconds / max(interval_steps, 1),
        "updates_per_second": updates_per_second,
        "eta_seconds": remaining_steps / max(updates_per_second, 1e-9),
        "images_seen": images_seen,
    }


def train_epoch(
    *,
    model: DigitCNN,
    loader: DataLoader,
    optimizer: torch.optim.Optimizer,
    run: oplogs.Run,
    monitor: GpuMonitor,
    output_dir: Path,
    device: torch.device,
    args: argparse.Namespace,
    epoch: int,
    global_step: int,
    total_steps: int,
    images_seen: int,
    training_started: float,
) -> tuple[int, int]:
    model.train()
    last_log_time = time.perf_counter()
    last_log_step = global_step
    for batch_index, (images, labels) in enumerate(loader, start=1):
        learning_rate = cosine_learning_rate(
            args.learning_rate, global_step, total_steps, args.warmup_steps
        )
        for group in optimizer.param_groups:
            group["lr"] = learning_rate
        labels = labels.to(device, non_blocking=True)
        optimizer.zero_grad(set_to_none=True)
        logits, latent = model(normalize(images, device))
        loss = nn.functional.cross_entropy(logits, labels)
        loss.backward()
        grad_norm = nn.utils.clip_grad_norm_(model.parameters(), args.max_grad_norm)
        optimizer.step()
        global_step += 1
        images_seen += len(labels)

        should_log = global_step == 1 or global_step % args.log_every == 0
        if not should_log and batch_index != len(loader):
            continue
        snapshot = monitor.sample(f"step {global_step}")
        now = time.perf_counter()
        metrics = coco_style_metrics(
            epoch=epoch,
            epoch_progress=100 * batch_index / len(loader),
            loss=loss,
            grad_norm=grad_norm,
            learning_rate=learning_rate,
            logits=logits,
            latent=latent,
            elapsed=now - training_started,
            interval_seconds=now - last_log_time,
            interval_steps=global_step - last_log_step,
            remaining_steps=total_steps - global_step,
            images_seen=images_seen,
        )
        metrics["batch_accuracy"] = logits.argmax(dim=1).eq(labels).float().mean().item()
        metrics.update(system_metrics(output_dir))
        metrics.update(snapshot.metrics())
        run.log(metrics, step=global_step)
        last_log_time = now
        last_log_step = global_step
    return global_step, images_seen


def train(args: argparse.Namespace) -> dict[str, object]:
    validate_args(args)
    torch.manual_seed(args.seed)
    torch.set_num_threads(args.threads)
    device = torch.device(args.device)
    if device.type != "cuda" or not torch.cuda.is_available():
        raise RuntimeError("This checked run requires a CUDA device and CUDA-enabled PyTorch")

    data_dir = Path(args.data_dir).expanduser().resolve()
    dataset = load_mnist(data_dir)
    train_loader, validation_loader, test_loader = make_loaders(dataset, args)
    total_steps = args.epochs * len(train_loader)

    monitor = GpuMonitor(
        device,
        process_limit_mib=args.vram_limit_mib,
        allocator_limit_mib=args.allocator_limit_mib,
    )
    startup = monitor.start()
    device_name = torch.cuda.get_device_name(device)
    model = DigitCNN().to(device)
    parameter_count = sum(parameter.numel() for parameter in model.parameters())
    model_snapshot = monitor.sample("model initialization")
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=args.learning_rate, weight_decay=args.weight_decay
    )

    config = run_config(
        args,
        device=device,
        device_name=device_name,
        train_samples=len(train_loader.dataset),
        validation_samples=len(validation_loader.dataset),
        test_samples=len(test_loader.dataset),
        max_steps=total_steps,
        parameter_count=parameter_count,
    )
    with oplogs.init(
        project="mnist-digit-cnn",
        name="mnist-cnn-under-500mb-vram",
        config=config,
        tags=["cnn", "mnist", "pytorch", "cuda", "under-500mb-vram"],
        open=False,
    ) as run:
        open_dashboard(run.url, args.open_dashboard)
        output_dir = Path(args.output_dir).expanduser().resolve() / run.id
        output_dir.mkdir(parents=True, exist_ok=True)
        run.watch(model, gradients=False)
        run.log({**startup.metrics(), **model_snapshot.metrics(), **system_metrics(output_dir)}, step=0)
        run.log(
            {"event/dataset": f"Loaded {len(dataset.train):,} train and {len(dataset.test):,} test digits"},
            step=0,
        )
        print(
            f"Training {parameter_count:,}-parameter MNIST CNN on {device_name}; "
            f"startup process VRAM {startup.process_vram_mib:.1f} MiB",
            flush=True,
        )

        training_started = time.perf_counter()
        global_step = 0
        images_seen = 0
        best_accuracy = -1.0
        best_epoch = 0
        best_state: dict[str, Tensor] = {}
        best_checkpoint: Path | None = None
        for epoch in range(1, args.epochs + 1):
            global_step, images_seen = train_epoch(
                model=model,
                loader=train_loader,
                optimizer=optimizer,
                run=run,
                monitor=monitor,
                output_dir=output_dir,
                device=device,
                args=args,
                epoch=epoch,
                global_step=global_step,
                total_steps=total_steps,
                images_seen=images_seen,
                training_started=training_started,
            )
            validation = evaluate(model, validation_loader, device)
            improved = validation.accuracy > best_accuracy
            checkpoint_path = save_checkpoint(
                model,
                output_dir / "checkpoints" / f"epoch-{epoch:02d}-step-{global_step:05d}.pt",
                epoch=epoch,
                step=global_step,
                validation_accuracy=validation.accuracy,
            )
            if improved:
                best_accuracy = validation.accuracy
                best_epoch = epoch
                best_checkpoint = checkpoint_path
                best_state = {
                    name: value.detach().cpu().clone()
                    for name, value in model.state_dict().items()
                }
            sample_path = write_grayscale_grid(
                torch.stack([validation_loader.dataset[index][0] for index in range(32)]),
                output_dir / "samples" / f"epoch-{epoch:02d}-step-{global_step:05d}.png",
            )
            run.log(
                {
                    "validation_loss": validation.loss,
                    "validation_accuracy": validation.accuracy,
                    "samples/predictions": oplogs.Image(
                        sample_path,
                        caption=f"Epoch {epoch}: held-out MNIST digits; labels and confidence are in the table",
                    ),
                    "samples/prediction_table": oplogs.Table(
                        prediction_rows(validation_loader.dataset, validation)
                    ),
                    "artifacts/checkpoint": oplogs.Artifact(
                        checkpoint_path,
                        mime_type="application/octet-stream",
                        artifact_type="model",
                        aliases=["latest", *(["best"] if improved else [])],
                        metadata={
                            "epoch": epoch,
                            "step": global_step,
                            "validation_accuracy": validation.accuracy,
                            "process_vram_mib": monitor.max_process_vram_mib,
                        },
                    ),
                    "event/checkpoint": f"Saved checkpoint at step {global_step:,}",
                    "event/sample": f"Logged prediction sample at step {global_step:,}",
                },
                step=global_step,
            )
            print(
                f"epoch {epoch:02d}/{args.epochs}: validation loss={validation.loss:.4f}, "
                f"accuracy={validation.accuracy:.3%}",
                flush=True,
            )

        if not best_state or best_checkpoint is None:
            raise RuntimeError("training finished without producing a best checkpoint")
        model.load_state_dict(best_state)
        test = evaluate(model, test_loader, device)
        final_snapshot = monitor.sample("final test evaluation")
        run.log(
            {
                "test_loss": test.loss,
                "test_accuracy": test.accuracy,
                "best_validation_accuracy": best_accuracy,
                "best_epoch": best_epoch,
                "final/confusion_matrix": oplogs.Table(confusion_rows(test.confusion)),
                "final/confidence_histogram": oplogs.Histogram(test.confidences.tolist(), bins=20),
                "final/test_predictions": oplogs.Table(prediction_rows(dataset.test, test)),
                "final/best_checkpoint": oplogs.Artifact(
                    best_checkpoint,
                    mime_type="application/octet-stream",
                    artifact_type="model",
                    aliases=["best", "digit-cnn"],
                    metadata={
                        "best_epoch": best_epoch,
                        "validation_accuracy": best_accuracy,
                        "test_accuracy": test.accuracy,
                    },
                ),
                "gpu/max_process_vram_mib": monitor.max_process_vram_mib,
                **final_snapshot.metrics(),
            },
            step=global_step,
        )
        print(f"test accuracy: {test.accuracy:.3%}", flush=True)
        print(
            f"maximum observed process VRAM: {monitor.max_process_vram_mib:.1f} MiB "
            f"(< {args.vram_limit_mib:.0f} MiB)",
            flush=True,
        )
        print(f"best checkpoint: {best_checkpoint}", flush=True)
        print(f"dashboard retained at: {run.url}", flush=True)
        return {
            "run_id": run.id,
            "run_url": run.url,
            "test_accuracy": test.accuracy,
            "best_checkpoint": str(best_checkpoint),
            "max_process_vram_mib": monitor.max_process_vram_mib,
        }


def validate_args(args: argparse.Namespace) -> None:
    if args.epochs < 1 or args.batch_size < 1 or args.validation_samples < 1:
        raise ValueError("epochs, batch size, and validation samples must be positive")
    if args.validation_samples >= 60_000:
        raise ValueError("validation samples must leave at least one MNIST training sample")
    if args.log_every < 1 or args.warmup_steps < 0:
        raise ValueError("log interval must be positive and warmup steps cannot be negative")
    if not 0 < args.vram_limit_mib < 500:
        raise ValueError("VRAM limit must be positive and strictly below 500 MiB")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--epochs", type=int, default=5)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--learning-rate", type=float, default=0.001)
    parser.add_argument("--weight-decay", type=float, default=0.0001)
    parser.add_argument("--max-grad-norm", type=float, default=1.0)
    parser.add_argument("--warmup-steps", type=int, default=100)
    parser.add_argument("--validation-samples", type=int, default=5_000)
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--seed", type=int, default=17)
    parser.add_argument("--log-every", type=int, default=20)
    parser.add_argument("--vram-limit-mib", type=float, default=480.0)
    parser.add_argument("--allocator-limit-mib", type=float, default=80.0)
    parser.add_argument("--data-dir", default="./data/mnist")
    parser.add_argument("--output-dir", default="./oplogs-mnist-output")
    parser.add_argument(
        "--open-dashboard",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="open the exact run URL in the default browser",
    )
    return parser.parse_args()


if __name__ == "__main__":
    train(parse_args())
