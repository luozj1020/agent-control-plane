import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createProjectConfigStore,
  ProjectConfigError,
} from "../project-config-store.mjs";

async function withProject(run) {
  const root = await mkdtemp(join(tmpdir(), "agent-control-project-"));
  const project = join(root, "project");
  await mkdir(project);
  try {
    await run({ project, root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("project configuration initializes explicitly and stores only project deltas", async () => {
  await withProject(async ({ project }) => {
    let tick = 0;
    const store = createProjectConfigStore({
      clock: () => new Date(`2026-09-02T00:00:0${tick++}.000Z`),
      nonceFactory: () => `project-${tick}`,
    });
    const before = await store.inspect(project);
    assert.equal(before.initialized, false);
    assert.deepEqual(before.overrides, {});

    const initialized = await store.initialize(project);
    assert.equal(initialized.initialized, true);
    assert.equal(initialized.revision, 0);
    assert.match(initialized.projectId, /^project-/);
    assert.match(initialized.configSha256, /^[a-f0-9]{64}$/);

    const saved = await store.save({
      projectRoot: project,
      expectedRevision: 0,
      overrides: {
        modeId: "balanced",
        mainAgentId: "codex",
        builderAgentId: "claude-code",
        skillAppendix: "## Project policy\n\nRun the repository checks.",
      },
    });
    assert.equal(saved.revision, 1);
    assert.notEqual(saved.configSha256, initialized.configSha256);
    assert.equal(saved.overrides.modeId, "balanced");
    assert.deepEqual(saved.history.map((entry) => entry.revision), [0]);

    const identityText = await readFile(join(project, ".agent-control-plane", "project.json"), "utf8");
    assert.doesNotMatch(identityText, /skillAppendix|balanced/);
  });
});

test("project configuration uses optimistic revisions and restores an immutable snapshot", async () => {
  await withProject(async ({ project }) => {
    let nonce = 0;
    const store = createProjectConfigStore({ nonceFactory: () => `id-${++nonce}` });
    await store.initialize(project);
    await store.save({ projectRoot: project, expectedRevision: 0, overrides: { modeId: "balanced" } });
    const second = await store.save({
      projectRoot: project,
      expectedRevision: 1,
      overrides: { modeId: "interactive" },
    });
    await assert.rejects(
      store.save({ projectRoot: project, expectedRevision: 1, overrides: { modeId: "overnight" } }),
      (error) => error instanceof ProjectConfigError && error.code === "project.revision_conflict",
    );
    const restored = await store.restore({
      projectRoot: project,
      expectedRevision: second.revision,
      revision: 1,
    });
    assert.equal(restored.revision, 3);
    assert.equal(restored.overrides.modeId, "balanced");
  });
});

test("project configuration rejects unsafe roots, control paths, and unknown fields", async () => {
  await withProject(async ({ project, root }) => {
    const store = createProjectConfigStore();
    await assert.rejects(
      store.inspect("relative/project"),
      (error) => error instanceof ProjectConfigError && error.code === "project.root_invalid",
    );
    const target = join(root, "target");
    await mkdir(target);
    await symlink(target, join(project, ".agent-control-plane"), "dir");
    await assert.rejects(
      store.inspect(project),
      (error) => error instanceof ProjectConfigError && error.code === "project.control_unsafe",
    );
    await rm(join(project, ".agent-control-plane"));
    await store.initialize(project);
    await assert.rejects(
      store.save({ projectRoot: project, expectedRevision: 0, overrides: { secret: "value" } }),
      (error) => error instanceof ProjectConfigError && error.code === "project.overrides_invalid",
    );
    await writeFile(join(project, ".agent-control-plane", "project.lock"), "occupied\n", "utf8");
    await assert.rejects(
      store.save({ projectRoot: project, expectedRevision: 0, overrides: {} }),
      (error) => error instanceof ProjectConfigError && error.code === "project.locked",
    );
  });
});
