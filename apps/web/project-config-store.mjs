import { createHash, randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import {
  BALANCED_BUDGET_LIMITS,
  BALANCED_TIMING_LIMITS,
  BUILTIN_MODE_CATALOG,
  EXAMPLE_AGENTS,
} from "../../packages/contracts/dist/index.js";

const OWNER = "agent-control-plane";
const SCHEMA_VERSION = 1;
const CONTROL_DIRECTORY = ".agent-control-plane";
const PROJECT_FILE = "project.json";
const WORKFLOW_FILE = "workflow.json";
const HISTORY_DIRECTORY = "history";
const LOCK_FILE = "project.lock";
const MAX_APPENDIX_BYTES = 32 * 1024;
const OVERRIDE_KEYS = new Set([
  "modeId",
  "mainAgentId",
  "builderAgentId",
  "overnightLoopPolicyId",
  "balancedBudget",
  "balancedTiming",
  "skillAppendix",
]);
const MODE_IDS = new Set(BUILTIN_MODE_CATALOG.modes.map((entry) => entry.id));
const AGENT_IDS = new Set(EXAMPLE_AGENTS.map((entry) => entry.id));
const OVERNIGHT_POLICY_IDS = new Set(
  BUILTIN_MODE_CATALOG.overnightLoopPolicies.map((entry) => entry.id),
);

export class ProjectConfigError extends Error {
  constructor(code, message, status = 400, path = null) {
    super(message);
    this.name = "ProjectConfigError";
    this.code = code;
    this.status = status;
    if (path) this.path = path;
  }
}

function safeIdentifier(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,159}$/.test(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function projectConfigSha256(projectId, workflow) {
  return createHash("sha256").update(JSON.stringify({
    projectId,
    revision: workflow.revision,
    overrides: workflow.overrides,
  })).digest("hex");
}

async function pathType(path) {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) return "symlink";
    if (metadata.isDirectory()) return "directory";
    if (metadata.isFile()) return "file";
    return "other";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      throw new ProjectConfigError("project.corrupt_json", "Project configuration is not valid JSON.", 409);
    }
    throw error;
  }
}

