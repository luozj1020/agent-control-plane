#!/usr/bin/env node

import { spawn } from "node:child_process";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BalancedRuntimeError, createBalancedRuntime } from "./balanced-runtime.mjs";
import { OvernightRuntimeError, createOvernightRuntime } from "./overnight-runtime.mjs";
import { createWorkflowCoreAdapter } from "./workflow-core-adapter.mjs";
import { discoverRuntimeActivation } from "./runtime-activation.mjs";
import {
  TaskCardError,
  createTaskCardTemplate,
  normalizeTaskCard,
  renderTaskCardMarkdown,
} from "./task-card.mjs";

const CLI_PATH = fileURLToPath(import.meta.url);
const workflowCoreAdapter = createWorkflowCoreAdapter();
const runtimeProtocolProvider = (mode) => workflowCoreAdapter.runtimeProtocol(mode);

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
    "  agent-control-plane balanced run --task TASK.json --worktree PATH --adapter ID [budget/environment/activation options]",
    "  agent-control-plane balanced review --run RUN_DIR --decision accept|revise|stop [--revision TASK.json]",
    "  agent-control-plane balanced status --run RUN_DIR",
    "  agent-control-plane balanced list",
    "  agent-control-plane overnight submit --task TASK.json --worktree PATH --adapter ID --strategy convergent|continuous-improvement [--wake-adapter ID] [--activation-id ID --skill-sha256 HASH] [--execution-env auto|host|sandbox --proxy-mode direct|inherit]",
    "  agent-control-plane overnight review --run RUN_DIR --decision accept|revise|continue|stop [--revision TASK.json] [--next NEXT.json]",
    "  agent-control-plane overnight interrupt --run RUN_DIR",
    "  agent-control-plane overnight status --run RUN_DIR",
    "  agent-control-plane overnight list",
    "  agent-control-plane overnight next-init --run RUN_DIR [--output NEXT.json]",
    "  agent-control-plane task init [--output TASK.json]",
    "  agent-control-plane task validate --task TASK.json",
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
    requireAllowedOptions(options, new Set(["task"]));
    const normalized = normalizeTaskCard(await readTask(options.task, "Task Card"));
    return { valid: true, ...normalized };
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

async function runOvernightCommand(command, options) {
  const runtime = createOvernightRuntime({ protocolProvider: runtimeProtocolProvider });
  if (command === "submit") {
    requireAllowedOptions(options, new Set([
      "task", "worktree", "adapter", "strategy", "wake-adapter",
      "activation-id", "skill-sha256",
      "execution-env", "proxy-mode", "environment-isolation", "network-diagnostics",
    ]));
    if (!options.worktree || !options.adapter || !options.strategy) {
      throw cliError("cli.missing_argument", "--worktree, --adapter, and --strategy are required.");
    }
    const active = await discoverRuntimeActivation("overnight");
    const created = await runtime.createRun({
      task: await readTask(options.task, "Task"),
      worktree: options.worktree,
      adapterId: options.adapter,
      activationId: options["activation-id"] ?? active.activationId,
      effectiveSkillSha256: options["skill-sha256"] ?? active.effectiveSkillSha256,
      projectBinding: active.projectBinding,
      strategy: options.strategy,
      wakeAdapterId: options["wake-adapter"] ?? "durable-file",
      runtimeEnvironment: {
        executionEnvironment: options["execution-env"],
        proxyMode: options["proxy-mode"],
        isolationMode: options["environment-isolation"],
        networkDiagnostics: options["network-diagnostics"],
      },
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
    requireAllowedOptions(options, new Set(["run", "decision", "revision", "next"]));
    if (!options.run || !options.decision) {
      throw cliError("cli.missing_argument", "--run and --decision are required.");
    }
    const reviewed = await runtime.review({
      runDirectory: options.run,
      decision: options.decision,
      revisionTask:
        options.decision === "revise" ? await readTask(options.revision, "Revision") : undefined,
      continuation:
        options.decision === "continue" ? await readTask(options.next, "Next-cycle contract") : undefined,
    });
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
    requireAllowedOptions(options, new Set([
      "task",
      "worktree",
      "adapter",
      "policy",
      "main-review-calls",
      "downstream-calls",
      "advisor-calls",
      "reserved-final-review-calls",
      "context-seconds",
      "first-progress-seconds",
      "active-seconds",
      "extension-seconds",
      "growing-extension-seconds",
      "hard-cap-seconds",
      "execution-env",
      "proxy-mode",
      "environment-isolation",
      "network-diagnostics",
      "activation-id",
      "skill-sha256",
      // Accepted but ignored so previously activated Skills do not regain a Token cap.
      "max-total-tokens",
    ]));
    if (!options.worktree || !options.adapter) {
      throw new BalancedRuntimeError(
        "cli.missing_argument",
        "--worktree and --adapter are required.",
      );
    }
    if (options["max-total-tokens"] !== undefined) {
      integerOption(options, "max-total-tokens");
    }
    const active = await discoverRuntimeActivation("balanced");
    result = await runtime.run({
      task: await readTask(options.task, "Task"),
      worktree: options.worktree,
      adapterId: options.adapter,
      activationId: options["activation-id"] ?? active.activationId,
      effectiveSkillSha256: options["skill-sha256"] ?? active.effectiveSkillSha256,
      projectBinding: active.projectBinding,
      policyRef: options.policy ?? "balanced-default@1.0.0",
      budget: {
        mainReviewCalls: integerOption(options, "main-review-calls"),
        downstreamCalls: integerOption(options, "downstream-calls"),
        advisorCalls: integerOption(options, "advisor-calls"),
        reservedFinalReviewCalls: integerOption(options, "reserved-final-review-calls"),
      },
      timing: {
        contextAcquisitionSeconds: integerOption(options, "context-seconds"),
        firstProgressSeconds: integerOption(options, "first-progress-seconds"),
        activeWindowSeconds: integerOption(options, "active-seconds"),
        progressExtensionSeconds: integerOption(options, "extension-seconds"),
        growingProgressExtensionSeconds: integerOption(options, "growing-extension-seconds"),
        hardCapSeconds: integerOption(options, "hard-cap-seconds"),
      },
      runtimeEnvironment: {
        executionEnvironment: options["execution-env"],
        proxyMode: options["proxy-mode"],
        isolationMode: options["environment-isolation"],
        networkDiagnostics: options["network-diagnostics"],
      },
    });
    result = {
      state: result.review.roundStatus,
      runDirectory: result.runDirectory,
      reviewPath: result.reviewPath,
      reviewSha256: result.reviewSha256,
    };
  } else if (command === "review") {
    requireAllowedOptions(options, new Set(["run", "decision", "revision"]));
    if (!options.run) throw new BalancedRuntimeError("cli.missing_argument", "--run is required.");
    if (!options.decision) {
      throw new BalancedRuntimeError("cli.missing_argument", "--decision is required.");
    }
    result = await runtime.review({
      runDirectory: options.run,
      decision: options.decision,
      revisionTask:
        options.decision === "revise" ? await readTask(options.revision, "Revision") : undefined,
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
      error instanceof TaskCardError
        ? error.code
        : "runtime.unexpected",
    message: error.message,
    ...(error.details ? { details: error.details } : {}),
  };
  await writeStream(process.stderr, `${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode =
    error instanceof BalancedRuntimeError ||
    error instanceof OvernightRuntimeError ||
    error instanceof TaskCardError
      ? 2
      : 1;
});
