#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Download one file with resume/progress using only the standard library."""
from __future__ import annotations

import argparse
import hashlib
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


def progress(done, total):
    print(f"PROGRESS {done} {total or 0}", flush=True)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def download_one(url, out, expect_sha="", expect_size=0):
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    part = out.with_suffix(out.suffix + ".part")
    if out.exists() and out.stat().st_size > 0:
        if (not expect_size or out.stat().st_size == expect_size) and (not expect_sha or sha256_file(out) == expect_sha):
            print(f"SKIP {out}", flush=True)
            return True
    existing = part.stat().st_size if part.exists() else 0
    req = urllib.request.Request(url, headers={
        "User-Agent": "dsh-singing-studio/0.3",
        "Accept": "*/*",
    })
    if existing:
        req.add_header("Range", f"bytes={existing}-")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            status = getattr(resp, "status", 200)
            length = int(resp.headers.get("Content-Length") or 0)
            if status == 200 and existing:
                existing = 0
            total = (length + existing) if length else 0
            mode = "ab" if existing and status == 206 else "wb"
            done = existing
            last = 0.0
            with open(part, mode) as f:
                while True:
                    chunk = resp.read(1024 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
                    done += len(chunk)
                    now = time.time()
                    if now - last > 0.5:
                        progress(done, total)
                        last = now
            progress(done, total)
    except Exception as error:
        print(f"ERROR {url} {error}", flush=True)
        return False
    if expect_size and part.stat().st_size != expect_size:
        print(f"ERROR size {part.stat().st_size} != {expect_size}", flush=True)
        return False
    if expect_sha and sha256_file(part) != expect_sha:
        print("ERROR sha256", flush=True)
        return False
    if out.exists():
        out.unlink()
    part.replace(out)
    print(f"DONE {out}", flush=True)
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--sha256", default="")
    ap.add_argument("--size", type=int, default=0)
    ap.add_argument("--proxy", default="")
    ap.add_argument("urls", nargs="+")
    args = ap.parse_args()
    if args.proxy:
        os.environ["http_proxy"] = args.proxy
        os.environ["https_proxy"] = args.proxy
    for url in args.urls:
        if download_one(url, args.out, args.sha256, args.size):
            return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
