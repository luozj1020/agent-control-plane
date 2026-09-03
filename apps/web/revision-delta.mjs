import { createHash } from "node:crypto";

import { taskAllowsNoChanges, validateTaskCard } from "./task-card.mjs";

const OWNER = "agent-control-plane";
const SCHEMA_VERSION = 1;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function fail(ErrorClass, code, message, path) {
  const error = new ErrorClass(code, message, 409);
  if (path) error.path = path;
  throw error;
}

function text(value, label, ErrorClass) {
  if (typeof value !== "string" || value.trim() === "" || value.length > 4096 || value.includes("\0")) {
    fail(ErrorClass, "revision_delta.invalid", `${label} must be non-empty text up to 4096 characters.`, label);
  }
  return value.trim();
}

function textList(value, label, ErrorClass, { required = false } = {}) {
  if (!Array.isArray(value) || (required && value.length === 0) || value.length > 256) {
    fail(ErrorClass, "revision_delta.invalid", `${label} must be ${required ? "a non-empty" : "an"} array with at most 256 entries.`, label);
  }
  return value.map((entry, index) => text(entry, `${label}[${index}]`, ErrorClass));
}

function reference(value, label, ErrorClass) {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    typeof value.workspaceId !== "string" || !SAFE_ID.test(value.workspaceId) ||
    typeof value.taskId !== "string" || !SAFE_ID.test(value.taskId) ||
    !Number.isSafeInteger(value.taskRevision) || value.taskRevision < 1 ||
    typeof value.taskSha256 !== "string" || !SHA256.test(value.taskSha256)
  ) {
    fail(ErrorClass, "revision_delta.reference_invalid", `${label} is not an immutable Task reference.`, label);
  }
  return {
    workspaceId: value.workspaceId,
    taskId: value.taskId,
    taskRevision: value.taskRevision,
    taskSha256: value.taskSha256,
  };
}

function sameReference(left, right) {
  return left.workspaceId === right.workspaceId && left.taskId === right.taskId &&
    left.taskRevision === right.taskRevision && left.taskSha256 === right.taskSha256;
}

function setContainsAll(container, required) {
  const values = new Set(container);
  return required.every((value) => values.has(value));
}

function objectSetContainsAll(container, required) {
  const values = new Set(container.map((value) => JSON.stringify(value)));
  return required.every((value) => values.has(JSON.stringify(value)));
}

function riskDoesNotDecrease(previous, candidate) {
  const severity = { no: 0, unknown: 1, yes: 2 };
  return Object.entries(previous).every(
    ([key, value]) => severity[candidate[key] ?? "unknown"] >= severity[value],
  );
}

export function validateBoundedTaskRevision(previousInput, candidateInput, ErrorClass = Error) {
  const previous = validateTaskCard(previousInput);
  const candidate = validateTaskCard(candidateInput);
  if (
    candidate.id !== previous.id || candidate.goal !== previous.goal || candidate.mode !== previous.mode ||
    JSON.stringify(candidate.profiles) !== JSON.stringify(previous.profiles)
  ) {
    fail(ErrorClass, "revision_delta.expanded", "A Revision Delta must preserve Task identity, goal, mode, and profiles.");
  }
  if (!objectSetContainsAll(previous.acceptance, candidate.acceptance)) {
    fail(ErrorClass, "revision_delta.expanded", "A Revision Delta may only narrow acceptance criteria.");
  }
  if (!setContainsAll(previous.scope.write_paths, candidate.scope.write_paths)) {
    fail(ErrorClass, "revision_delta.expanded", "A Revision Delta may not add allowed write paths.");
  }
  if (!setContainsAll(previous.scope.read_paths ?? [], candidate.scope.read_paths ?? [])) {
    fail(ErrorClass, "revision_delta.expanded", "A Revision Delta may not add allowed read paths.");
  }
  if (!setContainsAll(candidate.scope.forbidden_paths ?? [], previous.scope.forbidden_paths ?? [])) {
    fail(ErrorClass, "revision_delta.expanded", "A Revision Delta may not relax forbidden paths.");
  }
  if (!objectSetContainsAll(previous.validation, candidate.validation)) {
    fail(ErrorClass, "revision_delta.expanded", "A Revision Delta may not add validation commands.");
  }
  if (
    !setContainsAll(candidate.handoff.must_not_do ?? [], previous.handoff.must_not_do ?? []) ||
    !setContainsAll(candidate.stop_conditions, previous.stop_conditions) ||
    !setContainsAll(previous.handoff.may_decide ?? [], candidate.handoff.may_decide ?? []) ||
    !riskDoesNotDecrease(previous.risk, candidate.risk) ||
    (!taskAllowsNoChanges(previous) && taskAllowsNoChanges(candidate))
  ) {
    fail(ErrorClass, "revision_delta.expanded", "A Revision Delta may not relax authority, stop, risk, or no-change boundaries.");
  }
  return candidate;
}

export function normalizeRevisionDeltaInput(value, ErrorClass = Error) {
  const allowed = new Set([
    "summary", "changes", "affectedPaths", "affectedAcceptanceIds", "requiredEvidence", "task",
  ]);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.has(key))) {
    fail(ErrorClass, "revision_delta.invalid", "Revision Delta must be an object containing only supported fields.");
  }
  return {
    summary: text(value.summary, "summary", ErrorClass),
    changes: textList(value.changes, "changes", ErrorClass, { required: true }),
    affectedPaths: textList(value.affectedPaths ?? [], "affectedPaths", ErrorClass),
    affectedAcceptanceIds: textList(value.affectedAcceptanceIds ?? [], "affectedAcceptanceIds", ErrorClass),
    requiredEvidence: textList(value.requiredEvidence ?? [], "requiredEvidence", ErrorClass),
    task: validateTaskCard(value.task),
  };
}

