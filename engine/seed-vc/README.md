# Seed-VC sidecar

This directory is the GPL-3.0-only inference component. It runs as a persistent
process and exchanges bounded CPVE control/audio frames with the Electron
launcher. The launcher does not import or link the Seed-VC Python modules.

The upstream source is pinned as the `engine/vendor/seed-vc` git submodule. The
weights and Python environment are installed into ignored `runtime/seed-vc`
storage by `bun run setup:engine`; runtime startup is offline and fails closed
when the source, platform lock, weights, selected reference, or qualified
accelerator is missing.

The pinned realtime profiles are:

- macOS arm64: Apple MPS
- Windows x64: NVIDIA CUDA 13.0
- Linux x64: NVIDIA CUDA 13.0

All profiles use managed Python 3.11, PyTorch 2.13, TorchAudio 2.11, a 300 ms
input block, and 10 diffusion steps. The installer proves the requested device
with a real tensor operation before downloading models, binds the installation
manifest to the exact platform requirements lock, and enforces the 15 GiB
runtime ceiling. There is intentionally no CPU fallback: a CPU profile must be
measured against the realtime contract before it can be added.
