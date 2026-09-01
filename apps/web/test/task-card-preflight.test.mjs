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
