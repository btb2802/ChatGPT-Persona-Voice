"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { MacProcessRoute } = require("../electron/macos-process-route.cjs");
const {
  encodeAudioFrame,
  encodeFrame,
} = require("../electron/native-protocol.cjs");

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal = "SIGTERM") => {
    queueMicrotask(() => {
      child.exitCode = 0;
      child.emit("exit", 0, null);
    });
    return true;
  };
  return child;
}

function readyFrame() {
  return encodeFrame(
    "ready",
    Buffer.from(
      JSON.stringify({
        type: "ready",
        helper: "capture",
        protocolVersion: 1,
        source: "macOS process audio",
        pids: [10, 11],
        sampleRate: 48_000,
        channels: 2,
        sampleFormat: "f32le",
        supportsArming: true,
        supportsDeferredTap: true,
        supportsCaptureProof: true,
        armed: true,
        state: "armed",
        originalSuppressed: false,
        tapActive: false,
        activationSignal: "duplex_process_io",
      }),
    ),
  );
}

function statusFrame(state) {
  return encodeFrame(
    "status",
    Buffer.from(
      JSON.stringify({
        type: "status",
        state,
        reason:
          state === "engaged" ? "voice_session_active" : "voice_session_ended",
        originalSuppressed: state === "engaged",
        tapActive: state === "engaged",
        captureVerified: state === "engaged",
      }),
    ),
  );
}

function fixture(child = fakeChild()) {
  const spawns = [];
  const route = new MacProcessRoute({
    helperPath: "/helpers/capture",
    platform: "darwin",
    exists: () => true,
    probeHelper: async () => ({
      type: "ready",
      helper: "capture",
      protocolVersion: 1,
      sampleRate: 48_000,
      channels: 2,
      sampleFormat: "f32le",
      supportsArming: true,
      supportsDeferredTap: true,
      supportsCaptureProof: true,
    }),
    processResolver: async () => ({ pids: [10, 11], rootPids: [10] }),
    defaultProcessResolver: async () => ({ pids: [10, 11], rootPids: [10] }),
    spawnProcess: (executable, args) => {
      spawns.push({ executable, args });
      return child;
    },
  });
  return { child, route, spawns };
}

const settings = {
  sourceId: "process:darwin:Y2hhdGdwdA",
  sourceName: "ChatGPT",
};

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("macOS route probes without muting and shares concurrent native self-tests", async () => {
  {
    const { route, spawns } = fixture();
    assert.equal((await route.probe(settings)).ready, true);
    assert.deepEqual(await route.describe(settings), {
      sampleRate: 48_000,
      channels: 2,
      sampleFormat: "f32le",
    });
    assert.equal(spawns.length, 0);
    assert.equal(
      (await route.probe({ sourceId: null, sourceName: null })).ready,
      true,
    );
  }

  {
    let probeCalls = 0;
    let releaseProbe;
    const route = new MacProcessRoute({
      helperPath: "/helpers/capture",
      platform: "darwin",
      exists: () => true,
      probeHelper: async () => {
        probeCalls += 1;
        await new Promise((resolve) => {
          releaseProbe = resolve;
        });
        return {
          helper: "capture",
          sampleRate: 48_000,
          channels: 2,
          sampleFormat: "f32le",
          supportsArming: true,
          supportsDeferredTap: true,
          supportsCaptureProof: true,
        };
      },
    });
    const first = route.helperReadiness();
    const second = route.helperReadiness();
    assert.equal(probeCalls, 1);
    releaseProbe();
    assert.deepEqual(await first, await second);
  }
});

