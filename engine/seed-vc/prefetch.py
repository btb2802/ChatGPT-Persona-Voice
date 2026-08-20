#!/usr/bin/env python3
"""Download and verify the exact Seed-VC runtime weights."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys

from huggingface_hub import hf_hub_download

RUNTIME_PROFILES = (
    "darwin-arm64-mps",
    "windows-x64-cuda130",
    "linux-x64-cuda130",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-root", required=True, type=Path)
    parser.add_argument("--lock", required=True, type=Path)
    parser.add_argument("--runtime-profile", required=True, choices=RUNTIME_PROFILES)
    parser.add_argument("--requirements-lock", required=True, type=Path)
    return parser.parse_args()


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def main() -> None:
    args = parse_args()
    runtime_root = args.runtime_root.resolve()
    model_root = runtime_root / "models"
    lock_path = args.lock.resolve()
    requirements_path = args.requirements_lock.resolve()
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    if lock.get("schemaVersion") != 1:
        raise SystemExit("Unsupported model lock schema")
    downloaded: list[dict[str, object]] = []
    for repo_id, repository in lock["repositories"].items():
        cache_dir = model_root / repository["cache"]
        for filename, expected in repository["files"].items():
            print(f"Downloading {repo_id}/{filename}", flush=True)
            resolved = Path(hf_hub_download(
                repo_id=repo_id,
                filename=filename,
                revision=repository["revision"],
                cache_dir=cache_dir,
                token=False,
            )).resolve()
            actual = digest(resolved)
            if actual != expected:
                raise SystemExit(
                    f"SHA-256 mismatch for {repo_id}/{filename}: expected {expected}, received {actual}"
                )
            downloaded.append({
                "repo": repo_id,
                "revision": repository["revision"],
                "file": filename,
                "sha256": actual,
                "bytes": resolved.stat().st_size,
            })
    manifest = {
        "schemaVersion": 2,
        "runtimeProfile": args.runtime_profile,
        "requirementsSha256": digest(requirements_path),
        "modelLockSha256": digest(lock_path),
        "seedVcCommit": lock["seedVcCommit"],
        "python": f"{sys.version_info.major}.{sys.version_info.minor}",
        "files": downloaded,
    }
    runtime_root.mkdir(parents=True, exist_ok=True)
    (runtime_root / "install-manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Installed {sum(item['bytes'] for item in downloaded) / 1024**3:.2f} GiB of model weights", flush=True)


if __name__ == "__main__":
    main()
