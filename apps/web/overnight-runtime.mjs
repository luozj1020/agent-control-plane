import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, parse, resolve, sep } from "node:path";

import { createBuiltInAdapterRegistry } from "./agent-adapters.mjs";
import { snapshotWorktree } from "./balanced-runtime.mjs";
import { normalizeRuntimeEnvironment } from "./runtime-environment.mjs";
import {
  createNextCycleTemplate,
  taskAllowsNoChanges,
  taskValidationCommands,
  validateTaskCard,
} from "./task-card.mjs";
import { createWakeAdapterRegistry } from "./wake-adapters.mjs";

const RUNTIME_SCHEMA_VERSION = 1;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,159}$/;
const STRATEGIES = new Set(["convergent", "continuous-improvement"]);
const TERMINAL_STATES = new Set([
  "accepted",
  "stopped",
  "interrupted",
]);

export class OvernightRuntimeError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = "OvernightRuntimeError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, stableJson(value), { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function readJson(path, { missing = null, code = "runtime.corrupt_json" } = {}) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return missing;
    throw new OvernightRuntimeError(code, `Cannot read valid JSON from ${path}.`, 409);
  }
}

async function appendEvent(runDirectory, clock, type, detail = {}) {
  await appendFile(
    join(runDirectory, "monitor-events.jsonl"),
    `${JSON.stringify({ schemaVersion: 1, recordedAt: new Date(clock()).toISOString(), type, ...detail })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

async function ensureDirectory(path, label, { create = false } = {}) {
  if (!isAbsolute(path) || resolve(path) === parse(resolve(path)).root) {
    throw new OvernightRuntimeError("runtime.unsafe_path", `${label} must be a non-root absolute path.`);
  }
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new OvernightRuntimeError("runtime.path_missing", `${label} does not exist.`, 404);
    }
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new OvernightRuntimeError("runtime.unsafe_path", `${label} must be a real directory.`);
  }
  return realpath(path);
}

async function existingRoot(path) {
  try {
    return await ensureDirectory(resolve(path), "Overnight runtime root");
  } catch (error) {
    if (error instanceof OvernightRuntimeError && error.code === "runtime.path_missing") return null;
    throw error;
  }
}

function changedPaths(before, after) {
  const paths = new Set([...before.files.keys(), ...after.files.keys()]);
  return [...paths].filter((path) => before.files.get(path) !== after.files.get(path)).sort();
}

function globExpression(pattern) {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const wildcard = /[*?]/.test(normalized);
  let expression = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*" && normalized[index + 1] === "*") {
      expression += ".*";
      index += 1;
    } else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${expression}${wildcard ? "" : "(?:/.*)?"}$`);
}

function reviewProjection(task, before, after) {
  const allowed = task.scope.write_paths.map(globExpression);
  const forbidden = (task.scope.forbidden_paths ?? []).map(globExpression);
  const entries = changedPaths(before, after).map((path) => ({
    path,
    beforeSha256: before.files.get(path) ?? null,
    afterSha256: after.files.get(path) ?? null,
    classification: forbidden.some((pattern) => pattern.test(path))
      ? "forbidden"
      : allowed.some((pattern) => pattern.test(path))
        ? "allowed"
        : "out-of-scope",
  }));
  return {
    granularity: "file",
    coverage: "complete",
    entries,
    violations: entries.filter((entry) => entry.classification !== "allowed").map((entry) => entry.path),
  };
}

function execFileResult(command, args, options) {
  return new Promise((resolveResult) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      resolveResult({
        command: [command, ...args],
        exitCode: error?.code && Number.isInteger(error.code) ? error.code : error ? 1 : 0,
        signal: error?.signal ?? null,
        timedOut: error?.killed === true,
        stdout: String(stdout ?? "").slice(-32_768),
        stderr: String(stderr ?? "").slice(-32_768),
      });
    });
  });
}