async function writeJsonAtomic(path, value, nonce) {
  const temporary = `${path}.tmp-${nonce}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function validateOverrides(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectConfigError("project.overrides_invalid", "Project overrides must be an object.", 422, "overrides");
  }
  for (const key of Object.keys(value)) {
    if (!OVERRIDE_KEYS.has(key)) {
      throw new ProjectConfigError("project.overrides_invalid", `Unknown project override '${key}'.`, 422, `overrides.${key}`);
    }
  }
  for (const key of ["modeId", "mainAgentId", "builderAgentId", "overnightLoopPolicyId"]) {
    if (value[key] !== undefined && !safeIdentifier(value[key])) {
      throw new ProjectConfigError("project.overrides_invalid", `${key} must be a safe identifier.`, 422, `overrides.${key}`);
    }
  }
  if (value.modeId !== undefined && !MODE_IDS.has(value.modeId)) {
    throw new ProjectConfigError("project.overrides_invalid", "modeId is not available.", 422, "overrides.modeId");
  }
  for (const key of ["mainAgentId", "builderAgentId"]) {
    if (value[key] !== undefined && !AGENT_IDS.has(value[key])) {
      throw new ProjectConfigError("project.overrides_invalid", `${key} is not available.`, 422, `overrides.${key}`);
    }
  }
  if (
    value.overnightLoopPolicyId !== undefined &&
    !OVERNIGHT_POLICY_IDS.has(value.overnightLoopPolicyId)
  ) {
    throw new ProjectConfigError(
      "project.overrides_invalid",
      "overnightLoopPolicyId is not available.",
      422,
      "overrides.overnightLoopPolicyId",
    );
  }
  const validateBoundedRecord = (key, limits) => {
    const record = value[key];
    if (record === undefined) return;
    const limitKeys = Object.keys(limits);
    if (
      !record || typeof record !== "object" || Array.isArray(record) ||
      Object.keys(record).length !== limitKeys.length ||
      !limitKeys.every((field) =>
        Number.isSafeInteger(record[field]) &&
        record[field] >= limits[field].min && record[field] <= limits[field].max
      )
    ) {
      throw new ProjectConfigError("project.overrides_invalid", `${key} is outside the supported limits.`, 422, `overrides.${key}`);
    }
  };
  validateBoundedRecord("balancedBudget", BALANCED_BUDGET_LIMITS);
  validateBoundedRecord("balancedTiming", BALANCED_TIMING_LIMITS);
  if (
    value.balancedBudget &&
    value.balancedBudget.reservedFinalReviewCalls > value.balancedBudget.mainReviewCalls
  ) {
    throw new ProjectConfigError(
      "project.overrides_invalid",
      "reservedFinalReviewCalls cannot exceed mainReviewCalls.",
      422,
      "overrides.balancedBudget.reservedFinalReviewCalls",
    );
  }
  if (
    value.balancedTiming &&
    value.balancedTiming.hardCapSeconds < Math.max(
      value.balancedTiming.contextAcquisitionSeconds,
      value.balancedTiming.firstProgressSeconds,
      value.balancedTiming.activeWindowSeconds,
      value.balancedTiming.progressExtensionSeconds,
      value.balancedTiming.growingProgressExtensionSeconds,
    )
  ) {
    throw new ProjectConfigError(
      "project.overrides_invalid",
      "hardCapSeconds cannot be shorter than another timing window.",
      422,
      "overrides.balancedTiming.hardCapSeconds",
    );
  }
  if (
    value.skillAppendix !== undefined &&
    (typeof value.skillAppendix !== "string" || value.skillAppendix.includes("\0") ||
      Buffer.byteLength(value.skillAppendix, "utf8") > MAX_APPENDIX_BYTES)
  ) {
    throw new ProjectConfigError(
      "project.overrides_invalid",
      "skillAppendix must be UTF-8 text no larger than 32 KiB and contain no NUL bytes.",
      422,
      "overrides.skillAppendix",
    );
  }
  return clone(value);
}

function validateIdentity(value) {
  if (
    !value || value.schemaVersion !== SCHEMA_VERSION || value.owner !== OWNER ||
    !safeIdentifier(value.projectId) || typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt))
  ) {
    throw new ProjectConfigError("project.identity_invalid", "Project identity is invalid or not product-owned.", 409);
  }
  return value;
}

function validateWorkflow(value) {
  if (
    !value || value.schemaVersion !== SCHEMA_VERSION || value.owner !== OWNER ||
    !Number.isSafeInteger(value.revision) || value.revision < 0 ||
    typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))
  ) {
    throw new ProjectConfigError("project.workflow_invalid", "Project workflow configuration is invalid.", 409);
  }
  return { ...value, overrides: validateOverrides(value.overrides) };
}

export function createProjectConfigStore(options = {}) {
  const clock = options.clock ?? (() => new Date());
  const nonceFactory = options.nonceFactory ?? randomUUID;

  async function requireProjectRoot(input) {
    if (typeof input !== "string" || !isAbsolute(input)) {
      throw new ProjectConfigError("project.root_invalid", "projectRoot must be an absolute directory path.", 400, "projectRoot");
    }
    const requested = resolve(input);
    const type = await pathType(requested);
    if (type !== "directory") {
      throw new ProjectConfigError(
        "project.root_unavailable",
        type === "symlink" ? "Symlink project roots are not accepted." : "projectRoot must be an accessible directory.",
        400,
        "projectRoot",
      );
    }
    const canonical = await realpath(requested);
    const metadata = await stat(canonical);
    if (!metadata.isDirectory()) {
      throw new ProjectConfigError("project.root_unavailable", "projectRoot must be a directory.", 400, "projectRoot");
    }
    return canonical;
  }

  function paths(projectRoot) {
    const control = join(projectRoot, CONTROL_DIRECTORY);
    return {
      control,
      history: join(control, HISTORY_DIRECTORY),
      identity: join(control, PROJECT_FILE),
      lock: join(control, LOCK_FILE),
      workflow: join(control, WORKFLOW_FILE),
    };
  }

  async function readInitialized(projectRoot) {
    const projectPaths = paths(projectRoot);
    const controlType = await pathType(projectPaths.control);
    if (controlType === "missing") return null;
    if (controlType !== "directory") {
      throw new ProjectConfigError("project.control_unsafe", "Project control path is not a safe directory.", 409);
    }
    if ((await pathType(projectPaths.identity)) !== "file") {
      throw new ProjectConfigError("project.identity_unsafe", "Project identity must be a regular file.", 409);
    }
    if ((await pathType(projectPaths.workflow)) !== "file") {
      throw new ProjectConfigError("project.workflow_unsafe", "Project workflow configuration must be a regular file.", 409);
    }
    if ((await pathType(projectPaths.history)) !== "directory") {
      throw new ProjectConfigError("project.history_unsafe", "Project history must be a safe directory.", 409);
    }
    const identity = validateIdentity(await readJson(projectPaths.identity));
    const workflow = validateWorkflow(await readJson(projectPaths.workflow));
    return { identity, paths: projectPaths, workflow };
  }

  async function listHistory(projectPaths) {
    if ((await pathType(projectPaths.history)) === "missing") return [];
    const entries = await readdir(projectPaths.history, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^revision-\d+\.json$/.test(entry.name)) continue;
      try {
        const snapshot = validateWorkflow(await readJson(join(projectPaths.history, entry.name)));
        result.push({ revision: snapshot.revision, updatedAt: snapshot.updatedAt });
      } catch (error) {
        if (!(error instanceof ProjectConfigError)) throw error;
      }
    }
    return result.sort((left, right) => right.revision - left.revision);
  }

  async function inspect(input) {
    const projectRoot = await requireProjectRoot(input);
    const initialized = await readInitialized(projectRoot);
    if (!initialized) {
      return {
        schemaVersion: SCHEMA_VERSION,
        projectRoot,
        initialized: false,
        projectId: null,
        revision: null,
        configSha256: null,
        overrides: {},
        history: [],
      };
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      projectRoot,
      initialized: true,
      projectId: initialized.identity.projectId,
      revision: initialized.workflow.revision,
      configSha256: projectConfigSha256(initialized.identity.projectId, initialized.workflow),
      overrides: clone(initialized.workflow.overrides),
      history: await listHistory(initialized.paths),
    };
  }

  async function initialize(input) {
    const projectRoot = await requireProjectRoot(input);
    const existing = await readInitialized(projectRoot);
    if (existing) return inspect(projectRoot);
    const projectPaths = paths(projectRoot);
    const temporary = join(projectRoot, `${CONTROL_DIRECTORY}.tmp-${nonceFactory()}`);
    await mkdir(temporary, { mode: 0o700 });
    try {
      await mkdir(join(temporary, HISTORY_DIRECTORY), { mode: 0o700 });
      const now = clock().toISOString();
      await writeFile(join(temporary, PROJECT_FILE), `${JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        owner: OWNER,
        projectId: nonceFactory().toLowerCase(),
        createdAt: now,
      }, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await writeFile(join(temporary, WORKFLOW_FILE), `${JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        owner: OWNER,
        revision: 0,
        updatedAt: now,
        overrides: {},
      }, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporary, projectPaths.control);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
    return inspect(projectRoot);
  }

  async function withLock(projectPaths, operation) {
    let handle;
    try {
      handle = await open(projectPaths.lock, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquiredAt: clock().toISOString() })}\n`);
    } catch (error) {
      await handle?.close();
      if (handle) await rm(projectPaths.lock, { force: true });
      if (error?.code === "EEXIST") {
        throw new ProjectConfigError("project.locked", "Another project configuration write is active.", 409);
      }
      throw error;
    }
    try {
      return await operation();
    } finally {
      await handle?.close();
      await rm(projectPaths.lock, { force: true });
    }
  }

  async function save({ projectRoot: input, expectedRevision, overrides }) {
    const projectRoot = await requireProjectRoot(input);
    const initialized = await readInitialized(projectRoot);
    if (!initialized) {
      throw new ProjectConfigError("project.not_initialized", "Initialize the project before saving overrides.", 409);
    }
    const nextOverrides = validateOverrides(overrides);
    return withLock(initialized.paths, async () => {
      const current = validateWorkflow(await readJson(initialized.paths.workflow));
      if (expectedRevision !== current.revision) {
        throw new ProjectConfigError("project.revision_conflict", "Project configuration changed after it was loaded.", 409);
      }
      const historyPath = join(initialized.paths.history, `revision-${current.revision}.json`);
      try {
        await writeFile(historyPath, `${JSON.stringify(current, null, 2)}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const existing = validateWorkflow(await readJson(historyPath));
        if (JSON.stringify(existing) !== JSON.stringify(current)) {
          throw new ProjectConfigError(
            "project.history_conflict",
            "Existing project history does not match the current revision.",
            409,
          );
        }
      }
      const next = {
        schemaVersion: SCHEMA_VERSION,
        owner: OWNER,
        revision: current.revision + 1,
        updatedAt: clock().toISOString(),
        overrides: nextOverrides,
      };
      await writeJsonAtomic(initialized.paths.workflow, next, nonceFactory());
      return inspect(projectRoot);
    });
  }

  async function restore({ projectRoot: input, expectedRevision, revision }) {
    const projectRoot = await requireProjectRoot(input);
    const initialized = await readInitialized(projectRoot);
    if (!initialized) {
      throw new ProjectConfigError("project.not_initialized", "Project is not initialized.", 409);
    }
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new ProjectConfigError("project.history_invalid", "revision must be a non-negative integer.", 400);
    }
    const rawSnapshot = await readJson(join(initialized.paths.history, `revision-${revision}.json`));
    if (!rawSnapshot) {
      throw new ProjectConfigError("project.history_not_found", "Project revision was not found.", 404);
    }
    const snapshot = validateWorkflow(rawSnapshot);
    return save({ projectRoot, expectedRevision, overrides: snapshot.overrides });
  }

  return Object.freeze({ initialize, inspect, restore, save });
}
