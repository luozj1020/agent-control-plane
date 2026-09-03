#!/usr/bin/env node

import { spawn } from "node:child_process";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BUILTIN_MODE_CATALOG } from "../../packages/contracts/dist/index.js";
import { BalancedRuntimeError, createBalancedRuntime } from "./balanced-runtime.mjs";
import { OvernightRuntimeError, createOvernightRuntime } from "./overnight-runtime.mjs";
import { createWorkflowCoreAdapter } from "./workflow-core-adapter.mjs";
import { discoverRuntimeActivation } from "./runtime-activation.mjs";
import { createProjectConfigStore, ProjectConfigError } from "./project-config-store.mjs";
import {
  TaskCardError,
  createTaskCardTemplate,
  normalizeTaskCard,
  renderTaskCardMarkdown,
} from "./task-card.mjs";
import {
  WorkspaceTaskStoreError,
  createWorkspaceTaskStore,
} from "./workspace-task-store.mjs";
import {
  createTaskCardPreflightAdapters,
  preflightTaskCard,
} from "./task-card-preflight.mjs";

const CLI_PATH = fileURLToPath(import.meta.url);
const workflowCoreAdapter = createWorkflowCoreAdapter();
const runtimeProtocolProvider = (mode) => workflowCoreAdapter.runtimeProtocol(mode);

function workspaceTaskStore() {
  return createWorkspaceTaskStore({ projectConfigStore: createProjectConfigStore() });
}

function writeStream(stream, value) {
  return new Promise((resolveWrite, rejectWrite) => {
    stream.write(value, (error) => (error ? rejectWrite(error) : resolveWrite()));
  });
}

function cliError(code, message) {
  return new BalancedRuntimeError(code, message);
}

function parseOptions(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token.startsWith("--") || token.length === 2) {
      throw cliError("cli.invalid_argument", `Unexpected argument '${token}'.`);
    }
    const key = token.slice(2);
    const value = values[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw cliError("cli.invalid_argument", `Option '--${key}' requires a value.`);
    }
    if (options[key] !== undefined) {
      throw cliError("cli.invalid_argument", `Option '--${key}' was repeated.`);
    }
    options[key] = value;
    index += 1;
  }
  return options;
}

function integerOption(options, name) {
  if (options[name] === undefined) return undefined;
  if (!/^(0|[1-9]\d*)$/.test(options[name])) {
    throw cliError("cli.invalid_argument", `--${name} must be a non-negative integer.`);
  }
  return Number(options[name]);
}

function requireAllowedOptions(options, allowed) {
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) {
      throw cliError("cli.invalid_argument", `Unknown option '--${key}'.`);
    }
  }
}

async function readTask(path, label) {
  if (!path) throw cliError("cli.missing_argument", `${label} path is required.`);
  const absolute = resolve(path);
  const metadata = await lstat(absolute).catch((error) => {
    if (error?.code === "ENOENT") {
      throw cliError("cli.file_missing", `${label} file does not exist.`);
    }
    throw error;
  });
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > 128 * 1024) {
    throw cliError("cli.unsafe_file", `${label} must be a regular JSON file under 128 KiB.`);
  }
  try {
    return JSON.parse(await readFile(absolute, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw cliError("cli.invalid_json", `${label} is not valid JSON.`);
    }
    throw error;
  }
}

