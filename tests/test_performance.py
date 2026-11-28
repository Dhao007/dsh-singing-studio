"""CPU regression tests; no voice weights or CUDA device required."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "vendor" / "rvc"))
sys.path.insert(0, str(ROOT / "engine"))

from infer.module.commons import clip_grad_value_
from soulx_engine import SoulxEngine
from tools import cuda_graph


class GradientTests(unittest.TestCase):
    def test_norm_and_clipping_preserve_preclip_measurement(self):
        parameters = [torch.nn.Parameter(torch.zeros(2)) for _ in range(3)]
        parameters[0].grad = torch.tensor([3.0, -4.0])
        parameters[1].grad = torch.tensor([0.0, 12.0])
        self.assertAlmostEqual(clip_grad_value_(parameters, None), 13.0)
        torch.testing.assert_close(parameters[0].grad, torch.tensor([3.0, -4.0]))
        self.assertAlmostEqual(clip_grad_value_(parameters, 2.0), 13.0)
        torch.testing.assert_close(parameters[0].grad, torch.tensor([2.0, -2.0]))
        torch.testing.assert_close(parameters[1].grad, torch.tensor([0.0, 2.0]))

    def test_empty_and_l1_norm(self):
        self.assertEqual(clip_grad_value_([], None), 0.0)
        parameter = torch.nn.Parameter(torch.zeros(2))
        parameter.grad = torch.tensor([3.0, -4.0])
        self.assertEqual(clip_grad_value_(parameter, None, norm_type=1), 7.0)


class GraphTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {
            "RVC_CUDA_GRAPH": "1", "RVC_CUDA_GRAPH_MIN_CALLS": "3",
            "RVC_CUDA_GRAPH_MAX_CACHE": "2",
        })
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_non_cuda_devices_never_capture(self):
        with patch.object(cuda_graph, "_CapturedCall") as capture:
            for device in ("cpu", "mps", "privateuseone:0"):
                self.assertFalse(cuda_graph.cuda_graph_enabled(device))
            value = torch.tensor([2.0])
            torch.testing.assert_close(
                cuda_graph.run_cuda_graph(Mock(), "test", lambda x: x + 1, value),
                torch.tensor([3.0]),
            )
            capture.assert_not_called()

    def test_capture_only_after_reuse_and_replay_reads_new_input(self):
        cache = cuda_graph._GraphCache()
        entry = Mock(capture_ms=1.0)
        entry.replay.side_effect = lambda inputs: inputs[0] + 1
        with patch.object(cuda_graph, "_CapturedCall", return_value=entry) as capture:
            for number in range(4):
                value = torch.tensor([float(number)])
                torch.testing.assert_close(cache.run(("test",), lambda x: x + 1, (value,)), value + 1)
                self.assertEqual(capture.call_count, int(number >= 2))
        self.assertEqual(cache.deferred_count, 2)
        self.assertEqual(cache.replay_count, 2)

    def test_variable_lengths_have_bounded_pending_cache(self):
        cache = cuda_graph._GraphCache()
        with patch.object(cuda_graph, "_CapturedCall") as capture:
            for length in range(1, 30):
                cache.run(("test",), lambda x: x, (torch.ones(length),))
            capture.assert_not_called()
        self.assertLessEqual(len(cache.pending), 8)

    def test_capture_failure_keeps_eager_available(self):
        cache = cuda_graph._GraphCache()
        with patch.dict(os.environ, {"RVC_CUDA_GRAPH_MIN_CALLS": "1"}), patch.object(
            cuda_graph, "_CapturedCall", side_effect=RuntimeError("unsupported operator")
        ) as capture, self.assertLogs(cuda_graph.logger, level="ERROR"):
            for _ in range(2):
                result = cache.run(("test",), lambda x: x + 1, (torch.ones(1),))
                torch.testing.assert_close(result, torch.tensor([2.0]))
        capture.assert_called_once()
        self.assertEqual(cache.fallback_count, 2)


class PromptTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "voice.wav"
        self.path.write_bytes(b"source")
        self.engine = SoulxEngine.__new__(SoulxEngine)
        self.engine.device = "cpu"
        self.engine._prompt_cache = None
        self.engine._load_wav = Mock(return_value=torch.ones(1, 48000))
        self.engine._f0 = Mock(side_effect=lambda wav: np.ones(wav.shape[-1] // 480, dtype=np.float32))
        self.engine.model = Mock()
        self.engine.model.mel = Mock(side_effect=lambda wav: wav[:, ::480] * 2)

    def test_reuse_isolated_from_in_place_inference(self):
        values = self.engine._prepare_prompt(self.path, 1)
        self.assertEqual(values[0].shape[-1], 24000)
        for value in values:
            value.zero_()
        again = self.engine._prepare_prompt(self.path, 1)
        self.assertTrue(all(torch.all(value > 0) for value in again))
        self.engine._load_wav.assert_called_once()
        self.engine._f0.assert_called_once()
        self.engine.model.mel.assert_called_once()

    def test_file_and_duration_changes_invalidate(self):
        self.engine._prepare_prompt(self.path, 1)
        longer = self.engine._prepare_prompt(self.path, 2)
        self.assertEqual(longer[0].shape[-1], 48000)
        self.path.write_bytes(b"new source content")
        self.engine._prepare_prompt(self.path, 2)
        self.assertEqual(self.engine._f0.call_count, 3)

    def test_invalid_duration_and_deleted_source_do_not_use_cache(self):
        self.engine._prepare_prompt(self.path, 1)
        for value in (0, -1, float("inf"), float("nan")):
            with self.assertRaises(ValueError):
                self.engine._prepare_prompt(self.path, value)
        self.path.unlink()
        with self.assertRaises(FileNotFoundError):
            self.engine._prepare_prompt(self.path, 1)


if __name__ == "__main__":
    unittest.main()
