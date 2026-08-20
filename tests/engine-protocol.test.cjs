"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { EngineMessageParser, encodeEngineMessage } = require("../electron/engine-protocol.cjs");

test("engine protocol preserves split and coalesced binary messages", () => {
  const received = [];
  const parser = new EngineMessageParser((message) => received.push(message));
  const first = encodeEngineMessage({ type: "convert", id: 7 }, Buffer.from([1, 2, 3]));
  const second = encodeEngineMessage({ type: "reset", id: 8 });
  parser.push(first.subarray(0, 5));
  parser.push(Buffer.concat([first.subarray(5), second]));
  parser.finish();
  assert.deepEqual(received.map((message) => message.header), [
    { type: "convert", id: 7 },
    { type: "reset", id: 8 },
  ]);
  assert.deepEqual([...received[0].body], [1, 2, 3]);
  assert.equal(received[1].body.length, 0);
});

test("engine protocol rejects corrupt framing and truncated streams", () => {
  assert.throws(() => encodeEngineMessage({ id: 1 }), /header/);
  const parser = new EngineMessageParser(() => {});
  assert.throws(() => parser.push(Buffer.alloc(12)), /magic/);
  const truncated = new EngineMessageParser(() => {});
  truncated.push(encodeEngineMessage({ type: "reset", id: 1 }).subarray(0, 10));
  assert.throws(() => truncated.finish(), /truncated/);
});
