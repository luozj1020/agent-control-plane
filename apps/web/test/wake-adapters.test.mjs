import assert from "node:assert/strict";
import test from "node:test";

import { createDurableFileWakeAdapter, createWakeAdapterRegistry } from "../wake-adapters.mjs";

test("durable wake adapter schedules a hash-bound request without launching an upstream process", async () => {
  const adapter = createDurableFileWakeAdapter();
  const result = await adapter.deliver({
    wakeId: "a".repeat(64),
    wakePath: "/tmp/run/wake-request.json",
  });
  assert.deepEqual(result, {
    status: "scheduled",
    wakeId: "a".repeat(64),
    transport: "durable-file",
    detail: "A harness may consume the hash-bound wake request and open the next upstream episode.",
  });
});

test("wake adapter registry supports target-specific plugins and keeps durable-file as default", () => {
  const custom = { id: "codex-host", displayName: "Codex host", async deliver() {} };
  const registry = createWakeAdapterRegistry({ adapters: [custom] });
  assert.equal(registry.get("durable-file").id, "durable-file");
  assert.equal(registry.get("codex-host"), custom);
  assert.deepEqual(registry.list(), [
    { id: "durable-file", displayName: "Durable wake file" },
    { id: "codex-host", displayName: "Codex host" },
  ]);
});
