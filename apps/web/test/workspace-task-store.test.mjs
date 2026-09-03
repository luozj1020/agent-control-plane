import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BUILTIN_MODE_CATALOG,
  CODEX_OVERNIGHT_CLAUDE_PROFILE,
  EXAMPLE_AGENTS,
  resolveEffectiveSkill,
} from "../../../packages/contracts/dist/index.js";
import { createProjectConfigStore } from "../project-config-store.mjs";
import { createSkillStore } from "../skill-store.mjs";
import { createTaskCardTemplate, TaskCardError } from "../task-card.mjs";
import {
  WorkspaceTaskStoreError,
  createWorkspaceTaskStore,
} from "../workspace-task-store.mjs";

async function withStore(run) {
  const root = await mkdtemp(join(tmpdir(), "agent-control-workspace-task-"));
  const projectRoot = join(root, "project");
  const stateRoot = join(root, "state");
  await mkdir(projectRoot);
  let tick = 0;
  let nonce = 0;
  const projectConfigStore = createProjectConfigStore({
    stateRoot,
    clock: () => new Date(`2026-09-02T01:00:${String(tick++).padStart(2, "0")}.000Z`),
    nonceFactory: () => `project-${++nonce}`,
  });
  const store = createWorkspaceTaskStore({
    projectConfigStore,
    clock: () => new Date(`2026-09-02T02:00:${String(tick++).padStart(2, "0")}.000Z`),
    nonceFactory: () => `task-${++nonce}`,
  });
  try {
    await run({ projectRoot, stateRoot, projectConfigStore, store });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function validTask(taskId) {
  const task = createTaskCardTemplate();
  task.id = taskId;
  task.goal = "Implement one bounded, observable behavior.";
  task.acceptance[0].description = "The bounded behavior is observable.";
  return task;
}

test("draft identity uses only workingCopyGeneration and freeze allocates the first taskRevision", async () => {
  await withStore(async ({ projectRoot, stateRoot, store }) => {
    const created = await store.create({
      projectRoot,
      taskId: "ANNC-123",
      task: validTask("ANNC-123"),
      source: { kind: "upstream-agent", actor: "codex" },
    });
    assert.equal(created.workspace.projectId, null);
    assert.equal(created.workingCopy.workingCopyGeneration, 1);
    assert.equal(created.workingCopy.baseTaskRevision, null);
    assert.equal(Object.hasOwn(created.workingCopy, "taskRevision"), false);
    assert.equal(created.metadata.nextTaskRevision, 1);
    assert.deepEqual(created.metadata.taskRevisions, {});

    const draft = await store.current({ projectRoot, taskId: "ANNC-123" });
    assert.equal(draft.activeTask, null);
    assert.equal(draft.workingCopy.workingCopyGeneration, 1);
    assert.equal(draft.workingCopy.task.id, "ANNC-123");
    const draftIndex = await store.list({ projectRoot });
    assert.equal(draftIndex.activeTask, null);
    assert.deepEqual(draftIndex.tasks.map((entry) => ({
      taskId: entry.taskId,
      lifecycleStatus: entry.lifecycleStatus,
      workingCopyGeneration: entry.workingCopyGeneration,
      frozenTaskRevision: entry.frozenTaskRevision,
      active: entry.active,
    })), [{
      taskId: "ANNC-123",
      lifecycleStatus: "draft",
      workingCopyGeneration: 1,
      frozenTaskRevision: null,
      active: false,
    }]);

    const workspaceRoot = join(stateRoot, created.workspace.workspaceId);
    await assert.rejects(readFile(join(workspaceRoot, "active-task.json"), "utf8"), { code: "ENOENT" });
    await assert.rejects(
      store.freeze({
        projectRoot,
        taskId: "ANNC-123",
        expectedWorkingCopyGeneration: 1,
      }),
      (error) => error instanceof WorkspaceTaskStoreError && error.code === "task.working_copy_not_validated",
    );
    assert.deepEqual(
      await readdir(join(workspaceRoot, "tasks", "ANNC-123", "revisions")),
      [],
    );

    const validated = await store.validate({
      projectRoot,
      taskId: "ANNC-123",
      expectedWorkingCopyGeneration: 1,
    });
    assert.equal(validated.valid, true);
    assert.match(validated.taskSha256, /^[a-f0-9]{64}$/);

    const frozen = await store.freeze({
      projectRoot,
      taskId: "ANNC-123",
      expectedWorkingCopyGeneration: 1,
    });
    assert.deepEqual(frozen.task, {
      workspaceId: created.workspace.workspaceId,
      taskId: "ANNC-123",
      taskRevision: 1,
      taskSha256: validated.taskSha256,
    });
    assert.equal(frozen.metadata.taskRevisions["1"].lifecycleStatus, "frozen");
    assert.deepEqual(frozen.metadata.taskRevisions["1"].submittedRuns, []);

    const active = JSON.parse(await readFile(join(workspaceRoot, "active-task.json"), "utf8"));
    assert.deepEqual(Object.keys(active).sort(), [
      "taskId", "taskRevision", "taskSha256", "workspaceId",
    ]);
    assert.equal(active.taskRevision, 1);
    assert.equal(active.taskSha256, validated.taskSha256);
    const revisionPath = join(
      workspaceRoot,
      "tasks",
      "ANNC-123",
      "revisions",
      "task-revision-0001.json",
    );
    const artifact = JSON.parse(await readFile(revisionPath, "utf8"));
    assert.equal(artifact.taskRevision, 1);
    assert.equal(artifact.taskSha256, validated.taskSha256);
    await assert.rejects(writeFile(revisionPath, "{}", { flag: "wx" }), { code: "EEXIST" });

    const current = await store.current({ projectRoot });
    assert.deepEqual(current.activeTask, active);
    assert.equal(current.revisionArtifact.task.id, "ANNC-123");
    const frozenIndex = await store.list({ projectRoot });
    assert.equal(frozenIndex.tasks[0].lifecycleStatus, "frozen");
    assert.equal(frozenIndex.tasks[0].frozenTaskRevision, 1);
    assert.equal(frozenIndex.tasks[0].active, true);
  });
});

test("working-copy writes use CAS and invalidate validation without allocating taskRevision", async () => {
  await withStore(async ({ projectRoot, stateRoot, store }) => {
    await store.create({ projectRoot, taskId: "cas-task", task: validTask("cas-task") });
    await store.validate({
      projectRoot,
      taskId: "cas-task",
      expectedWorkingCopyGeneration: 1,
    });
    const changedTask = validTask("cas-task");
    changedTask.goal = "Implement the second bounded outcome.";
    const changed = await store.write({
      projectRoot,
      taskId: "cas-task",
      expectedWorkingCopyGeneration: 1,
      task: changedTask,
      source: { kind: "upstream-agent", actor: "codex" },
    });
    assert.equal(changed.workingCopy.workingCopyGeneration, 2);
    assert.equal(changed.metadata.workingCopyState.lifecycleStatus, "draft");
    assert.equal(changed.metadata.workingCopyState.validatedWorkingCopyGeneration, null);
    assert.equal(changed.metadata.nextTaskRevision, 1);
    await assert.rejects(
      store.write({
        projectRoot,
        taskId: "cas-task",
        expectedWorkingCopyGeneration: 1,
        task: changedTask,
      }),
      (error) => error instanceof WorkspaceTaskStoreError && error.code === "task.working_copy_conflict",
    );
    const workspace = await store.current({ projectRoot });
    assert.equal(workspace.activeTask, null);
    const revisionFiles = await readdir(join(
      stateRoot,
      changed.workspace.workspaceId,
      "tasks",
      "cas-task",
      "revisions",
    ));
    assert.deepEqual(revisionFiles, []);
  });
});

test("Workspace Preflight Receipt is immutable and becomes stale with Task or Skill drift", async () => {
  await withStore(async ({ projectRoot, stateRoot, store }) => {
    const created = await store.create({
      projectRoot,
      taskId: "receipt-task",
      task: validTask("receipt-task"),
    });
    const validated = await store.validate({
      projectRoot,
      taskId: "receipt-task",
      expectedWorkingCopyGeneration: 1,
    });
    const frozen = await store.freeze({
      projectRoot,
      taskId: "receipt-task",
      expectedWorkingCopyGeneration: 1,
    });
    const activation = {
      activationId: "activation-1",
      effectiveSkillSha256: "a".repeat(64),
      projectBinding: {
        projectId: null,
        workspaceId: created.workspace.workspaceId,
        projectRevision: created.workspace.workspaceRevision,
        projectConfigSha256: created.workspace.configSha256,
      },
    };
    const preflightResult = {
      ready: true,
      taskSha256: validated.taskSha256,
      checks: [{ id: "task-card", status: "passed" }],
      issues: [],
      envelope: {
        schemaVersion: 1,
        workflowMode: "overnight",
        taskId: "receipt-task",
        taskSha256: validated.taskSha256,
        worktree: projectRoot,
        adapterId: "claude-code",
        runtimeEnvironment: {
          executionEnvironment: "auto",
          proxyMode: "direct",
          isolationMode: "provider-scoped",
          networkDiagnostics: "metadata",
        },
        workflowContract: {
          sourceId: "agent-control-plane/workflow-core",
          version: "1.6.0",
          sha256: `sha256:${"c".repeat(64)}`,
          compatible: true,
        },
        strategy: "convergent",
        wakeAdapterId: "durable-file",
      },
    };
    const persisted = await store.createPreflight({
      projectRoot,
      taskId: "receipt-task",
      taskRevision: frozen.task.taskRevision,
      taskSha256: frozen.task.taskSha256,
      preflightResult,
      activation,
    });
    assert.match(persisted.receipt.preflightId, /^preflight-/);
    assert.match(persisted.receipt.preflightSha256, /^[a-f0-9]{64}$/);
    assert.equal(persisted.receipt.task.taskRevision, 1);

    const preflightFiles = await readdir(join(
      stateRoot,
      created.workspace.workspaceId,
      "tasks",
      "receipt-task",
      "preflights",
    ));
    assert.deepEqual(preflightFiles, [`${persisted.receipt.preflightId}.json`]);
    const loaded = await store.preflight({
      projectRoot,
      taskId: "receipt-task",
      preflightId: persisted.receipt.preflightId,
      activation,
    });
    assert.equal(loaded.receipt.preflightSha256, persisted.receipt.preflightSha256);
    assert.equal(loaded.revisionArtifact.taskSha256, frozen.task.taskSha256);
    const submitted = await store.recordSubmission({
      projectRoot,
      taskId: "receipt-task",
      preflightId: persisted.receipt.preflightId,
      runId: "run-1",
      activation,
    });
    assert.equal(submitted.metadata.taskRevisions["1"].lifecycleStatus, "submitted");
    assert.deepEqual(submitted.metadata.taskRevisions["1"].submittedRuns, ["run-1"]);
    const submittedIndex = await store.list({ projectRoot });
    assert.equal(submittedIndex.tasks[0].lifecycleStatus, "submitted");

    await assert.rejects(
      store.preflight({
        projectRoot,
        taskId: "receipt-task",
        preflightId: persisted.receipt.preflightId,
        activation: { ...activation, effectiveSkillSha256: "d".repeat(64) },
      }),
      (error) => error instanceof WorkspaceTaskStoreError && error.code === "preflight.activation_stale",
    );
  });
});

test("Revision Delta atomically creates a new immutable Task Revision and supersession lineage", async () => {
  await withStore(async ({ projectRoot, stateRoot, store }) => {
    const created = await store.create({
      projectRoot,
      taskId: "delta-task",
      task: validTask("delta-task"),
    });
    await store.validate({
      projectRoot,
      taskId: "delta-task",
      expectedWorkingCopyGeneration: 1,
    });
    const frozen = await store.freeze({
      projectRoot,
      taskId: "delta-task",
      expectedWorkingCopyGeneration: 1,
    });
    const candidate = structuredClone(frozen.revisionArtifact.task);
    candidate.handoff.must_not_do.push("Do not modify generated output.");
    const revised = await store.revise({
      projectRoot,
      taskId: "delta-task",
      baseTask: frozen.task,
      source: { kind: "revision-delta", actor: "codex" },
      review: {
        runId: "run-1",
        workflowMode: "balanced",
        artifactSha256: "a".repeat(64),
        sequence: 1,
      },
      delta: {
        summary: "Tighten the generated-output boundary.",
        changes: ["Forbid generated-output edits."],
        affectedPaths: ["generated/**"],
        affectedAcceptanceIds: ["acceptance-1"],
        requiredEvidence: ["Show no generated files changed."],
        task: candidate,
      },
    });
    assert.equal(revised.task.taskRevision, 2);
    assert.equal(revised.workingCopy.workingCopyGeneration, 2);
    assert.equal(revised.workingCopy.baseTaskRevision, 1);
    assert.equal(revised.metadata.taskRevisions["1"].supersededBy, 2);
    assert.equal(revised.metadata.taskRevisions["2"].supersedes, 1);
    assert.equal(
      revised.metadata.taskRevisions["2"].revisionDeltaId,
      revised.revisionDelta.revisionDeltaId,
    );
    assert.deepEqual(revised.revisionDelta.baseTask, frozen.task);
    assert.deepEqual(revised.revisionDelta.resultTask, revised.task);
    assert.match(revised.revisionDelta.revisionDeltaSha256, /^[a-f0-9]{64}$/);
    assert.equal(
      (await store.revisionDelta({
        projectRoot,
        taskId: "delta-task",
        revisionDeltaId: revised.revisionDelta.revisionDeltaId,
      })).revisionDeltaSha256,
      revised.revisionDelta.revisionDeltaSha256,
    );
    const deltaFiles = await readdir(join(
      stateRoot,
      created.workspace.workspaceId,
      "tasks",
      "delta-task",
      "deltas",
    ));
    assert.deepEqual(deltaFiles, [`${revised.revisionDelta.revisionDeltaId}.json`]);
    await assert.rejects(
      store.revise({
        projectRoot,
        taskId: "delta-task",
        baseTask: frozen.task,
        review: {
          runId: "run-1", workflowMode: "balanced", artifactSha256: "a".repeat(64), sequence: 1,
        },
        delta: {
          summary: "Stale edit.", changes: ["Retry stale base."], task: candidate,
        },
      }),
      (error) => error instanceof WorkspaceTaskStoreError && error.code === "revision_delta.base_task_stale",
    );
  });
});

test("invalid drafts cannot validate or leave an allocated Task Revision", async () => {
  await withStore(async ({ projectRoot, stateRoot, store }) => {
    const task = validTask("invalid-task");
    task.goal = "";
    const created = await store.create({ projectRoot, taskId: "invalid-task", task });
    await assert.rejects(
      store.validate({
        projectRoot,
        taskId: "invalid-task",
        expectedWorkingCopyGeneration: 1,
      }),
      (error) => error instanceof TaskCardError && error.code === "task.invalid",
    );
    await assert.rejects(
      store.freeze({
        projectRoot,
        taskId: "invalid-task",
        expectedWorkingCopyGeneration: 1,
      }),
      (error) => error instanceof WorkspaceTaskStoreError && error.code === "task.working_copy_not_validated",
    );
    assert.deepEqual(await readdir(join(
      stateRoot,
      created.workspace.workspaceId,
      "tasks",
      "invalid-task",
      "revisions",
    )), []);
  });
});

function runCli(args, cwd, stateRoot, environment = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [new URL("../balanced-cli.mjs", import.meta.url).pathname, ...args],
      {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          AGENT_CONTROL_PROJECT_STATE_DIR: stateRoot,
          ...environment,
        },
      },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }),
    );
  });
}

