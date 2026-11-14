#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 hubert_base/pytorch_model.bin 转成同目录的 model.safetensors。

transformers 4.56+ 在 torch < 2.6 时拒绝 `torch.load` 加载 `.bin`
（CVE-2025-32434），但 safetensors 不受这条限制，而且 `from_pretrained`
会自动优先选 `model.safetensors`。转换一次即可，不改 torch / transformers 版本。
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin", required=True, help="pytorch_model.bin 路径")
    ap.add_argument("--out", required=True, help="输出 model.safetensors 路径")
    args = ap.parse_args()

    src = Path(args.bin)
    out = Path(args.out)
    if not src.is_file():
        print(f"ERROR 找不到 {src}", flush=True)
        return 1

    try:
        import torch
        from safetensors.torch import save_file
    except Exception as error:  # noqa: BLE001
        print(f"ERROR 缺少依赖：{error}", flush=True)
        return 1

    try:
        state = torch.load(str(src), map_location="cpu")
    except Exception as error:  # noqa: BLE001
        print(f"ERROR 读取 {src} 失败：{error}", flush=True)
        return 1

    if isinstance(state, dict) and isinstance(state.get("state_dict"), dict):
        state = state["state_dict"]
    if not isinstance(state, dict):
        print("ERROR checkpoint 不是 state_dict", flush=True)
        return 1

    tensors = {}
    for key, value in state.items():
        if torch.is_tensor(value):
            tensors[key] = value.detach().to("cpu").contiguous()
    if not tensors:
        print("ERROR checkpoint 里没有张量", flush=True)
        return 1

    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(out.suffix + ".tmp")
    save_file(tensors, str(tmp))
    os.replace(tmp, out)

    size = out.stat().st_size
    print(f"DONE {out} ({len(tensors)} tensors, {size / 1048576:.0f} MB)", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