async function runValidation(task, worktree, timeoutMs) {
  const results = [];
  for (const [command, ...args] of taskValidationCommands(task)) {
    const result = await execFileResult(command, args, {
      cwd: worktree,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: timeoutMs,
      windowsHide: true,
    });
    results.push(result);
    if (result.exitCode !== 0) break;
  }
  return { status: results.every((entry) => entry.exitCode === 0) ? "passed" : "failed", results };
}

function setContainsAll(container, required) {
  const values = new Set(container);
  return required.every((value) => values.has(value));
}

function objectSetContainsAll(container, required) {
  const values = new Set(container.map((value) => JSON.stringify(value)));
  return required.every((value) => values.has(JSON.stringify(value)));
}

function riskDoesNotDecrease(previous, candidate) {
  const severity = { no: 0, unknown: 1, yes: 2 };
  return Object.entries(previous).every(
    ([key, value]) => severity[candidate[key] ?? "unknown"] >= severity[value],
  );
}

export function validateConvergentRevision(previous, candidateInput) {
  previous = validateTaskCard(previous);
  const candidate = validateTaskCard(candidateInput);
  if (
    candidate.goal !== previous.goal ||
    candidate.mode !== previous.mode ||
    JSON.stringify(candidate.profiles) !== JSON.stringify(previous.profiles)
  ) {
    throw new OvernightRuntimeError("revision.expanded", "A convergent revision must preserve goal, mode, and profiles.", 409);
  }
  if (!objectSetContainsAll(previous.acceptance, candidate.acceptance)) {
    throw new OvernightRuntimeError("revision.expanded", "A convergent revision may only narrow acceptance criteria.", 409);
  }
  if (!setContainsAll(previous.scope.write_paths, candidate.scope.write_paths)) {
    throw new OvernightRuntimeError("revision.expanded", "A convergent revision may not add allowed paths.", 409);
  }
  if (!setContainsAll(previous.scope.read_paths ?? [], candidate.scope.read_paths ?? [])) {
    throw new OvernightRuntimeError("revision.expanded", "A convergent revision may not add read paths.", 409);
  }
  if (!setContainsAll(candidate.scope.forbidden_paths ?? [], previous.scope.forbidden_paths ?? [])) {
    throw new OvernightRuntimeError("revision.expanded", "A convergent revision may not relax forbidden paths.", 409);
  }
  if (!objectSetContainsAll(previous.validation, candidate.validation)) {
    throw new OvernightRuntimeError("revision.expanded", "A convergent revision may not add validation commands.", 409);
  }
  if (
    !setContainsAll(candidate.handoff.must_not_do ?? [], previous.handoff.must_not_do ?? []) ||
    !setContainsAll(candidate.stop_conditions, previous.stop_conditions) ||
    !setContainsAll(previous.handoff.may_decide ?? [], candidate.handoff.may_decide ?? []) ||
    !riskDoesNotDecrease(previous.risk, candidate.risk) ||
    (!taskAllowsNoChanges(previous) && taskAllowsNoChanges(candidate))
  ) {
    throw new OvernightRuntimeError("revision.expanded", "A convergent revision may not relax authority, stop, or risk boundaries.", 409);
  }
  return candidate;
}

