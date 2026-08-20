# Troubleshooting

Start with the exact blocker shown in Settings → Diagnostics. The relay deliberately refuses to
start when any source, suppression, engine, or output probe is not ready.

## Capture a useful report

Before changing anything, record:

- macOS version and CPU architecture;
- source checkout commit;
- Bun and Node versions (`bun --version`, `node --version`);
- whether the app is a source checkout or local packaged artifact;
- selected source and voice;
- runtime state and stable blocker/error code;
- the smallest relevant, redacted log excerpt;
- exact command and whether the failure reproduces after a clean Stop/relaunch.

Do not attach audio or a complete log unless it is necessary and safe. Logs can contain local paths,
process/device names, and child-process diagnostics.

## Platform is blocked

### Windows or Linux

This is expected. The repository has a renderer and source discovery, but no complete transparent
relay. Windows needs a verifiable suppressing endpoint/driver; Linux needs an owned crash-safe
PipeWire route and output adapter. The Seed-VC installer is also Apple Silicon-only.

Do not try to bypass readiness by changing a capability result. There is no safe pass-through or
identity fallback. See [Platform matrix](PLATFORM_MATRIX.md).

### Intel macOS or macOS older than 14.2

The current end-to-end profile is unsupported. Core Audio process taps require macOS 14.2+, and the
installed engine profile requires Apple MPS on Apple Silicon.

## Dependency installation fails

Run from the repository root:

```bash
git submodule update --init --recursive
bun install --frozen-lockfile
```

If the lockfile install reports a mismatch, do not regenerate `bun.lock` just to make CI pass.
Confirm that the checkout and Bun version are expected, then report the exact error.

## Engine setup is unavailable or invalid

### “The current install profile supports Apple Silicon macOS only”

The check is intentional. No other accelerator profile is qualified.

### `uv` or Python 3.11 cannot be created

For a source checkout, verify `uv --version` and network access. The setup script asks `uv` for
Python 3.11 and synchronizes the locked requirements. A global Python environment is not a
supported replacement. A packaged app carries its own pinned `uv`; retry from **Settings → Voice**
and preserve the exact installer error if it still fails.

### Seed-VC submodule revision mismatch

```bash
git submodule update --init --recursive
git -C engine/vendor/seed-vc rev-parse HEAD
```

The printed revision must match `seedVcCommit` in `engine/seed-vc/model-lock.json`. Do not move the
submodule independently without updating the lock, tests, notices, and review evidence.

### Model hash or install-manifest mismatch

Rerun:

```bash
bun run setup:engine
```

Setup verifies pinned revisions and hashes. If it still fails, preserve the error and manifest for
diagnosis. If a clean reinstall is necessary, quit the app, rename the dedicated
`runtime/seed-vc/` directory as a backup, rerun setup, and remove the backup only after verifying the
new runtime. Do not delete a parent workspace or shared model cache by mistake.

### Packaged artifact reports a missing engine

Open **Settings → Voice** and select **Install engine**. The first install needs network access and
at least 6 GiB free; approximately 2.5 GiB remains installed. Cancellation leaves a resumable
staging area, so use **Resume** rather than copying a development runtime into application data.

If verification fails, keep the exact message. **Remove…** deletes the private runtime, staging,
managed Python, and cache, after which a fresh install can be attempted. It does not delete voices,
settings, or history.

## Native helper does not build

Verify the Apple toolchain:

```bash
xcode-select -p
clang --version
bun run build:native
bun run test:native
```

The helpers require macOS Core Audio frameworks and cannot be produced as a functioning relay on
Windows/Linux. Include the first compiler error, not only the final script exit.

## Audio Capture permission is missing

Symptoms include capture readiness timeout or a permission-related Core Audio error.

1. Open System Settings → Privacy & Security and review Audio Capture access.
2. Grant access to the development Electron app/terminal as appropriate for the current run mode.
3. Quit Persona Voice cleanly and restart it.
4. Run `bun run smoke:capture:mac` only if you intentionally want a live permissioned smoke.

TCC is not bypassed. Repeatedly relaunching without resolving the OS decision will not create a safe
route.

## Source application is not found

- Start ChatGPT or Codex before refreshing sources.
- If a pinned source was updated or moved, select it again so its executable identity is refreshed.
- Automatic mode matches ChatGPT/Codex process trees and excludes Persona Voice's own tree.
- Verify that the selected app is running in the same user session.

