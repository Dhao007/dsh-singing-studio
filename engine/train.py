#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""RVC 音色训练流水线：切分 → 提取 F0 / HuBERT 特征 → 训练 → 建索引 → 生成音域 Profile。

宿主通过 stdout 上的 ``PROGRESS {json}`` 行读取进度；子进程日志写 stderr 和 train.log。
训练本体在子进程里跑，收到 SIGTERM 会先杀掉子进程再退出，避免取消后还在后台训练。
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

AUDIO_EXT = {".wav", ".mp3", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".wma"}
SR_MAP = {"32k": 32000, "40k": 40000, "48k": 48000}
FPS = 100
LOG_HANDLE = None
CURRENT_CHILD: subprocess.Popen | None = None
CURRENT_TRAINER = None
STOPPING = False


def log(*args: object) -> None:
    line = " ".join(str(a) for a in args)
    print(line, file=sys.stderr, flush=True)
    if LOG_HANDLE is not None:
        try:
            LOG_HANDLE.write(line + "\n")
            LOG_HANDLE.flush()
        except Exception:
            pass


def emit(stage: str, progress: float, message: str = "", detail: dict | None = None) -> None:
    payload = {
        "stage": stage,
        "progress": round(max(0.0, min(1.0, float(progress))), 4),
        "message": message,
    }
    if detail is not None:
        payload["detail"] = detail
    print("PROGRESS " + json.dumps(payload, ensure_ascii=False), flush=True)


def fit_from_loss(loss: float | None) -> float | None:
    """把 mel 损失折算成 0-100 的“拟合度”，只用于看趋势。

    fit = 100 * (1 - e^(-18 / loss))：损失越小越接近 100，但永远不会到 100。
    """
    if loss is None:
        return None
    try:
        value = float(loss)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(value) or value <= 0:
        return None
    return round(100.0 * (1.0 - math.exp(-18.0 / value)), 1)


def fmt_eta(seconds: float | None) -> str:
    if seconds is None or not math.isfinite(seconds) or seconds < 0:
        return "计算中"
    seconds = int(round(seconds))
    if seconds < 60:
        return f"{seconds} 秒"
    minutes, sec = divmod(seconds, 60)
    if minutes < 60:
        return f"{minutes} 分 {sec:02d} 秒"
    hours, minutes = divmod(minutes, 60)
    return f"{hours} 小时 {minutes:02d} 分"


def _hard_kill(child: subprocess.Popen) -> None:
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(child.pid)], capture_output=True)
        else:
            os.killpg(os.getpgid(child.pid), signal.SIGTERM)
    except Exception:
        try:
            child.terminate()
        except Exception:
            pass


def stop_child(graceful: bool = False) -> None:
    """停止训练子进程。

    graceful=True 时写一个 STOP 文件，让 train.py 在下一个 step 存好检查点再退出；
    180 秒还没退出就强制结束（例如卡在 IO 上）。
    """
    global CURRENT_CHILD
    child = CURRENT_CHILD
    if child is None or child.poll() is not None:
        CURRENT_CHILD = None
        return
    trainer = CURRENT_TRAINER
    if graceful and trainer is not None:
        log("[训练] 正在保存检查点，请稍候…")
        try:
            trainer.stop_file.parent.mkdir(parents=True, exist_ok=True)
            trainer.stop_file.write_text("stop", encoding="utf-8")
        except Exception:
            pass
        deadline = time.time() + 180
        while time.time() < deadline and child.poll() is None:
            time.sleep(0.5)
        if child.poll() is not None:
            if trainer is not None and trainer.has_checkpoint():
                log("[训练] 检查点已保存，训练已停止")
            else:
                log("[训练] 训练已停止（没有生成新的检查点）")
            CURRENT_CHILD = None
            if trainer is not None:
                trainer.clear_stop_file()
            return
        log("[训练] 保存检查点超时，强制结束")
    log("[训练] 正在停止子进程…")
    _hard_kill(child)
    try:
        child.wait(timeout=15)
    except Exception:
        try:
            child.kill()
        except Exception:
            pass
    CURRENT_CHILD = None
    if trainer is not None:
        trainer.clear_stop_file()


def install_signals() -> None:
    def handler(signum, frame):  # noqa: ANN001
        global STOPPING
        trainer = CURRENT_TRAINER
        # 只有训练阶段才值得等检查点；切分 / 特征提取阶段直接停。
        can_save = trainer is not None and trainer.current_stage == "训练" and not STOPPING
        if can_save:
            STOPPING = True
            stop_child(graceful=True)
        else:
            stop_child()
        raise SystemExit(130)

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, handler)
        except Exception:
            pass


