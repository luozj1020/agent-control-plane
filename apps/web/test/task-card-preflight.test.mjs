import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createTaskCardTemplate } from "../task-card.mjs";
import { preflightTaskCard } from "../task-card-preflight.mjs";

const adapters = [{
  id: "claude-code",
  displayName: "Claude Code",
  requiresNetwork: true,
  filesystemIsolation: "post-run-only",
}];

test("preflight builds a hash-bound Overnight envelope without launching an agent", async () => {
  const worktree = await mkdtemp(join(tmpdir(), "agent-control-preflight-"));
  try {
    const result = await preflightTaskCard({
      task: {
        ...createTaskCardTemplate(),
        id: "preflight-task",
        validation: [{ id: "tests", command: ["npm", "test"] }],
      },
      workflowMode: "overnight",
      worktree,
      adapterId: "claude-code",
      strategy: "convergent",
    }, { adapters, environment: {} });

    assert.equal(result.ready, true);
    assert.match(result.taskSha256, /^[a-f0-9]{64}$/);
    assert.equal(result.envelope.workflowMode, "overnight");
    assert.equal(result.envelope.strategy, "convergent");
    assert.equal(result.envelope.taskSha256, result.taskSha256);
    assert.deepEqual(result.issues.map((entry) => entry.code), [
      "preflight.filesystem_isolation_advisory",
      "preflight.read_containment_unsupported",
    ]);
    assert.ok(result.checks.every((entry) => ["passed", "warning"].includes(entry.status)));
  } finally {
    await rm(worktree, { recursive: true, force: true });
  }
});

test("preflight reports all launch blockers and keeps warnings non-blocking", async () => {
  const task = createTaskCardTemplate();
  task.risk.security = "yes";
  const warning = await preflightTaskCard({
    task,
    workflowMode: "balanced",
    worktree: tmpdir(),
    adapterId: "claude-code",
    timing: {
      contextAcquisitionSeconds: 600,
      firstProgressSeconds: 600,
      activeWindowSeconds: 600,
      progressExtensionSeconds: 300,
      growingProgressExtensionSeconds: 300,
      hardCapSeconds: 1500,
    },
    budget: {
      mainReviewCalls: 3,
      downstreamCalls: 3,
      advisorCalls: 2,
      reservedFinalReviewCalls: 1,
    },
  }, { adapters, environment: {} });

  assert.equal(warning.ready, true);
  assert.ok(warning.issues.some((entry) => entry.code === "preflight.validation_empty"));
  assert.ok(warning.issues.some((entry) => entry.code === "preflight.human_authority"));
  assert.equal(warning.envelope.timing.activeWindowSeconds, 600);

  const blocked = await preflightTaskCard({
    task,
    workflowMode: "interactive",
    worktree: "relative/path",
    adapterId: "missing",
  }, { adapters, environment: {} });
  assert.equal(blocked.ready, false);
  assert.ok(blocked.issues.some((entry) => entry.code === "preflight.workflow_mode"));
  assert.ok(blocked.issues.some((entry) => entry.code === "preflight.worktree"));
  assert.ok(blocked.issues.some((entry) => entry.code === "preflight.adapter"));

  const invalidBalanced = await preflightTaskCard({
    task,
    workflowMode: "balanced",
    worktree: tmpdir(),
    adapterId: "claude-code",
    timing: {
      contextAcquisitionSeconds: 600,
      firstProgressSeconds: 600,
      activeWindowSeconds: 600,
      progressExtensionSeconds: 300,
      growingProgressExtensionSeconds: 300,
      hardCapSeconds: 60,
    },
    budget: {
      mainReviewCalls: 1,
      downstreamCalls: 3,
      advisorCalls: 2,
      reservedFinalReviewCalls: 2,
    },
  }, { adapters, environment: {} });
  assert.equal(invalidBalanced.ready, false);
  assert.ok(invalidBalanced.issues.some((entry) => entry.path === "timing.hardCapSeconds"));
  assert.ok(invalidBalanced.issues.some((entry) => entry.path === "budget.reservedFinalReviewCalls"));
});

test("preflight distinguishes exact containment from partial read audit", async () => {
  const input = {
    task: createTaskCardTemplate(),
    workflowMode: "overnight",
    worktree: tmpdir(),
    strategy: "convergent",
  };
  const exact = await preflightTaskCard({ ...input, adapterId: "exact" }, {
    adapters: [{
      id: "exact",
      displayName: "Exact Adapter",
      requiresNetwork: false,
      readContainment: "exact-paths",
      writeContainment: "exact-paths",
    }],
    environment: {},
  });
  assert.equal(exact.ready, true);
  assert.equal(exact.checks.find((entry) => entry.id === "read-containment").status, "passed");
  assert.equal(exact.checks.find((entry) => entry.id === "write-containment").status, "passed");
  assert.ok(!exact.issues.some((entry) => entry.code.includes("containment")));

  const partial = await preflightTaskCard({ ...input, adapterId: "partial" }, {
    adapters: [{
      id: "partial",
      displayName: "Partial Adapter",
      requiresNetwork: false,
      readContainment: "partial-event-audit",
      writeContainment: "post-run-audit",
      filesystemEventSource: "test-events",
    }],
    environment: {},
  });
  assert.equal(partial.ready, true);
  assert.ok(partial.issues.some((entry) => entry.code === "preflight.read_containment_partial"));
  assert.equal(partial.checks.find((entry) => entry.id === "read-containment").status, "warning");
});

