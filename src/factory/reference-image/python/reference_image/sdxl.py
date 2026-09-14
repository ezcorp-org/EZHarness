"""One seeded SDXL generation, with the pipeline supplied rather than imported.

The heavy import lives in `load_pipeline` and nowhere else. Everything that
decides what the model is asked — the settings, the seed, the refusal to accept
an unpinned request, and the shape of the result — is ordinary code that runs
without torch. That is what lets this file be exercised rather than excluded,
and it is also what makes the settings testable: a fake pipeline records exactly
what a real one would have been asked for.

C10 records seeds as inputs and makes no claim that the same seed reproduces the
same bytes on different hardware. This module therefore records the seed, the
device, and the runtime it observed alongside the image, so two runs that differ
can be compared rather than argued about.
"""

from __future__ import annotations

import importlib
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol


class GenerationError(RuntimeError):
    """Raised when a generation could not be asked for or could not complete."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class GenerationSettings:
    """Exactly the C10 settings, supplied by the lock and never defaulted here."""

    inference_steps: int
    guidance_scale: float
    width: int
    height: int
    dtype: str
    device: str

    def validate(self) -> None:
        if self.inference_steps <= 0:
            raise GenerationError("generation_settings_invalid", "The inference step count must be positive")
        if self.guidance_scale <= 0:
            raise GenerationError("generation_settings_invalid", "The guidance scale must be positive")
        if self.width <= 0 or self.height <= 0:
            raise GenerationError("generation_settings_invalid", "The output size must be positive")
        if not self.dtype:
            raise GenerationError("generation_settings_invalid", "The tensor type must be named")
        if not self.device:
            raise GenerationError("generation_settings_invalid", "The device must be named")


class Pipeline(Protocol):
    """The one call this pack makes into the model.

    Written as a protocol so a test supplies a recorder and the guest supplies
    the real pipeline, with no branch inside the generator deciding which it has.
    """

    def __call__(self, **kwargs: Any) -> Any: ...  # noqa: ANN401


@dataclass(frozen=True)
class GeneratedVariant:
    """One variant's bytes and the facts needed to audit how it was produced."""

    seed: int
    prompt: str
    png: bytes
    settings: GenerationSettings
    runtime: dict[str, str]


def load_pipeline(model_directory: str, dtype_name: str, device: str) -> Pipeline:
    """Imports diffusers and loads the pinned weights from the sealed closure.

    `local_files_only` is not optional. The guest has no network, so a pipeline
    that tried to resolve anything remotely would fail confusingly; stating it
    makes the intent explicit and turns a missing file into a clear error.
    """
    try:
        diffusers = importlib.import_module("diffusers")
        torch = importlib.import_module("torch")
    except ImportError as error:
        raise GenerationError(
            "generation_runtime_missing", f"The generation runtime is unavailable: {error}"
        ) from error
    dtype = getattr(torch, dtype_name, None)
    if dtype is None:
        raise GenerationError("generation_dtype_unknown", f"The tensor type {dtype_name} is not defined")
    pipeline = diffusers.StableDiffusionXLPipeline.from_pretrained(
        model_directory,
        torch_dtype=dtype,
        variant="fp16",
        use_safetensors=True,
        local_files_only=True,
        add_watermarker=False,
    )
    moved: Pipeline = pipeline.to(device)
    return moved


def _generator_for(seed: int, device: str) -> Any:  # noqa: ANN401
    """The seeded generator the pipeline draws from."""
    torch = importlib.import_module("torch")
    return torch.Generator(device=device).manual_seed(seed)


def assert_generation_request(prompt: str, seed: int, settings: GenerationSettings) -> None:
    """Checks everything about a request that needs no model to check.

    A caller runs this before loading weights. Refusing an empty prompt or a
    negative seed should not require a GPU, and making the refusal depend on the
    runtime would turn a bad request into a runtime error on a host that has no
    torch and into a clear refusal on one that does.
    """
    settings.validate()
    if not prompt.strip():
        raise GenerationError("generation_prompt_empty", "The prompt must not be empty")
    if seed < 0:
        raise GenerationError("generation_seed_invalid", "The seed must be a nonnegative integer")


def generate(
    pipeline: Pipeline,
    prompt: str,
    seed: int,
    settings: GenerationSettings,
    encode: Callable[[Any], bytes],
    runtime: dict[str, str],
    generator_factory: Callable[[int, str], Any] = _generator_for,
) -> GeneratedVariant:
    """Asks for one variant at one seed.

    Every argument the model receives is stated here, so the recorded call is the
    whole of what was asked. A pipeline that returns no image is an error rather
    than an empty variant, because an empty variant would be indistinguishable
    from a picture of nothing.
    """
    assert_generation_request(prompt, seed, settings)
    result = pipeline(
        prompt=prompt,
        num_inference_steps=settings.inference_steps,
        guidance_scale=settings.guidance_scale,
        width=settings.width,
        height=settings.height,
        generator=generator_factory(seed, settings.device),
    )
    images = getattr(result, "images", None)
    if not images:
        raise GenerationError("generation_no_image", "The pipeline returned no image")
    return GeneratedVariant(
        seed=seed, prompt=prompt, png=encode(images[0]), settings=settings, runtime=dict(runtime)
    )


def runtime_facts() -> dict[str, str]:
    """What the guest observed about its own runtime, for the evidence record."""
    try:
        torch = importlib.import_module("torch")
    except ImportError as error:
        raise GenerationError(
            "generation_runtime_missing", f"The generation runtime is unavailable: {error}"
        ) from error
    facts = {"torch": str(torch.__version__)}
    version = getattr(torch, "version", None)
    hip = getattr(version, "hip", None) if version is not None else None
    if hip:
        facts["hip"] = str(hip)
    cuda = getattr(version, "cuda", None) if version is not None else None
    if cuda:
        facts["cuda"] = str(cuda)
    return facts
