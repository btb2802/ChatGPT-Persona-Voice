"use strict";

class StoppedMutationGate {
  constructor(getRuntimeState) {
    if (typeof getRuntimeState !== "function") throw new Error("Runtime-state reader is required");
    this.getRuntimeState = getRuntimeState;
    this.active = null;
  }

  assertCanStart() {
    if (this.active) {
      throw new Error(`Cannot start the relay while ${this.active.label} is still being applied`);
    }
  }

  async run(label, operation) {
    if (typeof label !== "string" || !label.trim()) throw new Error("Mutation label is required");
    if (typeof operation !== "function") throw new Error("Mutation operation is required");
    if (this.active) throw new Error(`${this.active.label} is already being applied`);
    if (this.getRuntimeState() !== "stopped") {
      throw new Error("Stop the relay before changing audio settings");
    }

    let finish;
    const entry = {
      label: label.trim(),
      finished: new Promise((resolve) => { finish = resolve; }),
    };
    this.active = entry;
    try {
      return await operation();
    } finally {
      if (this.active === entry) this.active = null;
      finish();
    }
  }

  async waitForIdle() {
    const active = this.active;
    if (active) await active.finished;
  }
}

module.exports = { StoppedMutationGate };