export function validateImprovementContinuation(initial, previous, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new OvernightRuntimeError("continuation.invalid", "A next-cycle contract is required.");
  }
  initial = validateTaskCard(initial);
  previous = validateTaskCard(previous);
  const expectedGain = input.expected_gain ?? input.expectedGain;
  const rollbackBoundary = input.rollback_boundary ?? input.rollbackBoundary;
  for (const [key, value] of [
    ["rationale", input.rationale],
    ["expected_gain", expectedGain],
    ["rollback_boundary", rollbackBoundary],
  ]) {
    if (typeof value !== "string" || !value.trim() || value.length > 16_384) {
      throw new OvernightRuntimeError("continuation.invalid", `${key} is required for scope expansion.`);
    }
  }
  const task = validateTaskCard(input.task);
  if (!objectSetContainsAll(task.acceptance, initial.acceptance)) {
    throw new OvernightRuntimeError("continuation.metric_floor_removed", "The original acceptance floor must remain in every improvement cycle.", 409);
  }
  if (!setContainsAll(task.scope.forbidden_paths ?? [], initial.scope.forbidden_paths ?? [])) {
    throw new OvernightRuntimeError("continuation.authority_expanded", "Original forbidden boundaries cannot be relaxed.", 409);
  }
  if (
    task.goal !== initial.goal ||
    task.mode !== initial.mode ||
    JSON.stringify(task.profiles) !== JSON.stringify(initial.profiles) ||
    !setContainsAll(initial.scope.read_paths ?? [], task.scope.read_paths ?? []) ||
    !objectSetContainsAll(task.validation, initial.validation) ||
    !setContainsAll(task.handoff.must_not_do ?? [], initial.handoff.must_not_do ?? []) ||
    !setContainsAll(initial.handoff.may_decide ?? [], task.handoff.may_decide ?? []) ||
    !setContainsAll(task.stop_conditions, initial.stop_conditions) ||
    !riskDoesNotDecrease(initial.risk, task.risk)
  ) {
    throw new OvernightRuntimeError("continuation.authority_expanded", "Original goal, authority, stop, and risk boundaries must remain.", 409);
  }
  const previousPaths = new Set(previous.scope.write_paths);
  const additions = task.scope.write_paths.filter((path) => !previousPaths.has(path)).sort();
  const declared = [...new Set(input.added_paths ?? input.addedPaths ?? [])].sort();
  if (additions.length !== declared.length || additions.some((path, index) => path !== declared[index])) {
    throw new OvernightRuntimeError("continuation.expansion_mismatch", "added_paths must exactly declare the new write paths.", 409);
  }
  return Object.freeze({
    rationale: input.rationale.trim(),
    expected_gain: expectedGain.trim(),
    rollback_boundary: rollbackBoundary.trim(),
    added_paths: Object.freeze(declared),
    task,
  });
}

function buildPrompt(task, { cycle, strategy, priorWakeSha256 }) {
  return [
    "You are the downstream Builder in a durable Overnight workflow.",
    "Implement only the frozen JSON contract in the current worktree, then exit.",
    "Never edit forbidden or out-of-scope paths. Report assumptions, changes, validation, and risks.",
    `Strategy: ${strategy}; cycle: ${cycle}.`,
    priorWakeSha256 ? `This cycle follows reviewed wake request ${priorWakeSha256}.` : "This is the initial cycle.",
    "",
    JSON.stringify(task, null, 2),
  ].join("\n");
}

