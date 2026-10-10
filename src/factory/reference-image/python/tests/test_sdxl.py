"""What the generator asks the model, and what it refuses to ask."""

from __future__ import annotations

import dataclasses
import sys
import types
import unittest
from typing import Any
from unittest import mock

from reference_image.sdxl import (
    GenerationError,
    GenerationSettings,
    generate,
    load_pipeline,
    runtime_facts,
)

SETTINGS = GenerationSettings(
    inference_steps=30, guidance_scale=7.5, width=1024, height=1024, dtype="float16", device="cuda"
)


class Recorder:
    """A pipeline that records exactly what it was asked for."""

    def __init__(self, images: list[str] | None = None) -> None:
        self.calls: list[dict[str, Any]] = []
        self.images = ["picture"] if images is None else images

    def __call__(self, **kwargs: Any) -> Any:  # noqa: ANN401
        self.calls.append(kwargs)
        return types.SimpleNamespace(images=self.images)


def fake_generator(seed: int, device: str) -> str:
    return f"generator({seed},{device})"


class GenerateTest(unittest.TestCase):
    def test_asks_for_exactly_the_locked_settings(self) -> None:
        pipeline = Recorder()
        generate(pipeline, "one green oak tree", 11, SETTINGS, lambda image: str(image).encode(), {}, fake_generator)
        self.assertEqual(
            pipeline.calls[0],
            {
                "prompt": "one green oak tree",
                "num_inference_steps": 30,
                "guidance_scale": 7.5,
                "width": 1024,
                "height": 1024,
                "generator": "generator(11,cuda)",
            },
        )

    def test_each_seed_reaches_the_generator_unchanged(self) -> None:
        pipeline = Recorder()
        for seed in (11, 23, 37, 53):
            generate(pipeline, "tree", seed, SETTINGS, lambda image: b"x", {}, fake_generator)
        expected = [f"generator({seed},cuda)" for seed in (11, 23, 37, 53)]
        self.assertEqual([call["generator"] for call in pipeline.calls], expected)

    def test_returns_the_encoded_bytes_with_the_seed_and_runtime(self) -> None:
        variant = generate(
            Recorder(), "tree", 37, SETTINGS, lambda image: b"PNGBYTES", {"torch": "2.12.0"}, fake_generator
        )
        self.assertEqual(variant.png, b"PNGBYTES")
        self.assertEqual(variant.seed, 37)
        self.assertEqual(variant.prompt, "tree")
        self.assertEqual(variant.runtime, {"torch": "2.12.0"})
        self.assertEqual(variant.settings, SETTINGS)

    def test_the_recorded_runtime_is_a_copy(self) -> None:
        runtime = {"torch": "2.12.0"}
        variant = generate(Recorder(), "tree", 11, SETTINGS, lambda image: b"x", runtime, fake_generator)
        runtime["torch"] = "changed"
        self.assertEqual(variant.runtime, {"torch": "2.12.0"})

    def test_a_pipeline_that_returns_no_image_is_an_error(self) -> None:
        with self.assertRaises(GenerationError) as caught:
            generate(Recorder(images=[]), "tree", 11, SETTINGS, lambda image: b"x", {}, fake_generator)
        self.assertEqual(caught.exception.code, "generation_no_image")

    def test_a_result_without_an_images_field_is_an_error(self) -> None:
        class Bare:
            def __call__(self, **kwargs: Any) -> Any:  # noqa: ANN401
                return object()

        with self.assertRaises(GenerationError) as caught:
            generate(Bare(), "tree", 11, SETTINGS, lambda image: b"x", {}, fake_generator)
        self.assertEqual(caught.exception.code, "generation_no_image")

    def test_an_empty_prompt_is_refused_before_the_model_is_called(self) -> None:
        pipeline = Recorder()
        with self.assertRaises(GenerationError) as caught:
            generate(pipeline, "   ", 11, SETTINGS, lambda image: b"x", {}, fake_generator)
        self.assertEqual(caught.exception.code, "generation_prompt_empty")
        self.assertEqual(pipeline.calls, [])

    def test_a_negative_seed_is_refused_before_the_model_is_called(self) -> None:
        pipeline = Recorder()
        with self.assertRaises(GenerationError) as caught:
            generate(pipeline, "tree", -1, SETTINGS, lambda image: b"x", {}, fake_generator)
        self.assertEqual(caught.exception.code, "generation_seed_invalid")
        self.assertEqual(pipeline.calls, [])


class SettingsTest(unittest.TestCase):
    def test_the_locked_settings_are_valid(self) -> None:
        SETTINGS.validate()

    def test_every_unusable_setting_is_refused_by_name(self) -> None:
        broken = [
            dataclasses.replace(SETTINGS, inference_steps=0),
            dataclasses.replace(SETTINGS, guidance_scale=0.0),
            dataclasses.replace(SETTINGS, width=0),
            dataclasses.replace(SETTINGS, height=-1),
            dataclasses.replace(SETTINGS, dtype=""),
            dataclasses.replace(SETTINGS, device=""),
        ]
        for settings in broken:
            with self.subTest(settings=settings), self.assertRaises(GenerationError) as caught:
                settings.validate()
            self.assertEqual(caught.exception.code, "generation_settings_invalid")