test("macOS route arms without a tap, then proves deferred engagement before exposing PCM", async () => {
  const { route, child, spawns } = fixture();
  const routeErrors = [];
  const statuses = [];
  const acquiring = route.acquire(
    settings,
    (error) => routeErrors.push(error),
    (status) => statuses.push(status),
  );
  await nextTurn();
  child.stdout.emit("data", readyFrame());
  const guard = await acquiring;
  assert.equal(guard.armed, true);
  assert.equal(guard.originalSuppressed, false);
  assert.deepEqual(spawns[0].args, ["--root-pid", "10"]);

  const frames = [];
  const errors = [];
  const source = route.open(
    settings,
    (frame) => frames.push(frame),
    (error) => errors.push(error),
  );
  assert.equal(statuses.at(-1).state, "armed");
  child.stdout.emit("data", statusFrame("engaged"));
  assert.equal(guard.originalSuppressed, true);
  assert.equal(statuses.at(-1).state, "engaged");
  const pcm = Buffer.alloc(4 * 2 * 4);
  child.stdout.emit(
    "data",
    encodeAudioFrame({
      sequence: 4,
      sampleRate: 48_000,
      channels: 2,
      samplesPerChannel: 4,
      pcm,
    }),
  );
  assert.equal(frames.length, 1);
  assert.equal(frames[0].sequence, 4);
  assert.deepEqual(Buffer.from(frames[0].pcm), pcm);
  assert.deepEqual(errors, []);
  assert.deepEqual(routeErrors, []);

  child.stdout.emit("data", statusFrame("armed"));
  assert.equal(guard.originalSuppressed, false);
  assert.equal(statuses.at(-1).state, "armed");
  await source.close();
  assert.equal(guard.armed, true);
  await guard.close();
  assert.equal(guard.armed, false);
  assert.equal(guard.originalSuppressed, false);
});

test("pre-ready native initialization failures with explicit route truth do not invent suppression", async () => {
  const { route, child } = fixture();
  route.terminateProcess = async (target) => {
    target.exitCode = 1;
    target.emit("exit", 1, null);
  };
  const acquiring = route.acquire(
    settings,
    () => {},
    () => {},
  );
  await nextTurn();
  child.stdout.emit(
    "data",
    encodeFrame(
      "error",
      Buffer.from(
        JSON.stringify({
          type: "error",
          code: "capture_initialization_failed",
          message:
            "No active Core Audio process matches the selected application.",
          suppressionHeld: false,
        }),
      ),
    ),
  );

  await assert.rejects(acquiring, /No active Core Audio process matches/);
  assert.equal(route.child, null);
  assert.equal(route.isSuppressed(), false);
  await route.release();
});

test("capture queue errors preserve suppression until guard close", async () => {
  const { route, child } = fixture();
  const routeErrors = [];
  const acquiring = route.acquire(
    settings,
    (error) => routeErrors.push(error),
    () => {},
  );
  await nextTurn();
  child.stdout.emit("data", readyFrame());
  const guard = await acquiring;
  const errors = [];
  route.open(
    settings,
    () => {},
    (error) => errors.push(error),
  );
  child.stdout.emit("data", statusFrame("engaged"));
  child.stdout.emit(
    "data",
    encodeFrame(
      "error",
      Buffer.from(
        JSON.stringify({
          type: "error",
          code: "capture_queue_fault",
          message: "queue full",
          suppressionHeld: true,
        }),
      ),
    ),
  );
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "capture_queue_fault");
  assert.deepEqual(routeErrors, []);
  assert.equal(guard.originalSuppressed, true);
  await guard.close();
  assert.equal(guard.originalSuppressed, false);
});

test("unexpected helper exit reports route loss", async () => {
  const { route, child } = fixture();
  const routeErrors = [];
  const acquiring = route.acquire(
    settings,
    (error) => routeErrors.push(error),
    () => {},
  );
  await nextTurn();
  child.stdout.emit("data", readyFrame());
  const guard = await acquiring;
  const streamErrors = [];
  route.open(
    settings,
    () => {},
    (error) => streamErrors.push(error),
  );
  child.stdout.emit("data", statusFrame("engaged"));
  child.exitCode = 9;
  child.emit("exit", 9, null);
  assert.equal(guard.originalSuppressed, false);
  assert.deepEqual(streamErrors, []);
  assert.equal(routeErrors.length, 1);
  assert.equal(routeErrors[0].code, "source_suppression_lost");
  assert.match(routeErrors[0].message, /no longer suppressed/);
  await guard.close();
});

test("route liveness remains subscribed after the PCM stream closes", async () => {
  const { route, child } = fixture();
  const routeErrors = [];
  const statuses = [];
  const acquiring = route.acquire(
    settings,
    (error) => routeErrors.push(error),
    (status) => statuses.push(status),
  );
  await nextTurn();
  child.stdout.emit("data", readyFrame());
  const guard = await acquiring;
  const source = route.open(
    settings,
    () => {},
    () => {},
  );
  child.stdout.emit("data", statusFrame("engaged"));
  await source.close();
  child.stdout.emit("data", statusFrame("armed"));
  assert.equal(statuses.at(-1).state, "armed");

  child.exitCode = 7;
  child.emit("exit", 7, null);
  assert.equal(guard.originalSuppressed, false);
  assert.equal(routeErrors.length, 1);
  assert.equal(routeErrors[0].suppressionHeld, false);
  await guard.close();
});

