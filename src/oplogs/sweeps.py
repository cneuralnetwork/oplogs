"""Local subprocess sweep controller."""

from __future__ import annotations

import itertools
import json
import os
import random
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

from .storage import Storage


def load_sweep(path: str | Path) -> dict[str, Any]:
    source = Path(path).expanduser().resolve()
    if source.suffix == ".json":
        return json.loads(source.read_text(encoding="utf-8"))
    try:
        import yaml
    except ImportError as exc:
        raise RuntimeError("YAML sweeps require `pip install 'oplogs[sweeps]'`") from exc
    return yaml.safe_load(source.read_text(encoding="utf-8"))


def _values(specification: Any) -> list[Any]:
    if isinstance(specification, list):
        return specification
    if not isinstance(specification, dict):
        return [specification]
    if "values" in specification:
        return list(specification["values"])
    if "value" in specification:
        return [specification["value"]]
    minimum = specification.get("min")
    maximum = specification.get("max")
    if minimum is not None and maximum is not None:
        return [minimum + (maximum - minimum) * index / 9 for index in range(10)]
    return []


def generate_trials(config: dict[str, Any]) -> list[dict[str, Any]]:
    parameters = config.get("parameters", {})
    names = list(parameters)
    candidates = [_values(parameters[name]) for name in names]
    method = config.get("method", "grid")
    count = int(config.get("count", 10))
    if method == "grid":
        return [
            dict(zip(names, combination, strict=False))
            for combination in itertools.product(*candidates)
        ][:count]
    trials = []
    randomizer = random.Random(config.get("seed", 0))
    for _ in range(count):
        trials.append(
            {
                name: randomizer.choice(values)
                for name, values in zip(names, candidates, strict=False)
            }
        )
    return trials


def _suggest(trial: Any, name: str, specification: Any) -> Any:
    if isinstance(specification, list):
        return trial.suggest_categorical(name, specification)
    if not isinstance(specification, dict):
        return specification
    if "values" in specification:
        return trial.suggest_categorical(name, list(specification["values"]))
    if "value" in specification:
        return specification["value"]
    minimum = specification.get("min")
    maximum = specification.get("max")
    if minimum is None or maximum is None:
        raise ValueError(f"parameter {name!r} has no values or range")
    if specification.get("distribution") in {"int", "int_uniform"} or all(
        isinstance(value, int) for value in (minimum, maximum)
    ):
        return trial.suggest_int(
            name, int(minimum), int(maximum), log=bool(specification.get("log"))
        )
    return trial.suggest_float(
        name, float(minimum), float(maximum), log=bool(specification.get("log"))
    )


