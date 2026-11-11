#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SoulX-Singer SVC backend.

Zero-shot singing voice conversion: source vocal + per-frame F0 (already shifted
by the plugin's octave plan) + a short timbre prompt. Output is 24 kHz mono.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import warnings
from pathlib import Path

import numpy as np
import soundfile as sf
import torch

warnings.filterwarnings("ignore")

SAMPLE_RATE = 24000
HOP = 480
FPS = SAMPLE_RATE // HOP  # 50


def log(*a):
    print(*a, flush=True)


def load_wav_24k(path: str) -> torch.Tensor:
    import torchaudio
    wav, sr = torchaudio.load(path)
    if wav.shape[0] > 1:
        wav = wav.mean(0, keepdim=True)
    if sr != SAMPLE_RATE:
        wav = torchaudio.functional.resample(wav, sr, SAMPLE_RATE)
    return wav


def f0_pyworld(wav: torch.Tensor, fps: int = FPS) -> np.ndarray:
    audio = wav.squeeze(0).double().cpu().numpy()
    try:
        import pyworld as pw
        f0, t = pw.harvest(
            audio, SAMPLE_RATE,
            f0_floor=70.0, f0_ceil=1100.0,
            frame_period=1000.0 / fps,
        )
        return f0.astype(np.float32)
    except Exception:
        import librosa
        f0, _, _ = librosa.pyin(
            audio.astype(np.float32), fmin=70.0, fmax=1100.0, sr=SAMPLE_RATE,
            frame_length=2048, hop_length=HOP,
        )
        return np.nan_to_num(f0, nan=0.0).astype(np.float32)


def fit_length(arr: np.ndarray, n: int) -> np.ndarray:
    if len(arr) == n:
        return arr
    if len(arr) > n:
        return arr[:n]
    return np.pad(arr, (0, n - len(arr)), mode="constant")


def resample_f0(f0: np.ndarray, src_fps: int, dst_fps: int, n_dst: int) -> np.ndarray:
    if src_fps == dst_fps and len(f0) == n_dst:
        return f0.astype(np.float32)
    idx = np.floor(np.arange(n_dst) * src_fps / dst_fps).astype(np.int64)
    idx = np.clip(idx, 0, max(0, len(f0) - 1))
    return f0[idx].astype(np.float32)


def shift_curve(plan: dict, n_frames: int, fps: int = FPS, ramp_ms: float = 20.0) -> np.ndarray:
    """Per-frame semitone curve from plan.shifts; gaps are 0. Short ramps avoid clicks."""
    curve = np.zeros(n_frames, dtype=np.float32)
    for s in plan.get("shifts", []):
        a = max(0, int(round(float(s["start"]) * fps)))
        b = min(n_frames, int(round(float(s["end"]) * fps)))
        if b > a:
            curve[a:b] = float(s.get("semitones", 0))
    # Ramp only inside a segment at its edges, not across silence.
    r = max(1, int(round(ramp_ms / 1000.0 * fps)))
    for s in plan.get("shifts", []):
        a = max(0, int(round(float(s["start"]) * fps)))
        b = min(n_frames, int(round(float(s["end"]) * fps)))
        v = float(s.get("semitones", 0))
        if v == 0 or b - a < 2 * r + 2:
            continue
        curve[a:a + r] = np.linspace(0.0, v, r, endpoint=False)
        curve[b - r:b] = np.linspace(v, 0.0, r, endpoint=False)
    return curve


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--analysis", required=True)
    ap.add_argument("--plan", required=True)
    ap.add_argument("--prompt-wav", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--config", required=True)
    ap.add_argument("--soulx-dir", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--n-steps", type=int, default=16)
    ap.add_argument("--cfg", type=float, default=3.0)
    ap.add_argument("--prompt-seconds", type=float, default=12.0)
    ap.add_argument("--no-shift", action="store_true")
    args = ap.parse_args()

    soulx_dir = str(Path(args.soulx_dir).expanduser().resolve())
    input_path = str(Path(args.input).expanduser().resolve())
    analysis_path = str(Path(args.analysis).expanduser().resolve())
    plan_path = str(Path(args.plan).expanduser().resolve())
    prompt_path = str(Path(args.prompt_wav).expanduser().resolve())
    model_path = str(Path(args.model).expanduser().resolve())
    config_path = str(Path(args.config).expanduser().resolve())
    out_path = str(Path(args.out).expanduser().resolve())

    sys.path.insert(0, soulx_dir)
    os.chdir(soulx_dir)

    log("PROGRESS 0.03 load")
    analysis = json.loads(Path(analysis_path).read_text(encoding="utf-8"))
    plan = json.loads(Path(plan_path).read_text(encoding="utf-8"))
    target = load_wav_24k(input_path)
    duration = target.shape[-1] / SAMPLE_RATE
    n_frames = int(round(duration * FPS))
    log(f"TARGET {duration:.2f}s {n_frames} frames")

    # Target F0: analysis is 100 fps on 16 kHz; resample to 50 fps.
    f0 = np.asarray(analysis.get("f0") or [], dtype=np.float32)
    if len(f0) == 0:
        f0 = f0_pyworld(target)
    else:
        f0 = resample_f0(f0, int(analysis.get("fps", 100)), FPS, n_frames)
    f0 = fit_length(f0, n_frames)
    if not args.no_shift:
        curve = shift_curve(plan, n_frames)
        voiced = f0 > 0
        f0[voiced] = f0[voiced] * np.power(2.0, curve[voiced] / 12.0)
    log(f"F0 {float(f0[f0 > 0].min()) if (f0 > 0).any() else 0:.1f}-{float(f0[f0 > 0].max()) if (f0 > 0).any() else 0:.1f} Hz")

    # Prompt: trim to a clean, bounded clip; F0 at the same rate.
    prompt = load_wav_24k(prompt_path)
    max_len = int(args.prompt_seconds * SAMPLE_RATE)
    if prompt.shape[-1] > max_len:
        prompt = prompt[..., :max_len]
    pt_f0 = fit_length(f0_pyworld(prompt), int(round(prompt.shape[-1] / SAMPLE_RATE * FPS)))

    log("PROGRESS 0.10 model")
    from soulxsinger.models.soulxsinger_svc import SoulXSingerSVC
    from soulxsinger.utils.file_utils import load_config

    config = load_config(config_path)
    model = SoulXSingerSVC(config)
    checkpoint = torch.load(model_path, map_location="cpu", weights_only=False)
    if "state_dict" not in checkpoint:
        raise KeyError("checkpoint 没有 state_dict")
    model.load_state_dict(checkpoint["state_dict"], strict=True)
    model.eval()
    device = torch.device(args.device)
    model.to(device)
    log(f"DEVICE {device}")

    pt_wav = prompt.to(device)
    gt_wav = target.to(device)
    pt_f0_t = torch.from_numpy(pt_f0).unsqueeze(0).to(device)
    gt_f0_t = torch.from_numpy(f0).unsqueeze(0).to(device)

    log("PROGRESS 0.15 infer")
    with torch.no_grad():
        pt_mel = model.mel(pt_wav.float())
        overlap_segments, segments = model.build_vocal_segments(
            gt_f0_t.squeeze(0), f0_rate=FPS, uv_frames_th=10,
            min_duration_sec=15.0, max_duration_sec=30.0,
        )
        if not segments:
            segments = [(0.0, duration)]
            overlap_segments = [(0.0, duration)]
        generated = torch.zeros_like(gt_wav)
        for idx, (seg_start, seg_end) in enumerate(segments):
            ov_start, ov_end = overlap_segments[idx]
            w0 = max(0, min(int(round(ov_start * SAMPLE_RATE)), gt_wav.shape[-1]))
            w1 = max(w0, min(int(round(ov_end * SAMPLE_RATE)), gt_wav.shape[-1]))
            f0a = max(0, min(int(round(ov_start * FPS)), gt_f0_t.shape[-1]))
            f0b = max(f0a, min(int(round(ov_end * FPS)), gt_f0_t.shape[-1]))
            seg_wav = gt_wav[:, w0:w1]
            seg_f0 = gt_f0_t[:, f0a:f0b]
            seg_audio = model.infer_segment(
                pt_mel=pt_mel, pt_wav=pt_wav, gt_wav=seg_wav,
                pt_f0=pt_f0_t, gt_f0=seg_f0,
                pitch_shift=0, n_steps=int(args.n_steps), cfg=float(args.cfg),
            )
            a = int(round(seg_start * SAMPLE_RATE))
            b = int(round(seg_end * SAMPLE_RATE))
            piece = seg_audio[(a - w0):(b - w0)]
            generated[:, a:a + piece.shape[-1]] = piece
            log(f"PROGRESS {0.15 + 0.7 * (idx + 1) / len(segments):.3f} segment {idx + 1}/{len(segments)}")
    out = generated.squeeze(0).float().cpu().numpy()
    want = int(round(duration * SAMPLE_RATE))
    if len(out) > want:
        out = out[:want]
    elif len(out) < want:
        out = np.pad(out, (0, want - len(out)), mode="constant")
    peak = float(np.max(np.abs(out))) if len(out) else 0.0
    if peak > 0.99:
        out *= 0.99 / peak
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    sf.write(out_path, out.astype(np.float32), SAMPLE_RATE)
    log(f"PROGRESS 1.0 done {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
