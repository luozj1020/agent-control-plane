#!/usr/bin/env node

import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { BalancedRuntimeError, createBalancedRuntime } from "./balanced-runtime.mjs";

function parseOptions(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token.startsWith("--") || token.length === 2) {
      throw new BalancedRuntimeError("cli.invalid_argument", `Unexpected argument '${token}'.`);
    }
    const key = token.slice(2);
    const value = values[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new BalancedRuntimeError("cli.invalid_argument", `Option '--${key}' requires a value.`);
    }
    if (options[key] !== undefined) {
      throw new BalancedRuntimeError("cli.invalid_argument", `Option '--${key}' was repeated.`);
    }
    options[key] = value;
    index += 1;
  }
  return options;
}

function integerOption(options, name) {
  if (options[name] === undefined) return undefined;
  if (!/^(0|[1-9]\d*)$/.test(options[name])) {
    throw new BalancedRuntimeError("cli.invalid_argument", `--${name} must be a non-negative integer.`);
  }
  return Number(options[name]);
}

function requireAllowedOptions(options, allowed) {
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) {
      throw new BalancedRuntimeError("cli.invalid_argument", `Unknown option '--${key}'.`);
    }
  }
}

async function readTask(path, label) {
  if (!path) throw new BalancedRuntimeError("cli.missing_argument", `${label} path is required.`);
  const absolute = resolve(path);
  const metadata = await lstat(absolute).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new BalancedRuntimeError("cli.file_missing", `${label} file does not exist.`);
    }
    throw error;
  });
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > 128 * 1024) {
    throw new BalancedRuntimeError("cli.unsafe_file", `${label} must be a regular JSON file under 128 KiB.`);
  }
  try {
    return JSON.parse(await readFile(absolute, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new BalancedRuntimeError("cli.invalid_json", `${label} is not valid JSON.`);
    }
    throw error;
  }
}

function usage() {
  return [
    "Agent Control Plane Balanced Runner",
    "",
    "Commands:",
    "  agent-control-plane balanced run --task TASK.json --worktree PATH --adapter ID [budget options]",
    "  agent-control-plane balanced review --run RUN_DIR --decision accept|revise|stop [--revision TASK.json]",
    "  agent-control-plane balanced status --run RUN_DIR",
    "  agent-control-plane balanced list",
    "",
    "Budget options:",
    "  --main-review-calls N --downstream-calls N --advisor-calls N",
    "  --reserved-final-review-calls N --max-total-tokens N",
  ].join("\n");
}

async function main(argv) {
  if (argv[0] !== "balanced") {
    if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help") {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    throw new BalancedRuntimeError("cli.invalid_command", "Only the Balanced runtime is currently executable.");
  }
  const command = argv[1];
  if (!command || command === "help" || command === "--help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const options = parseOptions(argv.slice(2));
  const runtime = createBalancedRuntime();
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
      "max-total-tokens",
    ]));
    if (!options.worktree || !options.adapter) {
      throw new BalancedRuntimeError(
        "cli.missing_argument",
        "--worktree and --adapter are required.",
      );
    }
    result = await runtime.run({
      task: await readTask(options.task, "Task"),
      worktree: options.worktree,
      adapterId: options.adapter,
      policyRef: options.policy ?? "balanced-default@1.0.0",
      budget: {
        mainReviewCalls: integerOption(options, "main-review-calls"),
        downstreamCalls: integerOption(options, "downstream-calls"),
        advisorCalls: integerOption(options, "advisor-calls"),
        reservedFinalReviewCalls: integerOption(options, "reserved-final-review-calls"),
        maxTotalTokens: integerOption(options, "max-total-tokens"),
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
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main(process.argv.slice(2)).catch((error) => {
  const payload = {
    error: error instanceof BalancedRuntimeError ? error.code : "runtime.unexpected",
    message: error.message,
    ...(error.details ? { details: error.details } : {}),
  };
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = error instanceof BalancedRuntimeError ? 2 : 1;
});