Windows/Linux can list sources without having a relay; successful discovery alone is not readiness.

## Relay stays Armed

Armed means the original application route is unchanged and no Persona Voice output helper is open.
The macOS helper waits for the selected process tree to show active input and then audible output.
Chromium Audio Service descendants are discovered dynamically; starting the voice session after
Persona Voice no longer requires refreshing the source or restarting either app.

- Begin an actual voice session in ChatGPT/Codex.
- Confirm microphone/WebRTC setup completed in the source app.
- Wait for assistant audio, not only UI animation.
- If no engagement occurs, Stop before changing source or voice settings.

Do not interpret Armed as muted or converted playback.

## The beginning of a session is silent

The current Seed-VC adapter intentionally discards the first three seconds after each prepared/reset
engine session. This suppresses startup audio. It is not a performance delay and is separate from
the native output prebuffer.

If silence continues after that window, inspect whether the runtime reached Running and whether the
engine/output reported a fault.

## Output starts late or reports rebuffering

The output helper has 64 bounded buffers and a configured 500 ms startup/rebuffer target. The
current implementation begins/restarts output only after its buffer policy is satisfied. That value
is not a 500 ms end-to-end promise.

Run the opt-in jitter smoke on the affected output device:

```bash
bun run smoke:output:jitter:mac
```

Report underrun count, device name, sample format, and hardware/OS details. Do not “fix” starvation
by making queues unbounded or playing original audio.

## Runtime is Faulted

Faulted means a safety or cleanup step failed. The runtime may intentionally retain source
suppression until explicit cleanup.

1. Use Stop and wait for it to complete.
2. Do not start another relay session while Stop reports an error.
3. Quit the launcher cleanly after a successful Stop, then relaunch.
4. If the UI cannot stop, quit the source voice session and the launcher; record the error and
   verify normal source-app audio before trying again.

Never kill only the output/engine helper as a recovery shortcut while the capture route is engaged.
Ordered cleanup matters.

Common terminal causes include:

- capture sequence gap or 64-slot ring overflow;
- more than 6,000 ms of queued source duration (the UI target remains at most 1,000 ms);
- engine conversion/control timeout or worker exit;
- changed/invalid PCM format or body length;
- output rejection, underrun recovery failure, device loss, or drain timeout;
- route helper exit or failed suppression restoration.

If the selected app exits or relaunches, its resolved PID tree is no longer valid. Persona Voice
faults instead of waiting forever or silently following an unrelated process. Stop the relay,
reopen the app if needed, refresh sources, and Start again. `Route restoration unproven` is a
stronger warning: do not assume the original route is restored; quit the source application and
inspect diagnostics before retrying.

## OBS / BlackHole recording bus is blocked

The optional bus requires a local device with UID `BlackHole2ch_UID`. Install/configure BlackHole
independently, then refresh diagnostics. Persona Voice writes the same converted frames to the
default output and BlackHole; if either output cannot be prepared, engagement fails.

Use a normal, non-aggregate listening device as the macOS default. Persona Voice blocks every
default Aggregate/Multi-Output Device and any default route containing BlackHole: aggregate
membership can change during capture, and BlackHole on that route would let OBS receive unrelated
system audio or a duplicate converted stream. Persona Voice opens its own converted-only BlackHole
sink.

In recording software, avoid simultaneously recording the original application/system audio if the
goal is a converted-only mix. BlackHole/OBS behavior and storage are outside Persona Voice's privacy
boundary.

## History is missing or remains on disk

- History records only converted frames submitted to the active output session.
- The first discarded three seconds do not enter history.
- Disabling Save converted audio affects future frames only.
- Clear history removes indexed WAV files; backups/snapshots/recording software may retain copies.
- Retention cleanup runs every five minutes, so expiry is not an exact wall-clock deletion instant.

See [Privacy](PRIVACY.md) for the complete storage boundary.

## Logs and local data

Settings → Diagnostics can open the exact user-data directory. Typical files include:

```text
launcher-state.json
window-state.json
logs/launcher.jsonl
history/index.json
history/segments/*.wav
```

Developers may set `CODEX_PERSONA_VOICE_DATA_DIR` to an absolute dedicated test directory. Never
point it at a broad shared directory.

If the issue can expose sensitive audio, local data, or route-control behavior, report it through
[Security](../SECURITY.md) rather than a public issue.
