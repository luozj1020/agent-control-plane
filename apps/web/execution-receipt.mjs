import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import { validateTaskCard } from "./task-card.mjs";

const OWNER = "agent-control-plane";
const SCHEMA_VERSION = 1;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export class ExecutionReceiptError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = "ExecutionReceiptError";
    this.code = code;
    this.status = status;
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

export function canonicalSha256(value) {
  const encoded = JSON.stringify(stableValue(value));
  return createHash("sha256").update(encoded === undefined ? "undefined" : encoded).digest("hex");
}

export function taskCardSha256(task) {
  return canonicalSha256(validateTaskCard(task, { allowLegacy: false }));
}

function normalizedSha256(value) {
  return typeof value === "string" && value.startsWith("sha256:")
    ? value.slice("sha256:".length)
    : value;
}

function fail(ErrorType, code, message, status = 409) {
  throw new ErrorType(code, message, status);
}

function requireIdentifier(value, path, ErrorType) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    fail(ErrorType, "preflight.receipt_corrupt", `${path} is invalid.`);
  }
  return value;
}

function requireSha256(value, path, ErrorType) {
  const normalized = normalizedSha256(value);
  if (typeof normalized !== "string" || !SHA256.test(normalized)) {
    fail(ErrorType, "preflight.receipt_corrupt", `${path} is not a SHA-256 digest.`);
  }
  return normalized;
}

function requireTaskReference(value, ErrorType) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(ErrorType, "preflight.receipt_corrupt", "Preflight Task reference is invalid.");
  }
  if (!Number.isSafeInteger(value.taskRevision) || value.taskRevision < 1) {
    fail(ErrorType, "preflight.receipt_corrupt", "task.taskRevision must be a positive integer.");
  }
  return {
    workspaceId: requireIdentifier(value.workspaceId, "task.workspaceId", ErrorType),
    taskId: requireIdentifier(value.taskId, "task.taskId", ErrorType),
    taskRevision: value.taskRevision,
    taskSha256: requireSha256(value.taskSha256, "task.taskSha256", ErrorType),
  };
}

function requireWorkflowBinding(value, ErrorType) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(ErrorType, "preflight.receipt_corrupt", "Preflight workflow binding is invalid.");
  }
  if (!Number.isSafeInteger(value.workspaceRevision) || value.workspaceRevision < 0) {
    fail(ErrorType, "preflight.receipt_corrupt", "workflow.workspaceRevision must be a non-negative integer.");
  }
  return {
    workspaceRevision: value.workspaceRevision,
    configSha256: requireSha256(value.configSha256, "workflow.configSha256", ErrorType),
    activationId: requireIdentifier(value.activationId, "workflow.activationId", ErrorType),
    effectiveSkillSha256: requireSha256(
      value.effectiveSkillSha256,
      "workflow.effectiveSkillSha256",
      ErrorType,
    ),
  };
}

export function createPreflightReceipt(input) {
  const task = requireTaskReference(input?.task, ExecutionReceiptError);
  const workflow = requireWorkflowBinding(input?.workflow, ExecutionReceiptError);
  const preflightId = requireIdentifier(input?.preflightId, "preflightId", ExecutionReceiptError);
  if (typeof input?.createdAt !== "string" || !Number.isFinite(Date.parse(input.createdAt))) {
    fail(ExecutionReceiptError, "preflight.receipt_corrupt", "createdAt is invalid.");
  }
  if (!input?.runtimeEnvelope || typeof input.runtimeEnvelope !== "object" || Array.isArray(input.runtimeEnvelope)) {
    fail(ExecutionReceiptError, "preflight.receipt_corrupt", "runtimeEnvelope is invalid.");
  }
  const runtimeEnvelope = JSON.parse(JSON.stringify(input.runtimeEnvelope));
  const runtimeEnvelopeSha256 = canonicalSha256(runtimeEnvelope);
  const body = {
    schemaVersion: SCHEMA_VERSION,
    owner: OWNER,
    preflightId,
    createdAt: input.createdAt,
    task,
    workflow,
    runtimeEnvelope,
    runtimeEnvelopeSha256,
    checks: JSON.parse(JSON.stringify(input.checks ?? [])),
    issues: JSON.parse(JSON.stringify(input.issues ?? [])),
  };
  return { ...body, preflightSha256: canonicalSha256(body) };
}

