import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
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
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, parse, resolve, sep } from "node:path";

import { BUILTIN_MODE_CATALOG } from "../../packages/contracts/dist/index.js";
import { createBuiltInAdapterRegistry } from "./agent-adapters.mjs";

const RUNTIME_SCHEMA_VERSION = 1;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,159}$/;
const IGNORED_DIRECTORIES = new Set([".git", ".agent-control-plane", "node_modules"]);
const TASK_KEYS = new Set([
  "id",
  "objective",
  "acceptance",
  "allowedPaths",
  "forbiddenPaths",
  "validationCommands",
  "allowNoChanges",
]);

export class BalancedRuntimeError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = "BalancedRuntimeError";
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

async function readJson(path, code = "runtime.corrupt_json") {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new BalancedRuntimeError(code, `Cannot read valid JSON from ${path}.`, 409);
  }
}

async function appendJsonLine(path, value) {
  await appendFile(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
}

function ensurePositive(value, label, { zero = false } = {}) {
  if (!Number.isFinite(value) || value < (zero ? 0 : 0.001)) {
    throw new BalancedRuntimeError("runtime.invalid_policy", `${label} is invalid.`);
  }
  return value;
}

function validatePolicy(policy) {
  for (const key of [
    "contextAcquisitionSeconds",
    "activeWindowSeconds",
    "firstProgressSeconds",
    "progressExtensionSeconds",
    "growingProgressExtensionSeconds",
    "hardCapSeconds",
    "productIdleSeconds",
    "completionGraceSeconds",
    "tailSeconds",
    "advisorLeadSeconds",
    "advisorCallTimeoutSeconds",
    "pollSeconds",
  ]) {
    ensurePositive(policy[key], key);
  }
  ensurePositive(policy.noOutputSeconds, "noOutputSeconds", { zero: true });
  if (!Number.isSafeInteger(policy.productIdleConfirmations) || policy.productIdleConfirmations < 1) {
    throw new BalancedRuntimeError("runtime.invalid_policy", "productIdleConfirmations is invalid.");
  }
  if (policy.hardCapSeconds < policy.contextAcquisitionSeconds) {
    throw new BalancedRuntimeError(
      "runtime.invalid_policy",
      "Balanced hard cap cannot be shorter than context acquisition.",
    );
  }
  return policy;
}

function validateBudget(budget) {
  for (const [key, minimum] of [
    ["mainReviewCalls", 1],
    ["downstreamCalls", 1],
    ["advisorCalls", 0],
    ["reservedFinalReviewCalls", 0],
    ["maxTotalTokens", 0],
  ]) {
    if (!Number.isSafeInteger(budget[key]) || budget[key] < minimum) {
      throw new BalancedRuntimeError("runtime.invalid_budget", `${key} is invalid.`);
    }
  }
  if (budget.reservedFinalReviewCalls > budget.mainReviewCalls) {
    throw new BalancedRuntimeError(
      "runtime.invalid_budget",
      "Reserved final-review calls exceed the main-review budget.",
    );
  }
  return budget;
}

export function validateBalancedTask(task) {
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    throw new BalancedRuntimeError("task.invalid", "Balanced Task must be an object.");
  }
  for (const key of Object.keys(task)) {
    if (!TASK_KEYS.has(key)) {
      throw new BalancedRuntimeError("task.unknown_field", `Unknown Balanced Task field '${key}'.`);
    }
  }
  if (
    !SAFE_ID.test(task.id ?? "") ||
    typeof task.objective !== "string" ||
    !task.objective.trim() ||
    task.objective.length > 16_384
  ) {
    throw new BalancedRuntimeError("task.invalid", "Task id and objective are required.");
  }
  for (const key of ["acceptance", "allowedPaths", "forbiddenPaths"] ) {
    if (
      !Array.isArray(task[key]) ||
      (key !== "forbiddenPaths" && task[key].length === 0) ||
      task[key].length > 512 ||
      !task[key].every(
        (value) => typeof value === "string" && value.length > 0 && value.length <= 4096,
      )
    ) {
      throw new BalancedRuntimeError(
        "task.invalid",
        `${key} must be ${key === "forbiddenPaths" ? "an array" : "a non-empty array"} of non-empty strings.`,
      );
    }
  }
  for (const pattern of [...task.allowedPaths, ...task.forbiddenPaths]) {
    const normalized = pattern
      .replaceAll("\\", "/")
      .replace(/^\.\//, "")
      .replace(/\/+$/, "");
    if (
      !normalized ||
      normalized.startsWith("/") ||
      /^[A-Za-z]:\//.test(normalized) ||
      normalized.split("/").includes("..") ||
      normalized.includes("\0")
    ) {
      throw new BalancedRuntimeError(
        "task.unsafe_path",
        `Task path pattern '${pattern}' must stay relative to the worktree.`,
      );
    }
  }
  if (
    !Array.isArray(task.validationCommands) ||
    !task.validationCommands.every(
      (command) =>
        Array.isArray(command) &&
        command.length > 0 &&
        command.length <= 64 &&
        command.every((part) => typeof part === "string" && part.length > 0 && part.length <= 4096),
    )
  ) {
    throw new BalancedRuntimeError(
      "task.invalid",
      "validationCommands must contain argv arrays and never shell strings.",
    );
  }
  if (task.allowNoChanges !== undefined && typeof task.allowNoChanges !== "boolean") {
    throw new BalancedRuntimeError("task.invalid", "allowNoChanges must be boolean.");
  }
  return Object.freeze({
    id: task.id,
    objective: task.objective.trim(),
    acceptance: Object.freeze([...task.acceptance]),
    allowedPaths: Object.freeze([...task.allowedPaths]),
    forbiddenPaths: Object.freeze([...task.forbiddenPaths]),
    validationCommands: Object.freeze(task.validationCommands.map((command) => Object.freeze([...command]))),
    allowNoChanges: task.allowNoChanges === true,
  });
}

async function validateDirectory(path, label) {
  if (!isAbsolute(path) || resolve(path) === parse(resolve(path)).root) {
    throw new BalancedRuntimeError("runtime.unsafe_path", `${label} must be a non-root absolute path.`);
  }
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new BalancedRuntimeError("runtime.path_missing", `${label} does not exist.`);
    }
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new BalancedRuntimeError("runtime.unsafe_path", `${label} must be a real directory.`);
  }
  return realpath(path);
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function snapshotWorktree(worktree, options = {}) {
  const maximumFiles = options.maximumFiles ?? 50_000;
  const maximumBytes = options.maximumBytes ?? 2 * 1024 * 1024 * 1024;
  const files = new Map();
  let totalBytes = 0;
  const pending = [""];
  while (pending.length > 0) {
    const directory = pending.pop();
    const absolute = join(worktree, directory);
    const entries = await readdir(absolute, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const child = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) pending.push(child);
        continue;
      }
      if (entry.isSymbolicLink()) {
        throw new BalancedRuntimeError(
          "runtime.unsafe_worktree_symlink",
          `Worktree snapshot refuses symbolic link '${child}'.`,
          409,
        );
      }
      if (!entry.isFile()) continue;
      const metadata = await stat(join(worktree, child));
      totalBytes += metadata.size;
      if (files.size + 1 > maximumFiles || totalBytes > maximumBytes) {
        throw new BalancedRuntimeError(
          "runtime.snapshot_limit",
          "Worktree exceeds the configured snapshot safety limit.",
          409,
        );
      }
      files.set(child, await hashFile(join(worktree, child)));
    }
  }
  const hash = createHash("sha256");
  for (const [path, digest] of [...files.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(path).update("\0").update(digest).update("\n");
  }
  return { digest: hash.digest("hex"), files, fileCount: files.size, totalBytes };
}

