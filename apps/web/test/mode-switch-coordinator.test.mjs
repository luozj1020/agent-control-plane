import assert from "node:assert/strict";
import test from "node:test";

import { createLatestSwitchCoordinator } from "../public/mode-switch-coordinator.js";

function deferred() {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

test("serializes mode writes and keeps only the latest pending selection", async () => {
  const first = deferred();
  const applied = [];
  let concurrent = 0;
  let maximumConcurrent = 0;
  const coordinator = createLatestSwitchCoordinator({
    async apply(modeId) {
      applied.push(modeId);
      concurrent += 1;
      maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      if (modeId === "balanced") await first.promise;
      concurrent -= 1;
    },
  });

  const completion = coordinator.request("balanced");
  coordinator.request("overnight");
  coordinator.request("interactive");
  first.resolve();
  await completion;

  assert.deepEqual(applied, ["balanced", "interactive"]);
  assert.equal(maximumConcurrent, 1);
  assert.deepEqual(coordinator.state(), {
    active: null,
    pending: null,
    running: false,
  });
});

test("continues with the latest selection after an apply failure is handled", async () => {
  const applied = [];
  const coordinator = createLatestSwitchCoordinator({
    async apply(modeId) {
      try {
        if (modeId === "balanced") throw new Error("blocked");
        applied.push(modeId);
      } catch {
        applied.push(`${modeId}:failed`);
      }
    },
  });

  await coordinator.request("balanced");
  await coordinator.request("interactive");
  assert.deepEqual(applied, ["balanced:failed", "interactive"]);
});
