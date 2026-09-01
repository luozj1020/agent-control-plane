import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createWorkflowCoreAdapter } from "../workflow-core-adapter.mjs";
import { EMBEDDED_RUNTIME_PROTOCOLS } from "../workflow-runtime-protocol.mjs";

function hash(content) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function fixture(run, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "acp-aiwf-"));
  const schemaContent = Buffer.from('{"schema_version":1}\n');
  await mkdir(join(root, "contracts"));
  await mkdir(join(root, "schemas"));
  await writeFile(join(root, "schemas", "task-card-v1.schema.json"), schemaContent);
  const contract = {
    schema_version: 1,
    contract_id: "ai-coding-workflow",
    contract_version: overrides.version ?? "1.1.0",
    modes: (overrides.modes ?? ["overnight", "balanced", "interactive"]).map((id) => ({ id })),
    overnight_strategies: ["convergent", "continuous-improvement"].map((id) => ({ id })),
    review: { balanced_decisions: ["accept", "revise", "stop"] },
    projections: {
      task_card: { schema_binding: "task-card-v1", schema_version: 1 },
      control_plane_runtime: {
        overnight: {
          states: ["submitted", "running", "revision_pending", "accepted"],
          initial_state: "submitted",
          active_state: "running",
          wake_states: ["revision_pending"],
          terminal_states: ["accepted"],
          review_decisions: { revision_pending: ["accept", "revise", "stop"] },
          outcome_states: {
            interrupted: "accepted",
            runtime_failure: "revision_pending",
            scope_failure: "revision_pending",
            validation_failure: "revision_pending",
            no_change: "revision_pending",
            convergent_ready: "revision_pending",
            improvement_ready: "revision_pending",
          },
          decision_states: {
            accept: "accepted",
            stop: "accepted",
            revise: "submitted",
            continue: "submitted",
            interrupt: "accepted",
            interrupt_requested: "running",
          },
        },
        balanced: {
          states: ["created", "running", "review_pending", "accepted", "stopped"],
          initial_state: "created",
          active_state: "running",
          review_state: "review_pending",
          terminal_states: ["accepted", "stopped"],
          evidence_statuses: ["review_pending", "runtime_blocked"],
          review_decisions: ["accept", "revise", "stop"],
          outcome_states: {
            ready: "review_pending",
            runtime_failure: "review_pending",
            budget_failure: "review_pending",
            scope_failure: "review_pending",
            validation_failure: "review_pending",
          },
          decision_states: { accept: "accepted", revise: "running", stop: "stopped" },
        },
      },
    },
    schema_bindings: [{
      id: "task-card-v1",
      path: "schemas/task-card-v1.schema.json",
      sha256: overrides.bindingHash ?? hash(schemaContent),
    }],
  };
  await writeFile(join(root, "contracts", "workflow-contract-v1.json"), JSON.stringify(contract));
  try {
    await run({ root, schemaContent });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("default adapter binds the packaged Workflow Core without external discovery", async () => {
  const status = await createWorkflowCoreAdapter({
    environment: { AGENT_CONTROL_AIWF_ROOT: join(tmpdir(), "legacy-external-root") },
    candidateRoots: [join(tmpdir(), "legacy-sibling-root")],
  }).status();
  assert.equal(status.sourceId, "agent-control-plane/workflow-core");
  assert.equal(status.source.kind, "embedded");
  assert.match(status.source.root, /packages\/workflow-core$/);
  assert.equal(status.compatible, true);
  assert.equal(status.health, "compatible");
  assert.deepEqual(status.drift, []);
});

test("adapter loads a compatible embedded workflow contract and verifies schema bindings", async () => {
  await fixture(async ({ root, schemaContent }) => {
    const adapter = createWorkflowCoreAdapter({
      sourceRoot: root,
      localCompatibilitySurface: {
        modeIds: ["overnight", "balanced", "interactive"],
        overnightStrategyIds: ["convergent", "continuous-improvement"],
        balancedDecisions: ["accept", "revise", "stop"],
      },
    });
    const status = await adapter.status();
    assert.equal(status.available, true);
    assert.equal(status.compatible, true);
    assert.equal(status.health, "compatible");
    assert.equal(status.contractVersion, "1.1.0");
    assert.match(status.contractSha256, /^sha256:[0-9a-f]{64}$/);
    assert.equal(status.authority.workflowSemantics, "agent-control-plane/workflow-core");
    assert.equal(status.authority.localRuntime, "embedded-projection");
    assert.ok(status.checks.every((entry) => entry.status === "passed"));

    const schema = await adapter.schema("task-card-v1");
    assert.equal(schema.schema.schema_version, 1);
    assert.equal(schema.binding.sha256, hash(schemaContent));
    const protocol = await adapter.runtimeProtocol("balanced");
    assert.equal(protocol.contractVersion, "1.1.0");
    assert.equal(protocol.protocol.review_state, "review_pending");
  });
});

test("adapter ignores unused local compatibility copies after embedded projection", async () => {
  await fixture(async ({ root }) => {
    const adapter = createWorkflowCoreAdapter({
      sourceRoot: root,
      localCompatibilitySurface: {
        modeIds: ["overnight", "balanced", "interactive"],
        overnightStrategyIds: ["convergent", "continuous-improvement"],
        balancedDecisions: ["accept", "revise", "stop"],
        taskCardSchemaPath: join(root, "unused-local-copy.json"),
        runtimeAuthority: "compatibility-layer",
      },
    });
    const status = await adapter.status();
    assert.equal(status.compatible, true);
    assert.equal(status.health, "compatible");
    assert.deepEqual(status.drift, []);
  });
});

test("adapter fails closed when runtime safety defaults drift from the embedded projection", async () => {
  await fixture(async ({ root }) => {
    const adapter = createWorkflowCoreAdapter({
      sourceRoot: root,
      localCompatibilitySurface: {
        modeIds: ["overnight", "balanced", "interactive"],
        overnightStrategyIds: ["convergent", "continuous-improvement"],
        balancedDecisions: ["accept", "revise", "stop"],
        runtimeProtocols: EMBEDDED_RUNTIME_PROTOCOLS,
      },
    });
    const status = await adapter.status();
    assert.equal(status.compatible, false);
    assert.equal(status.health, "incompatible");
    assert.equal(
      status.checks.find((entry) => entry.id === "control-plane-projection")?.status,
      "failed",
    );
  });
});

test("adapter fails closed for unsupported major versions and a missing embedded root", async () => {
  await fixture(async ({ root }) => {
    const incompatible = await createWorkflowCoreAdapter({
      sourceRoot: root,
      localCompatibilitySurface: {
        modeIds: ["overnight", "balanced", "interactive"],
        overnightStrategyIds: ["convergent", "continuous-improvement"],
        balancedDecisions: ["accept", "revise", "stop"],
      },
    }).status();
    assert.equal(incompatible.health, "incompatible");
    assert.equal(incompatible.compatible, false);
  }, { version: "2.0.0" });

  const unavailable = await createWorkflowCoreAdapter({
    sourceRoot: join(tmpdir(), "missing-workflow-core"),
  }).status();
  assert.equal(unavailable.health, "unavailable");
  assert.equal(unavailable.available, false);
});