export function validatePreflightReceipt(receipt, ErrorType = ExecutionReceiptError) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    fail(ErrorType, "preflight.receipt_corrupt", "Preflight Receipt is invalid.");
  }
  if (receipt.schemaVersion !== SCHEMA_VERSION || receipt.owner !== OWNER) {
    fail(ErrorType, "preflight.receipt_corrupt", "Preflight Receipt ownership or schema is invalid.");
  }
  const expectedKeys = new Set([
    "schemaVersion", "owner", "preflightId", "createdAt", "task", "workflow",
    "runtimeEnvelope", "runtimeEnvelopeSha256", "checks", "issues", "preflightSha256",
  ]);
  if (
    Object.keys(receipt).length !== expectedKeys.size ||
    Object.keys(receipt).some((key) => !expectedKeys.has(key))
  ) {
    fail(ErrorType, "preflight.receipt_corrupt", "Preflight Receipt fields are invalid.");
  }
  requireIdentifier(receipt.preflightId, "preflightId", ErrorType);
  if (typeof receipt.createdAt !== "string" || !Number.isFinite(Date.parse(receipt.createdAt))) {
    fail(ErrorType, "preflight.receipt_corrupt", "Preflight Receipt timestamp is invalid.");
  }
  const task = requireTaskReference(receipt.task, ErrorType);
  const workflow = requireWorkflowBinding(receipt.workflow, ErrorType);
  if (!receipt.runtimeEnvelope || typeof receipt.runtimeEnvelope !== "object" || Array.isArray(receipt.runtimeEnvelope)) {
    fail(ErrorType, "preflight.receipt_corrupt", "Preflight runtime envelope is invalid.");
  }
  if (!Array.isArray(receipt.checks) || !Array.isArray(receipt.issues)) {
    fail(ErrorType, "preflight.receipt_corrupt", "Preflight checks or issues are invalid.");
  }
  const runtimeEnvelopeSha256 = requireSha256(
    receipt.runtimeEnvelopeSha256,
    "runtimeEnvelopeSha256",
    ErrorType,
  );
  if (canonicalSha256(receipt.runtimeEnvelope) !== runtimeEnvelopeSha256) {
    fail(ErrorType, "preflight.receipt_corrupt", "Preflight runtime envelope hash does not match.");
  }
  const preflightSha256 = requireSha256(receipt.preflightSha256, "preflightSha256", ErrorType);
  const body = { ...receipt };
  delete body.preflightSha256;
  if (canonicalSha256(body) !== preflightSha256) {
    fail(ErrorType, "preflight.receipt_corrupt", "Preflight Receipt hash does not match.");
  }
  const envelope = receipt.runtimeEnvelope;
  if (
    !new Set(["balanced", "overnight"]).has(envelope.workflowMode) ||
    typeof envelope.worktree !== "string" || !isAbsolute(envelope.worktree) ||
    typeof envelope.adapterId !== "string" || !SAFE_ID.test(envelope.adapterId) ||
    !envelope.runtimeEnvironment || typeof envelope.runtimeEnvironment !== "object" ||
    !envelope.workflowContract || typeof envelope.workflowContract !== "object" ||
    envelope.taskId !== task.taskId ||
    normalizedSha256(envelope.taskSha256) !== task.taskSha256
  ) {
    fail(ErrorType, "preflight.receipt_corrupt", "Runtime envelope does not match its Task reference.");
  }
  if (
    envelope.workflowMode === "balanced" &&
    (
      typeof envelope.policyRef !== "string" ||
      !envelope.timing || typeof envelope.timing !== "object" ||
      !envelope.budget || typeof envelope.budget !== "object"
    )
  ) {
    fail(ErrorType, "preflight.receipt_corrupt", "Balanced Preflight envelope is incomplete.");
  }
  if (
    envelope.workflowMode === "overnight" &&
    (
      !new Set(["convergent", "continuous-improvement"]).has(envelope.strategy) ||
      typeof envelope.wakeAdapterId !== "string" || !SAFE_ID.test(envelope.wakeAdapterId)
    )
  ) {
    fail(ErrorType, "preflight.receipt_corrupt", "Overnight Preflight envelope is incomplete.");
  }
  return {
    ...receipt,
    task,
    workflow,
    runtimeEnvelopeSha256,
    preflightSha256,
  };
}