test("a route-loss error clears suppression truth before the helper exits", async () => {
  const { route, child } = fixture();
  const routeErrors = [];
  const acquiring = route.acquire(
    settings,
    (error) => routeErrors.push(error),
    () => {},
  );
  await nextTurn();
  child.stdout.emit("data", readyFrame());
  const guard = await acquiring;
  route.open(
    settings,
    () => {},
    () => {},
  );
  child.stdout.emit("data", statusFrame("engaged"));
  assert.equal(guard.originalSuppressed, true);

  child.stdout.emit(
    "data",
    encodeFrame(
      "error",
      Buffer.from(
        JSON.stringify({
          type: "error",
          code: "source_process_exited",
          message: "selected process exited",
          suppressionHeld: false,
        }),
      ),
    ),
  );
  assert.equal(routeErrors.length, 1);
  assert.equal(guard.originalSuppressed, false);
  assert.equal(guard.armed, false);

  child.exitCode = 1;
  child.emit("exit", 1, null);
  await guard.close();
});

test("an unproven route restoration remains faulted and cannot report safe release", async () => {
  const { route, child } = fixture();
  const acquiring = route.acquire(
    settings,
    () => {},
    () => {},
  );
  await nextTurn();
  child.stdout.emit("data", readyFrame());
  const guard = await acquiring;
  child.stdout.emit("data", statusFrame("engaged"));
  child.kill = () => {
    queueMicrotask(() => {
      child.stdout.emit(
        "data",
        encodeFrame(
          "error",
          Buffer.from(
            JSON.stringify({
              type: "error",
              code: "route_disengage_failed",
              message: "restore failed",
              suppressionHeld: true,
            }),
          ),
        ),
      );
      child.exitCode = 1;
      child.emit("exit", 1, null);
    });
    return true;
  };

  await assert.rejects(() => guard.close(), /restore failed|could not prove/);
  assert.equal(guard.originalSuppressed, true);
  await assert.rejects(() => guard.close(), /restore failed|could not prove/);
});

test("an asynchronous restoration failure preserves the native held-suppression truth", async () => {
  const { route, child } = fixture();
  const routeErrors = [];
  const acquiring = route.acquire(
    settings,
    (error) => routeErrors.push(error),
    () => {},
  );
  await nextTurn();
  child.stdout.emit("data", readyFrame());
  const guard = await acquiring;
  route.open(
    settings,
    () => {},
    () => {},
  );
  child.stdout.emit("data", statusFrame("engaged"));

  child.stdout.emit(
    "data",
    encodeFrame(
      "error",
      Buffer.from(
        JSON.stringify({
          type: "error",
          code: "route_disengage_failed",
          message: "native restore proof failed",
          suppressionHeld: true,
        }),
      ),
    ),
  );
  assert.equal(routeErrors.length, 1);
  assert.equal(routeErrors[0].suppressionHeld, true);
  assert.equal(guard.originalSuppressed, true);
  child.exitCode = 1;
  child.emit("exit", 1, null);
  assert.equal(guard.originalSuppressed, true);
  await assert.rejects(() => guard.close(), /native restore proof failed/);
});

test("route release retains its helper handle after failed termination proof", async () => {
  const child = fakeChild();
  let attempts = 0;
  const { route } = fixture(child);
  route.terminateProcess = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("termination not proven");
    child.exitCode = 0;
    child.emit("exit", 0, null);
  };
  const acquiring = route.acquire(
    settings,
    () => {},
    () => {},
  );
  await nextTurn();
  child.stdout.emit("data", readyFrame());
  const guard = await acquiring;
  child.stdout.emit("data", statusFrame("engaged"));

  await assert.rejects(() => guard.close(), /termination not proven/);
  assert.equal(guard.originalSuppressed, true);
  await guard.close();
  assert.equal(attempts, 2);
  assert.equal(guard.originalSuppressed, false);
});

test("route acquisition cancellation terminates the armed helper without waiting for timeout", async () => {
  const child = fakeChild();
  const { route } = fixture(child);
  let terminated = 0;
  route.terminateProcess = async () => {
    terminated += 1;
    child.exitCode = 0;
    child.emit("exit", 0, null);
  };
  const controller = new AbortController();
  const acquiring = route.acquire(
    settings,
    () => {},
    () => {},
    { signal: controller.signal },
  );
  await nextTurn();
  controller.abort(new Error("cancelled by Stop"));
  await assert.rejects(acquiring, /cancelled by Stop/);
  assert.equal(terminated, 1);
  assert.equal(route.child, null);
});