class Trainer:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.rvc = Path(args.rvc_dir).expanduser().resolve()
        self.sr = SR_MAP[args.sr]
        self.exp_dir = self.rvc / "logs" / args.name
        self.dataset_src = Path(args.dataset).expanduser().resolve()
        self.models_dir = Path(args.models_dir).expanduser().resolve()
        self.profiles_dir = Path(args.profiles_dir).expanduser().resolve()
        self.result_path = Path(args.result).expanduser().resolve()
        self.slices = 0
        self.last_loss: float | None = None
        self.last_losses: dict[str, float] = {}
        self.epoch_losses: list[float] = []
        self.loss_by_epoch: dict[int, list[float]] = {}
        self.history: list[dict] = []
        self.train_started = 0.0
        self.train_finished = 0.0
        self.total_epochs = max(1, int(args.epochs))
        self.epoch = 0
        self.epoch_pct = 0.0
        self.fit: float | None = None
        self.eta: float | None = None
        self.last_emit = 0.0
        self.index_paths: list[str] = []
        self.resume = bool(getattr(args, "resume", 0))
        self.stop_file = self.exp_dir / "STOP"
        self.state_path = self.exp_dir / "plugin-state.json"
        self.current_stage = ""
        self.state = {
            "name": args.name,
            "label": args.label or args.name,
            "dataset": str(self.dataset_src),
            "sr": args.sr,
            "version": args.version,
            "epochs": self.total_epochs,
            "batchSize": int(args.batch_size),
            "per": float(args.per),
            "saveEvery": int(args.save_every),
            "auditionEvery": int(getattr(args, "audition_every", 0) or 0),
            "f0Method": args.f0_method,
            "pretrained": bool(args.pretrained),
            "device": args.device,
            "resume": self.resume,
            "stage": "init",
            "lastEpoch": 0,
            "slices": 0,
            "epochFits": {},
            "updatedAt": int(time.time()),
        }
        if self.resume:
            try:
                previous = json.loads(self.state_path.read_text(encoding="utf-8"))
            except Exception:
                previous = None
            if isinstance(previous, dict) and isinstance(previous.get("epochFits"), dict):
                self.state["epochFits"] = previous["epochFits"]

    # ---------------------------------------------------------------- helpers
    def detail(self) -> dict:
        return {
            "epoch": self.epoch,
            "totalEpochs": self.total_epochs,
            "epochPct": round(self.epoch_pct, 3),
            "loss": self.last_loss,
            "losses": dict(self.last_losses),
            "fit": self.fit,
            "etaSec": self.eta,
            "elapsedSec": round(time.time() - self.train_started, 1) if self.train_started else 0,
        }

    def stage(self, stage: str, progress: float, message: str = "", detail: dict | None = None) -> None:
        self.current_stage = stage
        emit(stage, progress, message, detail)
        self.last_emit = time.time()

    # ------------------------------------------------------------ 状态 / 续训
    def clear_stop_file(self) -> None:
        try:
            self.stop_file.unlink()
        except FileNotFoundError:
            pass
        except Exception:
            pass

    def save_state(self, stage: str | None = None, **extra: object) -> None:
        self.state.update(extra)
        if stage:
            self.state["stage"] = stage
        self.state["updatedAt"] = int(time.time())
        try:
            self.exp_dir.mkdir(parents=True, exist_ok=True)
            tmp = self.state_path.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(self.state, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp.replace(self.state_path)
        except Exception:
            pass

    def _count_files(self, sub: str, suffix: str) -> int:
        folder = self.exp_dir / sub
        if not folder.is_dir():
            return 0
        try:
            return sum(1 for item in folder.iterdir() if item.is_file() and item.name.endswith(suffix))
        except Exception:
            return 0

    def _feature_dir(self) -> str:
        return "3_feature256" if self.args.version == "v1" else "3_feature768"

    def preprocess_done(self) -> bool:
        gt = self._count_files("0_gt_wavs", ".wav")
        return gt > 0 and self._count_files("1_16k_wavs", ".wav") == gt

    def f0_done(self, slices: int) -> bool:
        return (self._count_files("2a_f0", ".npy") == slices
                and self._count_files("2b-f0nsf", ".npy") == slices)

    def hubert_done(self, slices: int) -> bool:
        return self._count_files(self._feature_dir(), ".npy") == slices

    def clear_dirs(self, *names: str) -> None:
        for name in names:
            shutil.rmtree(self.exp_dir / name, ignore_errors=True)

    def has_checkpoint(self) -> bool:
        if not self.exp_dir.is_dir():
            return False
        try:
            return any(item.name.startswith("G_") and item.name.endswith(".pth")
                       for item in self.exp_dir.iterdir() if item.is_file())
        except Exception:
            return False

    def train_detail(self, stage: str, progress: float, message: str) -> None:
        now = time.time()
        if now - self.last_emit < 0.4 and progress < 0.999:
            return
        self.stage(stage, progress, message, self.detail())

    def run_child(self, args: list[str], on_line=None) -> None:  # noqa: ANN001
        global CURRENT_CHILD
        env = dict(os.environ)
        env["PYTHONPATH"] = str(self.rvc) + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
        env["PYTHONUNBUFFERED"] = "1"
        try:
            env["RVC_AUDITION_EVERY"] = str(int(self.args.audition_every))
        except Exception:
            env["RVC_AUDITION_EVERY"] = "0"
        env.setdefault("PYTHONIOENCODING", "utf-8")
        # RVC 的训练日志跟随系统 locale；固定成中文，解析时同时兼容中英文。
        env["LANG"] = "zh_CN.UTF-8"
        env["LC_ALL"] = "zh_CN.UTF-8"
        proc = subprocess.Popen(
            [sys.executable, *args],
            cwd=str(self.rvc),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            start_new_session=(os.name != "nt"),
        )
        CURRENT_CHILD = proc
        try:
            if proc.stdout is not None:
                for raw in proc.stdout:
                    line = raw.rstrip()
                    if not line:
                        continue
                    log(line)
                    if on_line is not None:
                        try:
                            on_line(line)
                        except Exception:
                            pass
        finally:
            code = proc.wait()
            CURRENT_CHILD = None
        if code != 0:
            raise RuntimeError(f"训练子进程退出码 {code}（{args[0]} {args[1] if len(args) > 1 else ''}）")

    # ---------------------------------------------------------------- stages
    def check_inputs(self) -> list[Path]:
        a = self.args
        if not self.rvc.is_dir():
            raise RuntimeError(f"RVC 目录不存在：{self.rvc}")
        if not (self.rvc / "train" / "train.py").is_file():
            raise RuntimeError(f"RVC 训练代码缺失：{self.rvc / 'train' / 'train.py'}（先去「环境」页一键准备）")
        if not (self.rvc / "assets" / "rmvpe" / "rmvpe.pt").is_file():
            raise RuntimeError("缺少 assets/rmvpe/rmvpe.pt（先去「环境」页准备）")
        if not self.dataset_src.is_dir():
            raise RuntimeError(f"训练数据目录不存在：{self.dataset_src}")
        files = sorted(
            p for p in self.dataset_src.rglob("*")
            if p.is_file() and p.suffix.lower() in AUDIO_EXT and not p.name.startswith(".")
        )
        if not files:
            raise RuntimeError("训练数据目录里没有可用的音频文件（wav/flac/mp3/m4a/ogg）")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,39}", a.name):
            raise RuntimeError("模型名只能包含字母、数字、下划线、短横线（40 字符以内）")
        if not a.version in ("v1", "v2"):
            raise RuntimeError("版本只能是 v1 或 v2")
        if self.resume:
            if not self.exp_dir.is_dir() or not any(self.exp_dir.iterdir()):
                raise RuntimeError(f"没有可继续的训练：{self.exp_dir}")
            if not self.has_checkpoint() and not self.preprocess_done():
                raise RuntimeError("没有找到可继续的检查点或中间结果")
        elif self.exp_dir.exists() and any(self.exp_dir.iterdir()):
            raise RuntimeError(f"同名训练已存在：{self.exp_dir}，请换一个模型名或先删除旧目录")
        return files

    def stage_dataset(self, files: list[Path]) -> Path:
        stage = self.exp_dir / "_dataset"
        if stage.exists():
            shutil.rmtree(stage, ignore_errors=True)
        stage.mkdir(parents=True, exist_ok=True)
        for idx, src in enumerate(files):
            ext = src.suffix.lower()
            target = stage / f"{idx:05d}{ext}"
            try:
                if os.name == "nt":
                    os.link(src, target)
                else:
                    os.symlink(src, target)
            except Exception:
                shutil.copy2(src, target)
        return stage

    def write_config(self) -> None:
        cfg_path = self.rvc / "configs" / ("v1" if self.args.version == "v1" else "v2") / f"{self.args.sr}.json"
        if not cfg_path.is_file():
            raise RuntimeError(f"缺少训练配置模板：{cfg_path}")
        config = json.loads(cfg_path.read_text(encoding="utf-8"))
        # 让每个 epoch 至少打印一次 loss，拟合度才能按 epoch 更新。
        steps = max(1, math.ceil(max(1, self.slices) / max(1, int(self.args.batch_size))))
        config.setdefault("train", {})["log_interval"] = steps
        config["train"]["batch_size"] = int(self.args.batch_size)
        config.setdefault("data", {})["sampling_rate"] = self.sr
        self.exp_dir.mkdir(parents=True, exist_ok=True)
        (self.exp_dir / "config.json").write_text(
            json.dumps(config, ensure_ascii=False, indent=4), encoding="utf-8"
        )

    def preprocess(self, stage_dir: Path) -> None:
        total = 1
        progress = {"done": 0}

        def on_line(line: str) -> None:
            m = re.search(r"(?i)(?:进度|progress)[：:]\s*(\d+)/(\d+)", line)
            if m:
                progress["done"] = int(m.group(1))
                total_n = max(1, int(m.group(2)))
                self.stage("切分音频", 0.01 + 0.09 * (progress["done"] / total_n),
                           f"切分 {progress['done']}/{total_n}")

        self.stage("切分音频", 0.01, "正在按 3-4 秒切片并重采样…")
        self.run_child([
            "-m", "train.preprocess", str(stage_dir), str(self.sr), str(max(1, int(self.args.n_p))),
            str(self.exp_dir), "False", str(float(self.args.per)),
        ], on_line)
        total = len(list((self.exp_dir / "0_gt_wavs").glob("*.wav")))
        self.slices = total
        if total <= 0:
            raise RuntimeError("切分后没有得到有效音频片段，请检查训练数据")
        self.stage("切分音频", 0.10, f"得到 {total} 个训练片段")

    def extract_f0(self) -> None:
        use_cuda = self.args.device != "cpu" and self._cuda_available()
        method = str(self.args.f0_method)
        if method != "rmvpe":
            use_cuda = False

        def on_line(line: str) -> None:
            m = re.search(r"(?i)(?:进度|progress)[：:]\s*(\d+)/(\d+)", line)
            if m:
                done, total = int(m.group(1)), max(1, int(m.group(2)))
                self.stage("提取音高 F0", 0.10 + 0.10 * (done / total), f"F0 {done}/{total}")

        self.stage("提取音高 F0", 0.10, "RMVPE 提取音高…" if method == "rmvpe" else "Parselmouth 提取音高…")
        if use_cuda:
            args = ["-m", "train.dataset.extract_f0", "cuda", "1", "0", "0", str(self.exp_dir), "False"]
        else:
            args = ["-m", "train.dataset.extract_f0", "cpu", str(self.exp_dir), str(max(1, int(self.args.n_p))), method]
        self.run_child(args, on_line)

    def extract_hubert(self) -> None:
        use_cuda = self.args.device != "cpu" and self._cuda_available()
        version = "v1" if self.args.version == "v1" else "v2"

        def on_line(line: str) -> None:
            m = re.search(r"(?i)(?:进度|progress)[：:]\s*(\d+)/(\d+)", line)
            if m:
                done, total = int(m.group(1)), max(1, int(m.group(2)))
                self.stage("提取内容特征", 0.20 + 0.14 * (done / total), f"HuBERT {done}/{total}")

        self.stage("提取内容特征", 0.20, "HuBERT 提取内容特征…")
        if use_cuda:
            args = ["-m", "train.dataset.extract_hubert_feature", "cuda:0", "1", "0", "0", str(self.exp_dir), version, "False"]
        else:
            args = ["-m", "train.dataset.extract_hubert_feature", "cpu", "1", "0", str(self.exp_dir), version, "False"]
        self.run_child(args, on_line)
        if not list((self.exp_dir / "3_feature768" if version == "v2" else self.exp_dir / "3_feature256").glob("*.npy")):
            raise RuntimeError("HuBERT 特征提取失败，没有生成 .npy 文件")

    def write_filelist(self) -> None:
        gt = self.exp_dir / "0_gt_wavs"
        features = self.exp_dir / ("3_feature256" if self.args.version == "v1" else "3_feature768")
        f0_dir = self.exp_dir / "2a_f0"
        f0nsf_dir = self.exp_dir / "2b-f0nsf"
        names = (
            {n.split(".")[0] for n in os.listdir(gt)}
            & {n.split(".")[0] for n in os.listdir(features)}
            & {n.split(".")[0] for n in os.listdir(f0_dir)}
            & {n.split(".")[0] for n in os.listdir(f0nsf_dir)}
        )
        if not names:
            raise RuntimeError("没有可用于训练的切片（切分 / F0 / 特征三者对不上）")
        lines = []
        for name in sorted(names):
            lines.append(
                f"{gt / (name + '.wav')}|{features / (name + '.npy')}|"
                f"{f0_dir / (name + '.wav.npy')}|{f0nsf_dir / (name + '.wav.npy')}|0"
            )
        mute_gt = self.rvc / "logs" / "mute" / "0_gt_wavs" / f"mute{self.args.sr}.wav"
        mute_feat = self.rvc / "logs" / "mute" / ("3_feature256" if self.args.version == "v1" else "3_feature768") / "mute.npy"
        mute_f0 = self.rvc / "logs" / "mute" / "2a_f0" / "mute.wav.npy"
        mute_f0nsf = self.rvc / "logs" / "mute" / "2b-f0nsf" / "mute.wav.npy"
        if mute_gt.is_file() and mute_feat.is_file() and mute_f0.is_file() and mute_f0nsf.is_file():
            line = f"{mute_gt}|{mute_feat}|{mute_f0}|{mute_f0nsf}|0"
            lines.extend([line, line])
        (self.exp_dir / "filelist.txt").write_text("\n".join(lines), encoding="utf-8")
        self.slices = len(names)

    def pretrained(self, kind: str) -> str:
        if not self.args.pretrained:
            return ""
        names = [f"f0{kind}{self.args.sr}.pth"]
        if self.args.version == "v1":
            names.append(f"{kind}{self.args.sr}.pth")
        for folder in ("pretrained_v2", "pretrained"):
            for name in names:
                path = self.rvc / "assets" / folder / name
                if path.is_file():
                    return str(path)
        return ""

    def collect_auditions(self) -> list[dict]:
        """收集本轮训练每 N 轮导出的、可直接当音色用的 .pth。"""
        folder = self.rvc / "assets" / "weights"
        if not folder.is_dir() or int(self.args.audition_every) <= 0:
            return []
        pattern = re.compile(rf"^{re.escape(self.args.name)}_e(\d+)_s\d+\.pth$")
        latest: dict[int, dict] = {}
        try:
            entries = list(folder.iterdir())
        except Exception:
            entries = []
        for file in entries:
            if not file.is_file() or not file.name.endswith(".pth"):
                continue
            match = pattern.match(file.name)
            if not match:
                continue
            epoch = int(match.group(1))
            if epoch > self.total_epochs:
                continue
            try:
                size = file.stat().st_size
            except Exception:
                size = 0
            latest[epoch] = {"epoch": epoch, "path": str(file), "size": size}
        return [latest[key] for key in sorted(latest)]

    def train(self) -> None:
        # RVC 的 savee 直接写 assets/weights/<name>.pth，目录不存在会训练完才报错。
        weights_dir = self.rvc / "assets" / "weights"
        weights_dir.mkdir(parents=True, exist_ok=True)
        if not self.resume and int(self.args.audition_every) > 0:
            for file in weights_dir.glob(f"{self.args.name}_e*_s*.pth"):
                try:
                    file.unlink()
                except Exception:
                    pass
        pg = self.pretrained("G")
        pd = self.pretrained("D")
        note = ""
        if self.args.pretrained and (not pg or not pd):
            note = " · 未找到匹配底模，从零训练"
            self.stage("训练", 0.34, "未找到匹配的预训练底模，将从零训练（更慢）")
        use_cuda = self.args.device != "cpu" and self._cuda_available()
        args = [
            "-m", "train.train",
            "-e", self.args.name,
            "-sr", self.args.sr,
            "-f0", "1",
            "-bs", str(max(1, int(self.args.batch_size))),
            "-te", str(self.total_epochs),
            "-se", str(max(1, int(self.args.save_every))),
            "-l", "1",
            "-c", "0",
            "-sw", "0",
            "-v", "v1" if self.args.version == "v1" else "v2",
        ]
        if use_cuda:
            args += ["-g", "0"]
        if pg:
            args += ["-pg", pg]
        if pd:
            args += ["-pd", pd]

        self.train_started = time.time()
        self.epoch = 0
        self.stage("训练", 0.34, f"开始训练：{self.total_epochs} 轮 · 批大小 {self.args.batch_size}{note}", self.detail())
        self.save_state("训练中", slices=self.slices)

        re_pct = re.compile(r"(?:训练轮次|Training epoch)[：:]\s*(\d+)\s*\[(\d+)%\]")
        re_epoch = re.compile(r"====>\s*(?:轮次|Epoch)[：:]\s*(\d+)")
        re_loss = re.compile(
            r"loss_disc=([\d.]+),\s*loss_gen=([\d.]+),\s*loss_fm=([\d.]+),?\s*loss_mel=([\d.]+),\s*loss_kl=([\d.]+)"
        )

        def on_line(line: str) -> None:
            m_loss = re_loss.search(line)
            if m_loss:
                try:
                    disc, gen, fm, mel, kl = (float(m_loss.group(i)) for i in range(1, 6))
                    if all(math.isfinite(v) for v in (disc, gen, fm, mel, kl)):
                        self.last_losses = {"disc": disc, "gen": gen, "fm": fm, "mel": mel, "kl": kl}
                        self.last_loss = mel
                        self.epoch_losses.append(mel)
                        self.loss_by_epoch.setdefault(self.epoch or 1, []).append(mel)
                except Exception:
                    pass
            m_pct = re_pct.search(line)
            if m_pct:
                try:
                    epoch = int(m_pct.group(1))
                    pct = min(100.0, max(0.0, float(m_pct.group(2))))
                    self.epoch = max(self.epoch, epoch)
                    self.epoch_pct = pct / 100.0
                    if epoch > int(self.state.get("lastEpoch") or 0):
                        self.state["lastEpoch"] = epoch
                        self.save_state("训练中")
                    overall = 0.34 + 0.58 * ((epoch - 1 + pct / 100.0) / self.total_epochs)
                    eta = None
                    if epoch > 1 and self.train_started:
                        elapsed = time.time() - self.train_started
                        eta = elapsed / max(1, epoch - 1) * (self.total_epochs - epoch + 1)
                    self.eta = eta
                    msg = f"第 {epoch}/{self.total_epochs} 轮 · {pct:.0f}%"
                    if self.last_loss is not None:
                        msg += f" · mel {self.last_loss:.1f}"
                    self.train_detail("训练", overall, msg)
                except Exception:
                    pass
            m_epoch = re_epoch.search(line)
            if m_epoch:
                try:
                    epoch = int(m_epoch.group(1))
                    values = self.loss_by_epoch.get(epoch) or ([self.last_loss] if self.last_loss is not None else [])
                    loss = (sum(values) / len(values)) if values else None
                    self.last_loss = loss
                    fit = fit_from_loss(loss)
                    if fit is not None:
                        self.fit = fit
                    elapsed = time.time() - self.train_started
                    avg = elapsed / max(1, epoch)
                    self.epoch = epoch
                    self.epoch_pct = 0.0
                    self.eta = max(0.0, avg * (self.total_epochs - epoch))
                    self.state["lastEpoch"] = epoch
                    if fit is not None:
                        fits = self.state.get("epochFits")
                        if not isinstance(fits, dict):
                            fits = {}
                            self.state["epochFits"] = fits
                        fits[str(epoch)] = round(float(fit), 2)
                    self.save_state("训练中")
                    if loss is not None:
                        self.history.append({
                            "epoch": epoch,
                            "loss": round(float(loss), 4),
                            "fit": fit,
                            "losses": dict(self.last_losses),
                        })
                    overall = 0.34 + 0.58 * (epoch / self.total_epochs)
                    detail = self.detail()
                    self.stage("训练", overall,
                               f"第 {epoch}/{self.total_epochs} 轮完成 · loss {loss:.1f}" if loss is not None
                               else f"第 {epoch}/{self.total_epochs} 轮完成",
                               detail)
                except Exception:
                    pass

        self.run_child(args, on_line)
        self.train_finished = time.time()
        self.epoch = self.total_epochs
        self.epoch_pct = 0.0
        self.eta = 0.0
        self.stage("训练", 0.92, f"训练完成（{self.total_epochs} 轮）", self.detail())

    def find_model(self) -> Path:
        exact = self.rvc / "assets" / "weights" / f"{self.args.name}.pth"
        if exact.is_file():
            return exact
        candidates = sorted(
            (self.rvc / "assets" / "weights").glob(f"{self.args.name}*.pth"),
            key=lambda p: p.stat().st_mtime,
        )
        if not candidates:
            raise RuntimeError(f"训练结束但没有找到模型文件：{exact}")
        return candidates[-1]

    def build_index(self) -> None:
        if not self.args.index:
            return
        def on_line(line: str) -> None:
            m = re.search(r"(?i)(?:写入进度|write progress)[：:]\s*(\d+)/(\d+)", line)
            if m:
                done, total = int(m.group(1)), max(1, int(m.group(2)))
                self.stage("训练索引", 0.92 + 0.04 * (done / total), f"索引 {done}/{total}")

        self.stage("训练索引", 0.92, "构建 faiss 检索索引…")
        try:
            self.run_child([
                "-m", "train.train_index", self.args.name,
                "v1" if self.args.version == "v1" else "v2",
                str(self.rvc / "assets" / "indices"), "2", "single",
            ], on_line)
        except Exception as error:
            log("[索引训练] 失败（不影响模型）：", error)
            self.stage("训练索引", 0.96, "索引训练失败，已跳过")
            return
        self.index_paths = [
            str(p) for p in sorted((self.rvc / "assets" / "indices").glob(f"{self.args.name}*.index"))
        ]
        self.stage("训练索引", 0.96, "索引已生成" if self.index_paths else "索引已生成")

    def build_profile(self) -> str:
        """从训练集的 16k 切片采样 RMVPE，得到音域分位数 profile。"""
        self.stage("生成音域 Profile", 0.96, "统计训练集音域…")
        try:
            import numpy as np
            import soundfile as sf
            sys.path.insert(0, str(self.rvc))
            from infer.rmvpe import RMVPE

            rmvpe = RMVPE(str(self.rvc / "assets" / "rmvpe" / "rmvpe.pt"), False, "cpu")
            files = sorted((self.exp_dir / "1_16k_wavs").glob("*.wav"))
            if len(files) > 24:
                step = (len(files) - 1) / 23.0
                files = [files[int(round(i * step))] for i in range(24)]
            limit = max(10.0, float(self.args.profile_seconds))
            frames: list = []
            used = 0.0
            clips = 0
            for file in files:
                if used >= limit:
                    break
                try:
                    y, sr = sf.read(str(file), dtype="float32")
                    if y.ndim > 1:
                        y = y.mean(axis=1)
                    if sr != 16000:
                        import librosa
                        y = librosa.resample(y, orig_sr=sr, target_sr=16000)
                    f0 = rmvpe.infer_from_audio(np.asarray(y, dtype=np.float32), thred=0.03)
                    voiced = f0[f0 > 0]
                    if len(voiced):
                        frames.append(voiced)
                        clips += 1
                        used += len(y) / 16000.0
                except Exception as error:
                    log("[Profile] 跳过", file.name, error)
            if not frames:
                self.stage("生成音域 Profile", 0.98, "训练集没有检测到人声，未生成 Profile")
                return ""
            values = np.concatenate(frames).astype(np.float64)
            profile = {
                "id": self.args.name,
                "label": self.args.label or self.args.name,
                "model": f"{self.args.name}.pth",
                "method": "rmvpe",
                "fps": FPS,
                "source": str(self.dataset_src),
                "clips": clips,
                "durationSec": round(used, 2),
                "min": round(float(values.min()), 2),
                "max": round(float(values.max()), 2),
                "p1": round(float(np.percentile(values, 1)), 2),
                "p5": round(float(np.percentile(values, 5)), 2),
                "p50": round(float(np.percentile(values, 50)), 2),
                "p95": round(float(np.percentile(values, 95)), 2),
                "p99": round(float(np.percentile(values, 99)), 2),
                "notes": "训练完成后自动统计：采样训练集 16k 切片，RMVPE 有声帧分位数。",
                "promptWav": "",
            }
            self.profiles_dir.mkdir(parents=True, exist_ok=True)
            out = self.profiles_dir / f"{self.args.name}.json"
            out.write_text(json.dumps(profile, ensure_ascii=False, indent=2), encoding="utf-8")
            self.stage("生成音域 Profile", 0.99, f"舒适区 {profile['p5']:.0f}–{profile['p95']:.0f} Hz")
            return str(out)
        except Exception as error:
            log("[Profile] 生成失败：", error)
            self.stage("生成音域 Profile", 0.98, "Profile 生成失败，模型仍可使用（需手动补 profile）")
            return ""

    def _cuda_available(self) -> bool:
        try:
            import torch
            return bool(torch.cuda.is_available())
        except Exception:
            return False

    # ---------------------------------------------------------------- driver
    def run(self) -> dict:
        files = self.check_inputs()
        self.clear_stop_file()
        resumed = False
        if self.resume and self.preprocess_done():
            self.slices = self._count_files("0_gt_wavs", ".wav")
            self.stage("继续训练", 0.04, f"复用上次的 {self.slices} 个切片")
            self.save_state("切分完成", slices=self.slices)
            resumed = True
        else:
            self.stage("准备", 0.0, f"发现 {len(files)} 个音频文件")
            if self.resume:
                # 上次切分没做完：清掉半成品，从头切。
                self.clear_dirs("0_gt_wavs", "1_16k_wavs", "2a_f0", "2b-f0nsf", self._feature_dir())
                try:
                    (self.exp_dir / "filelist.txt").unlink()
                except Exception:
                    pass
            stage_dir = self.stage_dataset(files)
            self.preprocess(stage_dir)
            self.save_state("切分完成", slices=self.slices)
        self.write_config()

        if not (resumed and self.f0_done(self.slices)):
            if self.resume:
                self.clear_dirs("2a_f0", "2b-f0nsf")
            self.extract_f0()
            self.save_state("F0 完成")
        else:
            self.stage("提取音高 F0", 0.10, "复用上次的 F0")

        if not (resumed and self.hubert_done(self.slices)):
            if self.resume:
                self.clear_dirs(self._feature_dir())
            self.extract_hubert()
            self.save_state("特征完成")
        else:
            self.stage("提取内容特征", 0.20, "复用上次的 HuBERT 特征")

        self.write_filelist()
        self.stage("准备训练", 0.34, f"{self.slices} 个切片，开始训练")
        self.train()
        self.build_index()
        model_src = self.find_model()
        self.models_dir.mkdir(parents=True, exist_ok=True)
        model_dst = self.models_dir / f"{self.args.name}.pth"
        if model_src.resolve() != model_dst.resolve():
            shutil.copy2(model_src, model_dst)
        profile_path = self.build_profile()
        result = {
            "ok": True,
            "id": self.args.name,
            "label": self.args.label or self.args.name,
            "voiceId": self.args.name,
            "modelPath": str(model_dst),
            "profilePath": profile_path,
            "expDir": str(self.exp_dir),
            "indexPaths": self.index_paths,
            "epochs": self.total_epochs,
            "finalLoss": self.last_loss,
            "fit": self.fit,
            "history": self.history,
            "slices": self.slices,
            "auditions": self.collect_auditions(),
            "durationSec": round(self.train_finished - self.train_started, 1) if self.train_finished else None,
            "sr": self.args.sr,
            "version": self.args.version,
        }
        self.result_path.parent.mkdir(parents=True, exist_ok=True)
        self.result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        self.state["lastEpoch"] = self.total_epochs
        self.save_state("完成", slices=self.slices)
        self.stage("完成", 1.0, f"训练完成：{self.args.name}", self.detail())
        return result


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rvc-dir", required=True)
    ap.add_argument("--dataset", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--label", default="")
    ap.add_argument("--sr", default="48k", choices=sorted(SR_MAP))
    ap.add_argument("--version", default="v2", choices=["v1", "v2"])
    ap.add_argument("--epochs", type=int, default=20)
    ap.add_argument("--batch-size", type=int, default=4)
    ap.add_argument("--save-every", type=int, default=5)
    ap.add_argument("--audition-every", type=int, default=0)
    ap.add_argument("--per", type=float, default=3.7)
    ap.add_argument("--f0-method", default="rmvpe", choices=["rmvpe", "pm"])
    ap.add_argument("--n-p", type=int, default=2)
    ap.add_argument("--index", type=int, default=1)
    ap.add_argument("--pretrained", type=int, default=1)
    ap.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    ap.add_argument("--resume", type=int, default=0)
    ap.add_argument("--profile-seconds", type=float, default=120.0)
    ap.add_argument("--models-dir", required=True)
    ap.add_argument("--profiles-dir", required=True)
    ap.add_argument("--result", required=True)
    ap.add_argument("--log", default="")
    args = ap.parse_args()

    global LOG_HANDLE
    if args.log:
        Path(args.log).parent.mkdir(parents=True, exist_ok=True)
        LOG_HANDLE = open(args.log, "a", encoding="utf-8")
    install_signals()
    trainer = Trainer(args)
    global CURRENT_TRAINER
    CURRENT_TRAINER = trainer
    trainer.clear_stop_file()
    try:
        trainer.run()
        return 0
    except SystemExit:
        raise
    except Exception as error:
        log("[训练失败]", error)
        if trainer.exp_dir.is_dir():
            trainer.save_state("失败", error=str(error)[:500])
        emit("失败", 1.0, str(error))
        return 1
    finally:
        stop_child()
        if LOG_HANDLE is not None:
            LOG_HANDLE.close()


if __name__ == "__main__":
    raise SystemExit(main())
