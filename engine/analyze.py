#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Analyze a vocal stem: RMVPE F0, RMS, silence-based phrases/sections, coverage.

Output JSON is consumed by the DSH plugin host. All times are seconds.
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

warnings.filterwarnings("ignore")

HOP = 160          # 10 ms at 16 kHz
SR = 16000


def log(*a):
    print(*a, flush=True)


def load_mono(path: str) -> np.ndarray:
    y, sr = sf.read(path, dtype="float64")
    if y.ndim > 1:
        y = y.mean(axis=1)
    if sr != SR:
        import librosa
        y = librosa.resample(y.astype(np.float32), orig_sr=sr, target_sr=SR).astype(np.float64)
    return y


def rms_frames(y: np.ndarray, n: int) -> np.ndarray:
    import librosa
    r = librosa.feature.rms(y=y.astype(np.float32), frame_length=320, hop_length=HOP, center=True)[0]
    if len(r) < n:
        r = np.pad(r, (0, n - len(r)), mode="edge")
    return r[:n]


def runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """Inclusive-exclusive frame runs where mask is true."""
    out = []
    start = None
    for i, v in enumerate(mask):
        if v and start is None:
            start = i
        elif not v and start is not None:
            out.append((start, i))
            start = None
    if start is not None:
        out.append((start, len(mask)))
    return out


def merge_close(spans: list[tuple[int, int]], max_gap: int) -> list[tuple[int, int]]:
    if not spans:
        return []
    out = [spans[0]]
    for a, b in spans[1:]:
        pa, pb = out[-1]
        if a - pb <= max_gap:
            out[-1] = (pa, b)
        else:
            out.append((a, b))
    return out


def pct(v: np.ndarray, q: float) -> float:
    return float(np.percentile(v, q)) if len(v) else 0.0


def coverage(f0: np.ndarray, lo: float, hi: float) -> float:
    v = f0[(f0 > 0)]
    if not len(v):
        return 0.0
    return float(np.mean((v >= lo) & (v <= hi)))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--profile", required=True)
    ap.add_argument("--rvc-dir", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--phrase-gap", type=float, default=0.25)
    ap.add_argument("--section-gap", type=float, default=1.2)
    ap.add_argument("--min-phrase", type=float, default=0.6)
    ap.add_argument("--top-db", type=float, default=14.0)
    args = ap.parse_args()

    rvc_dir = str(Path(args.rvc_dir).expanduser().resolve())
    audio_path = str(Path(args.audio).expanduser().resolve())
    profile_path = str(Path(args.profile).expanduser().resolve())
    out_path = str(Path(args.out).expanduser().resolve())
    sys.path.insert(0, rvc_dir)
    os.chdir(rvc_dir)

    profile = json.loads(Path(profile_path).read_text(encoding="utf-8"))
    log("PROGRESS 0.05 load")
    y = load_mono(audio_path)
    duration = len(y) / SR
    log("PROGRESS 0.12 f0")

    from infer.rmvpe import RMVPE
    model_path = os.path.join(rvc_dir, "assets", "rmvpe", "rmvpe.pt")
    rmvpe = RMVPE(model_path, False, "cpu")
    f0 = rmvpe.infer_from_audio(y.astype(np.float32), thred=0.03).astype(np.float64)
    n = len(f0)
    log("PROGRESS 0.62 segments")

    rms = rms_frames(y, n)
    db = 20.0 * np.log10(np.maximum(rms, 1e-9))
    ref = float(np.percentile(db, 95))
    active = db > (ref - args.top_db)
    active &= rms > 1e-5

    # 80 ms bridging; drop very short blips.
    spans = merge_close(runs(active), max_gap=max(1, int(0.08 * 100)))
    spans = [(a, b) for a, b in spans if (b - a) / 100.0 >= 0.10]
    if not spans:
        spans = [(0, n)]

    # Phrase boundaries: split at gaps >= phrase_gap; enforce min duration.
    phrases: list[tuple[int, int]] = []
    for a, b in spans:
        if phrases and (a - phrases[-1][1]) / 100.0 < args.phrase_gap:
            phrases[-1] = (phrases[-1][0], b)
        else:
            phrases.append((a, b))
    merged: list[tuple[int, int]] = []
    for a, b in phrases:
        if (b - a) / 100.0 < args.min_phrase and merged:
            merged[-1] = (merged[-1][0], b)
        else:
            merged.append((a, b))
    phrases = merged

    # Sections: group phrases separated by long silences, else 8 phrases per group.
    sections: list[tuple[int, int]] = []
    for a, b in phrases:
        if sections and (a - sections[-1][1]) / 100.0 < args.section_gap:
            sections[-1] = (sections[-1][0], b)
        else:
            sections.append((a, b))
    if len(sections) <= 1 and len(phrases) > 8:
        sections = []
        for i in range(0, len(phrases), 8):
            group = phrases[i:i + 8]
            sections.append((group[0][0], group[-1][1]))

    voiced = f0 > 0
    vf = f0[voiced]
    stats = {
        "min": float(vf.min()) if len(vf) else 0.0,
        "max": float(vf.max()) if len(vf) else 0.0,
        "p1": pct(vf, 1), "p5": pct(vf, 5), "p50": pct(vf, 50),
        "p95": pct(vf, 95), "p99": pct(vf, 99),
        "voicedFrames": int(voiced.sum()),
        "activeFrames": int(active.sum()),
        "frames": int(n),
        "duration": round(duration, 3),
    }

    def seg(a, b):
        return {
            "start": round(a / 100.0, 3),
            "end": round(b / 100.0, 3),
            "from": int(a),
            "to": int(b),
        }

    out = {
        "version": 1,
        "audio": audio_path,
        "fps": 100,
        "duration": round(duration, 3),
        "f0": [round(float(x), 2) for x in f0],
        "rms": [round(float(x), 6) for x in rms],
        "active": [1 if x else 0 for x in active],
        "voiced": [1 if x else 0 for x in voiced],
        "phrases": [seg(a, b) for a, b in phrases],
        "sections": [seg(a, b) for a, b in sections],
        "stats": stats,
        "profile": profile,
        "coverage": {
            "comfort": round(coverage(f0, float(profile["p5"]), float(profile["p95"])), 4),
            "hard": round(coverage(f0, float(profile["p1"]), float(profile["p99"])), 4),
        },
        "params": {
            "phraseGap": args.phrase_gap,
            "sectionGap": args.section_gap,
            "minPhrase": args.min_phrase,
            "topDb": args.top_db,
        },
    }
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    Path(out_path).write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    log(f"PROGRESS 1.0 done {len(phrases)} phrases / {len(sections)} sections")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
