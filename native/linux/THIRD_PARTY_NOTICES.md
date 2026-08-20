# Linux audio third-party notices

## WirePlumber 0.4 policy base

`wireplumber/0.4/cpv-create-item.lua` is derived from WirePlumber
`src/scripts/create-item.lua` at tag `0.4.17`, commit
`d3eb77b292655cef333a8f4cab4e861415bc37c2`:

<https://gitlab.freedesktop.org/pipewire/wireplumber/-/blob/d3eb77b292655cef333a8f4cab4e861415bc37c2/src/scripts/create-item.lua>

WirePlumber is Copyright 2019-2022 Collabora Ltd. and licensed under the MIT
license. The license text is included in
`wireplumber/0.4/LICENSE.WirePlumber-MIT`.

Persona Voice retains the upstream 0.4 SessionItem creation behavior and adds
only route assignment before SessionItem registration plus route-scoped bypass
mute/unmute tied to the native guard-node lifetime. The file is plainly marked
as modified and is not represented as upstream WirePlumber code.

## PipeWire runtime

The Linux native helpers dynamically link the system `libpipewire-0.3` and use
public PipeWire/SPA headers. No PipeWire library source is copied into this
repository. PipeWire upstream source and licensing information are available
at <https://gitlab.freedesktop.org/pipewire/pipewire>.
