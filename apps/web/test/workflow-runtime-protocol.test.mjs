import assert from "node:assert/strict";
import test from "node:test";

import {
  EMBEDDED_RUNTIME_PROTOCOLS,
  resolveRuntimeProtocol,
} from "../workflow-runtime-protocol.mjs";

test("runtime protocol normalizes a hash-bound embedded projection", async () => {
  const resolved = await resolveRuntimeProtocol("balanced", async (mode) => ({
    schemaVersion: 1,
    sourceId: "agent-control-plane/workflow-core",
    contractVersion: "1.1.0",
    contractSha256: `sha256:${"a".repeat(64)}`,
    mode,
    protocol: EMBEDDED_RUNTIME_PROTOCOLS.balanced,
  }));
  assert.equal(resolved.source, "agent-control-plane/workflow-core");
  assert.equal(resolved.reviewState, "review_pending");
  assert.ok(resolved.reviewDecisions.has("revise"));
});

test("runtime protocol rejects references to undeclared states", async () => {
  await assert.rejects(
    resolveRuntimeProtocol("overnight", async () => ({
      protocol: {
        ...EMBEDDED_RUNTIME_PROTOCOLS.overnight,
        active_state: "unknown",
      },
    })),
    /unknown state/,
  );
});
