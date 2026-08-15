"""Best-effort automatic tracing for common Python LLM clients."""

from __future__ import annotations

import functools
import inspect
from types import ModuleType
from typing import Any

from .tracing import span

_patched: set[tuple[type[Any], str]] = set()
_patched_functions: set[tuple[str, str]] = set()


def _response_payload(value: Any) -> Any:
    for method in ("model_dump", "to_dict", "dict"):
        converter = getattr(value, method, None)
        if callable(converter):
            try:
                return converter()
            except (TypeError, ValueError):
                continue
    return value


def _patch_method(owner: type[Any], attribute: str, name: str) -> None:
    key = (owner, attribute)
    if key in _patched or not hasattr(owner, attribute):
        return
    original = getattr(owner, attribute)
    if inspect.iscoroutinefunction(original):

        @functools.wraps(original)
        async def async_wrapper(self, *args, **kwargs):
            with span(
                name, {"provider": name.split(".")[0]}, {"args": args, "kwargs": kwargs}
            ) as active_span:
                result = await original(self, *args, **kwargs)
                active_span.set_output(_response_payload(result))
                return result

        setattr(owner, attribute, async_wrapper)
    else:

        @functools.wraps(original)
        def wrapper(self, *args, **kwargs):
            with span(
                name, {"provider": name.split(".")[0]}, {"args": args, "kwargs": kwargs}
            ) as active_span:
                result = original(self, *args, **kwargs)
                active_span.set_output(_response_payload(result))
                return result

        setattr(owner, attribute, wrapper)
    _patched.add(key)


def _patch_function(module: ModuleType, attribute: str, name: str) -> None:
    key = (module.__name__, attribute)
    if key in _patched_functions or not hasattr(module, attribute):
        return
    original = getattr(module, attribute)
    if inspect.iscoroutinefunction(original):

        @functools.wraps(original)
        async def async_wrapper(*args, **kwargs):
            with span(
                name, {"provider": name.split(".")[0]}, {"args": args, "kwargs": kwargs}
            ) as active_span:
                result = await original(*args, **kwargs)
                active_span.set_output(_response_payload(result))
                return result

        setattr(module, attribute, async_wrapper)
    else:

        @functools.wraps(original)
        def wrapper(*args, **kwargs):
            with span(
                name, {"provider": name.split(".")[0]}, {"args": args, "kwargs": kwargs}
            ) as active_span:
                result = original(*args, **kwargs)
                active_span.set_output(_response_payload(result))
                return result

        setattr(module, attribute, wrapper)
    _patched_functions.add(key)


def patch_loaded_providers() -> list[str]:
    patched: list[str] = []
    try:
        from openai.resources.chat.completions import AsyncCompletions, Completions

        _patch_method(Completions, "create", "openai.chat.completions")
        _patch_method(AsyncCompletions, "create", "openai.chat.completions")
        patched.append("openai")
    except ImportError:
        pass
    try:
        from anthropic.resources.messages import AsyncMessages, Messages

        _patch_method(Messages, "create", "anthropic.messages")
        _patch_method(AsyncMessages, "create", "anthropic.messages")
        patched.append("anthropic")
    except ImportError:
        pass
    try:
        import litellm

        _patch_function(litellm, "completion", "litellm.completion")
        _patch_function(litellm, "acompletion", "litellm.completion")
        patched.append("litellm")
    except ImportError:
        pass
    try:
        from langchain_core.language_models.chat_models import BaseChatModel

        _patch_method(BaseChatModel, "invoke", "langchain.chat.invoke")
        _patch_method(BaseChatModel, "ainvoke", "langchain.chat.invoke")
        patched.append("langchain")
    except ImportError:
        pass
    try:
        from llama_index.core.llms.llm import LLM

        for attribute in ("chat", "achat", "complete", "acomplete"):
            _patch_method(LLM, attribute, f"llamaindex.{attribute}")
        patched.append("llamaindex")
    except ImportError:
        pass
    return patched
