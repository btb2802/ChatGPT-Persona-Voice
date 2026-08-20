#!/usr/bin/env python3
"""Verify an installed Seed-VC package without loading model code or MPS."""

from __future__ import annotations

import argparse
import importlib.metadata
import importlib.util
import json
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-root", required=True, type=Path)
    parser.add_argument("--lock", required=True, type=Path)
    parser.add_argument("--worker", required=True, type=Path)
    parser.add_argument("--runtime-profile", required=True, choices=(
        "darwin-arm64-mps",
        "windows-x64-cuda130",
        "linux-x64-cuda130",
    ))
    parser.add_argument("--requirements-lock", required=True, type=Path)
    parser.add_argument("--device", required=True, choices=("mps", "cuda"))
    parser.add_argument("--device-only", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    spec = importlib.util.spec_from_file_location("cpv_seed_vc_worker", args.worker.resolve())
    if spec is None or spec.loader is None:
        raise RuntimeError("Seed-VC verifier could not load the bundled worker")
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    if worker.RUNTIME_PROFILE_DEVICES.get(args.runtime_profile) != args.device:
        raise RuntimeError("Seed-VC runtime profile and accelerator do not match")
    lock = json.loads(args.lock.resolve().read_text(encoding="utf-8"))
    installed = {
        name: importlib.metadata.version(distribution)
        for name, distribution in worker.RUNTIME_DISTRIBUTIONS.items()
    }
    worker.validate_runtime_packages(lock.get("packages"), installed)
    import torch
    device = worker.validate_device_profile(torch, args.device)
    expected_backend = worker.RUNTIME_PROFILE_BACKENDS[args.runtime_profile]
    if device["backend"] != expected_backend:
        raise RuntimeError(
            f"Seed-VC profile {args.runtime_profile} requires {expected_backend}, found {device['backend']}"
        )
    if args.device_only:
        artifacts = {}
    else:
        lock, artifacts = worker.verify_model_artifacts(
            args.runtime_root.resolve(),
            args.lock.resolve(),
            args.runtime_profile,
            args.requirements_lock.resolve(),
        )
    print(json.dumps({
        "verified": True,
        "runtimeProfile": args.runtime_profile,
        **device,
        "python": lock.get("python"),
        "models": len(artifacts),
        "packages": installed,
    }, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    main()