class SweepController:
    def __init__(
        self, config: dict[str, Any], command: list[str], storage: Storage | None = None
    ) -> None:
        if not command:
            raise ValueError("sweep command cannot be empty")
        self.config = config
        self.command = command
        self.storage = storage or Storage()
        self.record = self.storage.create_sweep(
            config.get("project", "sweeps"), config.get("name", "local-sweep"), config
        )
        self._cancel = threading.Event()

    def run(self) -> dict[str, Any]:
        if self.config.get("method") in {"bayes", "bayesian"}:
            return self._run_bayesian()
        trials = generate_trials(self.config)
        concurrency = max(1, int(self.config.get("concurrency", 1)))
        gpu_ids = [str(value) for value in self.config.get("gpus", [])]
        self.storage.update_sweep(self.record["id"], "running")
        results: list[dict[str, Any]] = []
        try:
            with ThreadPoolExecutor(max_workers=concurrency) as executor:
                futures = {
                    executor.submit(
                        self._run_trial,
                        index,
                        trial,
                        gpu_ids[index % len(gpu_ids)] if gpu_ids else None,
                    ): trial
                    for index, trial in enumerate(trials)
                }
                for future in as_completed(futures):
                    results.append(future.result())
            state = "cancelled" if self._cancel.is_set() else "finished"
        except BaseException:
            self.storage.update_sweep(self.record["id"], "failed")
            raise
        self.storage.update_sweep(self.record["id"], state)
        return {"sweep_id": self.record["id"], "state": state, "trials": results}

    def _run_bayesian(self) -> dict[str, Any]:
        try:
            import optuna
        except ImportError as exc:
            raise RuntimeError("Bayesian sweeps require `pip install 'oplogs[sweeps]'`") from exc
        metric = self.config.get("metric", {})
        metric_name = metric if isinstance(metric, str) else metric.get("name")
        goal = (
            self.config.get("goal")
            or (metric.get("goal") if isinstance(metric, dict) else None)
            or "minimize"
        )
        direction = "maximize" if goal in {"maximize", "max"} else "minimize"
        sampler = optuna.samplers.TPESampler(seed=int(self.config.get("seed", 0)))
        study = optuna.create_study(direction=direction, sampler=sampler)
        count = int(self.config.get("count", 10))
        concurrency = max(1, int(self.config.get("concurrency", 1)))
        gpu_ids = [str(value) for value in self.config.get("gpus", [])]
        results: list[dict[str, Any]] = []
        self.storage.update_sweep(self.record["id"], "running")
        try:
            for offset in range(0, count, concurrency):
                batch: list[tuple[Any, int, dict[str, Any], str | None]] = []
                for index in range(offset, min(offset + concurrency, count)):
                    trial = study.ask()
                    parameters = {
                        name: _suggest(trial, name, specification)
                        for name, specification in self.config.get("parameters", {}).items()
                    }
                    gpu = gpu_ids[index % len(gpu_ids)] if gpu_ids else None
                    batch.append((trial, index, parameters, gpu))
                with ThreadPoolExecutor(max_workers=len(batch)) as executor:
                    futures = {
                        executor.submit(self._run_trial, index, parameters, gpu): trial
                        for trial, index, parameters, gpu in batch
                    }
                    for future in as_completed(futures):
                        trial = futures[future]
                        result = future.result()
                        objective = self._objective(result["index"], metric_name)
                        if objective is None:
                            objective = float(result["returncode"])
                            result["objective_source"] = "returncode"
                        else:
                            result["objective_source"] = metric_name
                        result["objective"] = objective
                        study.tell(trial, objective)
                        results.append(result)
                if self._cancel.is_set():
                    break
            state = "cancelled" if self._cancel.is_set() else "finished"
        except BaseException:
            self.storage.update_sweep(self.record["id"], "failed")
            raise
        self.storage.update_sweep(self.record["id"], state)
        return {
            "sweep_id": self.record["id"],
            "state": state,
            "method": "bayesian",
            "best": study.best_params if study.trials else {},
            "best_value": study.best_value if study.trials else None,
            "trials": sorted(results, key=lambda item: item["index"]),
        }

    def _objective(self, index: int, metric_name: str | None) -> float | None:
        if not metric_name:
            return None
        target = str(index)
        for run in self.storage.list_runs(project=self.record["project"], limit=5000):
            config = run.get("config", {})
            if config.get("_oplogs.sweep_id") != self.record["id"]:
                continue
            if str(config.get("_oplogs.sweep_index")) != target:
                continue
            value = run.get("summary", {}).get(metric_name)
            if isinstance(value, (int, float)):
                return float(value)
        return None

    def cancel(self) -> None:
        self._cancel.set()

    def _run_trial(self, index: int, parameters: dict[str, Any], gpu: str | None) -> dict[str, Any]:
        if self._cancel.is_set():
            return {"index": index, "state": "cancelled", "parameters": parameters}
        environment = os.environ.copy()
        environment["OPLOGS_SWEEP_ID"] = self.record["id"]
        environment["OPLOGS_SWEEP_INDEX"] = str(index)
        environment["OPLOGS_SWEEP_CONFIG"] = json.dumps(parameters)
        if gpu is not None:
            environment["CUDA_VISIBLE_DEVICES"] = gpu
        result = subprocess.run(self.command, env=environment, check=False)
        return {
            "index": index,
            "state": "finished" if result.returncode == 0 else "failed",
            "returncode": result.returncode,
            "parameters": parameters,
            "gpu": gpu,
        }


def sweep_config() -> dict[str, Any]:
    return json.loads(os.environ.get("OPLOGS_SWEEP_CONFIG", "{}"))