test("child-process uncertainty remains fail-closed until native restoration or clean release", async () => {
  {
    const child = fakeChild();
    let attempts = 0;
    const { route } = fixture(child);
    route.terminateProcess = async () => {
      attempts += 1;
      if (attempts === 1) {
        child.emit("error", new Error("kill EPERM"));
        throw new Error("termination not proven");
      }
      child.exitCode = 0;
      child.emit("exit", 0, null);
    };
    const acquiring = route.acquire(
      settings,
      () => {},
      () => {},
    );
    await nextTurn();
    child.stdout.emit("data", readyFrame());
    const guard = await acquiring;
    child.stdout.emit("data", statusFrame("engaged"));

    await assert.rejects(() => guard.close(), /termination not proven/);
    assert.equal(guard.originalSuppressed, true);
    await guard.close();
    assert.equal(guard.originalSuppressed, false);
  }

  {
    const { route, child } = fixture();
    const routeErrors = [];
    const statuses = [];
    const acquiring = route.acquire(
      settings,
      (error) => routeErrors.push(error),
      (status) => statuses.push(status),
    );
    await nextTurn();
    child.stdout.emit("data", readyFrame());
    const guard = await acquiring;
    child.stdout.emit("data", statusFrame("engaged"));
    child.emit("error", new Error("process control failed"));
    assert.equal(routeErrors.length, 1);
    assert.equal(routeErrors[0].suppressionHeld, true);
    assert.equal(guard.originalSuppressed, true);

    child.stdout.emit("data", statusFrame("armed"));
    assert.equal(statuses.at(-1).state, "armed");
    assert.equal(guard.originalSuppressed, false);
    await guard.close();
  }

  {
    const { route, child } = fixture();
    const routeErrors = [];
    const acquiring = route.acquire(
      settings,
      (error) => routeErrors.push(error),
      () => {},
    );
    await nextTurn();
    child.stdout.emit("data", readyFrame());
    const guard = await acquiring;

    child.emit("error", new Error("process control failed while armed"));
    assert.equal(routeErrors.length, 1);
    assert.equal(routeErrors[0].suppressionHeld, true);
    assert.equal(guard.originalSuppressed, true);
    assert.equal(guard.restorationUnproven, true);

    await guard.close();
    assert.equal(guard.originalSuppressed, false);
    assert.equal(guard.restorationUnproven, false);
  }

  {
    const { route, child } = fixture();
    const acquiring = route.acquire(
      settings,
      () => {},
      () => {},
    );
    await nextTurn();
    child.stdout.emit("data", readyFrame());
    const guard = await acquiring;
    child.stdout.emit("data", statusFrame("engaged"));
    child.emit("error", new Error("process control failed"));
    child.exitCode = 1;
    child.emit("exit", 1, null);
    assert.equal(guard.originalSuppressed, true);
    await assert.rejects(
      () => guard.close(),
      /without proving route restoration/,
    );
  }

  {
    const { route, child } = fixture();
    const routeErrors = [];
    const acquiring = route.acquire(
      settings,
      (error) => routeErrors.push(error),
      () => {},
    );
    await nextTurn();
    child.stdout.emit("data", readyFrame());
    const guard = await acquiring;
    child.stdout.emit("data", statusFrame("engaged"));
    child.emit("error", new Error("process control failed"));
    assert.equal(guard.restorationUnproven, true);

    child.stdout.emit(
      "data",
      encodeFrame(
        "error",
        Buffer.from(
          JSON.stringify({
            type: "error",
            code: "source_process_exited",
            message: "source exited after route restoration",
            suppressionHeld: false,
          }),
        ),
      ),
    );
    assert.equal(guard.originalSuppressed, false);
    assert.equal(guard.restorationUnproven, false);
    child.exitCode = 1;
    child.emit("exit", 1, null);
    await guard.close();
    assert.equal(routeErrors.length, 1);
  }
});

test("duplicate capture readiness cannot downgrade an engaged suppression state", async () => {
  const { route, child } = fixture();
  const routeErrors = [];
  const acquiring = route.acquire(
    settings,
    (error) => routeErrors.push(error),
    () => {},
  );
  await nextTurn();
  child.stdout.emit("data", readyFrame());
  const guard = await acquiring;
  child.stdout.emit("data", statusFrame("engaged"));
  child.stdout.emit("data", readyFrame());

  assert.equal(routeErrors.length, 1);
  assert.match(routeErrors[0].message, /readiness more than once/);
  assert.equal(routeErrors[0].suppressionHeld, true);
  assert.equal(guard.originalSuppressed, true);
  assert.equal(guard.restorationUnproven, true);
  await guard.close();
  assert.equal(guard.originalSuppressed, false);
});

