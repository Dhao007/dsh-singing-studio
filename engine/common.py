"""Shared helpers for resident singers workers."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np


def pick_device(allow_mps: bool = False) -> str:
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda"
        if allow_mps and getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return "mps"
    except Exception:
        pass
    return "cpu"


def device_label(device: str) -> str:
    if device == "cuda":
        try:
            import torch
            return torch.cuda.get_device_name(0)
        except Exception:
            return "CUDA"
    if device == "mps":
        return "Apple MPS"
    return "CPU"


class Protocol:
    """JSONL protocol on the real stdout; all prints go to stderr."""

    def __init__(self) -> None:
        self.out = sys.stdout
        sys.stdout = sys.stderr

    def send(self, obj: dict) -> None:
        self.out.write(json.dumps(obj, ensure_ascii=False) + "\n")
        self.out.flush()

    def progress(self, req_id, stage: str, value: float) -> None:
        self.send({"type": "progress", "id": req_id, "stage": stage, "value": float(value)})

    def log(self, text: str) -> None:
        print(text, file=sys.stderr, flush=True)


def load_json(path: str):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(path: str, obj) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def f0_percentiles(f0: np.ndarray) -> dict:
    v = f0[f0 > 0]
    if not len(v):
        return {"min": 0, "max": 0, "p1": 0, "p5": 0, "p50": 0, "p95": 0, "p99": 0}
    return {
        "min": float(v.min()), "max": float(v.max()),
        "p1": float(np.percentile(v, 1)), "p5": float(np.percentile(v, 5)),
        "p50": float(np.percentile(v, 50)), "p95": float(np.percentile(v, 95)),
        "p99": float(np.percentile(v, 99)),
    }
