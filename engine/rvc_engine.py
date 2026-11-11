#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Resident RVC engine: RMVPE + one or more RVC voice models stay loaded."""
from __future__ import annotations

import os
import sys
import tempfile
import warnings
from pathlib import Path

import numpy as np
import soundfile as sf

warnings.filterwarnings("ignore")
OUT_SR = 48000
FPS = 100


def _runs(mask):
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


def _merge_close(spans, max_gap):
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


def _merge_intervals(shifts, duration, fill_gap):
    items = []
    for s in sorted(shifts, key=lambda x: x["start"]):
        a = max(0.0, float(s["start"]))
        b = min(duration, float(s["end"]))
        if b - a < 0.02:
            continue
        items.append([a, b, int(s["semitones"])])
    if not items:
        return [[0.0, duration, 0]]
    out, cur = [], 0.0
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
    merged = []
    for a, b, s in out:
        if merged and merged[-1][2] == s and abs(merged[-1][1] - a) < 1e-6:
            merged[-1][1] = b
        else:
            merged.append([a, b, s])
    return merged


def _add_faded(out, weight, audio, start, fade):
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


class RvcEngine:
    def __init__(self, rvc_dir: str):
        self.rvc_dir = str(Path(rvc_dir).expanduser().resolve())
        sys.path.insert(0, self.rvc_dir)
        os.chdir(self.rvc_dir)
        os.environ.setdefault("weight_root", str(Path(self.rvc_dir) / "assets" / "weights"))
        os.environ.setdefault("index_root", str(Path(self.rvc_dir) / "logs"))
        os.environ.setdefault("outside_index_root", str(Path(self.rvc_dir) / "assets" / "indices"))
        os.environ.setdefault("rmvpe_root", str(Path(self.rvc_dir) / "assets" / "rmvpe"))

        from configs.config import Config
        original = sys.argv[:]
        sys.argv = [sys.argv[0]]
        try:
            self.config = Config()
        finally:
            sys.argv = original
        self.device = str(self.config.device)
        from infer.rmvpe import RMVPE
        self.rmvpe = RMVPE(
            str(Path(self.rvc_dir) / "assets" / "rmvpe" / "rmvpe.pt"),
            False,
            self.device,
        )
        from infer.vc.modules import VC
        self.vc = VC(self.config)
        self.current_model = ""

    def status(self):
        info = {"device": self.device, "model": self.current_model}
        if self.device == "cuda":
            try:
                import torch
                info["gpu"] = torch.cuda.get_device_name(0)
            except Exception:
                info["gpu"] = "CUDA"
        else:
            info["gpu"] = ""
        return info

    def load_voice(self, model_path: str):
        path = str(Path(model_path).expanduser().resolve())
        if not Path(path).is_file():
            raise FileNotFoundError(f"RVC 模型不存在：{path}")
        if self.current_model == path:
            return
        os.environ["weight_root"] = str(Path(path).parent)
        self.vc.get_vc(Path(path).name)
        self.current_model = path

    def analyze(self, audio, profile, out, params, progress=None):
        import librosa
        progress = progress or (lambda *_: None)
        progress("load", 0.03)
        y, sr = sf.read(audio, dtype="float64")
        if y.ndim > 1:
            y = y.mean(axis=1)
        if sr != 16000:
            y = librosa.resample(y.astype(np.float32), orig_sr=sr, target_sr=16000).astype(np.float64)
            sr = 16000
        duration = len(y) / sr
        progress("f0", 0.10)
        f0 = self.rmvpe.infer_from_audio(y.astype(np.float32), thred=0.03).astype(np.float64)
        n = len(f0)
        progress("segments", 0.65)
        rms = librosa.feature.rms(y=y.astype(np.float32), frame_length=320, hop_length=160, center=True)[0]
        if len(rms) < n:
            rms = np.pad(rms, (0, n - len(rms)), mode="edge")
        rms = rms[:n]
        db = 20.0 * np.log10(np.maximum(rms, 1e-9))
        ref = float(np.percentile(db, 95))
        active = (db > (ref - float(params.get("topDb", 14)))) & (rms > 1e-5)
        spans = _merge_close(_runs(active), max_gap=8)
        spans = [(a, b) for a, b in spans if (b - a) / FPS >= 0.10] or [(0, n)]

        phrase_gap = float(params.get("phraseGap", 0.25))
        section_gap = float(params.get("sectionGap", 1.2))
        min_phrase = float(params.get("minPhrase", 0.6))
        phrases = []
        for a, b in spans:
            if phrases and (a - phrases[-1][1]) / FPS < phrase_gap:
                phrases[-1] = (phrases[-1][0], b)
            else:
                phrases.append((a, b))
        merged = []
        for a, b in phrases:
            if (b - a) / FPS < min_phrase and merged:
                merged[-1] = (merged[-1][0], b)
            else:
                merged.append((a, b))
        phrases = merged
        sections = []
        for a, b in phrases:
            if sections and (a - sections[-1][1]) / FPS < section_gap:
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
            "p1": float(np.percentile(vf, 1)) if len(vf) else 0.0,
            "p5": float(np.percentile(vf, 5)) if len(vf) else 0.0,
            "p50": float(np.percentile(vf, 50)) if len(vf) else 0.0,
            "p95": float(np.percentile(vf, 95)) if len(vf) else 0.0,
            "p99": float(np.percentile(vf, 99)) if len(vf) else 0.0,
            "voicedFrames": int(voiced.sum()),
            "activeFrames": int(active.sum()),
            "frames": int(n),
            "duration": round(duration, 3),
        }

        def seg(a, b):
            return {"start": round(a / FPS, 3), "end": round(b / FPS, 3), "from": int(a), "to": int(b)}

        def cov(lo, hi):
            v = f0[f0 > 0]
            return float(np.mean((v >= lo) & (v <= hi))) if len(v) else 0.0

        result = {
            "version": 1,
            "audio": str(Path(audio).resolve()),
            "fps": FPS,
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
                "comfort": round(cov(float(profile["p5"]), float(profile["p95"])), 4),
                "hard": round(cov(float(profile["p1"]), float(profile["p99"])), 4),
            },
            "params": params,
        }
        from common import write_json
        write_json(out, result)
        progress("done", 1.0)
        return result

    def render(self, input_path, model_path, plan_path, out_path, params, progress=None):
        from common import load_json
        progress = progress or (lambda *_: None)
        self.load_voice(model_path)
        y, sr = sf.read(input_path, dtype="float64")
        if y.ndim > 1:
            y = y.mean(axis=1)
        duration = len(y) / sr
        plan = load_json(plan_path)
        intervals = _merge_intervals(plan.get("shifts", []), duration, float(params.get("fillGap", 0.5)))
        out = np.zeros(int(round(duration * OUT_SR)) + OUT_SR, dtype=np.float64)
        weight = np.zeros_like(out)
        fade = max(1, int(float(params.get("crossfadeMs", 50)) / 1000.0 * OUT_SR))
        pad = 0.08
        tmpdir = tempfile.mkdtemp(prefix="ss-rvc-")
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
                status, result = self.vc.vc_single(
                    0, seg_path, int(semis), "rmvpe", "",
                    float(params.get("indexRate", 0.0)), 0,
                    float(params.get("rmsMixRate", 0.25)), float(params.get("protect", 0.25)),
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
                _add_faded(out, weight, audio, start, fade)
                progress("render", 0.05 + 0.9 * (idx + 1) / len(intervals))
        finally:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)
        covered = weight > 1e-6
        out[covered] /= weight[covered]
        out = out[: int(round(duration * OUT_SR))]
        peak = float(np.max(np.abs(out))) if len(out) else 0.0
        if peak > 0.99:
            out *= 0.99 / peak
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        sf.write(out_path, out.astype(np.float32), OUT_SR)
        progress("done", 1.0)
        return out_path
