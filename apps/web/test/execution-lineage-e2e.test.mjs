import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BUILTIN_MODE_CATALOG,
  CODEX_OVERNIGHT_CLAUDE_PROFILE,
  EXAMPLE_AGENTS,
  resolveEffectiveSkill,
} from "../../../packages/contracts/dist/index.js";
import { validatePreflightReceipt, taskCardSha256 } from "../execution-receipt.mjs";
import { createProjectConfigStore } from "../project-config-store.mjs";
import { validateRevisionDeltaArtifact } from "../revision-delta.mjs";
import { createSkillStore } from "../skill-store.mjs";
import { createTaskCardTemplate } from "../task-card.mjs";

const CLI = new URL("../balanced-cli.mjs", import.meta.url).pathname;

function runCli(args, cwd, environment) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      {
        cwd,
        encoding: "utf8",
        timeout: 15_000,
        env: { ...process.env, ...environment },
      },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }),
    );
  });
}

async function successfulCli(args, cwd, environment) {
  const result = await runCli(args, cwd, environment);
  assert.equal(result.error, null, result.stderr);
  return JSON.parse(result.stdout);
}

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "agent-control-lineage-e2e-"));
  const projectRoot = join(root, "project");
  const stateRoot = join(root, "state");
  const skillsDir = join(root, "skills");
  const fakeClaude = join(root, "fake-claude.mjs");
  await mkdir(projectRoot);
  await mkdir(skillsDir);
  await writeFile(join(projectRoot, "app.txt"), "base\n", "utf8");
  await writeFile(fakeClaude, [
    "#!/usr/bin/env node",
    "import { appendFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "appendFileSync(join(process.cwd(), 'app.txt'), 'downstream-pass\\n');",
    "console.log(JSON.stringify({type:'assistant',session_id:'e2e-session',message:{id:'message-1',content:[],usage:{input_tokens:3,output_tokens:2}}}));",
    "console.log(JSON.stringify({type:'result',session_id:'e2e-session',usage:{input_tokens:3,output_tokens:2}}));",
  ].join("\n"), "utf8");
  await chmod(fakeClaude, 0o700);
  const baseEnvironment = {
    AGENT_CONTROL_PROJECT_STATE_DIR: stateRoot,
    AGENT_WORKFLOW_SKILLS_DIR: skillsDir,
    CODEX_SANDBOX_NETWORK_DISABLED: "0",
  };
  try {
    await run({ root, projectRoot, stateRoot, skillsDir, fakeClaude, baseEnvironment });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function canonicalTask(taskId) {
  const task = createTaskCardTemplate();
  task.id = taskId;
  task.goal = "Append one observable downstream result to app.txt.";
  task.scope.write_paths = ["app.txt"];
  task.scope.forbidden_paths = ["forbidden/**"];
  task.acceptance = [{
    id: "app-result",
    description: "app.txt contains a downstream result.",
  }];
  return task;
}

async function freezeInitialTask(context, task) {
  const taskPath = join(context.root, `${task.id}.json`);
  await writeFile(taskPath, `${JSON.stringify(task, null, 2)}\n`, "utf8");
  const created = await successfulCli([
    "task", "create", "--workspace", context.projectRoot,
    "--task-id", task.id, "--task", taskPath, "--source", "codex",
  ], context.root, context.baseEnvironment);
  assert.equal(created.workingCopy.workingCopyGeneration, 1);
  await successfulCli([
    "task", "validate", "--workspace", context.projectRoot,
    "--task-id", task.id, "--expected-working-copy-generation", "1",
  ], context.root, context.baseEnvironment);
  return successfulCli([
    "task", "freeze", "--workspace", context.projectRoot,
    "--task-id", task.id, "--expected-working-copy-generation", "1",
  ], context.root, context.baseEnvironment);
}

async function activateMode(context, mode) {
  const workspace = await createProjectConfigStore({ stateRoot: context.stateRoot })
    .resolveWorkspace(context.projectRoot, { register: false });
  const profile = {
    ...CODEX_OVERNIGHT_CLAUDE_PROFILE,
    id: `e2e-${mode}`,
    mode: { id: mode, version: "1.0.0" },
  };
  const resolved = resolveEffectiveSkill({
    profile,
    agents: EXAMPLE_AGENTS,
    catalog: BUILTIN_MODE_CATALOG,
  });
  assert.equal(resolved.ok, true);
  const activated = await createSkillStore({ skillsDir: context.skillsDir }).activate({
    ...resolved.value,
    projectBinding: {
      projectId: null,
      workspaceId: workspace.workspaceId,
      projectRevision: workspace.workspaceRevision,
      projectConfigSha256: workspace.configSha256,
    },
  });
  return activated.status.active;
}

async function preflight(context, taskId, mode) {
  return successfulCli([
    "task", "preflight", "--workspace", context.projectRoot,
    "--task-id", taskId, "--workflow-mode", mode,
    "--adapter", "claude-code", "--execution-env", "host",
    ...(mode === "overnight" ? ["--strategy", "convergent", "--wake-adapter", "durable-file"] : []),
  ], context.root, {
    ...context.baseEnvironment,
    AGENT_CONTROL_CLAUDE_COMMAND: process.execPath,
  });
}

async function writeRevisionDelta(context, task, name) {
  const revised = structuredClone(task);
  revised.handoff.must_not_do.push("Do not edit generated output.");
  const path = join(context.root, `${name}.json`);
  await writeFile(path, `${JSON.stringify({
    summary: "Tighten the generated-output boundary.",
    changes: ["Do not edit generated output."],
    affectedPaths: ["app.txt"],
    affectedAcceptanceIds: ["app-result"],
    requiredEvidence: ["Show the changed path and successful validation."],
    task: revised,
  }, null, 2)}\n`, "utf8");
  return path;
}

async function currentTask(context, taskId) {
  return successfulCli([
    "task", "current", "--workspace", context.projectRoot, "--task-id", taskId,
  ], context.root, context.baseEnvironment);
}

async function waitForOvernightState(context, runDirectory, expected, runtimeEnvironment) {
  let last = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await runCli(
      ["overnight", "status", "--run", runDirectory],
      context.root,
      runtimeEnvironment,
    );
    if (!result.error) {
      last = JSON.parse(result.stdout);
      if (last.state === expected) return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Overnight Run did not reach ${expected}; last state was ${last?.state ?? "unavailable"}.`);
}

function assertFrozenTaskReference(revisionArtifact, reference) {
  assert.equal(revisionArtifact.taskId, reference.taskId);
  assert.equal(revisionArtifact.taskRevision, reference.taskRevision);
  assert.equal(revisionArtifact.taskSha256, reference.taskSha256);
  assert.equal(taskCardSha256(revisionArtifact.task), reference.taskSha256);
}

test("canonical Balanced execution preserves Task -> Preflight -> Run -> Delta -> Task lineage", async () => {
  await fixture(async (context) => {
    const task = canonicalTask("balanced-e2e");
    const frozen = await freezeInitialTask(context, task);
    await activateMode(context, "balanced");
    const initialPreflight = await preflight(context, task.id, "balanced");
    assert.equal(initialPreflight.executionReady, true);
    validatePreflightReceipt(initialPreflight.receipt);
    assertFrozenTaskReference(frozen.revisionArtifact, initialPreflight.receipt.task);

    const runtimeEnvironment = {
      ...context.baseEnvironment,
      AGENT_CONTROL_CLAUDE_COMMAND: context.fakeClaude,
      AGENT_CONTROL_BALANCED_RUNS_DIR: join(context.root, "balanced-runs"),
    };
    const started = await successfulCli([
      "balanced", "run", "--workspace", context.projectRoot,
      "--task-id", task.id, "--preflight-id", initialPreflight.receipt.preflightId,
    ], context.root, runtimeEnvironment);
    assert.equal(started.state, "review_pending");
    let run = await successfulCli(
      ["balanced", "status", "--run", started.runDirectory],
      context.root,
      runtimeEnvironment,
    );
    assert.equal(run.runCreation.state, "running");
    assert.deepEqual(run.executionBinding.task, initialPreflight.receipt.task);
    assert.equal(run.executionBinding.preflight.preflightSha256, initialPreflight.receipt.preflightSha256);

    const deltaPath = await writeRevisionDelta(context, task, "balanced-delta");
    const revised = await successfulCli([
      "balanced", "review", "--run", started.runDirectory, "--decision", "revise",
      "--workspace", context.projectRoot, "--delta", deltaPath,
    ], context.root, runtimeEnvironment);
    assert.equal(revised.state, "review_pending");
    run = await successfulCli(
      ["balanced", "status", "--run", started.runDirectory],
      context.root,
      runtimeEnvironment,
    );
    assert.equal(run.revisionBindings.length, 1);
    const binding = run.revisionBindings[0];
    const revisionReceipt = JSON.parse(await readFile(
      join(started.runDirectory, "rounds", "002", "preflight-receipt.json"),
      "utf8",
    ));
    const delta = JSON.parse(await readFile(
      join(started.runDirectory, "rounds", "002", "revision-delta.json"),
      "utf8",
    ));
    validatePreflightReceipt(revisionReceipt);
    assert.deepEqual(binding.executionBinding.task, revisionReceipt.task);
    assert.equal(binding.executionBinding.preflight.preflightSha256, revisionReceipt.preflightSha256);
    validateRevisionDeltaArtifact(delta, {
      revisionDeltaId: binding.revisionDeltaId,
      baseTask: run.executionBinding.task,
      resultTask: binding.executionBinding.task,
    });

    const accepted = await successfulCli([
      "balanced", "review", "--run", started.runDirectory, "--decision", "accept",
    ], context.root, runtimeEnvironment);
    assert.equal(accepted.state, "accepted");
    const taskState = await currentTask(context, task.id);
    assertFrozenTaskReference(taskState.revisionArtifact, binding.executionBinding.task);
    assert.equal(taskState.metadata.taskRevisions["1"].supersededBy, 2);
    assert.equal(taskState.metadata.taskRevisions["2"].supersedes, 1);
    assert.deepEqual(taskState.metadata.taskRevisions["1"].submittedRuns, [run.runId]);
    assert.deepEqual(taskState.metadata.taskRevisions["2"].submittedRuns, [run.runId]);
  });
});

test("canonical Overnight execution preserves lineage across supervisor wake and revision", async () => {
  await fixture(async (context) => {
    const task = canonicalTask("overnight-e2e");
    const frozen = await freezeInitialTask(context, task);
    await activateMode(context, "overnight");
    const initialPreflight = await preflight(context, task.id, "overnight");
    assert.equal(initialPreflight.executionReady, true);
    validatePreflightReceipt(initialPreflight.receipt);
    assertFrozenTaskReference(frozen.revisionArtifact, initialPreflight.receipt.task);

    const runtimeEnvironment = {
      ...context.baseEnvironment,
      AGENT_CONTROL_CLAUDE_COMMAND: context.fakeClaude,
      AGENT_CONTROL_OVERNIGHT_RUNS_DIR: join(context.root, "overnight-runs"),
    };
    const submitted = await successfulCli([
      "overnight", "submit", "--workspace", context.projectRoot,
      "--task-id", task.id, "--preflight-id", initialPreflight.receipt.preflightId,
    ], context.root, runtimeEnvironment);
    let run = await waitForOvernightState(
      context,
      submitted.runDirectory,
      "revision_pending",
      runtimeEnvironment,
    );
    assert.equal(run.runCreation.state, "running");
    assert.deepEqual(run.executionBinding.task, initialPreflight.receipt.task);
    assert.equal(run.executionBinding.preflight.preflightSha256, initialPreflight.receipt.preflightSha256);

    const deltaPath = await writeRevisionDelta(context, task, "overnight-delta");
    const revised = await successfulCli([
      "overnight", "review", "--run", submitted.runDirectory, "--decision", "revise",
      "--workspace", context.projectRoot, "--delta", deltaPath,
    ], context.root, runtimeEnvironment);
    assert.equal(revised.resumeRequired, true);
    run = await waitForOvernightState(
      context,
      submitted.runDirectory,
      "revision_pending",
      runtimeEnvironment,
    );
    assert.equal(run.cycle, 2);
    assert.equal(run.revisionBindings.length, 1);
    const binding = run.revisionBindings[0];
    const revisionReceipt = JSON.parse(await readFile(
      join(submitted.runDirectory, "cycles", "002", "preflight-receipt.json"),
      "utf8",
    ));
    const delta = JSON.parse(await readFile(
      join(submitted.runDirectory, "cycles", "002", "revision-delta.json"),
      "utf8",
    ));
    validatePreflightReceipt(revisionReceipt);
    assert.deepEqual(binding.executionBinding.task, revisionReceipt.task);
    assert.equal(binding.executionBinding.preflight.preflightSha256, revisionReceipt.preflightSha256);
    validateRevisionDeltaArtifact(delta, {
      revisionDeltaId: binding.revisionDeltaId,
      baseTask: run.executionBinding.task,
      resultTask: binding.executionBinding.task,
    });

    const accepted = await successfulCli([
      "overnight", "review", "--run", submitted.runDirectory, "--decision", "accept",
    ], context.root, runtimeEnvironment);
    assert.equal(accepted.state, "accepted");
    const taskState = await currentTask(context, task.id);
    assertFrozenTaskReference(taskState.revisionArtifact, binding.executionBinding.task);
    assert.equal(taskState.metadata.taskRevisions["1"].supersededBy, 2);
    assert.equal(taskState.metadata.taskRevisions["2"].supersedes, 1);
    assert.deepEqual(taskState.metadata.taskRevisions["1"].submittedRuns, [run.runId]);
    assert.deepEqual(taskState.metadata.taskRevisions["2"].submittedRuns, [run.runId]);
  });
});