export function createRevisionDeltaArtifact(input, ErrorClass = Error) {
  const normalized = normalizeRevisionDeltaInput(input.delta, ErrorClass);
  const baseTask = reference(input.baseTask, "baseTask", ErrorClass);
  const resultTask = reference(input.resultTask, "resultTask", ErrorClass);
  if (
    baseTask.workspaceId !== resultTask.workspaceId || baseTask.taskId !== resultTask.taskId ||
    resultTask.taskRevision <= baseTask.taskRevision
  ) {
    fail(ErrorClass, "revision_delta.reference_invalid", "Revision Delta result must be a later revision of the same Workspace Task.");
  }
  if (!SAFE_ID.test(input.revisionDeltaId ?? "") || !SAFE_ID.test(input.review?.runId ?? "")) {
    fail(ErrorClass, "revision_delta.provenance_invalid", "Revision Delta identity and run provenance are required.");
  }
  if (!new Set(["balanced", "overnight"]).has(input.review?.workflowMode) ||
      !SHA256.test(input.review?.artifactSha256 ?? "") ||
      !Number.isSafeInteger(input.review?.sequence) || input.review.sequence < 1) {
    fail(ErrorClass, "revision_delta.provenance_invalid", "Revision Delta review provenance is invalid.");
  }
  const material = {
    schemaVersion: SCHEMA_VERSION,
    owner: OWNER,
    revisionDeltaId: input.revisionDeltaId,
    createdAt: input.createdAt,
    source: input.source,
    baseTask,
    resultTask,
    review: {
      runId: input.review.runId,
      workflowMode: input.review.workflowMode,
      artifactSha256: input.review.artifactSha256,
      sequence: input.review.sequence,
    },
    summary: normalized.summary,
    changes: normalized.changes,
    affectedPaths: normalized.affectedPaths,
    affectedAcceptanceIds: normalized.affectedAcceptanceIds,
    requiredEvidence: normalized.requiredEvidence,
  };
  return { ...material, revisionDeltaSha256: digest(material) };
}

export function validateRevisionDeltaArtifact(value, expected, ErrorClass = Error) {
  const keys = new Set([
    "schemaVersion", "owner", "revisionDeltaId", "createdAt", "source", "baseTask", "resultTask",
    "review", "summary", "changes", "affectedPaths", "affectedAcceptanceIds", "requiredEvidence",
    "revisionDeltaSha256",
  ]);
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== keys.size || Object.keys(value).some((key) => !keys.has(key)) ||
    value.schemaVersion !== SCHEMA_VERSION || value.owner !== OWNER ||
    !SAFE_ID.test(value.revisionDeltaId ?? "") ||
    typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) ||
    !value.source || typeof value.source !== "object" || Array.isArray(value.source) ||
    !SAFE_ID.test(value.source.kind ?? "") ||
    (value.source.actor !== undefined &&
      (typeof value.source.actor !== "string" || value.source.actor.length === 0 || value.source.actor.length > 255))
  ) {
    fail(ErrorClass, "revision_delta.corrupt", "Revision Delta artifact is invalid.");
  }
  const { revisionDeltaSha256, ...material } = value;
  if (!SHA256.test(revisionDeltaSha256 ?? "") || digest(material) !== revisionDeltaSha256) {
    fail(ErrorClass, "revision_delta.corrupt", "Revision Delta artifact hash is invalid.");
  }
  const baseTask = reference(value.baseTask, "baseTask", ErrorClass);
  const resultTask = reference(value.resultTask, "resultTask", ErrorClass);
  if (
    baseTask.workspaceId !== resultTask.workspaceId || baseTask.taskId !== resultTask.taskId ||
    resultTask.taskRevision <= baseTask.taskRevision || !SAFE_ID.test(value.review?.runId ?? "") ||
    !new Set(["balanced", "overnight"]).has(value.review?.workflowMode) ||
    !SHA256.test(value.review?.artifactSha256 ?? "") ||
    !Number.isSafeInteger(value.review?.sequence) || value.review.sequence < 1
  ) {
    fail(ErrorClass, "revision_delta.corrupt", "Revision Delta references or review provenance are invalid.");
  }
  text(value.summary, "summary", ErrorClass);
  textList(value.changes, "changes", ErrorClass, { required: true });
  textList(value.affectedPaths, "affectedPaths", ErrorClass);
  textList(value.affectedAcceptanceIds, "affectedAcceptanceIds", ErrorClass);
  textList(value.requiredEvidence, "requiredEvidence", ErrorClass);
  if (expected?.baseTask && !sameReference(baseTask, expected.baseTask)) {
    fail(ErrorClass, "revision_delta.binding_mismatch", "Revision Delta base Task does not match the expected binding.");
  }
  if (expected?.resultTask && !sameReference(resultTask, expected.resultTask)) {
    fail(ErrorClass, "revision_delta.binding_mismatch", "Revision Delta result Task does not match the expected binding.");
  }
  if (expected?.revisionDeltaId && value.revisionDeltaId !== expected.revisionDeltaId) {
    fail(ErrorClass, "revision_delta.binding_mismatch", "Revision Delta identity does not match the expected binding.");
  }
  return value;
}
