# Driver source provenance

- Upstream: <https://github.com/microsoft/Windows-driver-samples/tree/717778a20ba4dd2440fe609f69153a1f8a64f597/audio/simpleaudiosample>
- Upstream revision: `717778a20ba4dd2440fe609f69153a1f8a64f597`
- Vendored subtree: `upstream-simpleaudiosample/`
- Upstream license: Microsoft Public License (MS-PL), reproduced in `MS-PL-LICENSE`

Persona Voice modifications are intentionally limited to the product boundary:

- expose only a render endpoint; no microphone/capture endpoint is installed;
- brand the hardware ID, service, binary, catalog, INF, endpoint, resource metadata, and runtime GUIDs;
- add a marker property used by the route/output helpers to distinguish the owned sink;
- allow up to 32 simultaneous render streams;
- retain the sample's null-render behavior and disable render-data file creation by default.

All copyright and attribution notices in the vendored source are retained. Source distributions must include `MS-PL-LICENSE`. Binary distributions must use terms compatible with MS-PL and include the Microsoft driver-sample attribution in the repository's third-party notice. Microsoft names and trademarks are not licensed for product branding.