class LoadPipelineTest(unittest.TestCase):
    """The real import path, exercised with a substituted module.

    Substituting the module rather than skipping the test means the argument
    vector this pack passes to diffusers is measured on every run, including on
    a host with no torch.
    """

    def _install(self, dtype: Any = "float16-dtype") -> tuple[types.ModuleType, types.ModuleType, list[dict[str, Any]]]:  # noqa: ANN401
        calls: list[dict[str, Any]] = []

        class Pipe:
            def to(self, device: str) -> str:
                calls.append({"to": device})
                return f"pipeline-on-{device}"

        class Loader:
            @staticmethod
            def from_pretrained(directory: str, **kwargs: Any) -> Pipe:  # noqa: ANN401
                calls.append({"from_pretrained": directory, **kwargs})
                return Pipe()

        diffusers = types.ModuleType("diffusers")
        diffusers.StableDiffusionXLPipeline = Loader  # type: ignore[attr-defined]
        torch = types.ModuleType("torch")
        if dtype is not None:
            torch.float16 = dtype  # type: ignore[attr-defined]
        torch.__version__ = "2.12.0+rocm7.14.1"  # type: ignore[attr-defined]
        return diffusers, torch, calls

    def test_loads_the_pinned_weights_without_touching_the_network(self) -> None:
        diffusers, torch, calls = self._install()
        with mock.patch.dict(sys.modules, {"diffusers": diffusers, "torch": torch}):
            result = load_pipeline("/opt/reference-image/model", "float16", "cuda")
        self.assertEqual(result, "pipeline-on-cuda")
        loaded = calls[0]
        self.assertEqual(loaded["from_pretrained"], "/opt/reference-image/model")
        self.assertTrue(loaded["local_files_only"])
        self.assertTrue(loaded["use_safetensors"])
        self.assertFalse(loaded["add_watermarker"])
        self.assertEqual(loaded["variant"], "fp16")
        self.assertEqual(loaded["torch_dtype"], "float16-dtype")

    def test_a_missing_runtime_is_a_named_error(self) -> None:
        with mock.patch.dict(sys.modules, {"diffusers": None}), self.assertRaises(GenerationError) as caught:
            load_pipeline("/opt/model", "float16", "cuda")
        self.assertEqual(caught.exception.code, "generation_runtime_missing")

    def test_an_undefined_tensor_type_is_a_named_error(self) -> None:
        diffusers, torch, _ = self._install(dtype=None)
        with mock.patch.dict(sys.modules, {"diffusers": diffusers, "torch": torch}), self.assertRaises(
            GenerationError
        ) as caught:
            load_pipeline("/opt/model", "float16", "cuda")
        self.assertEqual(caught.exception.code, "generation_dtype_unknown")


class RuntimeFactsTest(unittest.TestCase):
    def test_reports_the_rocm_build_when_one_is_present(self) -> None:
        torch = types.ModuleType("torch")
        torch.__version__ = "2.12.0+rocm7.14.1"  # type: ignore[attr-defined]
        torch.version = types.SimpleNamespace(hip="7.14.60850", cuda=None)  # type: ignore[attr-defined]
        with mock.patch.dict(sys.modules, {"torch": torch}):
            self.assertEqual(runtime_facts(), {"torch": "2.12.0+rocm7.14.1", "hip": "7.14.60850"})

    def test_reports_the_cuda_build_when_one_is_present(self) -> None:
        torch = types.ModuleType("torch")
        torch.__version__ = "2.12.0+cu128"  # type: ignore[attr-defined]
        torch.version = types.SimpleNamespace(hip=None, cuda="12.8")  # type: ignore[attr-defined]
        with mock.patch.dict(sys.modules, {"torch": torch}):
            self.assertEqual(runtime_facts(), {"torch": "2.12.0+cu128", "cuda": "12.8"})

    def test_reports_only_the_version_when_neither_is_present(self) -> None:
        torch = types.ModuleType("torch")
        torch.__version__ = "2.12.0"  # type: ignore[attr-defined]
        with mock.patch.dict(sys.modules, {"torch": torch}):
            self.assertEqual(runtime_facts(), {"torch": "2.12.0"})

    def test_a_missing_runtime_is_a_named_error(self) -> None:
        with mock.patch.dict(sys.modules, {"torch": None}), self.assertRaises(GenerationError) as caught:
            runtime_facts()
        self.assertEqual(caught.exception.code, "generation_runtime_missing")


if __name__ == "__main__":
    unittest.main()
