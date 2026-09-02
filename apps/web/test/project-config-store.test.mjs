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

test("opening a new directory registers a local-only workspace without repository writes", async () => {
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

    const initialized = await store.open(project);
    assert.equal(initialized.storageVersion, 1);
    assert.equal(initialized.workspaceRegistered, true);
    assert.equal(initialized.repositoryConfigEnabled, false);
    assert.equal(initialized.revision, 0);
    assert.equal(initialized.projectId, null);
    assert.match(initialized.workspaceId, /^workspace-/);
    assert.match(initialized.configSha256, /^[a-f0-9]{64}$/);
    assert.equal((await store.recent()).projects[0].projectRoot, project);

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

    await assert.rejects(
      readFile(join(project, ".agent-control-plane", "workflow.json"), "utf8"),
      { code: "ENOENT" },
    );
    const localState = JSON.parse(
      await readFile(join(stateRoot, saved.workspaceId, "state.json"), "utf8"),
    );
    assert.equal(localState.revision, 1);
    assert.equal(localState.projectId, null);
    assert.equal(localState.localOverrides.modeId, "balanced");
    const recent = await store.recent();
    assert.equal(recent.corruptEntries, 0);
    assert.deepEqual(recent.projects.map((entry) => ({
      projectRoot: entry.projectRoot,
      modeId: entry.modeId,
      revision: entry.revision,
      available: entry.available,
    })), [{ projectRoot: project, modeId: "balanced", revision: 1, available: true }]);
  });
});

test("repository configuration is opt-in and preserves the existing workspace", async () => {
  await withProject(async ({ project, stateRoot }) => {
    let nonce = 0;
    const store = createProjectConfigStore({ stateRoot, nonceFactory: () => `id-${++nonce}` });
    const opened = await store.open(project);
    const local = await store.save({
      projectRoot: project,
      expectedRevision: opened.revision,
      expectedSharedConfigSha256: opened.sharedConfigSha256,
      scope: "local",
      overrides: { modeId: "balanced" },
    });

    const enabled = await store.initialize(project);
    assert.equal(enabled.workspaceId, opened.workspaceId);
    assert.equal(enabled.repositoryConfigEnabled, true);
    assert.match(enabled.projectId, /^project-/);
    assert.equal(enabled.revision, local.revision);
    assert.equal(enabled.localOverrides.modeId, "balanced");
    assert.equal(enabled.overrides.modeId, "balanced");

    const identity = JSON.parse(
      await readFile(join(project, ".agent-control-plane", "project.json"), "utf8"),
    );
    assert.equal(identity.projectId, enabled.projectId);
    const binding = JSON.parse(
      await readFile(join(stateRoot, enabled.workspaceId, "binding.json"), "utf8"),
    );
    assert.equal(binding.projectId, enabled.projectId);
  });
});

test("opening projects records local recency and never writes recent metadata into the repository", async () => {
  await withProject(async ({ project, root, stateRoot }) => {
    const second = join(root, "second-project");
    await mkdir(second);
    let tick = 0;
    let nonce = 0;
    const store = createProjectConfigStore({
      stateRoot,
      clock: () => new Date(`2026-09-02T00:00:${String(tick++).padStart(2, "0")}.000Z`),
      nonceFactory: () => `id-${++nonce}`,
    });
    const firstState = await store.open(project);
    const secondState = await store.open(second);
    await rm(join(stateRoot, secondState.workspaceId, "recent.json"));
    await store.open(project);

    const recent = await store.recent();
    assert.deepEqual(recent.projects.map((entry) => entry.projectRoot), [project, second]);
    assert.equal(recent.projects[0].workspaceId, firstState.workspaceId);
    await assert.rejects(
      readFile(join(project, ".agent-control-plane", "recent.json")),
      { code: "ENOENT" },
    );
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
    assert.match(legacy.workspaceId, /^workspace-/);

    const migrated = await store.migrate(project);
    assert.equal(migrated.migrationRequired, false);
    assert.match(migrated.workspaceId, /^workspace-/);
    assert.equal(migrated.revision, 2);
    assert.equal(migrated.migration.movedHistory, 1);
    assert.equal(migrated.migration.preservedLegacyHistory, true);
    assert.equal(
      JSON.parse(await readFile(join(control, "history", "revision-1.json"), "utf8")).revision,
      1,
    );
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
    await assert.rejects(
      store.inspect("/"),
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
    const unsafeRecentTarget = join(root, "unsafe-recent.json");
    await writeFile(unsafeRecentTarget, "{}\n");
    await rm(join(stateRoot, initialized.workspaceId, "recent.json"));
    await symlink(unsafeRecentTarget, join(stateRoot, initialized.workspaceId, "recent.json"));
    const recent = await store.recent();
    assert.equal(recent.projects.length, 0);
    assert.equal(recent.corruptEntries, 1);
  });
});