test("CLI exposes create, CAS write validation, freeze, and current workspace lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-control-task-cli-"));
  const projectRoot = join(root, "project");
  const stateRoot = join(root, "state");
  const taskPath = join(root, "TASK.json");
  const deltaPath = join(root, "REVISION-DELTA.json");
  await mkdir(projectRoot);
  await writeFile(taskPath, `${JSON.stringify(validTask("cli-task"), null, 2)}\n`);
  try {
    const created = await runCli([
      "task", "create", "--workspace", projectRoot, "--task-id", "cli-task",
      "--task", taskPath, "--source", "codex",
    ], root, stateRoot);
    assert.equal(created.error, null, created.stderr);
    assert.equal(JSON.parse(created.stdout).workingCopy.workingCopyGeneration, 1);
    const listed = await runCli([
      "task", "list", "--workspace", projectRoot,
    ], root, stateRoot);
    assert.equal(listed.error, null, listed.stderr);
    assert.equal(JSON.parse(listed.stdout).tasks[0].lifecycleStatus, "draft");

    const changedTask = validTask("cli-task");
    changedTask.goal = "Implement the CLI-updated bounded outcome.";
    await writeFile(taskPath, `${JSON.stringify(changedTask, null, 2)}\n`);
    const written = await runCli([
      "task", "write", "--workspace", projectRoot, "--task-id", "cli-task",
      "--task", taskPath, "--expected-working-copy-generation", "1", "--source", "codex",
    ], root, stateRoot);
    assert.equal(written.error, null, written.stderr);
    assert.equal(JSON.parse(written.stdout).workingCopy.workingCopyGeneration, 2);

    const validated = await runCli([
      "task", "validate", "--workspace", projectRoot, "--task-id", "cli-task",
      "--expected-working-copy-generation", "2",
    ], root, stateRoot);
    assert.equal(validated.error, null, validated.stderr);

    const frozen = await runCli([
      "task", "freeze", "--workspace", projectRoot, "--task-id", "cli-task",
      "--expected-working-copy-generation", "2",
    ], root, stateRoot);
    assert.equal(frozen.error, null, frozen.stderr);
    assert.equal(JSON.parse(frozen.stdout).task.taskRevision, 1);

    const current = await runCli([
      "task", "current", "--workspace", projectRoot,
    ], root, stateRoot);
    assert.equal(current.error, null, current.stderr);
    assert.equal(JSON.parse(current.stdout).activeTask.taskId, "cli-task");

    const draft = await runCli([
      "task", "current", "--workspace", projectRoot, "--task-id", "cli-task",
    ], root, stateRoot);
    assert.equal(draft.error, null, draft.stderr);
    assert.equal(JSON.parse(draft.stdout).revisionArtifact.taskRevision, 1);

    const currentWorkspace = await projectConfigStoreForCli(stateRoot).resolveWorkspace(
      projectRoot,
      { register: false },
    );
    const balancedProfile = {
      ...CODEX_OVERNIGHT_CLAUDE_PROFILE,
      id: "cli-balanced",
      mode: { id: "balanced", version: "1.0.0" },
    };
    const resolved = resolveEffectiveSkill({
      profile: balancedProfile,
      agents: EXAMPLE_AGENTS,
      catalog: BUILTIN_MODE_CATALOG,
    });
    assert.equal(resolved.ok, true);
    const skillsDir = join(root, "skills");
    await mkdir(skillsDir);
    const skillStore = createSkillStore({ skillsDir });
    await skillStore.activate({
      ...resolved.value,
      projectBinding: {
        projectId: null,
        workspaceId: currentWorkspace.workspaceId,
        projectRevision: currentWorkspace.workspaceRevision,
        projectConfigSha256: currentWorkspace.configSha256,
      },
    });
    const activationHistory = await skillStore.history();
    const activeHistoryId = activationHistory.entries.find((entry) => entry.isActive)?.historyId;
    const preflight = await runCli([
      "task", "preflight",
      "--workspace", projectRoot,
      "--task-id", "cli-task",
      "--workflow-mode", "balanced",
      "--adapter", "claude-code",
      "--execution-env", "host",
    ], root, stateRoot, {
      AGENT_WORKFLOW_SKILLS_DIR: skillsDir,
      AGENT_CONTROL_CLAUDE_COMMAND: process.execPath,
      CODEX_SANDBOX_NETWORK_DISABLED: "0",
    });
    assert.equal(preflight.error, null, preflight.stderr);
    const preflightResult = JSON.parse(preflight.stdout);
    assert.equal(preflightResult.executionReady, true);
    assert.equal(preflightResult.receipt.task.taskRevision, 1);
    assert.equal(preflightResult.receipt.workflow.activationId, activeHistoryId);

    const fakeClaude = join(root, "fake-claude.mjs");
    await writeFile(fakeClaude, [
      "#!/usr/bin/env node",
      "console.log(JSON.stringify({type:'assistant',session_id:'cli-session',message:{id:'message-1',content:[],usage:{input_tokens:3,output_tokens:2}}}));",
      "console.log(JSON.stringify({type:'result',session_id:'cli-session',usage:{input_tokens:3,output_tokens:2}}));",
    ].join("\n"));
    await chmod(fakeClaude, 0o700);
    const balancedRun = await runCli([
      "balanced", "run",
      "--workspace", projectRoot,
      "--task-id", "cli-task",
      "--preflight-id", preflightResult.receipt.preflightId,
    ], root, stateRoot, {
      AGENT_WORKFLOW_SKILLS_DIR: skillsDir,
      AGENT_CONTROL_CLAUDE_COMMAND: fakeClaude,
      AGENT_CONTROL_BALANCED_RUNS_DIR: join(root, "balanced-runs"),
      CODEX_SANDBOX_NETWORK_DISABLED: "0",
    });
    assert.equal(balancedRun.error, null, balancedRun.stderr);
    const balancedResult = JSON.parse(balancedRun.stdout);
    const runMetadata = JSON.parse(await readFile(join(balancedResult.runDirectory, "run.json"), "utf8"));
    assert.equal(runMetadata.executionBinding.task.taskRevision, 1);
    assert.equal(
      runMetadata.executionBinding.preflight.preflightId,
      preflightResult.receipt.preflightId,
    );
    assert.equal(
      JSON.parse(await readFile(join(balancedResult.runDirectory, "preflight-receipt.json"), "utf8")).preflightSha256,
      preflightResult.receipt.preflightSha256,
    );
    const submittedTask = await runCli([
      "task", "current", "--workspace", projectRoot, "--task-id", "cli-task",
    ], root, stateRoot);
    assert.equal(submittedTask.error, null, submittedTask.stderr);
    const submittedMetadata = JSON.parse(submittedTask.stdout).metadata.taskRevisions["1"];
    assert.equal(submittedMetadata.lifecycleStatus, "submitted");
    assert.deepEqual(submittedMetadata.submittedRuns, [runMetadata.runId]);

    const revisionTask = structuredClone(changedTask);
    revisionTask.handoff.must_not_do.push("Do not edit generated output.");
    await writeFile(deltaPath, `${JSON.stringify({
      summary: "Tighten the generated-output boundary.",
      changes: ["Do not edit generated output."],
      affectedPaths: ["generated/**"],
      affectedAcceptanceIds: ["acceptance-1"],
      requiredEvidence: ["Show no generated files changed."],
      task: revisionTask,
    }, null, 2)}\n`);
    const revisedRun = await runCli([
      "balanced", "review",
      "--run", balancedResult.runDirectory,
      "--decision", "revise",
      "--workspace", projectRoot,
      "--delta", deltaPath,
    ], root, stateRoot, {
      AGENT_WORKFLOW_SKILLS_DIR: skillsDir,
      AGENT_CONTROL_CLAUDE_COMMAND: fakeClaude,
      AGENT_CONTROL_BALANCED_RUNS_DIR: join(root, "balanced-runs"),
      CODEX_SANDBOX_NETWORK_DISABLED: "0",
    });
    assert.equal(revisedRun.error, null, revisedRun.stderr);
    assert.equal(JSON.parse(revisedRun.stdout).state, "validation_failed");
    const revisedMetadata = JSON.parse(await readFile(join(balancedResult.runDirectory, "run.json"), "utf8"));
    assert.equal(revisedMetadata.revisionBindings.length, 1);
    assert.equal(revisedMetadata.revisionBindings[0].round, 2);
    assert.equal(revisedMetadata.revisionBindings[0].executionBinding.task.taskRevision, 2);
    assert.equal(
      JSON.parse(await readFile(join(balancedResult.runDirectory, "rounds", "002", "revision-delta.json"), "utf8")).resultTask.taskRevision,
      2,
    );
    const revisedTaskState = JSON.parse((await runCli([
      "task", "current", "--workspace", projectRoot, "--task-id", "cli-task",
    ], root, stateRoot)).stdout);
    assert.equal(revisedTaskState.revisionArtifact.taskRevision, 2);
    assert.equal(revisedTaskState.metadata.taskRevisions["1"].supersededBy, 2);
    assert.deepEqual(revisedTaskState.metadata.taskRevisions["2"].submittedRuns, [runMetadata.runId]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function projectConfigStoreForCli(stateRoot) {
  return createProjectConfigStore({ stateRoot });
}