test("invalid lifecycle control faults the route even before PCM callbacks open", async () => {
  const { route, child } = fixture();
  const routeErrors = [];
  const acquiring = route.acquire(
    settings,
    (error) => routeErrors.push(error),
    () => {},
  );
  await nextTurn();
  child.stdout.emit("data", readyFrame());
  const guard = await acquiring;
  child.stdout.emit(
    "data",
    encodeFrame(
      "status",
      Buffer.from(
        JSON.stringify({
          type: "status",
          state: "engaged",
          reason: "invalid",
          originalSuppressed: false,
          tapActive: true,
          captureVerified: true,
        }),
      ),
    ),
  );
  assert.equal(routeErrors.length, 1);
  assert.match(routeErrors[0].message, /invalid route lifecycle/);
  assert.equal(guard.originalSuppressed, true);
  assert.equal(guard.restorationUnproven, true);
  await guard.close();
  assert.equal(guard.originalSuppressed, false);
});

test("a capture stream fault between route readiness and source open is retained", async () => {
  const { route, child } = fixture();
  const acquiring = route.acquire(
    settings,
    () => {},
    () => {},
  );
  await nextTurn();
  child.stdout.emit("data", readyFrame());
  const guard = await acquiring;
  child.stdout.emit("data", statusFrame("engaged"));
  child.stdout.emit(
    "data",
    encodeFrame(
      "error",
      Buffer.from(
        JSON.stringify({
          type: "error",
          code: "capture_queue_fault",
          message: "queue fault before open",
          suppressionHeld: true,
        }),
      ),
    ),
  );

  assert.throws(
    () =>
      route.open(
        settings,
        () => {},
        () => {},
      ),
    /queue fault before open/,
  );
  assert.equal(guard.originalSuppressed, true);
  await guard.close();
});

test("native held-suppression truth wins before the engaged status is delivered", async () => {
  const { route, child } = fixture();
  const acquiring = route.acquire(
    settings,
    () => {},
    () => {},
  );
  await nextTurn();
  child.stdout.emit("data", readyFrame());
  const guard = await acquiring;
  assert.equal(guard.originalSuppressed, false);

  child.stdout.emit(
    "data",
    encodeFrame(
      "error",
      Buffer.from(
        JSON.stringify({
          type: "error",
          code: "capture_queue_fault",
          message: "queue fault after native mute",
          suppressionHeld: true,
        }),
      ),
    ),
  );
  assert.equal(guard.originalSuppressed, true);
  assert.equal(guard.restorationUnproven, true);
  assert.throws(
    () =>
      route.open(
        settings,
        () => {},
        () => {},
      ),
    /queue fault after native mute/,
  );

  await guard.close();
  assert.equal(guard.originalSuppressed, false);
  assert.equal(guard.restorationUnproven, false);
});

test("capture lifecycle status before initial readiness is terminal and conservatively cleaned", async () => {
  const { route, child } = fixture();
  const acquiring = route.acquire(
    settings,
    () => {},
    () => {},
  );
  await nextTurn();
  child.stdout.emit("data", statusFrame("engaged"));
  await assert.rejects(acquiring, /status before readiness/);
  assert.equal(route.child, null);
});

