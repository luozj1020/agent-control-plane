import assert from "node:assert/strict";
import test from "node:test";

import {
  ExecutionReceiptError,
  bindReceiptToRuntime,
  createPreflightReceipt,
  taskCardSha256,
  validatePreflightReceipt,
} from "../execution-receipt.mjs";
import { normalizeRuntimeEnvironment } from "../runtime-environment.mjs";
import { createTaskCardTemplate } from "../task-card.mjs";

function task() {
  const value = createTaskCardTemplate();
  value.id = "ANNC-123";
  value.goal = "Implement one bounded outcome.";
  value.acceptance[0].description = "The bounded outcome is observable.";
  return value;
}

function fixture() {
  const frozenTask = task();
  const taskSha256 = taskCardSha256(frozenTask);
  const runtimeEnvironment = normalizeRuntimeEnvironment();
  const activation = {
    activationId: "activation-1",
    effectiveSkillSha256: "a".repeat(64),
    projectBinding: {
      projectId: null,
      workspaceId: "workspace-1",
      projectRevision: 3,
      projectConfigSha256: "b".repeat(64),
    },
  };
  const workflowContract = {
    source: "agent-control-plane/workflow-core",
    version: "1.6.0",
    sha256: `sha256:${"c".repeat(64)}`,
  };
  const timing = {
    contextAcquisitionSeconds: 600,
    firstProgressSeconds: 600,
    activeWindowSeconds: 600,
    progressExtensionSeconds: 300,
    growingProgressExtensionSeconds: 300,
    hardCapSeconds: 1500,
  };
  const budget = {
    mainReviewCalls: 3,
    downstreamCalls: 3,
    advisorCalls: 2,
    reservedFinalReviewCalls: 1,
  };
  const runtimeEnvelope = {
    schemaVersion: 1,
    workflowMode: "balanced",
    taskId: frozenTask.id,
    taskSha256,
    worktree: "/tmp/acp-receipt-worktree",
    adapterId: "claude-code",
    runtimeEnvironment,
    workflowContract: {
      sourceId: workflowContract.source,
      version: workflowContract.version,
      sha256: workflowContract.sha256,
      compatible: true,
    },
    policyRef: "balanced-default@1.0.0",
    timing,
    budget,
  };
  const receipt = createPreflightReceipt({
    preflightId: "preflight-1",
    createdAt: "2026-09-03T01:00:00.000Z",
    task: {
      workspaceId: "workspace-1",
      taskId: frozenTask.id,
      taskRevision: 4,
      taskSha256,
    },
    workflow: {
      workspaceRevision: 3,
      configSha256: "b".repeat(64),
      activationId: activation.activationId,
      effectiveSkillSha256: activation.effectiveSkillSha256,
    },
    runtimeEnvelope,
    checks: [{ id: "task-card", status: "passed" }],
    issues: [],
  });
  return {
    activation,
    budget,
    frozenTask,
    receipt,
    runtimeEnvironment,
    timing,
    workflowContract,
  };
}

test("Preflight Receipt binds immutable Task, Workspace, Skill, and Runtime envelope", () => {
  const value = fixture();
  const validated = validatePreflightReceipt(value.receipt);
  assert.match(validated.preflightSha256, /^[a-f0-9]{64}$/);
  assert.match(validated.runtimeEnvelopeSha256, /^[a-f0-9]{64}$/);

  const binding = bindReceiptToRuntime({
    receipt: value.receipt,
    task: value.frozenTask,
    workflowMode: "balanced",
    worktree: value.receipt.runtimeEnvelope.worktree,
    adapterId: "claude-code",
    runtimeEnvironment: value.runtimeEnvironment,
    policyRef: "balanced-default@1.0.0",
    timing: value.timing,
    budget: value.budget,
    activation: value.activation,
    workflowContract: value.workflowContract,
  });
  assert.equal(binding.task.taskRevision, 4);
  assert.equal(binding.preflight.preflightId, "preflight-1");
  assert.equal(binding.workflow.workspaceRevision, 3);
});

test("Preflight Receipt and bound Runtime envelope fail closed after tampering or drift", () => {
  const value = fixture();
  const tampered = structuredClone(value.receipt);
  tampered.checks.push({ id: "invented", status: "passed" });
  assert.throws(
    () => validatePreflightReceipt(tampered),
    (error) => error instanceof ExecutionReceiptError && error.code === "preflight.receipt_corrupt",
  );

  assert.throws(
    () => bindReceiptToRuntime({
      receipt: value.receipt,
      task: value.frozenTask,
      workflowMode: "balanced",
      worktree: value.receipt.runtimeEnvelope.worktree,
      adapterId: "claude-code",
      runtimeEnvironment: value.runtimeEnvironment,
      policyRef: "balanced-default@1.0.0",
      timing: { ...value.timing, hardCapSeconds: 1499 },
      budget: value.budget,
      activation: value.activation,
      workflowContract: value.workflowContract,
    }),
    (error) => error.code === "runtime.preflight_envelope_mismatch",
  );

  assert.throws(
    () => bindReceiptToRuntime({
      receipt: value.receipt,
      task: value.frozenTask,
      workflowMode: "balanced",
      worktree: value.receipt.runtimeEnvelope.worktree,
      adapterId: "claude-code",
      runtimeEnvironment: value.runtimeEnvironment,
      policyRef: "balanced-default@1.0.0",
      timing: value.timing,
      budget: value.budget,
      activation: { ...value.activation, effectiveSkillSha256: "d".repeat(64) },
      workflowContract: value.workflowContract,
    }),
    (error) => error.code === "runtime.activation_preflight_mismatch",
  );
});