async function withRunLock(runDirectory, operation) {
  const lockPath = join(runDirectory, "run.lock");
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(stableJson({ pid: process.pid, acquiredAt: new Date().toISOString() }));
  } catch (error) {
    await handle?.close();
    if (error?.code === "EEXIST") {
      throw new OvernightRuntimeError("runtime.locked", "Another process owns this Overnight run.", 409);
    }
    throw error;
  }
  try {
    return await operation();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

export function createOvernightRuntime(options = {}) {
  const adapters = options.adapters ?? createBuiltInAdapterRegistry();
  const wakeAdapters = options.wakeAdapters ?? createWakeAdapterRegistry();
  const runtimeRootConfigured = resolve(
    options.runtimeRoot ??
      process.env.AGENT_CONTROL_OVERNIGHT_RUNS_DIR ??
      join(homedir(), ".agent-control-plane", "overnight-runs"),
  );
  const clock = options.clock ?? (() => Date.now());
  const snapshot = options.snapshotWorktree ?? snapshotWorktree;
  const pollMilliseconds = options.pollMilliseconds ?? 1000;
  const executionEpochMilliseconds = options.executionEpochMilliseconds ?? 6 * 60 * 60 * 1000;
  const validationTimeoutMilliseconds = options.validationTimeoutMilliseconds ?? 15 * 60 * 1000;

  async function persistMetadata(runDirectory, metadata, state = metadata.state) {
    metadata.state = state;
    metadata.updatedAt = new Date(clock()).toISOString();
    await writeJsonAtomic(join(runDirectory, "run.json"), metadata);
    await appendEvent(runDirectory, clock, "state-transition", { state, cycle: metadata.cycle });
  }

  async function createRun(input) {
    if (!input || typeof input.worktree !== "string" || !input.worktree.trim()) {
      throw new OvernightRuntimeError("runtime.invalid_input", "An absolute worktree path is required.");
    }
    if (!STRATEGIES.has(input.strategy)) {
      throw new OvernightRuntimeError("runtime.invalid_strategy", "Strategy must be convergent or continuous-improvement.");
    }
    const worktree = await ensureDirectory(resolve(input.worktree), "Worktree");
    const runtimeRoot = await ensureDirectory(runtimeRootConfigured, "Overnight runtime root", { create: true });
    if (runtimeRoot === worktree || runtimeRoot.startsWith(`${worktree}${sep}`)) {
      throw new OvernightRuntimeError("runtime.unsafe_root", "Overnight artifacts cannot be stored inside the product worktree.");
    }
    const task = validateTaskCard(input.task);
    const adapter = adapters.get(input.adapterId);
    if (!adapter) throw new OvernightRuntimeError("runtime.adapter_unknown", `Unknown adapter '${input.adapterId}'.`);
    const wakeAdapter = wakeAdapters.get(input.wakeAdapterId ?? "durable-file");
    if (!wakeAdapter) {
      throw new OvernightRuntimeError("runtime.wake_adapter_unknown", `Unknown wake adapter '${input.wakeAdapterId}'.`);
    }
    const runtimeEnvironment = normalizeRuntimeEnvironment(input.runtimeEnvironment);
    const runId = `${new Date(clock()).toISOString().replace(/[:.]/g, "-").toLowerCase()}-${task.id.slice(0, 64)}-${randomUUID()}`;
    const runDirectory = join(runtimeRoot, runId);
    const cycleDirectory = join(runDirectory, "cycles", "001");
    await mkdir(cycleDirectory, { recursive: true, mode: 0o700 });
    const taskEnvelope = { schemaVersion: 1, kind: "overnight-task", cycle: 1, task };
    const taskText = stableJson(taskEnvelope);
    await writeFile(join(cycleDirectory, "task.json"), taskText, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const metadata = {
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      runId,
      state: "submitted",
      strategy: input.strategy,
      taskId: task.id,
      initialTaskSha256: sha256(taskText),
      currentTaskSha256: sha256(taskText),
      worktree,
      adapterId: adapter.id,
      runtimeEnvironment,
      wakeAdapterId: wakeAdapter.id,
      cycle: 1,
      sessionId: null,
      activeProcess: null,
      latestWakePath: null,
      latestWakeSha256: null,
      createdAt: new Date(clock()).toISOString(),
      updatedAt: new Date(clock()).toISOString(),
    };
    await writeJsonAtomic(join(runDirectory, "run.json"), metadata);
    await appendEvent(runDirectory, clock, "run-submitted", { strategy: input.strategy, cycle: 1 });
    return { runDirectory, metadata };
  }

  async function loadRun(runDirectoryInput) {
    const root = await existingRoot(runtimeRootConfigured);
    if (!root) throw new OvernightRuntimeError("runtime.path_missing", "Overnight runtime root does not exist.", 404);
    const runDirectory = await ensureDirectory(resolve(runDirectoryInput), "Run directory");
    const metadata = await readJson(join(runDirectory, "run.json"));
    if (!metadata || metadata.schemaVersion !== RUNTIME_SCHEMA_VERSION || !SAFE_ID.test(metadata.runId ?? "")) {
      throw new OvernightRuntimeError("runtime.corrupt_run", "Overnight run metadata is invalid.", 409);
    }
    if (basename(runDirectory) !== metadata.runId || resolve(root, metadata.runId) !== runDirectory) {
      throw new OvernightRuntimeError("runtime.unsafe_path", "Run identity does not match the configured runtime root.", 409);
    }
    const cycleDirectory = join(runDirectory, "cycles", String(metadata.cycle).padStart(3, "0"));
    const taskText = await readFile(join(cycleDirectory, "task.json"), "utf8").catch(() => null);
    if (!taskText || sha256(taskText) !== metadata.currentTaskSha256) {
      throw new OvernightRuntimeError("runtime.corrupt_run", "Current Overnight task hash is invalid.", 409);
    }
    const task = validateTaskCard(JSON.parse(taskText).task);
    const initialText = await readFile(join(runDirectory, "cycles", "001", "task.json"), "utf8").catch(() => null);
    if (!initialText || sha256(initialText) !== metadata.initialTaskSha256) {
      throw new OvernightRuntimeError("runtime.corrupt_run", "Initial Overnight task hash is invalid.", 409);
    }
    const initialTask = validateTaskCard(JSON.parse(initialText).task);
    const adapter = adapters.get(metadata.adapterId);
    if (!adapter) throw new OvernightRuntimeError("runtime.adapter_unknown", `Unknown adapter '${metadata.adapterId}'.`);
    const wakeAdapter = wakeAdapters.get(metadata.wakeAdapterId ?? "durable-file");
    if (!wakeAdapter) {
      throw new OvernightRuntimeError("runtime.wake_adapter_unknown", `Unknown wake adapter '${metadata.wakeAdapterId}'.`);
    }
    return { runDirectory, cycleDirectory, metadata, task, initialTask, adapter, wakeAdapter };
  }

  async function writeWake(loaded, evidence, state) {
    const { runDirectory, metadata } = loaded;
    const evidenceText = stableJson(evidence);
    const evidencePath = join(loaded.cycleDirectory, "evidence.json");
    await writeFile(evidencePath, evidenceText, { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (state === "interrupted") {
      await persistMetadata(runDirectory, metadata, state);
      await appendEvent(runDirectory, clock, "terminal-without-wake", {
        state,
        cycle: metadata.cycle,
        evidenceSha256: sha256(evidenceText),
      });
      return { wake: null, wakePath: null, wakeSha256: null, delivery: null };
    }
    const wake = {
      schemaVersion: 1,
      kind: "overnight-wake-request",
      runId: metadata.runId,
      cycle: metadata.cycle,
      strategy: metadata.strategy,
      state,
      taskSha256: metadata.currentTaskSha256,
      evidencePath,
      evidenceSha256: sha256(evidenceText),
      allowedDecisions:
        state === "improvement_cycle_ready"
          ? ["continue", "revise", "stop"]
          : state === "revision_pending"
            ? ["accept", "revise", "stop"]
            : ["stop"],
      requestedAt: new Date(clock()).toISOString(),
    };
    const wakeText = stableJson(wake);
    const wakePath = join(runDirectory, "wake-request.json");
    await writeJsonAtomic(wakePath, wake);
    metadata.latestWakePath = wakePath;
    metadata.latestWakeSha256 = sha256(wakeText);
    await persistMetadata(runDirectory, metadata, state);
    await appendEvent(runDirectory, clock, "wake-requested", {
      state,
      cycle: metadata.cycle,
      wakeSha256: metadata.latestWakeSha256,
      evidenceSha256: wake.evidenceSha256,
    });
    let delivery;
    try {
      delivery = await loaded.wakeAdapter.deliver({
        runId: metadata.runId,
        cycle: metadata.cycle,
        strategy: metadata.strategy,
        state,
        worktree: metadata.worktree,
        wakePath,
        wakeId: metadata.latestWakeSha256,
      });
    } catch (error) {
      delivery = {
        status: "failed",
        wakeId: metadata.latestWakeSha256,
        transport: loaded.wakeAdapter.id,
        error: error.message,
      };
    }
    const deliveryReceipt = {
      schemaVersion: 1,
      adapterId: loaded.wakeAdapter.id,
      ...delivery,
      recordedAt: new Date(clock()).toISOString(),
    };
    await writeJsonAtomic(join(runDirectory, "wake-delivery.json"), deliveryReceipt);
    metadata.wakeDelivery = deliveryReceipt;
    metadata.updatedAt = new Date(clock()).toISOString();
    await writeJsonAtomic(join(runDirectory, "run.json"), metadata);
    await appendEvent(runDirectory, clock, "wake-delivery-recorded", {
      cycle: metadata.cycle,
      adapterId: loaded.wakeAdapter.id,
      status: deliveryReceipt.status,
      wakeSha256: metadata.latestWakeSha256,
    });
    return { wake, wakePath, wakeSha256: metadata.latestWakeSha256, delivery: deliveryReceipt };
  }

  async function executeCycle(runDirectoryInput) {
    const loaded = await loadRun(runDirectoryInput);
    return withRunLock(loaded.runDirectory, async () => {
      const current = await loadRun(loaded.runDirectory);
      const { runDirectory, cycleDirectory, metadata, task, adapter } = current;
      if (metadata.state !== "submitted") {
        throw new OvernightRuntimeError("runtime.invalid_state", `Cannot supervise a run in '${metadata.state}'.`, 409);
      }
      await persistMetadata(runDirectory, metadata, "running");
      const baseline = await snapshot(metadata.worktree);
      const baselineRecord = { digest: baseline.digest, fileCount: baseline.fileCount, totalBytes: baseline.totalBytes };
      await writeJsonAtomic(join(cycleDirectory, "baseline.json"), baselineRecord);
      let interrupted = false;
      let timedOut = false;
      const events = [];
      const eventWrites = [];
      const controller = await adapter.start({
        worktree: metadata.worktree,
        prompt: buildPrompt(task, {
          cycle: metadata.cycle,
          strategy: metadata.strategy,
          priorWakeSha256: metadata.cycle > 1 ? metadata.latestWakeSha256 : null,
        }),
        resumeSessionId: metadata.sessionId,
        stdoutPath: join(cycleDirectory, "downstream.stdout.jsonl"),
        stderrPath: join(cycleDirectory, "downstream.stderr.log"),
        terminationGraceMs: 5000,
        runtimeEnvironment: metadata.runtimeEnvironment,
        onEvent(event) {
          const recorded = { at: new Date(clock()).toISOString(), ...event };
          events.push(recorded);
          eventWrites.push(
            appendEvent(runDirectory, clock, "adapter-activity", {
              cycle: metadata.cycle,
              activity: recorded,
            }),
          );
        },
      });
      metadata.activeProcess = controller.identity ?? { pid: controller.pid ?? null };
      await writeJsonAtomic(join(runDirectory, "run.json"), metadata);
      await appendEvent(runDirectory, clock, "process-started", { cycle: metadata.cycle, identity: metadata.activeProcess });
      const startedAt = clock();
      let adapterResult;
      while (!adapterResult) {
        const result = await Promise.race([controller.result, wait(pollMilliseconds).then(() => null)]);
        if (result) {
          adapterResult = result;
          break;
        }
        if (await readJson(join(runDirectory, "interrupt-request.json"), { missing: null })) {
          interrupted = true;
          await controller.terminate();
          adapterResult = await controller.result;
          break;
        }
        if (clock() - startedAt >= executionEpochMilliseconds) {
          timedOut = true;
          await controller.terminate();
          adapterResult = await controller.result;
          break;
        }
      }
      metadata.sessionId = adapterResult.sessionId ?? controller.sessionId?.() ?? metadata.sessionId;
      metadata.activeProcess = null;
      await Promise.all(eventWrites);
      await appendEvent(runDirectory, clock, "process-exited", {
        cycle: metadata.cycle,
        exitCode: adapterResult.exitCode,
        signal: adapterResult.signal,
        interrupted,
        timedOut,
      });
      const after = await snapshot(metadata.worktree);
      const projection = reviewProjection(task, baseline, after);
      const validation = await runValidation(task, metadata.worktree, validationTimeoutMilliseconds);
      const evidence = {
        schemaVersion: 1,
        kind: "overnight-cycle-evidence",
        runId: metadata.runId,
        cycle: metadata.cycle,
        strategy: metadata.strategy,
        taskSha256: metadata.currentTaskSha256,
        baseline: baselineRecord,
        after: { digest: after.digest, fileCount: after.fileCount, totalBytes: after.totalBytes },
        process: adapterResult,
        activity: events,
        reviewProjection: projection,
        validation,
        recordedAt: new Date(clock()).toISOString(),
      };
      let state;
      if (interrupted) state = "interrupted";
      else if (
        timedOut ||
        adapterResult.exitCode !== 0 ||
        adapterResult.error ||
        adapterResult.failureCategory
      ) state = "runtime_blocked";
      else if (projection.violations.length > 0) state = "scope_violation";
      else if (validation.status !== "passed") state = "validation_failed";
      else if (projection.entries.length === 0 && !taskAllowsNoChanges(task)) state = "revision_pending";
      else state = metadata.strategy === "convergent" ? "revision_pending" : "improvement_cycle_ready";
      metadata.latestFailureCategory = adapterResult.failureCategory ?? null;
      metadata.latestRuntimeDiagnostics = adapterResult.diagnostics ?? null;
      return { runDirectory, state, ...(await writeWake(current, evidence, state)) };
    });
  }

  async function review(input) {
    const loaded = await loadRun(input.runDirectory);
    return withRunLock(loaded.runDirectory, async () => {
      const current = await loadRun(loaded.runDirectory);
      const { runDirectory, metadata } = current;
      const wakeText = await readFile(join(runDirectory, "wake-request.json"), "utf8").catch(() => null);
      if (!wakeText || sha256(wakeText) !== metadata.latestWakeSha256) {
        throw new OvernightRuntimeError("review.stale_wake", "The current wake request is missing or stale.", 409);
      }
      const wake = JSON.parse(wakeText);
      if (wake.state !== metadata.state || wake.cycle !== metadata.cycle) {
        throw new OvernightRuntimeError("review.stale_wake", "The wake request no longer matches the current run state.", 409);
      }
      if (!wake.allowedDecisions.includes(input.decision)) {
        throw new OvernightRuntimeError("review.invalid_decision", `Decision '${input.decision}' is not allowed in '${metadata.state}'.`, 409);
      }
      if (input.decision === "accept" || input.decision === "stop") {
        const state = input.decision === "accept" ? "accepted" : "stopped";
        const decision = {
          schemaVersion: 1,
          decision: input.decision,
          wakeSha256: metadata.latestWakeSha256,
          decidedAt: new Date(clock()).toISOString(),
        };
        await writeJsonAtomic(join(current.cycleDirectory, "review-decision.json"), decision);
        await persistMetadata(runDirectory, metadata, state);
        return { runDirectory, state, resumeRequired: false };
      }
      let nextTask;
      let continuation = null;
      if (input.decision === "revise") {
        nextTask = validateConvergentRevision(current.task, input.revisionTask);
      } else {
        if (metadata.strategy !== "continuous-improvement") {
          throw new OvernightRuntimeError("review.invalid_decision", "Only continuous improvement may continue with expanded scope.", 409);
        }
        continuation = validateImprovementContinuation(current.initialTask, current.task, input.continuation);
        nextTask = continuation.task;
      }
      const nextCycle = metadata.cycle + 1;
      const nextDirectory = join(runDirectory, "cycles", String(nextCycle).padStart(3, "0"));
      await mkdir(nextDirectory, { recursive: true, mode: 0o700 });
      const envelope = {
        schemaVersion: 1,
        kind: "overnight-task",
        cycle: nextCycle,
        task: nextTask,
        priorWakeSha256: metadata.latestWakeSha256,
        ...(continuation ? { improvement: continuation } : {}),
      };
      const taskText = stableJson(envelope);
      await writeFile(join(nextDirectory, "task.json"), taskText, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await writeJsonAtomic(join(current.cycleDirectory, "review-decision.json"), {
        schemaVersion: 1,
        decision: input.decision,
        nextCycle,
        nextTaskSha256: sha256(taskText),
        wakeSha256: metadata.latestWakeSha256,
        decidedAt: new Date(clock()).toISOString(),
      });
      metadata.cycle = nextCycle;
      metadata.currentTaskSha256 = sha256(taskText);
      await persistMetadata(runDirectory, metadata, "submitted");
      return { runDirectory, state: "submitted", cycle: nextCycle, resumeRequired: true };
    });
  }

  async function interrupt(runDirectoryInput) {
    const loaded = await loadRun(runDirectoryInput);
    if (TERMINAL_STATES.has(loaded.metadata.state)) {
      return { runDirectory: loaded.runDirectory, state: loaded.metadata.state, alreadyTerminal: true };
    }
    await writeJsonAtomic(join(loaded.runDirectory, "interrupt-request.json"), {
      schemaVersion: 1,
      requestedAt: new Date(clock()).toISOString(),
      requestedForCycle: loaded.metadata.cycle,
    });
    await appendEvent(loaded.runDirectory, clock, "interrupt-requested", { cycle: loaded.metadata.cycle });
    if (loaded.metadata.state !== "running") {
      try {
        await withRunLock(loaded.runDirectory, async () => {
          const current = await loadRun(loaded.runDirectory);
          await persistMetadata(current.runDirectory, current.metadata, "interrupted");
        });
        return { runDirectory: loaded.runDirectory, state: "interrupted" };
      } catch (error) {
        if (error instanceof OvernightRuntimeError && error.code === "runtime.locked") {
          return { runDirectory: loaded.runDirectory, state: "interrupt_requested" };
        }
        throw error;
      }
    }
    return { runDirectory: loaded.runDirectory, state: "interrupt_requested" };
  }

  async function interruptById(runId) {
    if (!SAFE_ID.test(runId ?? "")) {
      throw new OvernightRuntimeError("runtime.unsafe_path", "Run id is invalid.");
    }
    const root = await existingRoot(runtimeRootConfigured);
    if (!root) throw new OvernightRuntimeError("runtime.path_missing", "Overnight runtime root does not exist.", 404);
    return interrupt(join(root, runId));
  }

  async function status(runDirectory) {
    return (await loadRun(runDirectory)).metadata;
  }

  async function nextTemplate(runDirectory) {
    return createNextCycleTemplate((await loadRun(runDirectory)).task);
  }

  async function listRuns() {
    const root = await existingRoot(runtimeRootConfigured);
    if (!root) return [];
    const runs = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
      try {
        const metadata = await readJson(join(root, entry.name, "run.json"));
        if (metadata?.schemaVersion === RUNTIME_SCHEMA_VERSION) runs.push(metadata);
      } catch {
        // One corrupt run must not hide healthy run history.
      }
    }
    return runs.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  return Object.freeze({
    createRun,
    executeCycle,
    interrupt,
    interruptById,
    listRuns,
    nextTemplate,
    review,
    status,
  });
}
