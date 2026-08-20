# Seed-VC sidecar

This directory is the GPL-3.0-only inference component. It runs as a persistent
process and exchanges bounded CPVE control/audio frames with the Electron
launcher. The launcher does not import or link the Seed-VC Python modules.

The upstream source is pinned as the `engine/vendor/seed-vc` git submodule. The
weights and Python environment are installed into ignored `runtime/seed-vc`
storage by `bun run setup:engine`; runtime startup is offline and fails closed
when the source, lock, weights, selected reference, or MPS backend is missing.

The current tested runtime profile is Apple Silicon with Python 3.11,
PyTorch 2.13, TorchAudio 2.11, a 300 ms input block, and 10 diffusion steps.
