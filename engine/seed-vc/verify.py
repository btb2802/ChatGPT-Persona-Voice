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
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    spec = importlib.util.spec_from_file_location("cpv_seed_vc_worker", args.worker.resolve())
    if spec is None or spec.loader is None:
        raise RuntimeError("Seed-VC verifier could not load the bundled worker")
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    lock, artifacts = worker.verify_model_artifacts(
        args.runtime_root.resolve(),
        args.lock.resolve(),
    )
    installed = {
        name: importlib.metadata.version(distribution)
        for name, distribution in worker.RUNTIME_DISTRIBUTIONS.items()
    }
    worker.validate_runtime_packages(lock.get("packages"), installed)
    print(json.dumps({
        "verified": True,
        "python": lock.get("python"),
        "models": len(artifacts),
        "packages": installed,
    }, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    main()
