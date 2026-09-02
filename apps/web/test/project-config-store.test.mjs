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
  const stateRoot = join(root, "local-state");
  await mkdir(project);
  try {
    await run({ project, root, stateRoot });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("new projects keep declarative policy in the repository and mutable state locally", async () => {
  await withProject(async ({ project, stateRoot }) => {
    let tick = 0;
    const store = createProjectConfigStore({
      stateRoot,
      clock: () => new Date(`2026-09-02T00:00:0${tick++}.000Z`),
      nonceFactory: () => `id-${tick}`,
    });
    const before = await store.inspect(project);
    assert.equal(before.initialized, false);
    assert.equal(before.workspaceId, null);

    const initialized = await store.initialize(project);
    assert.equal(initialized.storageVersion, 2);
    assert.equal(initialized.revision, 0);
    assert.match(initialized.projectId, /^project-/);
    assert.match(initialized.workspaceId, /^workspace-/);
    assert.match(initialized.configSha256, /^[a-f0-9]{64}$/);

    const saved = await store.save({
      projectRoot: project,
      expectedRevision: 0,
      expectedSharedConfigSha256: initialized.sharedConfigSha256,
      scope: "local",
      overrides: {
        modeId: "balanced",
        mainAgentId: "codex",
        builderAgentId: "claude-code",
        skillAppendix: "## Project policy\n\nRun the repository checks.",
      },
    });
    assert.equal(saved.revision, 1);
    assert.equal(saved.overrides.modeId, "balanced");
    assert.deepEqual(saved.sharedOverrides, {});
    assert.equal(saved.localOverrides.modeId, "balanced");
    assert.deepEqual(saved.history.map((entry) => entry.revision), [0]);

    const repositoryWorkflow = JSON.parse(
      await readFile(join(project, ".agent-control-plane", "workflow.json"), "utf8"),
    );
    assert.deepEqual(repositoryWorkflow, {
      schemaVersion: 2,
      owner: "agent-control-plane",
      overrides: {},
    });
    const localState = JSON.parse(
      await readFile(join(stateRoot, saved.workspaceId, "state.json"), "utf8"),
    );
    assert.equal(localState.revision, 1);
    assert.equal(localState.localOverrides.modeId, "balanced");
  });
});

test("shared publishing clears the masking local delta and detects repository drift", async () => {
  await withProject(async ({ project, stateRoot }) => {
    let nonce = 0;
    const store = createProjectConfigStore({ stateRoot, nonceFactory: () => `id-${++nonce}` });
    const initialized = await store.initialize(project);
    const local = await store.save({
      projectRoot: project,
      expectedRevision: 0,
      expectedSharedConfigSha256: initialized.sharedConfigSha256,
      scope: "local",
      overrides: { modeId: "balanced" },
    });
    const shared = await store.save({
      projectRoot: project,
      expectedRevision: local.revision,
      expectedSharedConfigSha256: local.sharedConfigSha256,
      scope: "shared",
      overrides: { modeId: "interactive" },
    });
    assert.equal(shared.overrides.modeId, "interactive");
    assert.equal(shared.sharedOverrides.modeId, "interactive");
    assert.deepEqual(shared.localOverrides, {});
    await writeFile(join(project, ".agent-control-plane", "workflow.json"), `${JSON.stringify({
      schemaVersion: 2,
      owner: "agent-control-plane",
      overrides: { modeId: "overnight" },
    }, null, 2)}\n`);
    await assert.rejects(
      store.save({
        projectRoot: project,
        expectedRevision: shared.revision,
        expectedSharedConfigSha256: shared.sharedConfigSha256,
        scope: "shared",
        overrides: { modeId: "balanced" },
      }),
      (error) => error instanceof ProjectConfigError && error.code === "project.shared_conflict",
    );
  });
});

test("local revisions restore shared and local snapshots without losing lineage", async () => {
  await withProject(async ({ project, stateRoot }) => {
    let nonce = 0;
    const store = createProjectConfigStore({ stateRoot, nonceFactory: () => `id-${++nonce}` });
    const initialized = await store.initialize(project);
    const first = await store.save({
      projectRoot: project,
      expectedRevision: 0,
      expectedSharedConfigSha256: initialized.sharedConfigSha256,
      scope: "local",
      overrides: { modeId: "balanced" },
    });
    const second = await store.save({
      projectRoot: project,
      expectedRevision: first.revision,
      expectedSharedConfigSha256: first.sharedConfigSha256,
      scope: "local",
      overrides: { modeId: "interactive" },
    });
    await assert.rejects(
      store.save({
        projectRoot: project,
        expectedRevision: 1,
        expectedSharedConfigSha256: second.sharedConfigSha256,
        scope: "local",
        overrides: { modeId: "overnight" },
      }),
      (error) => error instanceof ProjectConfigError && error.code === "project.revision_conflict",
    );
    const restored = await store.restore({
      projectRoot: project,
      expectedRevision: second.revision,
      expectedSharedConfigSha256: second.sharedConfigSha256,
      revision: 1,
    });
    assert.equal(restored.revision, 3);
    assert.equal(restored.overrides.modeId, "balanced");
  });
});

test("legacy repository-local history migrates explicitly into workspace state", async () => {
  await withProject(async ({ project, stateRoot }) => {
    const control = join(project, ".agent-control-plane");
    await mkdir(join(control, "history"), { recursive: true });
    await writeFile(join(control, "project.json"), `${JSON.stringify({
      schemaVersion: 1,
      owner: "agent-control-plane",
      projectId: "legacy-project",
      createdAt: "2026-09-01T00:00:00.000Z",
    }, null, 2)}\n`);
    const legacyWorkflow = (revision, modeId) => ({
      schemaVersion: 1,
      owner: "agent-control-plane",
      revision,
      updatedAt: `2026-09-01T00:00:0${revision}.000Z`,
      overrides: modeId ? { modeId } : {},
    });
    await writeFile(join(control, "workflow.json"), `${JSON.stringify(legacyWorkflow(2, "interactive"), null, 2)}\n`);
    await writeFile(join(control, "history", "revision-1.json"), `${JSON.stringify(legacyWorkflow(1, "balanced"), null, 2)}\n`);
    const store = createProjectConfigStore({ stateRoot, nonceFactory: () => "migration-id" });

    const legacy = await store.inspect(project);
    assert.equal(legacy.migrationRequired, true);
    assert.equal(legacy.workspaceId, null);

    const migrated = await store.migrate(project);
    assert.equal(migrated.migrationRequired, false);
    assert.match(migrated.workspaceId, /^workspace-/);
    assert.equal(migrated.revision, 2);
    assert.equal(migrated.migration.movedHistory, 1);
    await assert.rejects(readFile(join(control, "history", "revision-1.json")), { code: "ENOENT" });
    const repositoryWorkflow = JSON.parse(await readFile(join(control, "workflow.json"), "utf8"));
    assert.equal(repositoryWorkflow.schemaVersion, 2);
    assert.equal(repositoryWorkflow.revision, undefined);
    assert.equal(repositoryWorkflow.overrides.modeId, "interactive");
  });
});

test("project configuration rejects unsafe roots, control paths, and local locks", async () => {
  await withProject(async ({ project, root, stateRoot }) => {
    const store = createProjectConfigStore({ stateRoot });
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
    const initialized = await store.initialize(project);
    await assert.rejects(
      store.save({
        projectRoot: project,
        expectedRevision: 0,
        expectedSharedConfigSha256: initialized.sharedConfigSha256,
        overrides: { secret: "value" },
      }),
      (error) => error instanceof ProjectConfigError && error.code === "project.overrides_invalid",
    );
    await writeFile(join(stateRoot, initialized.workspaceId, "project.lock"), "occupied\n", "utf8");
    await assert.rejects(
      store.save({
        projectRoot: project,
        expectedRevision: 0,
        expectedSharedConfigSha256: initialized.sharedConfigSha256,
        overrides: {},
      }),
      (error) => error instanceof ProjectConfigError && error.code === "project.locked",
    );
  });
});
