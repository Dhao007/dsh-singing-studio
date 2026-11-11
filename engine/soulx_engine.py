#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Resident SoulX-Singer SVC engine."""
from __future__ import annotations

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
FPS = SAMPLE_RATE // HOP


class SoulxEngine:
    def __init__(self, soulx_dir: str, model_path: str, config_path: str, device: str | None = None):
        self.soulx_dir = str(Path(soulx_dir).expanduser().resolve())
        self.model_path = str(Path(model_path).expanduser().resolve())
        self.config_path = str(Path(config_path).expanduser().resolve())
        sys.path.insert(0, self.soulx_dir)
        os.chdir(self.soulx_dir)
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        from soulxsinger.models.soulxsinger_svc import SoulXSingerSVC
        from soulxsinger.utils.file_utils import load_config
        self.config = load_config(self.config_path)
        self.model = SoulXSingerSVC(self.config)
        checkpoint = torch.load(self.model_path, map_location="cpu", weights_only=False)
        if "state_dict" not in checkpoint:
            raise KeyError("checkpoint 没有 state_dict")
        self.model.load_state_dict(checkpoint["state_dict"], strict=True)
        self.model.eval()
        self.model.to(torch.device(self.device))
        self.loaded = True

    def status(self):
        info = {"device": self.device, "model": self.model_path, "loaded": self.loaded}
        if self.device == "cuda":
            try:
                info["gpu"] = torch.cuda.get_device_name(0)
            except Exception:
                info["gpu"] = "CUDA"
        else:
            info["gpu"] = ""
        return info

    @staticmethod
    def _load_wav(path):
        import torchaudio
        wav, sr = torchaudio.load(path)
        if wav.shape[0] > 1:
            wav = wav.mean(0, keepdim=True)
        if sr != SAMPLE_RATE:
            wav = torchaudio.functional.resample(wav, sr, SAMPLE_RATE)
        return wav

    @staticmethod
    def _f0(wav, fps=FPS):
        audio = wav.squeeze(0).double().cpu().numpy()
        try:
            import pyworld as pw
            f0, _ = pw.harvest(audio, SAMPLE_RATE, f0_floor=70.0, f0_ceil=1100.0, frame_period=1000.0 / fps)
            return f0.astype(np.float32)
        except Exception:
            import librosa
            f0, _, _ = librosa.pyin(
                audio.astype(np.float32), fmin=70.0, fmax=1100.0, sr=SAMPLE_RATE,
                frame_length=2048, hop_length=HOP,
            )
            return np.nan_to_num(f0, nan=0.0).astype(np.float32)

    @staticmethod
    def _fit(arr, n):
        if len(arr) == n:
            return arr
        if len(arr) > n:
            return arr[:n]
        return np.pad(arr, (0, n - len(arr)), mode="constant")

    @staticmethod
    def _resample_f0(f0, src_fps, dst_fps, n):
        idx = np.floor(np.arange(n) * src_fps / dst_fps).astype(np.int64)
        idx = np.clip(idx, 0, max(0, len(f0) - 1))
        return f0[idx].astype(np.float32)

    @staticmethod
    def _shift_curve(plan, n, fps=FPS, ramp_ms=20.0):
        curve = np.zeros(n, dtype=np.float32)
        for s in plan.get("shifts", []):
            a = max(0, int(round(float(s["start"]) * fps)))
            b = min(n, int(round(float(s["end"]) * fps)))
            if b > a:
                curve[a:b] = float(s.get("semitones", 0))
        r = max(1, int(round(ramp_ms / 1000.0 * fps)))
        for s in plan.get("shifts", []):
            a = max(0, int(round(float(s["start"]) * fps)))
            b = min(n, int(round(float(s["end"]) * fps)))
            v = float(s.get("semitones", 0))
            if v == 0 or b - a < 2 * r + 2:
                continue
            curve[a:a + r] = np.linspace(0.0, v, r, endpoint=False)
            curve[b - r:b] = np.linspace(v, 0.0, r, endpoint=False)
        return curve

    def render(self, input_path, analysis_path, plan_path, prompt_path, out_path, params, progress=None):
        from common import load_json
        progress = progress or (lambda *_: None)
        progress("load", 0.03)
        analysis = load_json(analysis_path)
        plan = load_json(plan_path)
        target = self._load_wav(input_path)
        duration = target.shape[-1] / SAMPLE_RATE
        n_frames = int(round(duration * FPS))
        f0 = np.asarray(analysis.get("f0") or [], dtype=np.float32)
        if len(f0) == 0:
            f0 = self._f0(target)
        else:
            f0 = self._resample_f0(f0, int(analysis.get("fps", 100)), FPS, n_frames)
        f0 = self._fit(f0, n_frames)
        if not params.get("noShift"):
            curve = self._shift_curve(plan, n_frames)
            voiced = f0 > 0
            f0[voiced] = f0[voiced] * np.power(2.0, curve[voiced] / 12.0)

        prompt = self._load_wav(prompt_path)
        max_len = int(float(params.get("promptSeconds", 12)) * SAMPLE_RATE)
        if prompt.shape[-1] > max_len:
            prompt = prompt[..., :max_len]
        pt_f0 = self._fit(self._f0(prompt), int(round(prompt.shape[-1] / SAMPLE_RATE * FPS)))

        device = torch.device(self.device)
        pt_wav = prompt.to(device)
        gt_wav = target.to(device)
        pt_f0_t = torch.from_numpy(pt_f0).unsqueeze(0).to(device)
        gt_f0_t = torch.from_numpy(f0).unsqueeze(0).to(device)
        progress("infer", 0.12)
        with torch.no_grad():
            pt_mel = self.model.mel(pt_wav.float())
            overlap_segments, segments = self.model.build_vocal_segments(
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
                seg_audio = self.model.infer_segment(
                    pt_mel=pt_mel, pt_wav=pt_wav, gt_wav=seg_wav,
                    pt_f0=pt_f0_t, gt_f0=seg_f0,
                    pitch_shift=0, n_steps=int(params.get("steps", 16)),
                    cfg=float(params.get("cfg", 3.0)),
                )
                a = int(round(seg_start * SAMPLE_RATE))
                b = int(round(seg_end * SAMPLE_RATE))
                piece = seg_audio[(a - w0):(b - w0)]
                generated[:, a:a + piece.shape[-1]] = piece
                progress("infer", 0.15 + 0.7 * (idx + 1) / len(segments))
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
        progress("done", 1.0)
        return out_path
