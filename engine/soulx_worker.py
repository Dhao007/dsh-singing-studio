#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""JSONL resident worker for SoulX-Singer SVC."""
from __future__ import annotations

import argparse
import json
import sys
import traceback

from common import Protocol
from soulx_engine import SoulxEngine


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--soulx-dir", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--config", required=True)
    ap.add_argument("--device", default="")
    args = ap.parse_args()

    proto = Protocol()
    engine = SoulxEngine(args.soulx_dir, args.model, args.config, args.device or None)
    proto.send({"type": "ready", "result": engine.status()})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        req_id = req.get("id")
        op = req.get("op")
        a = req.get("args") or {}
        try:
            if op == "status":
                proto.send({"type": "result", "id": req_id, "ok": True, "result": engine.status()})
            elif op == "render":
                def progress(stage, value):
                    proto.progress(req_id, stage, value)
                engine.render(
                    a["input"], a["analysis"], a["plan"], a["prompt"], a["out"],
                    a.get("params") or {}, progress,
                )
                proto.send({"type": "result", "id": req_id, "ok": True, "result": {"out": a["out"], "status": engine.status()}})
            elif op == "shutdown":
                proto.send({"type": "result", "id": req_id, "ok": True, "result": {}})
                return 0
            else:
                proto.send({"type": "result", "id": req_id, "ok": False, "error": f"unknown op: {op}"})
        except Exception as error:
            proto.send({
                "type": "result", "id": req_id, "ok": False,
                "error": str(error), "trace": traceback.format_exc()[-2000:],
            })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
