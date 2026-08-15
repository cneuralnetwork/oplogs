"""Framework autologging without importing heavy libraries eagerly."""

from __future__ import annotations

import functools
import sys
import threading
import time
from typing import Any

_patched: set[str] = set()


def _active_run() -> Any | None:
    from ..sdk import current_run

    run = current_run()
    return run if run and not getattr(run, "_finished", True) else None


def _announce(run: Any, name: str, payload: dict[str, Any]) -> None:
    announced = getattr(run, "_announced_integrations", set())
    if name in announced:
        return
    run._announced_integrations = {*announced, name}
    run._emit("integration", {"name": name, **payload})


def _patch_huggingface(run: Any) -> bool:
    try:
        import transformers
        from transformers import Trainer
    except ImportError:
        return False
    _announce(run, "transformers", {"version": getattr(transformers, "__version__", "unknown")})
    if "transformers" in _patched:
        return True
    original = Trainer.log

    @functools.wraps(original)
    def log(self, logs, *args, **kwargs):
        active = _active_run()
        numeric = {
            f"huggingface.{key}": value
            for key, value in logs.items()
            if isinstance(value, (int, float))
        }
        if active and numeric:
            active.log(numeric, step=getattr(self.state, "global_step", None))
        return original(self, logs, *args, **kwargs)

    Trainer.log = log
    _patched.add("transformers")
    return True


def _patch_keras(run: Any) -> bool:
    try:
        import keras
    except ImportError:
        return False
    _announce(run, "keras", {"version": getattr(keras, "__version__", "unknown")})
    if "keras" in _patched:
        return True
    original = keras.Model.fit

    class OplogsCallback(keras.callbacks.Callback):
        _oplogs_callback = True

        def on_epoch_end(self, epoch, logs=None):
            active = _active_run()
            numeric = {
                f"keras.{key}": value
                for key, value in (logs or {}).items()
                if isinstance(value, (int, float))
            }
            if active and numeric:
                active.log(numeric, step=epoch)

    @functools.wraps(original)
    def fit(self, *args, **kwargs):
        callbacks = list(kwargs.pop("callbacks", []) or [])
        if not any(getattr(callback, "_oplogs_callback", False) for callback in callbacks):
            callbacks.append(OplogsCallback())
        return original(self, *args, callbacks=callbacks, **kwargs)

    keras.Model.fit = fit
    _patched.add("keras")
    return True


def _patch_lightning(run: Any) -> bool:
    module = sys.modules.get("lightning.pytorch") or sys.modules.get("pytorch_lightning")
    if not module:
        return False
    _announce(run, "lightning", {"version": getattr(module, "__version__", "unknown")})
    if "lightning" in _patched:
        return True
    callback_base = module.Callback

    class OplogsCallback(callback_base):
        _oplogs_callback = True

        def on_train_epoch_end(self, trainer, pl_module):
            del pl_module
            active = _active_run()
            values = {
                f"lightning.{key}": value.item() if hasattr(value, "item") else value
                for key, value in trainer.callback_metrics.items()
                if isinstance(value, (int, float)) or hasattr(value, "item")
            }
            if active and values:
                active.log(values, step=trainer.global_step)

    original = module.Trainer.__init__

    @functools.wraps(original)
    def trainer_init(self, *args, **kwargs):
        callbacks = list(kwargs.pop("callbacks", []) or [])
        if not any(getattr(callback, "_oplogs_callback", False) for callback in callbacks):
            callbacks.append(OplogsCallback())
        return original(self, *args, callbacks=callbacks, **kwargs)

    module.Trainer.__init__ = trainer_init
    _patched.add("lightning")
    return True


def _patch_optimizer(optimizer_type: type[Any]) -> None:
    key = f"torch.optimizer:{optimizer_type.__module__}.{optimizer_type.__qualname__}"
    if key in _patched or "step" not in optimizer_type.__dict__:
        return
    original = optimizer_type.__dict__["step"]

    @functools.wraps(original)
    def step(self, *args, **kwargs):
        result = original(self, *args, **kwargs)
        active = _active_run()
        if active:
            count = int(getattr(self, "_oplogs_step", 0)) + 1
            self._oplogs_step = count
            active.log(
                {
                    f"pytorch.lr.group_{index}": group.get("lr", 0.0)
                    for index, group in enumerate(self.param_groups)
                },
                step=count,
            )
        return result

    optimizer_type.step = step
    _patched.add(key)


def _patch_torch(run: Any) -> bool:
    try:
        import torch
    except ImportError:
        return False
    _announce(
        run,
        "pytorch",
        {
            "version": torch.__version__,
            "cuda_available": torch.cuda.is_available(),
            "device_count": torch.cuda.device_count(),
        },
    )
    for candidate in vars(torch.optim).values():
        if isinstance(candidate, type) and issubclass(candidate, torch.optim.Optimizer):
            _patch_optimizer(candidate)
    return True


def _capture_jax(run: Any) -> bool:
    try:
        import jax
    except ImportError:
        return False
    _announce(
        run,
        "jax",
        {
            "version": getattr(jax, "__version__", "unknown"),
            "devices": [str(device) for device in jax.devices()],
        },
    )
    return True


def _estimator_subclasses(base: type[Any]) -> list[type[Any]]:
    found: list[type[Any]] = []
    queue = list(base.__subclasses__())
    while queue:
        candidate = queue.pop()
        if candidate in found:
            continue
        found.append(candidate)
        queue.extend(candidate.__subclasses__())
    return found


def _patch_estimator(estimator_type: type[Any]) -> None:
    key = f"sklearn.estimator:{estimator_type.__module__}.{estimator_type.__qualname__}"
    if key in _patched or "fit" not in estimator_type.__dict__:
        return
    original = estimator_type.__dict__["fit"]
    if not callable(original):
        return

    @functools.wraps(original)
    def fit(self, *args, **kwargs):
        result = original(self, *args, **kwargs)
        active = _active_run()
        if active:
            try:
                parameters = self.get_params(deep=False)
            except Exception:
                parameters = {}
            active._emit(
                "model",
                {
                    "framework": "scikit-learn",
                    "class": f"{type(self).__module__}.{type(self).__qualname__}",
                    "parameters": parameters,
                },
            )
        return result

    estimator_type.fit = fit
    _patched.add(key)


def _capture_sklearn(run: Any) -> bool:
    try:
        import sklearn
        from sklearn.base import BaseEstimator
    except ImportError:
        return False
    _announce(run, "scikit-learn", {"version": sklearn.__version__})
    for estimator_type in _estimator_subclasses(BaseEstimator):
        _patch_estimator(estimator_type)
    return True


def enable_autolog(run: Any) -> None:
    def monitor() -> None:
        patchers = [
            _patch_torch,
            _patch_keras,
            _patch_lightning,
            _patch_huggingface,
            _capture_jax,
            _capture_sklearn,
        ]
        while not getattr(run, "_finished", True):
            for patcher in patchers:
                try:
                    patcher(run)
                except Exception as exc:
                    run._emit(
                        "integration.error", {"integration": patcher.__name__, "error": str(exc)}
                    )
            try:
                from ..provider_tracing import patch_loaded_providers

                patch_loaded_providers()
            except Exception as exc:
                run._emit(
                    "integration.error", {"integration": "provider_tracing", "error": str(exc)}
                )
            time.sleep(1)

    threading.Thread(target=monitor, name="oplogs-autolog", daemon=True).start()