function sameValue(left, right) {
  return canonicalSha256(left) === canonicalSha256(right);
}

export function bindReceiptToRuntime(input, ErrorType = ExecutionReceiptError) {
  const receipt = validatePreflightReceipt(input?.receipt, ErrorType);
  const task = validateTaskCard(input?.task, { allowLegacy: false });
  const taskHash = taskCardSha256(task);
  const activation = input?.activation;
  const envelope = receipt.runtimeEnvelope;
  const protocol = input?.workflowContract;
  const normalizedProtocolSha256 = normalizedSha256(protocol?.sha256);

  if (receipt.task.taskId !== task.id || receipt.task.taskSha256 !== taskHash) {
    fail(ErrorType, "runtime.task_preflight_mismatch", "Task Card does not match the frozen Preflight Task reference.");
  }
  if (
    envelope.workflowMode !== input.workflowMode ||
    resolve(envelope.worktree ?? "") !== resolve(input.worktree ?? "") ||
    envelope.adapterId !== input.adapterId
  ) {
    fail(ErrorType, "runtime.preflight_envelope_mismatch", "Runtime mode, worktree, or adapter differs from Preflight.");
  }
  if (!sameValue(envelope.runtimeEnvironment, input.runtimeEnvironment)) {
    fail(ErrorType, "runtime.preflight_envelope_mismatch", "Runtime environment differs from Preflight.");
  }
  if (input.workflowMode === "overnight" && envelope.strategy !== input.strategy) {
    fail(ErrorType, "runtime.preflight_envelope_mismatch", "Overnight strategy differs from Preflight.");
  }
  if (input.workflowMode === "overnight" && envelope.wakeAdapterId !== input.wakeAdapterId) {
    fail(ErrorType, "runtime.preflight_envelope_mismatch", "Overnight wake adapter differs from Preflight.");
  }
  if (input.workflowMode === "balanced") {
    if (
      envelope.policyRef !== input.policyRef ||
      !sameValue(envelope.timing, input.timing) ||
      !sameValue(envelope.budget, input.budget)
    ) {
      fail(ErrorType, "runtime.preflight_envelope_mismatch", "Balanced timing or budget differs from Preflight.");
    }
  }
  if (
    envelope.workflowContract?.version !== protocol?.version ||
    normalizedSha256(envelope.workflowContract?.sha256) !== normalizedProtocolSha256
  ) {
    fail(ErrorType, "runtime.workflow_preflight_mismatch", "Workflow Contract differs from Preflight.");
  }
  if (
    !activation?.activationId ||
    receipt.workflow.activationId !== activation.activationId ||
    receipt.workflow.effectiveSkillSha256 !== normalizedSha256(activation.effectiveSkillSha256)
  ) {
    fail(ErrorType, "runtime.activation_preflight_mismatch", "Active Skill differs from Preflight.");
  }
  const project = activation.projectBinding;
  if (
    !project ||
    receipt.task.workspaceId !== project.workspaceId ||
    receipt.workflow.workspaceRevision !== project.projectRevision ||
    receipt.workflow.configSha256 !== normalizedSha256(project.projectConfigSha256)
  ) {
    fail(ErrorType, "runtime.workspace_preflight_mismatch", "Workspace configuration differs from Preflight.");
  }
  return Object.freeze({
    task: receipt.task,
    preflight: {
      preflightId: receipt.preflightId,
      preflightSha256: receipt.preflightSha256,
      runtimeEnvelopeSha256: receipt.runtimeEnvelopeSha256,
    },
    workflow: receipt.workflow,
  });
}

export function validateRunReceipt(receipt, executionBinding, ErrorType = ExecutionReceiptError) {
  const validated = validatePreflightReceipt(receipt, ErrorType);
  const projected = {
    task: validated.task,
    preflight: {
      preflightId: validated.preflightId,
      preflightSha256: validated.preflightSha256,
      runtimeEnvelopeSha256: validated.runtimeEnvelopeSha256,
    },
    workflow: validated.workflow,
  };
  if (!sameValue(projected, executionBinding)) {
    fail(ErrorType, "runtime.preflight_receipt_corrupt", "Run metadata does not match its Preflight Receipt snapshot.");
  }
  return validated;
}
