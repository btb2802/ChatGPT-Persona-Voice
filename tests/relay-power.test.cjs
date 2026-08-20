"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createRelayPowerController } = require("../electron/relay-power.cjs");

test("relay power controller acquires once, releases once, and fails closed", () => {
  const started = new Set();
  const calls = [];
  const controller = createRelayPowerController({
    start: (type) => {
      calls.push(["start", type]);
      started.add(17);
      return 17;
    },
    isStarted: (id) => started.has(id),
    stop: (id) => {
      calls.push(["stop", id]);
      return started.delete(id);
    },
  });

  assert.equal(controller.start(), 17);
  assert.equal(controller.start(), 17);
  assert.equal(controller.active, true);
  assert.equal(controller.stop(), true);
  assert.equal(controller.stop(), false);
  assert.equal(controller.active, false);
  assert.deepEqual(calls, [
    ["start", "prevent-app-suspension"],
    ["stop", 17],
  ]);
  const stopped = [];
  const rejectedController = createRelayPowerController({
    start: () => 21,
    isStarted: () => false,
    stop: (id) => { stopped.push(id); return true; },
  });
  assert.throws(() => rejectedController.start(), /Could not prevent voice relay suspension/);
  assert.deepEqual(stopped, [21]);
  assert.equal(rejectedController.active, false);
});