function usage() {
  return [
    "Agent Control Plane Runtime",
    "",
    "Commands:",
    "  agent-control-plane balanced run --workspace PATH --task-id ID --preflight-id ID",
    "  agent-control-plane balanced review --run RUN_DIR --decision accept|revise|stop [--workspace PATH --delta DELTA.json]",
    "  agent-control-plane balanced status --run RUN_DIR",
    "  agent-control-plane balanced list",
    "  agent-control-plane overnight submit --workspace PATH --task-id ID --preflight-id ID",
    "  agent-control-plane overnight review --run RUN_DIR --decision accept|revise|continue|stop [--workspace PATH --delta DELTA.json] [--next NEXT.json]",
    "  agent-control-plane overnight interrupt --run RUN_DIR",
    "  agent-control-plane overnight status --run RUN_DIR",
    "  agent-control-plane overnight list",
    "  agent-control-plane overnight next-init --run RUN_DIR [--output NEXT.json]",
    "  agent-control-plane task init [--output TASK.json]",
    "  agent-control-plane task create --workspace PATH --task-id ID [--task TASK.json] [--source AGENT]",
    "  agent-control-plane task edit --workspace PATH --task-id ID [--base-task-revision N] [--source AGENT]",
    "  agent-control-plane task write --workspace PATH --task-id ID --task TASK.json --expected-working-copy-generation N [--source AGENT]",
    "  agent-control-plane task validate --task TASK.json",
    "  agent-control-plane task validate --workspace PATH --task-id ID --expected-working-copy-generation N",
    "  agent-control-plane task freeze --workspace PATH --task-id ID --expected-working-copy-generation N",
    "  agent-control-plane task current --workspace PATH [--task-id ID]",
    "  agent-control-plane task list --workspace PATH",
    "  agent-control-plane task preflight --workspace PATH --workflow-mode balanced|overnight [runtime options]",
    "  agent-control-plane task migrate --task LEGACY.json [--output TASK.json]",
    "  agent-control-plane task render --task TASK.json --view audit|execution [--output TASK.md]",
    "",
    "Budget options:",
    "  --main-review-calls N --downstream-calls N --advisor-calls N",
    "  --reserved-final-review-calls N",
    "",
    "Timing overrides (seconds):",
    "  --context-seconds N --first-progress-seconds N --active-seconds N",
    "  --extension-seconds N --growing-extension-seconds N --hard-cap-seconds N",
  ].join("\n");
}

function balancedPreflightProfile(active, options) {
  const timingPolicy = BUILTIN_MODE_CATALOG.tunedWindowPolicies.find(
    (entry) => entry.id === "balanced-default" && entry.version === "1.0.0",
  );
  const budgetPolicy = BUILTIN_MODE_CATALOG.balancedBudgetPolicies.find(
    (entry) => entry.id === "balanced-standard" && entry.version === "1.0.0",
  );
  const timingBase = active.balancedTiming ?? timingPolicy;
  const budgetBase = active.balancedBudget ?? budgetPolicy;
  const pick = (name, fallback) => integerOption(options, name) ?? fallback;
  return {
    policyRef: "balanced-default@1.0.0",
    timing: {
      contextAcquisitionSeconds: pick("context-seconds", timingBase.contextAcquisitionSeconds),
      firstProgressSeconds: pick("first-progress-seconds", timingBase.firstProgressSeconds),
      activeWindowSeconds: pick("active-seconds", timingBase.activeWindowSeconds),
      progressExtensionSeconds: pick("extension-seconds", timingBase.progressExtensionSeconds),
      growingProgressExtensionSeconds: pick(
        "growing-extension-seconds",
        timingBase.growingProgressExtensionSeconds,
      ),
      hardCapSeconds: pick("hard-cap-seconds", timingBase.hardCapSeconds),
    },
    budget: {
      mainReviewCalls: pick("main-review-calls", budgetBase.mainReviewCalls),
      downstreamCalls: pick("downstream-calls", budgetBase.downstreamCalls),
      advisorCalls: pick("advisor-calls", budgetBase.advisorCalls),
      reservedFinalReviewCalls: pick(
        "reserved-final-review-calls",
        budgetBase.reservedFinalReviewCalls,
      ),
    },
  };
}

function overnightPreflightStrategy(active, requested) {
  if (requested) return requested;
  const reference = active.overnightLoopPolicy;
  const policy = BUILTIN_MODE_CATALOG.overnightLoopPolicies.find(
    (entry) => entry.id === reference?.id && entry.version === reference?.version,
  );
  return policy?.strategy ?? "convergent";
}

async function writeScaffold(value, output, label) {
  if (!output) return { template: value };
  const outputPath = resolve(output);
  const existing = await lstat(outputPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    throw cliError("cli.output_exists", `${label} output already exists; edit it or choose another path.`);
  }
  try {
    await writeFile(outputPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw cliError("cli.output_exists", `${label} output already exists; edit it or choose another path.`);
    }
    throw error;
  }
  return { outputPath };
}

