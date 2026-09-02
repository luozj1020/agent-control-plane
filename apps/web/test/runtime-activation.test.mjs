import assert from "node:assert/strict";
import test from "node:test";

import { BalancedRuntimeError } from "../balanced-runtime.mjs";
import {
  discoverRuntimeActivation,
  normalizeRuntimeActivation,
} from "../runtime-activation.mjs";

test("normalizes optional activation identity without inventing a link", () => {
  assert.deepEqual(normalizeRuntimeActivation({}, BalancedRuntimeError), {
    activationId: null,
    effectiveSkillSha256: null,
    projectBinding: null,
  });
  assert.deepEqual(normalizeRuntimeActivation({
    activationId: "activation-1",
    effectiveSkillSha256: `sha256:${"a".repeat(64)}`,
  }, BalancedRuntimeError), {
    activationId: "activation-1",
    effectiveSkillSha256: "a".repeat(64),
    projectBinding: null,
  });
  assert.deepEqual(normalizeRuntimeActivation({
    projectBinding: {
      projectId: "project-1",
      workspaceId: "workspace-1",
      projectRevision: 2,
      projectConfigSha256: `sha256:${"c".repeat(64)}`,
    },
  }, BalancedRuntimeError).projectBinding, {
    projectId: "project-1",
    workspaceId: "workspace-1",
    projectRevision: 2,
    projectConfigSha256: "c".repeat(64),
  });
  assert.deepEqual(normalizeRuntimeActivation({
    projectBinding: {
      workspaceId: "workspace-local",
      projectRevision: 0,
      projectConfigSha256: "d".repeat(64),
    },
  }, BalancedRuntimeError).projectBinding, {
    projectId: null,
    workspaceId: "workspace-local",
    projectRevision: 0,
    projectConfigSha256: "d".repeat(64),
  });
});

test("rejects malformed activation identifiers and hashes", () => {
  assert.throws(
    () => normalizeRuntimeActivation({ activationId: "../active" }, BalancedRuntimeError),
    (error) => error.code === "runtime.invalid_activation",
  );
  assert.throws(
    () => normalizeRuntimeActivation({ effectiveSkillSha256: "not-a-hash" }, BalancedRuntimeError),
    (error) => error.code === "runtime.invalid_activation",
  );
  assert.throws(
    () => normalizeRuntimeActivation({
      projectBinding: { projectId: "project-1", workspaceId: "workspace-1", projectRevision: -1, projectConfigSha256: "bad" },
    }, BalancedRuntimeError),
    (error) => error.code === "runtime.invalid_activation",
  );
});

test("discovers only an active activation matching the runtime mode", async () => {
  const store = {
    async history() {
      return {
        entries: [{
          historyId: "activation-1",
          isActive: true,
          mode: { id: "balanced" },
          contentSha256: "b".repeat(64),
          projectBinding: {
            projectId: "project-1",
            workspaceId: "workspace-1",
            projectRevision: 2,
            projectConfigSha256: "c".repeat(64),
          },
        }],
      };
    },
  };
  assert.deepEqual(await discoverRuntimeActivation("balanced", { store }), {
    activationId: "activation-1",
    effectiveSkillSha256: "b".repeat(64),
    projectBinding: {
      projectId: "project-1",
      workspaceId: "workspace-1",
      projectRevision: 2,
      projectConfigSha256: "c".repeat(64),
    },
  });
  assert.deepEqual(await discoverRuntimeActivation("overnight", { store }), {
    activationId: null,
    effectiveSkillSha256: null,
    projectBinding: null,
  });
});

test("activation discovery is optional and fails open for runtime execution", async () => {
  const store = { async history() { throw new Error("corrupt store"); } };
  assert.deepEqual(await discoverRuntimeActivation("balanced", { store }), {
    activationId: null,
    effectiveSkillSha256: null,
    projectBinding: null,
  });
});

test("legacy project activations remain readable but are not projected into new runtime lineage", async () => {
  const store = {
    async history() {
      return {
        entries: [{
          historyId: "activation-legacy",
          isActive: true,
          mode: { id: "balanced" },
          contentSha256: "d".repeat(64),
          projectBinding: {
            projectId: "project-1",
            projectRevision: 1,
            projectConfigSha256: "e".repeat(64),
          },
        }],
      };
    },
  };
  assert.deepEqual(await discoverRuntimeActivation("balanced", { store }), {
    activationId: "activation-legacy",
    effectiveSkillSha256: "d".repeat(64),
    projectBinding: null,
  });
});
