import assert from "node:assert/strict";
import test from "node:test";

import {
  createRevisionDeltaArtifact,
  validateBoundedTaskRevision,
  validateRevisionDeltaArtifact,
} from "../revision-delta.mjs";
import { createTaskCardTemplate } from "../task-card.mjs";

class DeltaError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function task() {
  const value = createTaskCardTemplate();
  value.id = "ANNC-123";
  value.goal = "Implement one bounded outcome.";
  value.acceptance[0].description = "The bounded outcome is observable.";
  return value;
}

test("Revision Delta is hash-bound to immutable base/result Tasks and review provenance", () => {
  const previous = task();
  const candidate = structuredClone(previous);
  candidate.handoff.must_not_do.push("Do not edit generated output.");
  validateBoundedTaskRevision(previous, candidate, DeltaError);
  const artifact = createRevisionDeltaArtifact({
    revisionDeltaId: "delta-1",
    createdAt: "2026-09-03T02:00:00.000Z",
    source: { kind: "revision-delta", actor: "codex" },
    baseTask: {
      workspaceId: "workspace-1", taskId: "ANNC-123", taskRevision: 1, taskSha256: "a".repeat(64),
    },
    resultTask: {
      workspaceId: "workspace-1", taskId: "ANNC-123", taskRevision: 2, taskSha256: "b".repeat(64),
    },
    review: {
      runId: "run-1", workflowMode: "balanced", artifactSha256: "c".repeat(64), sequence: 1,
    },
    delta: {
      summary: "Remove an unnecessary write boundary.",
      changes: ["Do not edit source files."],
      affectedPaths: ["src/**"],
      affectedAcceptanceIds: ["acceptance-1"],
      requiredEvidence: ["Validation remains green."],
      task: candidate,
    },
  }, DeltaError);
  assert.match(artifact.revisionDeltaSha256, /^[a-f0-9]{64}$/);
  assert.equal(validateRevisionDeltaArtifact(artifact, {
    revisionDeltaId: "delta-1",
    baseTask: artifact.baseTask,
    resultTask: artifact.resultTask,
  }, DeltaError), artifact);
  assert.throws(
    () => validateRevisionDeltaArtifact({ ...artifact, summary: "tampered" }, {}, DeltaError),
    (error) => error instanceof DeltaError && error.code === "revision_delta.corrupt",
  );
});

test("Revision Delta rejects expanded Task boundaries", () => {
  const previous = task();
  const candidate = structuredClone(previous);
  candidate.scope.write_paths.push("new/**");
  assert.throws(
    () => validateBoundedTaskRevision(previous, candidate, DeltaError),
    (error) => error instanceof DeltaError && error.code === "revision_delta.expanded",
  );
});
