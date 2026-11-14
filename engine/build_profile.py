#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Build an RVC pitch-range profile from an audio file or a training-data folder.

IMPORTANT: do not rename this file to profile.py. RVC/SoulX workers put this
engine/ directory on sys.path; a local profile.py shadows the Python stdlib
module and breaks transformers' lazy imports (HubertModel).

This is the same statistic used by train.py: voiced-frame F0 percentiles from
clean target-voice audio, analysed with RMVPE. It does not load or run the RVC
checkpoint; the .pth only supplies the model id / display name.
"""
from __future__ import annotations

import argparse
import json
import sys
import warnings
from pathlib import Path

import numpy as np

warnings.filterwarnings("ignore")

AUDIO_EXTS = {".wav", ".flac", ".mp3", ".m4a", ".aac", ".ogg", ".opus", ".wma"}


def collect_audio(path: Path, out: list[Path], depth: int = 0) -> None:
    if depth > 6 or len(out) >= 2000:
        return
    if path.is_file():
        if path.suffix.lower() in AUDIO_EXTS:
            out.append(path)
        return
    if not path.is_dir():
        return
    try:
        entries = sorted(path.iterdir(), key=lambda p: p.name.lower())
    except OSError:
        return
    for entry in entries:
        if entry.name.startswith("."):
            continue
        if entry.is_dir():
            collect_audio(entry, out, depth + 1)
        elif entry.suffix.lower() in AUDIO_EXTS:
            out.append(entry)
        if len(out) >= 2000:
            return


def load_chunk(path: Path, max_seconds: float):
    import librosa
    import soundfile as sf

    y, sr = sf.read(str(path), dtype="float32", always_2d=False)
    if y.ndim > 1:
        y = y.mean(axis=1)
    if sr != 16000:
        y = librosa.resample(np.asarray(y, dtype=np.float32), orig_sr=sr, target_sr=16000)
    if max_seconds > 0:
        y = y[: int(max_seconds * 16000)]
    return np.asarray(y, dtype=np.float32)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", required=True, help="audio file or training-data directory")
    ap.add_argument("--name", required=True, help="model id used by the plugin")
    ap.add_argument("--label", default="", help="display label")
    ap.add_argument("--model", default="", help="model filename, e.g. my_voice.pth")
    ap.add_argument("--source", default="", help="source path recorded in the profile")
    ap.add_argument("--out", required=True, help="profile JSON path")
    ap.add_argument("--rvc-dir", required=True, help="RVC runtime directory containing assets/rmvpe")
    ap.add_argument("--max-seconds", type=float, default=120.0)
    ap.add_argument("--max-clips", type=int, default=24)
    args = ap.parse_args()

    dataset = Path(args.dataset).expanduser().resolve()
    files: list[Path] = []
    collect_audio(dataset, files)
    if not files:
        print(f"没有在训练数据里找到音频：{dataset}", file=sys.stderr)
        return 2
    if len(files) > args.max_clips:
        step = (len(files) - 1) / max(1, args.max_clips - 1)
        files = [files[int(round(i * step))] for i in range(args.max_clips)]
    per_file = max(1.0, float(args.max_seconds) / max(1, min(len(files), args.max_clips)))

    rvc = Path(args.rvc_dir).expanduser().resolve()
    rmvpe_path = rvc / "assets" / "rmvpe" / "rmvpe.pt"
    if not rmvpe_path.exists():
        print(f"RMVPE 模型不存在：{rmvpe_path}", file=sys.stderr)
        return 2
    sys.path.insert(0, str(rvc))
    try:
        from infer.rmvpe import RMVPE
    except Exception as error:
        print(f"无法加载 RMVPE：{error}", file=sys.stderr)
        return 2

    rmvpe = RMVPE(str(rmvpe_path), False, "cpu")
    frames: list[np.ndarray] = []
    used = 0.0
    clips = 0
    for file in files:
        if used >= args.max_seconds:
            break
        try:
            remaining = max(0.5, min(per_file, args.max_seconds - used))
            y = load_chunk(file, remaining)
            if len(y) < int(0.5 * 16000):
                continue
            f0 = rmvpe.infer_from_audio(np.asarray(y, dtype=np.float32), thred=0.03)
            voiced = f0[f0 > 0]
            if len(voiced):
                frames.append(voiced)
                clips += 1
                used += len(y) / 16000.0
        except Exception as error:
            print(f"跳过 {file.name}：{error}", file=sys.stderr)

    if not frames:
        print("训练数据里没有检测到有声帧，无法生成 Profile", file=sys.stderr)
        return 2

    values = np.concatenate(frames).astype(np.float64)
    profile = {
        "id": args.name,
        "label": args.label or args.name,
        "model": args.model,
        "method": "rmvpe",
        "fps": 100,
        "source": args.source or str(dataset),
        "clips": clips,
        "durationSec": round(used, 2),
        "min": round(float(values.min()), 2),
        "max": round(float(values.max()), 2),
        "p1": round(float(np.percentile(values, 1)), 2),
        "p5": round(float(np.percentile(values, 5)), 2),
        "p50": round(float(np.percentile(values, 50)), 2),
        "p95": round(float(np.percentile(values, 95)), 2),
        "p99": round(float(np.percentile(values, 99)), 2),
        "notes": "从训练数据生成：RMVPE 有声帧分位数；不重新训练模型。",
        "promptWav": "",
    }
    out = Path(args.out).expanduser().resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(profile, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(profile, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