function changedPaths(before, after) {
  const paths = new Set([...before.files.keys(), ...after.files.keys()]);
  return [...paths].filter((path) => before.files.get(path) !== after.files.get(path)).sort();
}

function globExpression(pattern) {
  const normalized = pattern
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  const containsWildcard = /[*?]/.test(normalized);
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
  return new RegExp(`${expression}${containsWildcard ? "" : "(?:/.*)?"}$`);
}

function buildReviewProjection(task, before, after, paths) {
  const allowed = task.allowedPaths.map(globExpression);
  const forbidden = task.forbiddenPaths.map(globExpression);
  const entries = paths.map((path) => {
    const classification = forbidden.some((pattern) => pattern.test(path))
      ? "forbidden"
      : allowed.some((pattern) => pattern.test(path))
        ? "allowed"
        : "out-of-scope";
    return {
      path,
      beforeSha256: before.files.get(path) ?? null,
      afterSha256: after.files.get(path) ?? null,
      classification,
    };
  });
  return {
    granularity: "file",
    coverage: entries.length === paths.length ? "complete" : "invalid",
    entries,
  };
}

function scopeResult(projection) {
  const violations = projection.entries
    .filter((entry) => entry.classification !== "allowed")
    .map((entry) => entry.path);
  return { status: violations.length === 0 ? "passed" : "failed", violations };
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
  for (const [command, ...args] of task.validationCommands) {
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
  return {
    status: results.every((result) => result.exitCode === 0) ? "passed" : "failed",
    results,
  };
}

async function readLedger(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function foldedReservations(records) {
  const reservations = new Map();
  for (const record of records) reservations.set(record.reservationId, record);
  return reservations;
}

function budgetSnapshot(records, budget) {
  const folded = foldedReservations(records);
  const used = { main: 0, downstream: 0, advisor: 0 };
  let totalTokens = 0;
  for (const record of folded.values()) {
    if (record.state !== "cancelled") used[record.role] = (used[record.role] ?? 0) + 1;
    totalTokens += record.totalTokens ?? 0;
  }
  return {
    limits: budget,
    used,
    remaining: {
      main: Math.max(0, budget.mainReviewCalls - used.main),
      downstream: Math.max(0, budget.downstreamCalls - used.downstream),
      advisor: Math.max(0, budget.advisorCalls - used.advisor),
      tokens: budget.maxTotalTokens === 0 ? null : Math.max(0, budget.maxTotalTokens - totalTokens),
    },
    totalTokens,
  };
}

async function checkBudgetAvailable(runDirectory, budget, role, stage) {
  const ledgerPath = join(runDirectory, "budget-ledger.jsonl");
  const records = await readLedger(ledgerPath);
  const snapshot = budgetSnapshot(records, budget);
  const maximum = {
    main: budget.mainReviewCalls,
    downstream: budget.downstreamCalls,
    advisor: budget.advisorCalls,
  }[role];
  let usable = maximum;
  const finalStage = stage === "accept" || stage === "stop";
  if (role === "main" && !finalStage) usable -= budget.reservedFinalReviewCalls;
  if ((snapshot.used[role] ?? 0) >= Math.max(0, usable)) {
    throw new BalancedRuntimeError(
      "budget_exhausted",
      `${role} call budget is exhausted for stage '${stage}'.`,
      409,
      snapshot,
    );
  }
  if (
    role !== "main" &&
    budget.maxTotalTokens > 0 &&
    snapshot.totalTokens >= budget.maxTotalTokens
  ) {
    throw new BalancedRuntimeError("budget_exhausted", "Token budget is exhausted.", 409, snapshot);
  }
  return snapshot;
}

async function reserveBudget(runDirectory, budget, role, stage) {
  const ledgerPath = join(runDirectory, "budget-ledger.jsonl");
  const snapshot = await checkBudgetAvailable(runDirectory, budget, role, stage);
  const reservationId = randomUUID();
  await appendJsonLine(ledgerPath, {
    schemaVersion: 1,
    reservationId,
    role,
    stage,
    state: "reserved",
    recordedAt: new Date().toISOString(),
  });
  return { reservationId, role, stage, snapshot };
}

async function settleBudget(runDirectory, reservation, state, totalTokens = 0) {
  await appendJsonLine(join(runDirectory, "budget-ledger.jsonl"), {
    schemaVersion: 1,
    reservationId: reservation.reservationId,
    role: reservation.role,
    stage: reservation.stage,
    state,
    totalTokens,
    recordedAt: new Date().toISOString(),
  });
}

function defaultAdvisor() {
  return Object.freeze({
    id: "deterministic-activity-advisor",
    async evaluate(snapshot) {
      const recent = snapshot.lastTaskDirectedAt > snapshot.lastProductChangeAt;
      const idle = snapshot.now - snapshot.lastProductChangeAt;
      return {
        decision: recent && idle < snapshot.productIdleMs ? "continue" : "stop",
        reason: recent ? "recent-task-directed-activity" : "no-recent-task-directed-activity",
      };
    },
  });
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function policyReference(policy) {
  return `${policy.id}@${policy.version}`;
}

function resolvePolicy(catalog, reference) {
  const [id, version] = reference.split("@");
  const policy = catalog.tunedWindowPolicies.find(
    (candidate) => candidate.id === id && candidate.version === version,
  );
  if (!policy) {
    throw new BalancedRuntimeError("runtime.policy_unknown", `Unknown Balanced policy '${reference}'.`);
  }
  return validatePolicy(policy);
}

function resolveBudget(catalog, overrides = {}) {
  const mode = catalog.modes.find((candidate) => candidate.kind === "balanced");
  const base = catalog.balancedBudgetPolicies.find(
    (candidate) =>
      candidate.id === mode?.budgetPolicy.id && candidate.version === mode?.budgetPolicy.version,
  );
  if (!base) throw new BalancedRuntimeError("runtime.budget_unknown", "Balanced budget policy is missing.");
  return validateBudget({
    mainReviewCalls: overrides.mainReviewCalls ?? base.mainReviewCalls,
    downstreamCalls: overrides.downstreamCalls ?? base.downstreamCalls,
    advisorCalls: overrides.advisorCalls ?? base.advisorCalls,
    reservedFinalReviewCalls:
      overrides.reservedFinalReviewCalls ?? base.reservedFinalReviewCalls,
    maxTotalTokens: overrides.maxTotalTokens ?? base.maxTotalTokens,
  });
}

function buildPrompt(task, context) {
  return [
    "You are the downstream Builder in a bounded Balanced workflow round.",
    "The JSON contract below is frozen. Implement it in the current worktree.",
    "Do not edit forbidden paths or paths outside allowedPaths. Run assigned validation when useful.",
    "Finish by reporting assumptions, changed paths, validation, and remaining risks, then exit.",
    context.round > 1
      ? `This is revision round ${context.round}; preserve prior accepted work and implement only this delta.`
      : "This is the initial round.",
    "",
    JSON.stringify(task, null, 2),
  ].join("\n");
}

async function ensureRuntimeRoot(root) {
  if (!isAbsolute(root) || resolve(root) === parse(resolve(root)).root) {
    throw new BalancedRuntimeError("runtime.unsafe_root", "Runtime root must be a non-root absolute path.");
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const metadata = await lstat(root);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new BalancedRuntimeError("runtime.unsafe_root", "Runtime root must be a real directory.");
  }
  return realpath(root);
}

async function existingRuntimeRoot(root) {
  if (!isAbsolute(root) || resolve(root) === parse(resolve(root)).root) {
    throw new BalancedRuntimeError("runtime.unsafe_root", "Runtime root must be a non-root absolute path.");
  }
  try {
    const metadata = await lstat(root);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new BalancedRuntimeError("runtime.unsafe_root", "Runtime root must be a real directory.");
    }
    return realpath(root);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
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
      throw new BalancedRuntimeError("runtime.locked", "Another process owns this Balanced run.", 409);
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

export function createBalancedRuntime(options = {}) {
  const catalog = options.catalog ?? BUILTIN_MODE_CATALOG;
  const adapters = options.adapters ?? createBuiltInAdapterRegistry();
  const advisor = options.advisor ?? defaultAdvisor();
  const runtimeRootConfigured =
    options.runtimeRoot ??
    process.env.AGENT_CONTROL_BALANCED_RUNS_DIR ??
    join(homedir(), ".agent-control-plane", "balanced-runs");
  const clock = options.clock ?? (() => Date.now());
  const wait = options.sleep ?? sleep;
  const snapshot = options.snapshotWorktree ?? snapshotWorktree;

  async function createRun(input) {
    if (!input || typeof input.worktree !== "string" || input.worktree.trim() === "") {
      throw new BalancedRuntimeError("runtime.invalid_input", "An absolute worktree path is required.");
    }
    const worktree = await validateDirectory(resolve(input.worktree), "Worktree");
    const configuredRoot = resolve(runtimeRootConfigured);
    if (configuredRoot === worktree || configuredRoot.startsWith(`${worktree}${sep}`)) {
      throw new BalancedRuntimeError(
        "runtime.unsafe_root",
        "Balanced runtime artifacts cannot be stored inside the product worktree.",
      );
    }
    const runtimeRoot = await ensureRuntimeRoot(configuredRoot);
    const task = validateBalancedTask(input.task);
    const adapter = adapters.get(input.adapterId);
    if (!adapter) {
      throw new BalancedRuntimeError("runtime.adapter_unknown", `Unknown adapter '${input.adapterId}'.`);
    }
    const policy = resolvePolicy(catalog, input.policyRef ?? "balanced-default@1.0.0");
    const budget = resolveBudget(catalog, input.budget);
    const runId = `${new Date(clock()).toISOString().replace(/[:.]/g, "-").toLowerCase()}-${task.id.slice(0, 64)}-${randomUUID()}`;
    const runDirectory = join(runtimeRoot, runId);
    await mkdir(runDirectory, { mode: 0o700 });
    const contract = { schemaVersion: 1, kind: "balanced-task", task };
    const contractText = stableJson(contract);
    await writeFile(join(runDirectory, "task.json"), contractText, { mode: 0o600, flag: "wx" });
    const metadata = {
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      runId,
      state: "created",
      taskId: task.id,
      taskSha256: sha256(contractText),
      worktree,
      adapterId: adapter.id,
      policyRef: policyReference(policy),
      policy,
      budget,
      rounds: 0,
      sessionId: null,
      latestReviewPath: null,
      latestReviewSha256: null,
      createdAt: new Date(clock()).toISOString(),
      updatedAt: new Date(clock()).toISOString(),
    };
    await writeJsonAtomic(join(runDirectory, "run.json"), metadata);
    return { runDirectory, metadata, task, adapter, policy, budget };
  }

  async function loadRun(runDirectoryInput) {
    const runtimeRoot = await existingRuntimeRoot(runtimeRootConfigured);
    if (!runtimeRoot) {
      throw new BalancedRuntimeError("runtime.path_missing", "Balanced runtime root does not exist.", 404);
    }
    const runDirectory = await validateDirectory(resolve(runDirectoryInput), "Run directory");
    const metadata = await readJson(join(runDirectory, "run.json"));
    if (!metadata || metadata.schemaVersion !== RUNTIME_SCHEMA_VERSION || !SAFE_ID.test(metadata.runId ?? "")) {
      throw new BalancedRuntimeError("runtime.corrupt_run", "Balanced run metadata is invalid.", 409);
    }
    if (basename(runDirectory) !== metadata.runId) {
      throw new BalancedRuntimeError("runtime.corrupt_run", "Balanced run identity does not match its directory.", 409);
    }
    if (resolve(runtimeRoot, metadata.runId) !== runDirectory) {
      throw new BalancedRuntimeError("runtime.unsafe_path", "Run directory is outside the configured runtime root.", 409);
    }
    const taskPath = join(runDirectory, "task.json");
    const taskText = await readFile(taskPath).catch(() => null);
    if (!taskText || sha256(taskText) !== metadata.taskSha256) {
      throw new BalancedRuntimeError("runtime.corrupt_run", "Frozen Balanced Task hash is invalid.", 409);
    }
    const taskEnvelope = JSON.parse(taskText.toString("utf8"));
    const task = validateBalancedTask(taskEnvelope?.task);
    const adapter = adapters.get(metadata.adapterId);
    if (!adapter) throw new BalancedRuntimeError("runtime.adapter_unknown", `Unknown adapter '${metadata.adapterId}'.`);
    return {
      runDirectory,
      metadata,
      task,
      adapter,
      policy: validatePolicy(metadata.policy),
      budget: validateBudget(metadata.budget),
    };
  }

  async function executeRoundLocked(context, task, revisionDecision = null) {
    const { runDirectory, metadata, adapter, policy, budget } = context;
    const round = metadata.rounds + 1;
    const roundDirectory = join(runDirectory, "rounds", String(round).padStart(3, "0"));
    await mkdir(roundDirectory, { recursive: true, mode: 0o700 });
    const reservation = await reserveBudget(runDirectory, budget, "downstream", `round-${round}`);
    reservation.role = "downstream";
    reservation.stage = `round-${round}`;
    const baseline = await snapshot(metadata.worktree);
    const baselineRecord = {
      digest: baseline.digest,
      fileCount: baseline.fileCount,
      totalBytes: baseline.totalBytes,
      recordedAt: new Date(clock()).toISOString(),
    };
    await writeJsonAtomic(join(roundDirectory, "baseline.json"), baselineRecord);
    const roundContract = {
      schemaVersion: 1,
      round,
      task,
      priorReviewSha256: revisionDecision?.reviewSha256 ?? null,
    };
    const roundContractText = stableJson(roundContract);
    await writeFile(join(roundDirectory, "contract.json"), roundContractText, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });

    const startedAt = clock();
    const hardDeadline = startedAt + policy.hardCapSeconds * 1000;
    const contextDeadline = startedAt + policy.contextAcquisitionSeconds * 1000;
    let phaseDeadline = Math.min(
      contextDeadline,
      startedAt + policy.firstProgressSeconds * 1000,
    );
    let lastProductChangeAt = startedAt;
    let lastTaskDirectedAt = 0;
    let firstOutputAt = 0;
    let implementationCompleteAt = 0;
    let completionReadyAt = 0;
    let currentSnapshot = baseline;
    let productDelta = false;
    let firstProductChangeAt = 0;
    let firstProgressBoundaryPassed = false;
    let idleConfirmations = 0;
    let advisorEvaluation = null;
    let advisorBudgetUnavailable = false;
    let extensions = 0;
    let terminationReason = null;
    let controller;
    let adapterResult;
    let settled = false;
    const pendingEvents = [];
    const eventsPath = join(roundDirectory, "events.jsonl");
    const record = (event) => pendingEvents.push({
      schemaVersion: 1,
      round,
      recordedAt: new Date(clock()).toISOString(),
      ...event,
    });
    const flushEvents = async () => {
      const events = pendingEvents.splice(0);
      for (const event of events) await appendJsonLine(eventsPath, event);
    };
    const currentAdvisorPhase = () =>
      productDelta ? "active" : firstProgressBoundaryPassed ? "context" : "first-progress";
    const timeoutReasonForPhase = (phase) =>
      phase === "active"
        ? "active_window_timeout"
        : phase === "first-progress"
          ? "first_progress_timeout"
          : "context_timeout";
    const cancelAdvisorEvaluation = async (reason, currentProductDigest = currentSnapshot.digest) => {
      if (!advisorEvaluation) return;
      const evaluation = advisorEvaluation;
      advisorEvaluation = null;
      evaluation.abortController.abort();
      await settleBudget(runDirectory, evaluation.reservation, "cancelled", 0);
      record({
        type: "extension-evaluation-invalidated",
        advisor: advisor.id,
        phase: evaluation.phase,
        boundProductDigest: evaluation.boundProductDigest,
        currentProductDigest,
        reason,
      });
    };
    const startAdvisorEvaluation = async (now) => {
      if (advisorEvaluation) return;
      const phase = currentAdvisorPhase();
      const reservation = await reserveBudget(
        runDirectory,
        budget,
        "advisor",
        `${phase}-extension`,
      );
      const abortController = new AbortController();
      const evaluation = {
        phase,
        reservation,
        abortController,
        boundProductDigest: currentSnapshot.digest,
        windowDeadline: phaseDeadline,
        result: null,
        pendingRecorded: false,
      };
      const advisorTimeoutMs = Math.max(
        1,
        Math.min(
          policy.advisorCallTimeoutSeconds * 1000,
          Math.max(1, hardDeadline - now),
        ),
      );
      evaluation.promise = Promise.race([
        Promise.resolve().then(() =>
          advisor.evaluate({
            now,
            phase,
            lastTaskDirectedAt,
            lastProductChangeAt,
            productIdleMs: policy.productIdleSeconds * 1000,
            productDigest: evaluation.boundProductDigest,
            signal: abortController.signal,
          }),
        ),
        wait(advisorTimeoutMs).then(() => ({
          decision: "stop",
          reason: "advisor-timeout",
        })),
      ]).then(
        (advice) => {
          evaluation.result = { advice, finishedAt: clock() };
        },
        (error) => {
          evaluation.result = { error, finishedAt: clock() };
        },
      );
      advisorEvaluation = evaluation;
      record({
        type: "extension-evaluation-started",
        advisor: advisor.id,
        phase,
        boundProductDigest: evaluation.boundProductDigest,
        activeDeadline: new Date(Math.min(phaseDeadline, hardDeadline)).toISOString(),
      });
    };

    metadata.state = "running";
    metadata.rounds = round;
    metadata.updatedAt = new Date(clock()).toISOString();
    await writeJsonAtomic(join(runDirectory, "run.json"), metadata);
    record({ type: "round-started", policyRef: metadata.policyRef, baselineDigest: baseline.digest });

    try {
      controller = await adapter.start({
        worktree: metadata.worktree,
        prompt: buildPrompt(task, { round }),
        resumeSessionId: metadata.sessionId,
        stdoutPath: join(roundDirectory, "stdout.jsonl"),
        stderrPath: join(roundDirectory, "stderr.log"),
        terminationGraceMs: 5000,
        onEvent(event) {
          const now = clock();
          if (event.type === "output" && firstOutputAt === 0) firstOutputAt = now;
          if (event.type === "task-directed") lastTaskDirectedAt = now;
          if (event.type === "implementation-complete" && implementationCompleteAt === 0) {
            implementationCompleteAt = now;
          }
          if (event.type === "completion-ready" && completionReadyAt === 0) completionReadyAt = now;
          record(event);
        },
      });
      await writeJsonAtomic(join(roundDirectory, "process.json"), {
        schemaVersion: 1,
        state: "running",
        adapterId: metadata.adapterId,
        identity: controller.identity ?? { pid: controller.pid ?? null },
        startedAt: new Date(clock()).toISOString(),
      });
      const resultPromise = controller.result.then((result) => {
        adapterResult = result;
        settled = true;
        return result;
      });

      while (!settled) {
        const pollMs = Math.max(10, policy.pollSeconds * 1000);
        await Promise.race([resultPromise, wait(pollMs)]);
        if (settled) break;
        const now = clock();
        try {
          const observed = await snapshot(metadata.worktree);
          if (observed.digest !== currentSnapshot.digest) {
            await cancelAdvisorEvaluation(
              "product-changed-during-evaluation",
              observed.digest,
            );
            currentSnapshot = observed;
            productDelta = observed.digest !== baseline.digest;
            if (productDelta && firstProductChangeAt === 0) firstProductChangeAt = now;
            lastProductChangeAt = now;
            phaseDeadline = now + policy.activeWindowSeconds * 1000;
            idleConfirmations = 0;
            record({
              type: "active-window-refreshed",
              productDigest: observed.digest,
              activeDeadline: new Date(Math.min(phaseDeadline, hardDeadline)).toISOString(),
            });
          }
        } catch (error) {
          terminationReason = error.code ?? "snapshot_failed";
        }
        if (
          productDelta &&
          now - lastProductChangeAt >= policy.productIdleSeconds * 1000
        ) {
          idleConfirmations += 1;
        } else {
          idleConfirmations = 0;
        }
        const currentUsage = controller.usage();
        const priorTokens = reservation.snapshot.totalTokens;
        if (
          budget.maxTotalTokens > 0 &&
          priorTokens + currentUsage.totalTokens > budget.maxTotalTokens
        ) {
          terminationReason = "budget_exhausted";
        }
        if (now >= hardDeadline) terminationReason = "hard_timeout";
        if (
          !terminationReason &&
          policy.noOutputSeconds > 0 &&
          firstOutputAt === 0 &&
          now - startedAt >= policy.noOutputSeconds * 1000
        ) {
          terminationReason = "no_output_timeout";
        }
        if (
          !terminationReason &&
          implementationCompleteAt > 0 &&
          completionReadyAt === 0 &&
          now - implementationCompleteAt >= policy.tailSeconds * 1000
        ) {
          terminationReason = "tail_timeout";
        }
        if (
          !terminationReason &&
          completionReadyAt > 0 &&
          now - completionReadyAt >= policy.completionGraceSeconds * 1000
        ) {
          terminationReason = "completion_ready_converged";
        }
        if (
          !terminationReason &&
          !advisorEvaluation &&
          !advisorBudgetUnavailable &&
          now >= phaseDeadline - policy.advisorLeadSeconds * 1000
        ) {
          try {
            await startAdvisorEvaluation(now);
          } catch (error) {
            if (error.code === "budget_exhausted") {
              advisorBudgetUnavailable = true;
              record({
                type: "extension-evaluation-skipped",
                advisor: advisor.id,
                phase: currentAdvisorPhase(),
                reason: "advisor-call-budget-exhausted",
              });
            } else {
              terminationReason = "advisor_failed";
            }
          }
        }
        if (!terminationReason && now >= phaseDeadline) {
          if (advisorBudgetUnavailable) {
            terminationReason = timeoutReasonForPhase(currentAdvisorPhase());
          } else if (!advisorEvaluation) {
            try {
              await startAdvisorEvaluation(now);
            } catch (error) {
              terminationReason =
                error.code === "budget_exhausted"
                  ? timeoutReasonForPhase(currentAdvisorPhase())
                  : "advisor_failed";
            }
          }
          if (!terminationReason && advisorEvaluation && !advisorEvaluation.result) {
            if (!advisorEvaluation.pendingRecorded) {
              advisorEvaluation.pendingRecorded = true;
              record({
                type: "extension-evaluation-pending",
                advisor: advisor.id,
                phase: advisorEvaluation.phase,
                reason: "advisor-running-at-window-boundary",
                boundProductDigest: advisorEvaluation.boundProductDigest,
              });
            }
          } else if (!terminationReason && advisorEvaluation) {
            const evaluation = advisorEvaluation;
            advisorEvaluation = null;
            const { advice, error, finishedAt: adviceFinishedAt } = evaluation.result;
            if (error) {
              await settleBudget(runDirectory, evaluation.reservation, "failed", 0);
              terminationReason = "advisor_failed";
            } else {
              const afterAdviceSnapshot = await snapshot(metadata.worktree);
              const adviceStale = afterAdviceSnapshot.digest !== evaluation.boundProductDigest;
              await settleBudget(
                runDirectory,
                evaluation.reservation,
                adviceStale ? "cancelled" : "succeeded",
                0,
              );
              if (adviceStale) {
                currentSnapshot = afterAdviceSnapshot;
                productDelta = afterAdviceSnapshot.digest !== baseline.digest;
                if (productDelta && firstProductChangeAt === 0) {
                  firstProductChangeAt = adviceFinishedAt;
                }
                lastProductChangeAt = adviceFinishedAt;
                phaseDeadline = Math.min(
                  adviceFinishedAt + policy.activeWindowSeconds * 1000,
                  hardDeadline,
                );
                idleConfirmations = 0;
                record({
                  type: "extension-evaluation-invalidated",
                  advisor: advisor.id,
                  phase: evaluation.phase,
                  boundProductDigest: evaluation.boundProductDigest,
                  currentProductDigest: afterAdviceSnapshot.digest,
                  reason: "product-changed-during-evaluation",
                });
              }
              record({
                type: "extension-evaluation",
                advisor: advisor.id,
                phase: evaluation.phase,
                boundProductDigest: evaluation.boundProductDigest,
                idleConfirmations,
                stale: adviceStale,
                ...advice,
              });
              if (adviceFinishedAt >= hardDeadline) {
                terminationReason = "hard_timeout";
              } else if (adviceStale) {
                // Product growth already refreshed a complete active window.
              } else if (advice.decision === "continue") {
                const seconds =
                  extensions === 0
                    ? policy.progressExtensionSeconds
                    : policy.growingProgressExtensionSeconds;
                if (evaluation.phase === "first-progress") firstProgressBoundaryPassed = true;
                phaseDeadline = Math.min(
                  Math.max(
                    now + seconds * 1000,
                    evaluation.phase === "first-progress" ? contextDeadline : 0,
                  ),
                  hardDeadline,
                );
                extensions += 1;
                record({
                  type: "active-window-extended",
                  extensionSeconds: seconds,
                  extensionOrdinal: extensions,
                  activeDeadline: new Date(phaseDeadline).toISOString(),
                });
              } else if (
                evaluation.phase === "active" &&
                idleConfirmations < policy.productIdleConfirmations &&
                now < hardDeadline
              ) {
                phaseDeadline = Math.min(
                  now + Math.max(10, policy.pollSeconds * 1000),
                  hardDeadline,
                );
                record({
                  type: "extension-evaluation-pending",
                  reason: "awaiting-product-idle-corroboration",
                  idleConfirmations,
                  requiredConfirmations: policy.productIdleConfirmations,
                });
              } else {
                terminationReason = timeoutReasonForPhase(evaluation.phase);
              }
            }
          }
        }
        await flushEvents();
        if (terminationReason) {
          record({ type: "termination-requested", reason: terminationReason });
          await controller.terminate();
          await resultPromise;
          break;
        }
      }
    } catch (error) {
      terminationReason = error.code === "ENOENT" ? "adapter_unavailable" : "adapter_failed";
      if (controller && !settled) {
        await controller.terminate().catch(() => undefined);
        adapterResult = await controller.result.catch(() => null);
        settled = true;
      }
      adapterResult = {
        exitCode: adapterResult?.exitCode ?? null,
        signal: adapterResult?.signal ?? null,
        sessionId: adapterResult?.sessionId ?? metadata.sessionId,
        usage: adapterResult?.usage ?? { totalTokens: 0 },
        error: error.message,
      };
      record({ type: "adapter-error", message: error.message });
    }

    await cancelAdvisorEvaluation("round-finished").catch((error) => {
      record({ type: "advisor-cleanup-error", message: error.message });
      if (!terminationReason) terminationReason = "advisor_failed";
    });
    const executionFinishedAt = clock();
    await flushEvents();
    await writeJsonAtomic(join(roundDirectory, "process.json"), {
      schemaVersion: 1,
      state: "exited",
      adapterId: metadata.adapterId,
      identity: controller?.identity ?? { pid: controller?.pid ?? null },
      exitCode: adapterResult?.exitCode ?? null,
      signal: adapterResult?.signal ?? null,
      terminationReason,
      finishedAt: new Date(clock()).toISOString(),
    });
    const usage = adapterResult?.usage ?? controller?.usage?.() ?? { totalTokens: 0 };
    if (
      budget.maxTotalTokens > 0 &&
      reservation.snapshot.totalTokens + (usage.totalTokens ?? 0) > budget.maxTotalTokens
    ) {
      terminationReason = "budget_exhausted";
    }
    const budgetState =
      terminationReason === "budget_exhausted" ? "failed" : adapterResult?.exitCode === 0 ? "succeeded" : "failed";
    await settleBudget(runDirectory, reservation, budgetState, usage.totalTokens ?? 0);

    const validation = await runValidation(
      task,
      metadata.worktree,
      Math.max(1000, Math.min(policy.hardCapSeconds * 1000, 10 * 60 * 1000)),
    );
    const finalSnapshot = await snapshot(metadata.worktree);
    const paths = changedPaths(baseline, finalSnapshot);
    const reviewProjection = buildReviewProjection(task, baseline, finalSnapshot, paths);
    const scope = scopeResult(reviewProjection);
    const hasRequiredChange = task.allowNoChanges || paths.length > 0;
    let roundStatus = "review_pending";
    if (terminationReason && terminationReason !== "completion_ready_converged") {
      roundStatus = terminationReason === "budget_exhausted" ? "budget_exhausted" : "runtime_blocked";
    } else if (scope.status !== "passed") roundStatus = "scope_violation";
    else if (validation.status !== "passed" || !hasRequiredChange) roundStatus = "validation_failed";
    else if (adapterResult?.exitCode !== 0 && terminationReason !== "completion_ready_converged") {
      roundStatus = "runtime_blocked";
    }
    const ledger = await readLedger(join(runDirectory, "budget-ledger.jsonl"));
    const evidenceBudget = budgetSnapshot(ledger, budget);
    const revisionBudgetAvailable =
      evidenceBudget.used.downstream < budget.downstreamCalls &&
      evidenceBudget.used.main < budget.mainReviewCalls - budget.reservedFinalReviewCalls &&
      (budget.maxTotalTokens === 0 || evidenceBudget.totalTokens < budget.maxTotalTokens);
    const allowedDecisions =
      roundStatus === "budget_exhausted"
        ? ["stop"]
        : roundStatus === "review_pending"
          ? ["accept", ...(revisionBudgetAvailable ? ["revise"] : []), "stop"]
          : [...(revisionBudgetAvailable ? ["revise"] : []), "stop"];
    const review = {
      schemaVersion: 1,
      kind: "balanced-round-review",
      workflowMode: "balanced",
      runId: metadata.runId,
      taskId: task.id,
      round,
      roundKind: round === 1 ? "initial" : "revision",
      roundStatus,
      codexReviewRequired: true,
      mergeAuthorized: false,
      executionOwner: "downstream",
      adapterId: metadata.adapterId,
      sessionId: adapterResult?.sessionId ?? metadata.sessionId ?? null,
      taskSha256: sha256(roundContractText),
      priorReviewSha256: revisionDecision?.reviewSha256 ?? null,
      timeWindowPlan: {
        source: "agent-control-plane-runtime",
        fixedSingleCheckpoint: false,
        policyRef: metadata.policyRef,
        contextAcquisitionSeconds: policy.contextAcquisitionSeconds,
        activeWindowSeconds: policy.activeWindowSeconds,
        firstProgressSeconds: policy.firstProgressSeconds,
        progressExtensionSeconds: policy.progressExtensionSeconds,
        growingProgressExtensionSeconds: policy.growingProgressExtensionSeconds,
        hardCapSeconds: policy.hardCapSeconds,
        noOutputSeconds: policy.noOutputSeconds,
        productIdleSeconds: policy.productIdleSeconds,
        productIdleConfirmations: policy.productIdleConfirmations,
        completionGraceSeconds: policy.completionGraceSeconds,
        tailSeconds: policy.tailSeconds,
        advisorLeadSeconds: policy.advisorLeadSeconds,
        advisorCallTimeoutSeconds: policy.advisorCallTimeoutSeconds,
        growthExtensionPolicy: "renewable-product-growth-until-hard-cap",
        extensionsUsed: extensions,
        terminationReason,
        totalExecutionSecondsObserved: (executionFinishedAt - startedAt) / 1000,
        contextAcquisitionSecondsObserved:
          firstProductChangeAt > 0 ? (firstProductChangeAt - startedAt) / 1000 : null,
        activeExecutionSecondsObserved:
          firstProductChangeAt > 0 ? (executionFinishedAt - firstProductChangeAt) / 1000 : null,
        firstOutputSecondsObserved:
          firstOutputAt > 0 ? (firstOutputAt - startedAt) / 1000 : null,
        tailSecondsObserved:
          implementationCompleteAt > 0
            ? (executionFinishedAt - implementationCompleteAt) / 1000
            : null,
        completionReadyObserved: completionReadyAt > 0,
      },
      evidence: {
        baselineProductDigest: baseline.digest,
        finalProductDigest: finalSnapshot.digest,
        changedPaths: paths,
        reviewProjection,
        scope,
        validation,
        adapter: {
          exitCode: adapterResult?.exitCode ?? null,
          signal: adapterResult?.signal ?? null,
          error: adapterResult?.error ?? null,
        },
        usage,
        budget: evidenceBudget,
      },
      allowedDecisions,
      nextRoundRequiresRevisionDelta: true,
      generatedAt: new Date(clock()).toISOString(),
    };
    const reviewPath = join(roundDirectory, "balanced-review.json");
    await writeJsonAtomic(reviewPath, review);
    const reviewSha256 = sha256(await readFile(reviewPath));
    metadata.state = roundStatus;
    metadata.sessionId = review.sessionId;
    metadata.latestReviewPath = reviewPath;
    metadata.latestReviewSha256 = reviewSha256;
    metadata.updatedAt = new Date(clock()).toISOString();
    await writeJsonAtomic(join(runDirectory, "run.json"), metadata);
    return { runDirectory, reviewPath, reviewSha256, review };
  }

  async function run(input) {
    const created = await createRun(input);
    return withRunLock(created.runDirectory, () => executeRoundLocked(created, created.task));
  }

  async function review(input) {
    const loaded = await loadRun(input.runDirectory);
    return withRunLock(loaded.runDirectory, async () => {
      const metadata = await readJson(join(loaded.runDirectory, "run.json"));
      if (!["review_pending", "runtime_blocked", "budget_exhausted", "scope_violation", "validation_failed"].includes(metadata.state)) {
        throw new BalancedRuntimeError("review.invalid_state", `Run state '${metadata.state}' cannot be reviewed.`, 409);
      }
      if (!metadata.latestReviewPath || !metadata.latestReviewSha256) {
        throw new BalancedRuntimeError("review.missing", "Latest Balanced review is missing.", 409);
      }
      const reviewPath = resolve(metadata.latestReviewPath);
      if (
        reviewPath !== loaded.runDirectory &&
        !reviewPath.startsWith(`${loaded.runDirectory}${sep}`)
      ) {
        throw new BalancedRuntimeError("review.stale", "Balanced review path escaped its run directory.", 409);
      }
      const reviewText = await readFile(reviewPath);
      if (sha256(reviewText) !== metadata.latestReviewSha256) {
        throw new BalancedRuntimeError("review.stale", "Balanced review hash does not match run state.", 409);
      }
      const latestReview = JSON.parse(reviewText.toString("utf8"));
      const current = await snapshot(metadata.worktree);
      if (current.digest !== latestReview.evidence.finalProductDigest) {
        throw new BalancedRuntimeError("review.stale", "Worktree changed after the Balanced review was generated.", 409);
      }
      if (!["accept", "revise", "stop"].includes(input.decision)) {
        throw new BalancedRuntimeError("review.invalid_decision", "Decision must be accept, revise, or stop.");
      }
      if (!latestReview.allowedDecisions.includes(input.decision)) {
        throw new BalancedRuntimeError(
          "review.decision_blocked",
          `Decision '${input.decision}' is not allowed for round status '${latestReview.roundStatus}'.`,
          409,
        );
      }
      const revision = input.decision === "revise" ? validateBalancedTask(input.revisionTask) : null;
      if (revision) {
        await checkBudgetAvailable(
          loaded.runDirectory,
          loaded.budget,
          "downstream",
          `round-${metadata.rounds + 1}`,
        );
      }
      const reservation = await reserveBudget(
        loaded.runDirectory,
        loaded.budget,
        "main",
        input.decision,
      );
      reservation.role = "main";
      reservation.stage = input.decision;
      const decision = {
        schemaVersion: 1,
        kind: "balanced-review-decision",
        runId: metadata.runId,
        round: metadata.rounds,
        decision: input.decision,
        reviewPath: metadata.latestReviewPath,
        reviewSha256: metadata.latestReviewSha256,
        productDigest: current.digest,
        recordedAt: new Date(clock()).toISOString(),
      };
      const decisionPath = join(
        loaded.runDirectory,
        "rounds",
        String(metadata.rounds).padStart(3, "0"),
        "review-decision.json",
      );
      await writeJsonAtomic(decisionPath, decision);
      await settleBudget(loaded.runDirectory, reservation, "succeeded", 0);
      if (input.decision === "revise") {
        metadata.state = "revision_pending";
        metadata.updatedAt = new Date(clock()).toISOString();
        await writeJsonAtomic(join(loaded.runDirectory, "run.json"), metadata);
        loaded.metadata = metadata;
        return executeRoundLocked(loaded, revision, decision);
      }
      metadata.state = input.decision === "accept" ? "accepted" : "stopped";
      metadata.updatedAt = new Date(clock()).toISOString();
      await writeJsonAtomic(join(loaded.runDirectory, "run.json"), metadata);
      return { runDirectory: loaded.runDirectory, decisionPath, decision, state: metadata.state };
    });
  }

  async function status(runDirectory) {
    const loaded = await loadRun(runDirectory);
    const ledger = await readLedger(join(loaded.runDirectory, "budget-ledger.jsonl"));
    return {
      ...loaded.metadata,
      budgetState: budgetSnapshot(ledger, loaded.budget),
    };
  }

  async function listRuns() {
    const root = await existingRuntimeRoot(runtimeRootConfigured);
    if (!root) return [];
    const entries = await readdir(root, { withFileTypes: true });
    const runs = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
      try {
        const metadata = await readJson(join(root, entry.name, "run.json"));
        if (metadata?.schemaVersion === RUNTIME_SCHEMA_VERSION) {
          const ledger = await readLedger(join(root, entry.name, "budget-ledger.jsonl"));
          runs.push({ ...metadata, budgetState: budgetSnapshot(ledger, metadata.budget) });
        }
      } catch {
        // Corrupt runs remain isolated and do not hide healthy history.
      }
    }
    return runs.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  return Object.freeze({ listRuns, review, run, status });
}
