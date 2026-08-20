"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { StoppedMutationGate } = require("../electron/stopped-mutation-gate.cjs");

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

test("stopped-only mutations exclude startup and always release their gate", async () => {
  let state = "stopped";
  const gate = new StoppedMutationGate(() => state);
  const release = deferred();
  const mutation = gate.run("source selection", async () => {
    await release.promise;
    return "saved";
  });

  assert.throws(() => gate.assertCanStart(), /source selection is still being applied/);
  await assert.rejects(() => gate.run("voice selection", async () => {}), /source selection is already/);
  const idle = gate.waitForIdle();
  release.resolve();
  assert.equal(await mutation, "saved");
  await idle;
  assert.doesNotThrow(() => gate.assertCanStart());

  state = "running";
  await assert.rejects(() => gate.run("settings update", async () => {}), /Stop the relay/);
  const failedGate = new StoppedMutationGate(() => "stopped");
  await assert.rejects(
    () => failedGate.run("source selection", async () => { throw new Error("discovery failed"); }),
    /discovery failed/,
  );
  assert.doesNotThrow(() => failedGate.assertCanStart());
  assert.equal(await failedGate.run("settings update", async () => 42), 42);
});