async function writeTextScaffold(value, output, label) {
  if (!output) return { content: value };
  const outputPath = resolve(output);
  const existing = await lstat(outputPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    throw cliError("cli.output_exists", `${label} output already exists; choose another path.`);
  }
  await writeFile(outputPath, value, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return { outputPath };
}

async function runTaskCommand(command, options) {
  if (command === "init") {
    requireAllowedOptions(options, new Set(["output"]));
    return writeScaffold(createTaskCardTemplate(), options.output, "Task Card");
  }
  if (command === "validate") {
    if (options.workspace !== undefined) {
      requireAllowedOptions(options, new Set([
        "workspace", "task-id", "expected-working-copy-generation",
      ]));
      return workspaceTaskStore().validate({
        projectRoot: options.workspace,
        taskId: options["task-id"],
        expectedWorkingCopyGeneration: integerOption(options, "expected-working-copy-generation"),
      });
    }
    requireAllowedOptions(options, new Set(["task"]));
    const normalized = normalizeTaskCard(await readTask(options.task, "Task Card"));
    return { valid: true, ...normalized };
  }
  if (command === "create") {
    requireAllowedOptions(options, new Set(["workspace", "task-id", "task", "source"]));
    if (!options.workspace || !options["task-id"]) {
      throw cliError("cli.missing_argument", "--workspace and --task-id are required.");
    }
    return workspaceTaskStore().create({
      projectRoot: options.workspace,
      taskId: options["task-id"],
      task: options.task ? await readTask(options.task, "Task Card") : undefined,
      source: { kind: "upstream-agent", ...(options.source ? { actor: options.source } : {}) },
    });
  }
  if (command === "write") {
    requireAllowedOptions(options, new Set([
      "workspace", "task-id", "task", "expected-working-copy-generation", "source",
    ]));
    if (!options.workspace || !options["task-id"] || !options.task) {
      throw cliError("cli.missing_argument", "--workspace, --task-id, and --task are required.");
    }
    return workspaceTaskStore().write({
      projectRoot: options.workspace,
      taskId: options["task-id"],
      task: await readTask(options.task, "Task Card"),
      expectedWorkingCopyGeneration: integerOption(options, "expected-working-copy-generation"),
      source: { kind: "upstream-agent", ...(options.source ? { actor: options.source } : {}) },
    });
  }
  if (command === "edit") {
    requireAllowedOptions(options, new Set(["workspace", "task-id", "base-task-revision", "source"]));
    if (!options.workspace || !options["task-id"]) {
      throw cliError("cli.missing_argument", "--workspace and --task-id are required.");
    }
    return workspaceTaskStore().edit({
      projectRoot: options.workspace,
      taskId: options["task-id"],
      baseTaskRevision: integerOption(options, "base-task-revision"),
      source: { kind: "manual-revision", ...(options.source ? { actor: options.source } : {}) },
    });
  }
  if (command === "freeze") {
    requireAllowedOptions(options, new Set([
      "workspace", "task-id", "expected-working-copy-generation",
    ]));
    if (!options.workspace || !options["task-id"]) {
      throw cliError("cli.missing_argument", "--workspace and --task-id are required.");
    }
    return workspaceTaskStore().freeze({
      projectRoot: options.workspace,
      taskId: options["task-id"],
      expectedWorkingCopyGeneration: integerOption(options, "expected-working-copy-generation"),
    });
  }
  if (command === "current") {
    requireAllowedOptions(options, new Set(["workspace", "task-id"]));
    if (!options.workspace) throw cliError("cli.missing_argument", "--workspace is required.");
    return workspaceTaskStore().current({
      projectRoot: options.workspace,
      taskId: options["task-id"],
    });
  }
  if (command === "list") {
    requireAllowedOptions(options, new Set(["workspace"]));
    if (!options.workspace) throw cliError("cli.missing_argument", "--workspace is required.");
    return workspaceTaskStore().list({ projectRoot: options.workspace });
  }
  if (command === "preflight") {
    requireAllowedOptions(options, new Set([
      "workspace", "task-id", "workflow-mode", "adapter", "worktree", "strategy",
      "wake-adapter", "policy",
      "main-review-calls", "downstream-calls", "advisor-calls", "reserved-final-review-calls",
      "context-seconds", "first-progress-seconds", "active-seconds", "extension-seconds",
      "growing-extension-seconds", "hard-cap-seconds",
      "execution-env", "proxy-mode", "environment-isolation", "network-diagnostics",
    ]));
    if (!options.workspace || !new Set(["balanced", "overnight"]).has(options["workflow-mode"])) {
      throw cliError(
        "cli.missing_argument",
        "--workspace and --workflow-mode balanced|overnight are required.",
      );
    }
    const workflowMode = options["workflow-mode"];
    const active = await discoverRuntimeActivation(workflowMode);
    const store = workspaceTaskStore();
    const current = await store.current({
      projectRoot: options.workspace,
      ...(options["task-id"] ? { taskId: options["task-id"] } : {}),
    });
    if (!current.revisionArtifact) {
      throw new WorkspaceTaskStoreError(
        "preflight.task_not_frozen",
        "Preflight requires an immutable frozen Task Revision.",
        409,
      );
    }
    const adapterId = options.adapter ?? active.targetAdapterId;
    if (!adapterId) {
      throw cliError("cli.missing_argument", "--adapter is required when the active Skill has no downstream binding.");
    }
    const balanced = balancedPreflightProfile(active, options);
    const preflight = await preflightTaskCard({
      task: current.revisionArtifact.task,
      workflowMode,
      adapterId,
      worktree: options.worktree ?? options.workspace,
      runtimeEnvironment: {
        executionEnvironment: options["execution-env"],
        proxyMode: options["proxy-mode"],
        isolationMode: options["environment-isolation"],
        networkDiagnostics: options["network-diagnostics"],
      },
      ...(workflowMode === "overnight" ? {
        strategy: overnightPreflightStrategy(active, options.strategy),
        wakeAdapterId: options["wake-adapter"] ?? "durable-file",
      } : {
        policyRef: options.policy ?? balanced.policyRef,
        timing: balanced.timing,
        budget: balanced.budget,
      }),
    }, {
      adapters: createTaskCardPreflightAdapters(process.env),
      environment: process.env,
      workflowContract: await workflowCoreAdapter.status(),
    });
    if (!preflight.ready) {
      return { ...preflight, executionReady: false, receipt: null };
    }
    const persisted = await store.createPreflight({
      projectRoot: options.workspace,
      taskId: current.revisionArtifact.taskId,
      taskRevision: current.revisionArtifact.taskRevision,
      taskSha256: current.revisionArtifact.taskSha256,
      preflightResult: preflight,
      activation: active,
    });
    return { ...preflight, executionReady: true, receipt: persisted.receipt };
  }
  if (command === "migrate") {
    requireAllowedOptions(options, new Set(["task", "output"]));
    const normalized = normalizeTaskCard(await readTask(options.task, "Task Card"));
    if (!options.output) return normalized;
    return {
      ...await writeScaffold(normalized.task, options.output, "Migrated Task Card"),
      migrated: normalized.migrated,
      sourceFormat: normalized.sourceFormat,
    };
  }
  if (command === "render") {
    requireAllowedOptions(options, new Set(["task", "view", "output"]));
    if (!new Set(["audit", "execution"]).has(options.view)) {
      throw cliError("cli.invalid_argument", "--view must be audit or execution.");
    }
    const normalized = normalizeTaskCard(await readTask(options.task, "Task Card"));
    return {
      ...await writeTextScaffold(
        renderTaskCardMarkdown(normalized.task, { view: options.view }),
        options.output,
        "Rendered Task Card",
      ),
      view: options.view,
      migrated: normalized.migrated,
    };
  }
  throw cliError("cli.invalid_command", `Unknown Task Card command '${command}'.`);
}

function launchOvernightSupervisor(runDirectory) {
  const child = spawn(process.execPath, [CLI_PATH, "overnight", "supervise", "--run", runDirectory], {
    cwd: process.cwd(),
    detached: true,
    env: process.env,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return child.pid ?? null;
}

async function loadExecutionReceipt(mode, options) {
  if (!options.workspace || !options["task-id"] || !options["preflight-id"]) {
    throw cliError(
      "cli.missing_argument",
      "--workspace, --task-id, and --preflight-id are required.",
    );
  }
  const active = await discoverRuntimeActivation(mode);
  const store = workspaceTaskStore();
  const bound = await store.preflight({
    projectRoot: options.workspace,
    taskId: options["task-id"],
    preflightId: options["preflight-id"],
    activation: active,
  });
  if (bound.receipt.runtimeEnvelope.workflowMode !== mode) {
    throw new WorkspaceTaskStoreError(
      "preflight.workflow_mode_mismatch",
      `Preflight Receipt is not for ${mode}.`,
      409,
    );
  }
  return { ...bound, active, store };
}

async function prepareRevision(mode, options, status) {
  if (!options.workspace || !options.delta) {
    throw cliError("cli.missing_argument", "--workspace and --delta are required for revise.");
  }
  const active = await discoverRuntimeActivation(mode);
  const store = workspaceTaskStore();
  const priorBinding = (status.revisionBindings ?? []).at(-1)?.executionBinding ?? status.executionBinding;
  if (!priorBinding?.task || !priorBinding?.preflight?.preflightId) {
    throw cliError("revision_delta.base_binding_missing", "The run has no immutable current Task/Preflight binding.");
  }
  const taskId = priorBinding.task.taskId;
  if (options["task-id"] && options["task-id"] !== taskId) {
    throw cliError("revision_delta.task_mismatch", "--task-id does not match the run's current Task binding.");
  }
  const prior = await store.preflight({
    projectRoot: options.workspace,
    taskId,
    preflightId: priorBinding.preflight.preflightId,
    activation: active,
  });
  const delta = await readTask(options.delta, "Revision Delta");
  if (!delta?.task) {
    throw cliError("revision_delta.invalid", "Revision Delta must contain the complete candidate Task in 'task'.");
  }
  const envelope = prior.receipt.runtimeEnvelope;
  const diagnostic = await preflightTaskCard({
    task: delta.task,
    workflowMode: mode,
    adapterId: envelope.adapterId,
    worktree: envelope.worktree,
    runtimeEnvironment: envelope.runtimeEnvironment,
    ...(mode === "overnight" ? {
      strategy: envelope.strategy,
      wakeAdapterId: envelope.wakeAdapterId,
    } : {
      policyRef: envelope.policyRef,
      timing: envelope.timing,
      budget: envelope.budget,
    }),
  }, {
    adapters: createTaskCardPreflightAdapters(process.env),
    environment: process.env,
    workflowContract: await workflowCoreAdapter.status(),
  });
  if (!diagnostic.ready) {
    const error = cliError("revision_delta.preflight_failed", "Revision Delta candidate did not pass Preflight.");
    error.details = diagnostic;
    throw error;
  }
  const reviewArtifactSha256 = mode === "balanced" ? status.latestReviewSha256 : status.latestWakeSha256;
  const sequence = mode === "balanced" ? status.rounds : status.cycle;
  const revised = await store.revise({
    projectRoot: options.workspace,
    taskId,
    baseTask: priorBinding.task,
    delta,
    source: { kind: "revision-delta", actor: "upstream-reviewer" },
    review: {
      runId: status.runId,
      workflowMode: mode,
      artifactSha256: reviewArtifactSha256,
      sequence,
    },
  });
  const persisted = await store.createPreflight({
    projectRoot: options.workspace,
    taskId,
    taskRevision: revised.task.taskRevision,
    taskSha256: revised.task.taskSha256,
    preflightResult: diagnostic,
    activation: active,
  });
  return {
    active,
    store,
    taskId,
    revisionArtifact: revised.revisionArtifact,
    revisionDelta: revised.revisionDelta,
    receipt: persisted.receipt,
  };
}

async function runOvernightCommand(command, options) {
  const runtime = createOvernightRuntime({ protocolProvider: runtimeProtocolProvider });
  if (command === "submit") {
    requireAllowedOptions(options, new Set(["workspace", "task-id", "preflight-id"]));
    const bound = await loadExecutionReceipt("overnight", options);
    const envelope = bound.receipt.runtimeEnvelope;
    const created = await runtime.createRun({
      task: bound.revisionArtifact.task,
      worktree: envelope.worktree,
      adapterId: envelope.adapterId,
      activationId: bound.active.activationId,
      effectiveSkillSha256: bound.active.effectiveSkillSha256,
      projectBinding: bound.active.projectBinding,
      strategy: envelope.strategy,
      wakeAdapterId: envelope.wakeAdapterId,
      runtimeEnvironment: envelope.runtimeEnvironment,
      preflightReceipt: bound.receipt,
    });
    await bound.store.recordSubmission({
      projectRoot: options.workspace,
      taskId: options["task-id"],
      preflightId: options["preflight-id"],
      runId: created.metadata.runId,
      activation: bound.active,
    });
    return {
      state: created.metadata.state,
      runDirectory: created.runDirectory,
      supervisorPid: launchOvernightSupervisor(created.runDirectory),
    };
  }
  if (command === "supervise") {
    requireAllowedOptions(options, new Set(["run"]));
    if (!options.run) throw cliError("cli.missing_argument", "--run is required.");
    const executed = await runtime.executeCycle(options.run);
    return {
      state: executed.state,
      runDirectory: executed.runDirectory,
      wakePath: executed.wakePath,
      wakeSha256: executed.wakeSha256,
    };
  }
  if (command === "review") {
    requireAllowedOptions(options, new Set(["run", "decision", "workspace", "task-id", "delta", "next"]));
    if (!options.run || !options.decision) {
      throw cliError("cli.missing_argument", "--run and --decision are required.");
    }
    const revision = options.decision === "revise"
      ? await prepareRevision("overnight", options, await runtime.status(options.run))
      : null;
    const reviewed = await runtime.review({
      runDirectory: options.run,
      decision: options.decision,
      revision: revision ? {
        task: revision.revisionArtifact.task,
        revisionDelta: revision.revisionDelta,
        preflightReceipt: revision.receipt,
      } : undefined,
      continuation:
        options.decision === "continue" ? await readTask(options.next, "Next-cycle contract") : undefined,
    });
    if (revision) {
      await revision.store.recordSubmission({
        projectRoot: options.workspace,
        taskId: revision.taskId,
        preflightId: revision.receipt.preflightId,
        runId: (await runtime.status(options.run)).runId,
        activation: revision.active,
      });
    }
    return {
      ...reviewed,
      ...(reviewed.resumeRequired
        ? { supervisorPid: launchOvernightSupervisor(reviewed.runDirectory) }
        : {}),
    };
  }
  if (command === "interrupt") {
    requireAllowedOptions(options, new Set(["run"]));
    if (!options.run) throw cliError("cli.missing_argument", "--run is required.");
    return runtime.interrupt(options.run);
  }
  if (command === "status") {
    requireAllowedOptions(options, new Set(["run"]));
    if (!options.run) throw cliError("cli.missing_argument", "--run is required.");
    return runtime.status(options.run);
  }
  if (command === "list") {
    if (Object.keys(options).length > 0) {
      throw cliError("cli.invalid_argument", "The list command accepts no options.");
    }
    return { runs: await runtime.listRuns() };
  }
  if (command === "next-init") {
    requireAllowedOptions(options, new Set(["run", "output"]));
    if (!options.run) throw cliError("cli.missing_argument", "--run is required.");
    return writeScaffold(await runtime.nextTemplate(options.run), options.output, "Next-cycle Card");
  }
  throw cliError("cli.invalid_command", `Unknown Overnight command '${command}'.`);
}

async function main(argv) {
  if (!new Set(["balanced", "overnight", "task"]).has(argv[0])) {
    if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help") {
      await writeStream(process.stdout, `${usage()}\n`);
      return;
    }
    throw cliError("cli.invalid_command", "Choose the task, Balanced, or Overnight command group.");
  }
  const command = argv[1];
  if (!command || command === "help" || command === "--help") {
    await writeStream(process.stdout, `${usage()}\n`);
    return;
  }
  const options = parseOptions(argv.slice(2));
  if (argv[0] === "task") {
    await writeStream(process.stdout, `${JSON.stringify(await runTaskCommand(command, options), null, 2)}\n`);
    return;
  }
  if (argv[0] === "overnight") {
    await writeStream(process.stdout, `${JSON.stringify(await runOvernightCommand(command, options), null, 2)}\n`);
    return;
  }
  const runtime = createBalancedRuntime({ protocolProvider: runtimeProtocolProvider });
  let result;
  if (command === "run") {
    requireAllowedOptions(options, new Set(["workspace", "task-id", "preflight-id"]));
    const bound = await loadExecutionReceipt("balanced", options);
    const envelope = bound.receipt.runtimeEnvelope;
    result = await runtime.run({
      task: bound.revisionArtifact.task,
      worktree: envelope.worktree,
      adapterId: envelope.adapterId,
      activationId: bound.active.activationId,
      effectiveSkillSha256: bound.active.effectiveSkillSha256,
      projectBinding: bound.active.projectBinding,
      policyRef: envelope.policyRef,
      budget: envelope.budget,
      timing: envelope.timing,
      runtimeEnvironment: envelope.runtimeEnvironment,
      preflightReceipt: bound.receipt,
      onRunCreated: ({ metadata }) => bound.store.recordSubmission({
        projectRoot: options.workspace,
        taskId: options["task-id"],
        preflightId: options["preflight-id"],
        runId: metadata.runId,
      }),
    });
    result = {
      state: result.review.roundStatus,
      runDirectory: result.runDirectory,
      reviewPath: result.reviewPath,
      reviewSha256: result.reviewSha256,
    };
  } else if (command === "review") {
    requireAllowedOptions(options, new Set(["run", "decision", "workspace", "task-id", "delta"]));
    if (!options.run) throw new BalancedRuntimeError("cli.missing_argument", "--run is required.");
    if (!options.decision) {
      throw new BalancedRuntimeError("cli.missing_argument", "--decision is required.");
    }
    const revision = options.decision === "revise"
      ? await prepareRevision("balanced", options, await runtime.status(options.run))
      : null;
    result = await runtime.review({
      runDirectory: options.run,
      decision: options.decision,
      revision: revision ? {
        task: revision.revisionArtifact.task,
        revisionDelta: revision.revisionDelta,
        preflightReceipt: revision.receipt,
      } : undefined,
      onRevisionCreated: revision ? ({ metadata }) => revision.store.recordSubmission({
        projectRoot: options.workspace,
        taskId: revision.taskId,
        preflightId: revision.receipt.preflightId,
        runId: metadata.runId,
      }) : undefined,
    });
    result = result.review
      ? {
          state: result.review.roundStatus,
          runDirectory: result.runDirectory,
          reviewPath: result.reviewPath,
          reviewSha256: result.reviewSha256,
        }
      : {
          state: result.state,
          runDirectory: result.runDirectory,
          decisionPath: result.decisionPath,
        };
  } else if (command === "status") {
    requireAllowedOptions(options, new Set(["run"]));
    if (!options.run) throw new BalancedRuntimeError("cli.missing_argument", "--run is required.");
    result = await runtime.status(options.run);
  } else if (command === "list") {
    if (Object.keys(options).length > 0) {
      throw new BalancedRuntimeError("cli.invalid_argument", "The list command accepts no options.");
    }
    result = { runs: await runtime.listRuns() };
  } else {
    throw new BalancedRuntimeError("cli.invalid_command", `Unknown Balanced command '${command}'.`);
  }
  await writeStream(process.stdout, `${JSON.stringify(result, null, 2)}\n`);
}

main(process.argv.slice(2)).catch(async (error) => {
  const payload = {
    error:
      error instanceof BalancedRuntimeError ||
      error instanceof OvernightRuntimeError ||
      error instanceof TaskCardError ||
      error instanceof ProjectConfigError ||
      error instanceof WorkspaceTaskStoreError
        ? error.code
        : "runtime.unexpected",
    message: error.message,
    ...(error.details ? { details: error.details } : {}),
  };
  await writeStream(process.stderr, `${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode =
    error instanceof BalancedRuntimeError ||
    error instanceof OvernightRuntimeError ||
    error instanceof TaskCardError ||
    error instanceof ProjectConfigError ||
    error instanceof WorkspaceTaskStoreError
      ? 2
      : 1;
});
