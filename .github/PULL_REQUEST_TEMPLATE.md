## Summary

<!-- What problem does this solve, and what user-visible/runtime behavior changes? -->

## Scope and architecture

<!-- Which renderer/main/native/engine/output/persistence boundaries are affected? -->

- Platforms affected:
- Runtime/protocol states affected:
- Explicitly out of scope:

## Safety and recovery

<!-- Describe readiness, suppression, failure, queue/time bounds, ordered cleanup, and rollback. -->

- [ ] No identity/pass-through or hidden compatibility fallback was added.
- [ ] Missing/invalid dependencies and unsupported platforms still fail closed.
- [ ] Fault and cleanup behavior has a regression test or documented manual evidence.

## Privacy, security, and licenses

- [ ] I documented any new local data, network request, permission, diagnostic, or retention behavior.
- [ ] I documented third-party code/model/voice provenance, hashes, terms, and required credits.
- [ ] No private audio, credentials, user data, runtime cache, generated artifact, or log is included.
- [ ] Security-sensitive details are being coordinated privately when necessary.

## Verification

<!-- Replace with exact commands and results. Include host/OS/hardware for native/engine evidence. -->

```text
bun run test
bun run typecheck
bun run build:renderer
```

- [ ] Applicable native/engine/permissioned smokes were run or marked not applicable with a reason.
- [ ] Contract, platform, privacy, troubleshooting, and changelog docs were updated where behavior changed.
- [ ] UI changes were checked for keyboard/focus, long content, and truthful runtime state.

## Release truth

- [ ] This PR does not present a local artifact as a supported installer.
- [ ] Platform and latency claims are backed by the stated evidence and preserve known limitations.