test("coalesced readiness failures preserve owned cleanup and truthful suppression state", async () => {
  {
    const child = fakeChild();
    const { route } = fixture(child);
    let terminated = 0;
    route.terminateProcess = async () => {
      terminated += 1;
      child.exitCode = 0;
      child.emit("exit", 0, null);
    };
    const routeErrors = [];
    const statuses = [];
    const acquiring = route.acquire(
      settings,
      (error) => routeErrors.push(error),
      (status) => statuses.push(status),
    );
    await nextTurn();
    child.stdout.emit(
      "data",
      Buffer.concat([
        readyFrame(),
        encodeFrame(
          "error",
          Buffer.from(
            JSON.stringify({
              type: "error",
              code: "source_process_exited",
              message: "source vanished during acquisition",
              suppressionHeld: false,
            }),
          ),
        ),
      ]),
    );

    await assert.rejects(acquiring, /source vanished during acquisition/);
    assert.equal(terminated, 1);
    assert.equal(route.child, null);
    assert.deepEqual(routeErrors, []);
    assert.deepEqual(statuses, []);
  }

  {
    const child = fakeChild();
    const { route } = fixture(child);
    route.terminateProcess = async () => {
      child.exitCode = 1;
      child.emit("exit", 1, null);
    };
    const routeErrors = [];
    const statuses = [];
    const acquiring = route.acquire(
      settings,
      (error) => routeErrors.push(error),
      (status) => statuses.push(status),
    );
    await nextTurn();
    child.stdout.emit(
      "data",
      Buffer.concat([
        readyFrame(),
        statusFrame("engaged"),
        encodeFrame(
          "error",
          Buffer.from(
            JSON.stringify({
              type: "error",
              code: "route_disengage_failed",
              message: "restore failed during acquisition",
              suppressionHeld: true,
            }),
          ),
        ),
      ]),
    );

    let failure;
    try {
      await acquiring;
    } catch (error) {
      failure = error;
    }
    assert.match(failure?.message || "", /restore failed during acquisition/);
    assert.equal(failure?.suppressionHeld, true);
    assert.equal(failure?.suppressionSession?.originalSuppressed, true);
    assert.equal(failure?.suppressionSession?.restorationUnproven, true);
    assert.deepEqual(routeErrors, []);
    assert.deepEqual(statuses, []);
    await assert.rejects(
      () => failure.suppressionSession.close(),
      /restore failed during acquisition/,
    );
  }

  {
    const child = fakeChild();
    const { route } = fixture(child);
    let attempts = 0;
    route.terminateProcess = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("termination not proven");
      child.exitCode = 0;
      child.emit("exit", 0, null);
    };
    const acquiring = route.acquire(
      settings,
      () => {},
      () => {},
    );
    await nextTurn();
    child.stdout.emit(
      "data",
      Buffer.concat([
        readyFrame(),
        encodeFrame(
          "error",
          Buffer.from(
            JSON.stringify({
              type: "error",
              code: "malformed_error",
              message: "missing route truth",
            }),
          ),
        ),
      ]),
    );

    let failure;
    try {
      await acquiring;
    } catch (error) {
      failure = error;
    }
    assert.match(failure?.message || "", /could not be terminated/);
    assert.equal(failure?.suppressionHeld, true);
    assert.equal(failure?.suppressionSession?.originalSuppressed, true);
    assert.equal(failure?.suppressionSession?.restorationUnproven, true);
    assert.equal(route.child, child);
    await failure.suppressionSession.close();
    assert.equal(failure.suppressionSession.originalSuppressed, false);
    assert.equal(failure.suppressionSession.restorationUnproven, false);
  }
});

test("PCM while armed faults the control route even before source callbacks open", async () => {
  const { route, child } = fixture();
  const routeErrors = [];
  const acquiring = route.acquire(
    settings,
    (error) => routeErrors.push(error),
    () => {},
  );
  await nextTurn();
  child.stdout.emit("data", readyFrame());
  const guard = await acquiring;
  child.stdout.emit(
    "data",
    encodeAudioFrame({
      sequence: 0,
      sampleRate: 48_000,
      channels: 2,
      samplesPerChannel: 1,
      pcm: Buffer.alloc(8),
    }),
  );
  assert.equal(routeErrors.length, 1);
  assert.match(routeErrors[0].message, /before proving original suppression/);
  assert.equal(guard.originalSuppressed, true);
  assert.equal(guard.restorationUnproven, true);
  await guard.close();
  assert.equal(guard.originalSuppressed, false);
});

test("a post-ready native error cannot omit suppression truth", async () => {
  const { route, child } = fixture();
  const routeErrors = [];
  const acquiring = route.acquire(
    settings,
    (error) => routeErrors.push(error),
    () => {},
  );
  await nextTurn();
  child.stdout.emit("data", readyFrame());
  const guard = await acquiring;
  child.stdout.emit("data", statusFrame("engaged"));
  child.stdout.emit(
    "data",
    encodeFrame(
      "error",
      Buffer.from(
        JSON.stringify({
          type: "error",
          code: "malformed_error",
          message: "missing route truth",
        }),
      ),
    ),
  );
  assert.equal(routeErrors.length, 1);
  assert.match(routeErrors[0].message, /omitted its suppression state/);
  assert.equal(guard.originalSuppressed, true);
  assert.equal(guard.restorationUnproven, true);
  await guard.close();
});
