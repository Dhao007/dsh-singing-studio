#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Render a vocal stem with per-interval octave shifts using the local RVC model.

The plan is a list of {start, end, semitones}. Gaps shorter than --fill-gap are
absorbed into the previous interval to avoid needless switches; longer gaps stay
at 0. Output is 48 kHz mono float WAV.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
import warnings
from pathlib import Path

import numpy as np
import soundfile as sf

warnings.filterwarnings("ignore")
OUT_SR = 48000


def log(*a):
    print(*a, flush=True)


def merge_intervals(shifts, duration: float, fill_gap: float):
    """Absolute shifts -> non-overlapping intervals covering [0, duration]."""
    items = []
    for s in sorted(shifts, key=lambda x: x["start"]):
        a = max(0.0, float(s["start"]))
        b = min(duration, float(s["end"]))
        if b - a < 0.02:
            continue
        items.append([a, b, int(s["semitones"])])
    if not items:
        return [[0.0, duration, 0]]
    out = []
    cur = 0.0
    for a, b, s in items:
        if a > cur:
            gap = a - cur
            if out and gap <= fill_gap:
                out[-1][1] = a
            else:
                out.append([cur, a, 0])
        out.append([a, b, s])
        cur = b
    if cur < duration:
        if out and (duration - cur) <= fill_gap:
            out[-1][1] = duration
        else:
            out.append([cur, duration, 0])
    # Merge adjacent same shift.
    merged = []
    for a, b, s in out:
        if merged and merged[-1][2] == s and abs(merged[-1][1] - a) < 1e-6:
            merged[-1][1] = b
        else:
            merged.append([a, b, s])
    return merged


def add_faded(out: np.ndarray, weight: np.ndarray, audio: np.ndarray, start: int, fade: int):
    n = len(audio)
    if n <= 0:
        return
    end = min(len(out), start + n)
    n = end - start
    if n <= 0:
        return
    a = audio[:n].astype(np.float64)
    w = np.ones(n, dtype=np.float64)
    f = min(fade, n // 2)
    if f > 0:
        ramp = np.linspace(0.0, 1.0, f, endpoint=False)
        w[:f] *= ramp
        w[-f:] *= ramp[::-1]
    out[start:end] += a * w
    weight[start:end] += w


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--plan", required=True)
    ap.add_argument("--rvc-dir", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--protect", type=float, default=0.25)
    ap.add_argument("--rms-mix-rate", type=float, default=0.25)
    ap.add_argument("--index-rate", type=float, default=0.0)
    ap.add_argument("--crossfade-ms", type=float, default=50.0)
    ap.add_argument("--fill-gap", type=float, default=0.5)
    args = ap.parse_args()

    rvc_dir = str(Path(args.rvc_dir).expanduser().resolve())
    input_path = str(Path(args.input).expanduser().resolve())
    model_path = Path(args.model).expanduser().resolve()
    plan_path = str(Path(args.plan).expanduser().resolve())
    out_path = str(Path(args.out).expanduser().resolve())

    y, sr = sf.read(input_path, dtype="float64")
    if y.ndim > 1:
        y = y.mean(axis=1)
    duration = len(y) / sr
    plan = json.loads(Path(plan_path).read_text(encoding="utf-8"))
    intervals = merge_intervals(plan.get("shifts", []), duration, args.fill_gap)

    log(f"PROGRESS 0.02 intervals {len(intervals)}")
    sys.path.insert(0, rvc_dir)
    os.chdir(rvc_dir)
    os.environ.setdefault("weight_root", str(model_path.parent))
    os.environ.setdefault("index_root", str(Path(rvc_dir) / "logs"))
    os.environ.setdefault("outside_index_root", str(Path(rvc_dir) / "assets" / "indices"))
    os.environ.setdefault("rmvpe_root", str(Path(rvc_dir) / "assets" / "rmvpe"))

    from configs.config import Config
    from infer.vc.modules import VC

    original_argv = sys.argv[:]
    sys.argv = [sys.argv[0]]
    try:
        config = Config()
    finally:
        sys.argv = original_argv

    log(f"DEVICE {config.device}")
    vc = VC(config)
    vc.get_vc(model_path.name)

    out = np.zeros(int(round(duration * OUT_SR)) + OUT_SR, dtype=np.float64)
    weight = np.zeros_like(out)
    fade = max(1, int(args.crossfade_ms / 1000.0 * OUT_SR))
    pad = 0.08
    tmpdir = tempfile.mkdtemp(prefix="ss-render-")
    try:
        for idx, (a, b, semis) in enumerate(intervals):
            a2 = max(0.0, a - pad)
            b2 = min(duration, b + pad)
            i0 = max(0, int(round(a2 * sr)))
            i1 = min(len(y), int(round(b2 * sr)))
            seg = y[i0:i1]
            if len(seg) < int(0.05 * sr):
                continue
            seg_path = os.path.join(tmpdir, f"seg_{idx:03d}.wav")
            sf.write(seg_path, seg, sr)
            status, result = vc.vc_single(
                0, seg_path, int(semis), "rmvpe", "", float(args.index_rate),
                0, float(args.rms_mix_rate), float(args.protect),
            )
            if not result or result[0] is None or result[1] is None:
                raise RuntimeError(f"RVC 渲染失败：{status}")
            sr_out, audio = result
            audio = np.asarray(audio)
            if audio.dtype == np.int16:
                audio = audio.astype(np.float64) / 32768.0
            else:
                audio = audio.astype(np.float64)
            if audio.ndim > 1:
                audio = audio.mean(axis=1)
            if sr_out != OUT_SR:
                import librosa
                audio = librosa.resample(audio, orig_sr=sr_out, target_sr=OUT_SR)
            start = int(round(i0 / sr * OUT_SR))
            add_faded(out, weight, audio, start, fade)
            log(f"PROGRESS {0.05 + 0.9 * (idx + 1) / len(intervals):.3f} segment {idx + 1}/{len(intervals)} shift {semis}")
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    covered = weight > 1e-6
    out[covered] /= weight[covered]
    out = out[: int(round(duration * OUT_SR))]
    peak = float(np.max(np.abs(out))) if len(out) else 0.0
    if peak > 0.99:
        out *= 0.99 / peak
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    sf.write(out_path, out.astype(np.float32), OUT_SR)
    log(f"PROGRESS 1.0 done {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