test("preflight returns Task Card validation failures as structured checks", async () => {
  const invalid = createTaskCardTemplate();
  invalid.scope.write_paths = ["../outside"];
  const result = await preflightTaskCard({
    task: invalid,
    workflowMode: "overnight",
    worktree: tmpdir(),
    adapterId: "claude-code",
    strategy: "continuous-improvement",
  }, { adapters, environment: {} });

  assert.equal(result.ready, false);
  assert.equal(result.task, null);
  assert.equal(result.taskSha256, null);
  assert.ok(result.issues.some((entry) => entry.code === "task.unsafe_path"));
  assert.equal(result.checks.find((entry) => entry.id === "task-card").status, "failed");
});

test("preflight reports interface ownership and deterministic boundary coverage", async () => {
  const worktree = await mkdtemp(join(tmpdir(), "agent-control-interface-preflight-"));
  try {
    const task = createTaskCardTemplate();
    task.extensions.task_shape = {
      participants: [
        { id: "producer", owner: "worker", responsibilities: ["Produce normalized data"] },
        { id: "consumer", owner: "tester", responsibilities: ["Consume normalized data"] },
      ],
      interfaces: [{
        id: "normalized-data",
        producer: "producer",
        consumer: "consumer",
        owner: "consumer",
        contract: "Consumer receives stable normalized fields.",
      }],
    };
    const result = await preflightTaskCard({
      task,
      workflowMode: "overnight",
      worktree,
      adapterId: "claude-code",
      strategy: "convergent",
    }, { adapters, environment: {} });
    assert.equal(result.ready, true);
    assert.ok(result.issues.some((entry) => entry.code === "preflight.interface_validation_partial"));
    const ownership = result.checks.find((entry) => entry.id === "interface-ownership");
    assert.equal(ownership.status, "warning");
    assert.match(ownership.detail, /1 个接口均有负责人/);

    task.extensions.task_shape.interfaces = [];
    const undeclared = await preflightTaskCard({
      task,
      workflowMode: "overnight",
      worktree,
      adapterId: "claude-code",
      strategy: "convergent",
    }, { adapters, environment: {} });
    assert.ok(undeclared.issues.some((entry) => entry.code === "preflight.interfaces_undeclared"));
  } finally {
    await rm(worktree, { recursive: true, force: true });
  }
});

test("preflight treats sandbox network denial as a host handoff, not model unavailability", async () => {
  const result = await preflightTaskCard({
    task: createTaskCardTemplate(),
    workflowMode: "overnight",
    worktree: tmpdir(),
    adapterId: "claude-code",
    strategy: "convergent",
    runtimeEnvironment: {
      executionEnvironment: "auto",
      proxyMode: "inherit",
      isolationMode: "provider-scoped",
      networkDiagnostics: "metadata",
    },
  }, {
    adapters,
    environment: {
      PATH: "/bin",
      CODEX_SANDBOX_NETWORK_DISABLED: "1",
      HTTPS_PROXY: "http://proxy.example:8080",
    },
  });

  assert.equal(result.ready, false);
  assert.ok(result.issues.some((entry) => entry.code === "preflight.host_handoff_required"));
  assert.equal(result.envelope.runtimeEnvironment.proxyMode, "inherit");
  assert.doesNotMatch(JSON.stringify(result), /proxy\.example/);
});

test("preflight detects a missing downstream CLI before creating a run", async () => {
  const result = await preflightTaskCard({
    task: createTaskCardTemplate(),
    workflowMode: "overnight",
    worktree: tmpdir(),
    adapterId: "missing-cli-adapter",
    strategy: "convergent",
  }, {
    adapters: [{
      id: "missing-cli-adapter",
      displayName: "Missing CLI",
      command: "definitely-not-an-installed-agent-cli",
      requiresNetwork: false,
      filesystemIsolation: "post-run-only",
    }],
    environment: { PATH: tmpdir() },
  });
  assert.equal(result.ready, false);
  assert.ok(result.issues.some((entry) => entry.code === "preflight.adapter_command_missing"));
});

test("preflight binds the embedded Workflow Contract and blocks missing or incompatible core", async () => {
  const input = {
    task: createTaskCardTemplate(),
    workflowMode: "overnight",
    strategy: "convergent",
    adapterId: "claude-code",
    worktree: tmpdir(),
  };
  const baseOptions = {
    adapters: [{ id: "claude-code", displayName: "Claude Code", command: null }],
    environment: {},
  };
  const compatible = await preflightTaskCard(input, {
    ...baseOptions,
    workflowContract: {
      sourceId: "agent-control-plane/workflow-core",
      available: true,
      compatible: true,
      health: "compatible",
      contractVersion: "1.1.0",
      contractSha256: `sha256:${"a".repeat(64)}`,
    },
  });
  assert.equal(compatible.ready, true);
  assert.equal(compatible.envelope.workflowContract.version, "1.1.0");

  const unavailable = await preflightTaskCard(input, {
    ...baseOptions,
    workflowContract: {
      sourceId: "agent-control-plane/workflow-core",
      available: false,
      compatible: false,
      health: "unavailable",
      contractVersion: null,
      contractSha256: null,
    },
  });
  assert.equal(unavailable.ready, false);
  assert.ok(unavailable.issues.some(
    (entry) => entry.code === "preflight.workflow_contract_unavailable" && entry.severity === "error",
  ));

  const incompatible = await preflightTaskCard(input, {
    ...baseOptions,
    workflowContract: {
      sourceId: "agent-control-plane/workflow-core",
      available: true,
      compatible: false,
      health: "incompatible",
      contractVersion: "2.0.0",
      contractSha256: `sha256:${"b".repeat(64)}`,
    },
  });
  assert.equal(incompatible.ready, false);
  assert.ok(incompatible.issues.some(
    (entry) => entry.code === "preflight.workflow_contract_incompatible" && entry.severity === "error",
  ));
});
