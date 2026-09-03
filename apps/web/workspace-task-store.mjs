import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { createTaskCardTemplate, normalizeTaskCard } from "./task-card.mjs";
import {
  createPreflightReceipt,
  taskCardSha256,
  validatePreflightReceipt,
} from "./execution-receipt.mjs";
import {
  createRevisionDeltaArtifact,
  normalizeRevisionDeltaInput,
  validateBoundedTaskRevision,
  validateRevisionDeltaArtifact,
} from "./revision-delta.mjs";

const OWNER = "agent-control-plane";
const SCHEMA_VERSION = 1;
const TASKS_DIRECTORY = "tasks";
const ACTIVE_TASK_FILE = "active-task.json";
const WORKING_COPY_FILE = "working-copy.json";
const METADATA_FILE = "metadata.json";
const REVISIONS_DIRECTORY = "revisions";
const PREFLIGHTS_DIRECTORY = "preflights";
const DELTAS_DIRECTORY = "deltas";
const LOCK_FILE = "task.lock";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_TASK_BYTES = 128 * 1024;

export class WorkspaceTaskStoreError extends Error {
  constructor(code, message, status = 400, path = null) {
    super(message);
    this.name = "WorkspaceTaskStoreError";
    this.code = code;
    this.status = status;
    if (path) this.path = path;
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha256(value) {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function requireTaskId(value, path = "taskId") {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new WorkspaceTaskStoreError(
      "task.task_id_invalid",
      `${path} must be a safe Task Card identifier.`,
      422,
      path,
    );
  }
  return value;
}

function requireWorkingCopyGeneration(value, path = "expectedWorkingCopyGeneration") {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new WorkspaceTaskStoreError(
      "task.working_copy_generation_invalid",
      `${path} must be a positive integer.`,
      422,
      path,
    );
  }
  return value;
}

function requireDraft(value, taskId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceTaskStoreError("task.working_copy_invalid", "Task Card draft must be an object.", 422, "task");
  }
  if (value.id !== taskId) {
    throw new WorkspaceTaskStoreError(
      "task.task_id_mismatch",
      "The Task Card id must match taskId.",
      422,
      "task.id",
    );
  }
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > MAX_TASK_BYTES) {
    throw new WorkspaceTaskStoreError("task.working_copy_too_large", "Task Card draft exceeds 128 KiB.", 413, "task");
  }
  return clone(value);
}

function normalizeSource(value) {
  if (value === undefined || value === null) return { kind: "upstream-agent" };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceTaskStoreError("task.source_invalid", "source must be an object.", 422, "source");
  }
  const allowed = new Set(["kind", "actor"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new WorkspaceTaskStoreError("task.source_invalid", `Unknown source field '${key}'.`, 422, `source.${key}`);
    }
  }
  if (typeof value.kind !== "string" || !SAFE_ID.test(value.kind)) {
    throw new WorkspaceTaskStoreError("task.source_invalid", "source.kind must be a safe identifier.", 422, "source.kind");
  }
  if (
    value.actor !== undefined &&
    (typeof value.actor !== "string" || value.actor.length === 0 || value.actor.length > 255 || value.actor.includes("\0"))
  ) {
    throw new WorkspaceTaskStoreError("task.source_invalid", "source.actor must be non-empty text up to 255 characters.", 422, "source.actor");
  }
  return { kind: value.kind, ...(value.actor === undefined ? {} : { actor: value.actor }) };
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

async function readJson(path, code, message) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      throw new WorkspaceTaskStoreError(code, message, 409);
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

function taskPaths(workspaceRoot, taskId) {
  const tasksRoot = join(workspaceRoot, TASKS_DIRECTORY);
  const root = join(tasksRoot, taskId);
  return {
    tasksRoot,
    root,
    workingCopy: join(root, WORKING_COPY_FILE),
    metadata: join(root, METADATA_FILE),
    revisions: join(root, REVISIONS_DIRECTORY),
    preflights: join(root, PREFLIGHTS_DIRECTORY),
    deltas: join(root, DELTAS_DIRECTORY),
    lock: join(root, LOCK_FILE),
    activeTask: join(workspaceRoot, ACTIVE_TASK_FILE),
  };
}

function taskRevisionFile(paths, taskRevision) {
  return join(paths.revisions, `task-revision-${String(taskRevision).padStart(4, "0")}.json`);
}

function preflightFile(paths, preflightId) {
  return join(paths.preflights, `${requireTaskId(preflightId, "preflightId")}.json`);
}

function revisionDeltaFile(paths, revisionDeltaId) {
  return join(paths.deltas, `${requireTaskId(revisionDeltaId, "revisionDeltaId")}.json`);
}

function publicWorkspace(workspace) {
  return {
    workspaceId: workspace.workspaceId,
    projectId: workspace.projectId,
    projectRoot: workspace.projectRoot,
    workspaceRevision: workspace.workspaceRevision,
    configSha256: workspace.configSha256,
  };
}

function validateWorkingCopy(value, expected) {
  if (
    !value || value.schemaVersion !== SCHEMA_VERSION || value.owner !== OWNER ||
    value.workspaceId !== expected.workspaceId || value.taskId !== expected.taskId ||
    !Number.isSafeInteger(value.workingCopyGeneration) || value.workingCopyGeneration < 1 ||
    (value.baseTaskRevision !== null && (!Number.isSafeInteger(value.baseTaskRevision) || value.baseTaskRevision < 1)) ||
    typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt)) ||
    !value.task || typeof value.task !== "object" || Array.isArray(value.task) ||
    Object.hasOwn(value, "taskRevision")
  ) {
    throw new WorkspaceTaskStoreError("task.working_copy_corrupt", "Working copy metadata is invalid.", 409);
  }
  normalizeSource(value.source);
  requireDraft(value.task, expected.taskId);
  return value;
}

function validateMetadata(value, expected) {
  const workingCopyState = value?.workingCopyState;
  if (
    !value || value.schemaVersion !== SCHEMA_VERSION || value.owner !== OWNER ||
    value.workspaceId !== expected.workspaceId || value.taskId !== expected.taskId ||
    typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt)) ||
    !Number.isSafeInteger(value.nextTaskRevision) || value.nextTaskRevision < 1 ||
    !workingCopyState || typeof workingCopyState !== "object" || Array.isArray(workingCopyState) ||
    !Number.isSafeInteger(workingCopyState.workingCopyGeneration) || workingCopyState.workingCopyGeneration < 1 ||
    (workingCopyState.baseTaskRevision !== null &&
      (!Number.isSafeInteger(workingCopyState.baseTaskRevision) || workingCopyState.baseTaskRevision < 1)) ||
    !new Set(["draft", "validated", "frozen"]).has(workingCopyState.lifecycleStatus) ||
    (workingCopyState.validatedWorkingCopyGeneration !== null &&
      (!Number.isSafeInteger(workingCopyState.validatedWorkingCopyGeneration) ||
        workingCopyState.validatedWorkingCopyGeneration < 1)) ||
    (workingCopyState.validatedTaskSha256 !== null &&
      !SHA256.test(workingCopyState.validatedTaskSha256 ?? "")) ||
    (workingCopyState.revisionDeltaId !== undefined &&
      !SAFE_ID.test(workingCopyState.revisionDeltaId)) ||
    (workingCopyState.lifecycleStatus === "frozen" &&
      (!Number.isSafeInteger(workingCopyState.frozenTaskRevision) ||
        workingCopyState.frozenTaskRevision < 1)) ||
    !value.taskRevisions || typeof value.taskRevisions !== "object" || Array.isArray(value.taskRevisions)
  ) {
    throw new WorkspaceTaskStoreError("task.metadata_corrupt", "Task metadata is invalid.", 409);
  }
  for (const [taskRevisionKey, taskRevisionMetadata] of Object.entries(value.taskRevisions)) {
    if (
      !/^[1-9]\d*$/.test(taskRevisionKey) ||
      !taskRevisionMetadata || typeof taskRevisionMetadata !== "object" || Array.isArray(taskRevisionMetadata) ||
      !SHA256.test(taskRevisionMetadata.taskSha256 ?? "") ||
      !new Set(["frozen", "submitted"]).has(taskRevisionMetadata.lifecycleStatus) ||
      typeof taskRevisionMetadata.frozenAt !== "string" ||
      !Number.isFinite(Date.parse(taskRevisionMetadata.frozenAt)) ||
      !Array.isArray(taskRevisionMetadata.submittedRuns) ||
      !taskRevisionMetadata.submittedRuns.every((runId) => typeof runId === "string" && SAFE_ID.test(runId)) ||
      (taskRevisionMetadata.supersedes !== undefined &&
        (!Number.isSafeInteger(taskRevisionMetadata.supersedes) || taskRevisionMetadata.supersedes < 1)) ||
      (taskRevisionMetadata.supersededBy !== undefined &&
        (!Number.isSafeInteger(taskRevisionMetadata.supersededBy) || taskRevisionMetadata.supersededBy < 1)) ||
      (taskRevisionMetadata.revisionDeltaId !== undefined &&
        !SAFE_ID.test(taskRevisionMetadata.revisionDeltaId))
    ) {
      throw new WorkspaceTaskStoreError("task.metadata_corrupt", "Task Revision metadata is invalid.", 409);
    }
  }
  for (const [taskRevisionKey, taskRevisionMetadata] of Object.entries(value.taskRevisions)) {
    if (taskRevisionMetadata.supersededBy !== undefined) {
      const successor = value.taskRevisions[String(taskRevisionMetadata.supersededBy)];
      if (!successor || successor.supersedes !== Number(taskRevisionKey)) {
        throw new WorkspaceTaskStoreError("task.metadata_corrupt", "Task supersession lineage is inconsistent.", 409);
      }
    }
    if (taskRevisionMetadata.supersedes !== undefined) {
      const predecessor = value.taskRevisions[String(taskRevisionMetadata.supersedes)];
      if (!predecessor || predecessor.supersededBy !== Number(taskRevisionKey)) {
        throw new WorkspaceTaskStoreError("task.metadata_corrupt", "Task Revision provenance is incomplete.", 409);
      }
    }
  }
  return value;
}

function validateActiveTask(value, workspaceId) {
  const expectedKeys = new Set(["workspaceId", "taskId", "taskRevision", "taskSha256"]);
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some((key) => !expectedKeys.has(key)) ||
    Object.keys(value).length !== expectedKeys.size ||
    value.workspaceId !== workspaceId || !SAFE_ID.test(value.taskId ?? "") ||
    !Number.isSafeInteger(value.taskRevision) || value.taskRevision < 1 ||
    !SHA256.test(value.taskSha256 ?? "")
  ) {
    throw new WorkspaceTaskStoreError("task.active_task_corrupt", "Active Task reference is invalid.", 409);
  }
  return value;
}

function validateRevisionArtifact(value, reference) {
  const expectedKeys = new Set([
    "schemaVersion", "owner", "workspaceId", "taskId", "taskRevision", "taskSha256", "task",
  ]);
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some((key) => !expectedKeys.has(key)) ||
    value.schemaVersion !== SCHEMA_VERSION || value.owner !== OWNER ||
    value.workspaceId !== reference.workspaceId || value.taskId !== reference.taskId ||
    value.taskRevision !== reference.taskRevision || value.taskSha256 !== reference.taskSha256
  ) {
    throw new WorkspaceTaskStoreError(
      "task.task_revision_corrupt",
      "Task Revision does not match its immutable reference.",
      409,
    );
  }
  const canonical = normalizeTaskCard(value.task, { allowLegacy: false }).task;
  if (sha256(canonical) !== reference.taskSha256) {
    throw new WorkspaceTaskStoreError(
      "task.task_revision_corrupt",
      "Task Revision content hash does not match its immutable reference.",
      409,
    );
  }
  return { ...value, task: canonical };
}

export function createWorkspaceTaskStore(options = {}) {
  if (!options.projectConfigStore || typeof options.projectConfigStore.resolveWorkspace !== "function") {
    throw new WorkspaceTaskStoreError(
      "task.workspace_resolver_required",
      "A project configuration store with resolveWorkspace() is required.",
      500,
    );
  }
  const projectConfigStore = options.projectConfigStore;
  const clock = options.clock ?? (() => new Date());
  const nonceFactory = options.nonceFactory ?? randomUUID;

  async function resolveTask(projectRoot, taskId) {
    const workspace = await projectConfigStore.resolveWorkspace(projectRoot);
    const safeTaskId = requireTaskId(taskId);
    const paths = taskPaths(workspace.workspaceRoot, safeTaskId);
    return { workspace, taskId: safeTaskId, paths };
  }

  async function ensureTasksRoot(paths) {
    const type = await pathType(paths.tasksRoot);
    if (type === "missing") await mkdir(paths.tasksRoot, { mode: 0o700 });
    else if (type !== "directory") {
      throw new WorkspaceTaskStoreError("task.store_unsafe", "Workspace tasks path is unsafe.", 409);
    }
  }

  async function readTaskState(resolved) {
    const rootType = await pathType(resolved.paths.root);
    if (rootType === "missing") {
      throw new WorkspaceTaskStoreError("task.not_found", "Workspace Task was not found.", 404);
    }
    if (rootType !== "directory") {
      throw new WorkspaceTaskStoreError("task.store_unsafe", "Workspace Task path is unsafe.", 409);
    }
    for (const path of [resolved.paths.workingCopy, resolved.paths.metadata]) {
      if ((await pathType(path)) !== "file") {
        throw new WorkspaceTaskStoreError("task.store_unsafe", "Workspace Task state is incomplete or unsafe.", 409);
      }
    }
    if ((await pathType(resolved.paths.revisions)) !== "directory") {
      throw new WorkspaceTaskStoreError("task.store_unsafe", "Task revision storage is unsafe.", 409);
    }
    const expected = { workspaceId: resolved.workspace.workspaceId, taskId: resolved.taskId };
    const result = {
      workingCopy: validateWorkingCopy(
        await readJson(resolved.paths.workingCopy, "task.working_copy_corrupt", "Working copy is not valid JSON."),
        expected,
      ),
      metadata: validateMetadata(
        await readJson(resolved.paths.metadata, "task.metadata_corrupt", "Task metadata is not valid JSON."),
        expected,
      ),
    };
    if (
      result.metadata.workingCopyState.workingCopyGeneration !== result.workingCopy.workingCopyGeneration ||
      result.metadata.workingCopyState.baseTaskRevision !== result.workingCopy.baseTaskRevision
    ) {
      throw new WorkspaceTaskStoreError(
        "task.metadata_corrupt",
        "Working copy identity does not match Task metadata.",
        409,
      );
    }
    return result;
  }

  async function withTaskLock(resolved, operation) {
    const rootType = await pathType(resolved.paths.root);
    if (rootType === "missing") {
      throw new WorkspaceTaskStoreError("task.not_found", "Workspace Task was not found.", 404);
    }
    if (rootType !== "directory") {
      throw new WorkspaceTaskStoreError("task.store_unsafe", "Workspace Task path is unsafe.", 409);
    }
    let handle;
    try {
      handle = await open(resolved.paths.lock, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquiredAt: clock().toISOString() })}\n`);
    } catch (error) {
      await handle?.close();
      if (handle) await rm(resolved.paths.lock, { force: true });
      if (error?.code === "EEXIST") {
        throw new WorkspaceTaskStoreError("task.locked", "Another Task Card write is active.", 409);
      }
      throw error;
    }
    try {
      return await operation();
    } finally {
      await handle?.close();
      await rm(resolved.paths.lock, { force: true });
    }
  }

  function assertExpectedGeneration(workingCopy, expectedWorkingCopyGeneration) {
    requireWorkingCopyGeneration(expectedWorkingCopyGeneration);
    if (workingCopy.workingCopyGeneration !== expectedWorkingCopyGeneration) {
      throw new WorkspaceTaskStoreError(
        "task.working_copy_conflict",
        "Working copy changed after it was read.",
        409,
        "expectedWorkingCopyGeneration",
      );
    }
  }

  async function create({ projectRoot, taskId, task, source } = {}) {
    const resolved = await resolveTask(projectRoot, taskId);
    await ensureTasksRoot(resolved.paths);
    const taskRootType = await pathType(resolved.paths.root);
    if (taskRootType !== "missing") {
      if (taskRootType !== "directory") {
        throw new WorkspaceTaskStoreError("task.store_unsafe", "Workspace Task path is unsafe.", 409);
      }
      throw new WorkspaceTaskStoreError("task.already_exists", "Workspace Task already exists.", 409);
    }
    const now = clock().toISOString();
    const normalizedSource = normalizeSource(source);
    const draft = requireDraft(task ?? { ...createTaskCardTemplate(), id: resolved.taskId }, resolved.taskId);
    const temporary = `${resolved.paths.root}.tmp-${nonceFactory()}`;
    await mkdir(temporary, { mode: 0o700 });
    try {
      await mkdir(join(temporary, REVISIONS_DIRECTORY), { mode: 0o700 });
      await mkdir(join(temporary, PREFLIGHTS_DIRECTORY), { mode: 0o700 });
      await mkdir(join(temporary, DELTAS_DIRECTORY), { mode: 0o700 });
      const workingCopy = {
        schemaVersion: SCHEMA_VERSION,
        owner: OWNER,
        workspaceId: resolved.workspace.workspaceId,
        taskId: resolved.taskId,
        workingCopyGeneration: 1,
        baseTaskRevision: null,
        createdAt: now,
        updatedAt: now,
        source: normalizedSource,
        task: draft,
      };
      const metadata = {
        schemaVersion: SCHEMA_VERSION,
        owner: OWNER,
        workspaceId: resolved.workspace.workspaceId,
        taskId: resolved.taskId,
        createdAt: now,
        updatedAt: now,
        nextTaskRevision: 1,
        workingCopyState: {
          workingCopyGeneration: 1,
          baseTaskRevision: null,
          lifecycleStatus: "draft",
          validatedWorkingCopyGeneration: null,
          validatedTaskSha256: null,
        },
        taskRevisions: {},
      };
      await writeFile(join(temporary, WORKING_COPY_FILE), `${JSON.stringify(workingCopy, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await writeFile(join(temporary, METADATA_FILE), `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporary, resolved.paths.root);
      return { workspace: publicWorkspace(resolved.workspace), workingCopy, metadata };
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      if (error?.code === "EEXIST") {
        throw new WorkspaceTaskStoreError("task.already_exists", "Workspace Task already exists.", 409);
      }
      throw error;
    }
  }

  async function write({ projectRoot, taskId, expectedWorkingCopyGeneration, task, source } = {}) {
    const resolved = await resolveTask(projectRoot, taskId);
    return withTaskLock(resolved, async () => {
      const current = await readTaskState(resolved);
      assertExpectedGeneration(current.workingCopy, expectedWorkingCopyGeneration);
      if (current.metadata.workingCopyState.lifecycleStatus === "frozen") {
        throw new WorkspaceTaskStoreError(
          "task.working_copy_frozen",
          "A frozen working copy cannot be edited in place; create a new working copy from its Task Revision.",
          409,
        );
      }
      const now = clock().toISOString();
      const workingCopy = {
        ...current.workingCopy,
        workingCopyGeneration: current.workingCopy.workingCopyGeneration + 1,
        updatedAt: now,
        source: normalizeSource(source ?? current.workingCopy.source),
        task: requireDraft(task, resolved.taskId),
      };
      const metadata = {
        ...current.metadata,
        updatedAt: now,
        workingCopyState: {
          workingCopyGeneration: workingCopy.workingCopyGeneration,
          baseTaskRevision: workingCopy.baseTaskRevision,
          lifecycleStatus: "draft",
          validatedWorkingCopyGeneration: null,
          validatedTaskSha256: null,
        },
      };
      let workingCopyWritten = false;
      try {
        await writeJsonAtomic(resolved.paths.workingCopy, workingCopy, nonceFactory());
        workingCopyWritten = true;
        await writeJsonAtomic(resolved.paths.metadata, metadata, nonceFactory());
      } catch (error) {
        if (workingCopyWritten) {
          await writeJsonAtomic(resolved.paths.workingCopy, current.workingCopy, nonceFactory());
        }
        throw error;
      }
      return { workspace: publicWorkspace(resolved.workspace), workingCopy, metadata };
    });
  }

  async function validate({ projectRoot, taskId, expectedWorkingCopyGeneration } = {}) {
    const resolved = await resolveTask(projectRoot, taskId);
    return withTaskLock(resolved, async () => {
      const current = await readTaskState(resolved);
      assertExpectedGeneration(current.workingCopy, expectedWorkingCopyGeneration);
      const normalized = normalizeTaskCard(current.workingCopy.task, { allowLegacy: false });
      const taskSha256 = taskCardSha256(normalized.task);
      const metadata = {
        ...current.metadata,
        updatedAt: clock().toISOString(),
        workingCopyState: {
          ...current.metadata.workingCopyState,
          lifecycleStatus: "validated",
          validatedWorkingCopyGeneration: current.workingCopy.workingCopyGeneration,
          validatedTaskSha256: taskSha256,
        },
      };
      await writeJsonAtomic(resolved.paths.metadata, metadata, nonceFactory());
      return {
        valid: true,
        workspace: publicWorkspace(resolved.workspace),
        workingCopyGeneration: current.workingCopy.workingCopyGeneration,
        taskSha256,
        task: normalized.task,
      };
    });
  }

  async function freeze({ projectRoot, taskId, expectedWorkingCopyGeneration } = {}) {
    const resolved = await resolveTask(projectRoot, taskId);
    return withTaskLock(resolved, async () => {
      const current = await readTaskState(resolved);
      assertExpectedGeneration(current.workingCopy, expectedWorkingCopyGeneration);
      const state = current.metadata.workingCopyState;
      if (
        state.lifecycleStatus !== "validated" ||
        state.validatedWorkingCopyGeneration !== current.workingCopy.workingCopyGeneration
      ) {
        throw new WorkspaceTaskStoreError(
          "task.working_copy_not_validated",
          "The current working copy generation must be validated before freeze.",
          409,
        );
      }
      const normalized = normalizeTaskCard(current.workingCopy.task, { allowLegacy: false });
      const taskSha256 = taskCardSha256(normalized.task);
      if (taskSha256 !== state.validatedTaskSha256) {
        throw new WorkspaceTaskStoreError(
          "task.working_copy_validation_stale",
          "The validated Task Card content no longer matches the working copy.",
          409,
        );
      }
      const taskRevision = current.metadata.nextTaskRevision;
      const frozenAt = clock().toISOString();
      const taskReference = {
        workspaceId: resolved.workspace.workspaceId,
        taskId: resolved.taskId,
        taskRevision,
        taskSha256,
      };
      const revisionArtifact = {
        schemaVersion: SCHEMA_VERSION,
        owner: OWNER,
        ...taskReference,
        task: normalized.task,
      };
      const activeTask = taskReference;
      const revisionPath = taskRevisionFile(resolved.paths, taskRevision);
      const activeType = await pathType(resolved.paths.activeTask);
      if (!new Set(["missing", "file"]).has(activeType)) {
        throw new WorkspaceTaskStoreError("task.active_task_unsafe", "Active Task reference path is unsafe.", 409);
      }
      const priorActive = activeType === "file" ? await readJson(
        resolved.paths.activeTask,
        "task.active_task_corrupt",
        "Active Task reference is not valid JSON.",
      ) : null;
      if (priorActive) validateActiveTask(priorActive, resolved.workspace.workspaceId);
      const metadata = clone(current.metadata);
      metadata.updatedAt = frozenAt;
      metadata.nextTaskRevision = taskRevision + 1;
      metadata.workingCopyState = {
        ...metadata.workingCopyState,
        lifecycleStatus: "frozen",
        frozenTaskRevision: taskRevision,
      };
      metadata.taskRevisions[String(taskRevision)] = {
        taskSha256,
        lifecycleStatus: "frozen",
        frozenAt,
        source: current.workingCopy.source,
        submittedRuns: [],
        ...(current.workingCopy.baseTaskRevision === null ? {} : {
          supersedes: current.workingCopy.baseTaskRevision,
        }),
      };
      let revisionWritten = false;
      let metadataWritten = false;
      let activeWritten = false;
      try {
        await writeFile(revisionPath, `${JSON.stringify(revisionArtifact, null, 2)}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o400,
        });
        revisionWritten = true;
        await writeJsonAtomic(resolved.paths.metadata, metadata, nonceFactory());
        metadataWritten = true;
        await writeJsonAtomic(resolved.paths.activeTask, activeTask, nonceFactory());
        activeWritten = true;
      } catch (error) {
        if (activeWritten) {
          if (priorActive) await writeJsonAtomic(resolved.paths.activeTask, priorActive, nonceFactory());
          else await rm(resolved.paths.activeTask, { force: true });
        }
        if (metadataWritten) {
          await writeJsonAtomic(resolved.paths.metadata, current.metadata, nonceFactory());
        }
        if (revisionWritten) await rm(revisionPath, { force: true });
        if (error?.code === "EEXIST") {
          throw new WorkspaceTaskStoreError("task.task_revision_conflict", "Task Revision already exists.", 409);
        }
        throw error;
      }
      return {
        workspace: publicWorkspace(resolved.workspace),
        task: taskReference,
        activeTask,
        revisionArtifact,
        metadata,
      };
    });
  }

  async function current({ projectRoot, taskId } = {}) {
    const workspace = await projectConfigStore.resolveWorkspace(projectRoot, { register: false });
    const paths = taskPaths(workspace.workspaceRoot, "placeholder");
    const activeType = await pathType(paths.activeTask);
    if (activeType === "missing" && taskId === undefined) {
      return { workspace: publicWorkspace(workspace), activeTask: null };
    }
    if (activeType !== "missing" && activeType !== "file") {
      throw new WorkspaceTaskStoreError("task.active_task_unsafe", "Active Task reference path is unsafe.", 409);
    }
    const activeTask = activeType === "file"
      ? validateActiveTask(
        await readJson(paths.activeTask, "task.active_task_corrupt", "Active Task reference is not valid JSON."),
        workspace.workspaceId,
      )
      : null;
    if (taskId !== undefined) {
      const safeTaskId = requireTaskId(taskId);
      const resolvedDraft = {
        workspace,
        taskId: safeTaskId,
        paths: taskPaths(workspace.workspaceRoot, safeTaskId),
      };
      const state = await readTaskState(resolvedDraft);
      const frozenTaskRevision = state.metadata.workingCopyState.frozenTaskRevision ?? null;
      if (state.metadata.workingCopyState.lifecycleStatus === "frozen") {
        const taskRevisionMetadata = state.metadata.taskRevisions[String(frozenTaskRevision)];
        if (!taskRevisionMetadata) {
          throw new WorkspaceTaskStoreError("task.metadata_corrupt", "Frozen Task Revision metadata is missing.", 409);
        }
        const taskReference = {
          workspaceId: workspace.workspaceId,
          taskId: safeTaskId,
          taskRevision: frozenTaskRevision,
          taskSha256: taskRevisionMetadata.taskSha256,
        };
        const revisionPath = taskRevisionFile(resolvedDraft.paths, frozenTaskRevision);
        const revisionType = await pathType(revisionPath);
        if (revisionType === "missing") {
          throw new WorkspaceTaskStoreError("task.task_revision_missing", "Frozen Task Revision is missing.", 409);
        }
        if (revisionType !== "file") {
          throw new WorkspaceTaskStoreError("task.task_revision_unsafe", "Frozen Task Revision path is unsafe.", 409);
        }
        return {
          workspace: publicWorkspace(workspace),
          activeTask,
          revisionArtifact: validateRevisionArtifact(
            await readJson(revisionPath, "task.task_revision_corrupt", "Task Revision is not valid JSON."),
            taskReference,
          ),
          metadata: state.metadata,
        };
      }
      return {
        workspace: publicWorkspace(workspace),
        activeTask,
        workingCopy: state.workingCopy,
        metadata: state.metadata,
      };
    }
    const resolved = {
      workspace,
      taskId: activeTask.taskId,
      paths: taskPaths(workspace.workspaceRoot, activeTask.taskId),
    };
    const state = await readTaskState(resolved);
    const revisionPath = taskRevisionFile(resolved.paths, activeTask.taskRevision);
    const revisionType = await pathType(revisionPath);
    if (revisionType === "missing") {
      throw new WorkspaceTaskStoreError("task.task_revision_missing", "Active Task Revision is missing.", 409);
    }
    if (revisionType !== "file") {
      throw new WorkspaceTaskStoreError("task.task_revision_unsafe", "Active Task Revision path is unsafe.", 409);
    }
    const revisionArtifact = validateRevisionArtifact(
      await readJson(revisionPath, "task.task_revision_corrupt", "Task Revision is not valid JSON."),
      activeTask,
    );
    return {
      workspace: publicWorkspace(workspace),
      activeTask,
      revisionArtifact,
      metadata: state.metadata,
    };
  }

  async function list({ projectRoot } = {}) {
    const workspace = await projectConfigStore.resolveWorkspace(projectRoot, { register: false });
    const paths = taskPaths(workspace.workspaceRoot, "placeholder");
    const tasksRootType = await pathType(paths.tasksRoot);
    if (tasksRootType === "missing") {
      return {
        workspace: publicWorkspace(workspace),
        activeTask: null,
        tasks: [],
        corruptEntries: 0,
      };
    }
    if (tasksRootType !== "directory") {
      throw new WorkspaceTaskStoreError("task.store_unsafe", "Workspace tasks path is unsafe.", 409);
    }
    const activeType = await pathType(paths.activeTask);
    if (!new Set(["missing", "file"]).has(activeType)) {
      throw new WorkspaceTaskStoreError("task.active_task_unsafe", "Active Task reference path is unsafe.", 409);
    }
    const activeTask = activeType === "file"
      ? validateActiveTask(
        await readJson(paths.activeTask, "task.active_task_corrupt", "Active Task reference is not valid JSON."),
        workspace.workspaceId,
      )
      : null;
    const entries = await readdir(paths.tasksRoot, { withFileTypes: true });
    const tasks = [];
    let corruptEntries = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) {
        corruptEntries += 1;
        continue;
      }
      const resolved = {
        workspace,
        taskId: entry.name,
        paths: taskPaths(workspace.workspaceRoot, entry.name),
      };
      try {
        const state = await readTaskState(resolved);
        const frozenTaskRevision = state.metadata.workingCopyState.frozenTaskRevision ?? null;
        const frozenLifecycle = frozenTaskRevision === null
          ? null
          : state.metadata.taskRevisions[String(frozenTaskRevision)]?.lifecycleStatus ?? null;
        tasks.push({
          taskId: entry.name,
          lifecycleStatus: frozenLifecycle ?? state.metadata.workingCopyState.lifecycleStatus,
          workingCopyGeneration: state.workingCopy.workingCopyGeneration,
          baseTaskRevision: state.workingCopy.baseTaskRevision,
          validatedWorkingCopyGeneration:
            state.metadata.workingCopyState.validatedWorkingCopyGeneration,
          frozenTaskRevision,
          updatedAt: state.metadata.updatedAt,
          active: activeTask?.taskId === entry.name &&
            activeTask.taskRevision === state.metadata.workingCopyState.frozenTaskRevision,
        });
      } catch (error) {
        if (!(error instanceof WorkspaceTaskStoreError)) throw error;
        corruptEntries += 1;
      }
    }
    tasks.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    if (
      activeTask &&
      !tasks.some((task) => task.taskId === activeTask.taskId && task.active)
    ) {
      throw new WorkspaceTaskStoreError(
        "task.active_task_corrupt",
        "Active Task reference does not resolve to a readable frozen Task Revision.",
        409,
      );
    }
    if (activeTask) await current({ projectRoot });
    return {
      workspace: publicWorkspace(workspace),
      activeTask,
      tasks,
      corruptEntries,
    };
  }

  function assertActivationMatchesWorkspace(activation, workspace) {
    const skillSha256 = typeof activation?.effectiveSkillSha256 === "string" &&
      activation.effectiveSkillSha256.startsWith("sha256:")
      ? activation.effectiveSkillSha256.slice("sha256:".length)
      : activation?.effectiveSkillSha256;
    const projectHash = typeof activation?.projectBinding?.projectConfigSha256 === "string" &&
      activation.projectBinding.projectConfigSha256.startsWith("sha256:")
      ? activation.projectBinding.projectConfigSha256.slice("sha256:".length)
      : activation?.projectBinding?.projectConfigSha256;
    if (
      !activation?.activationId || !SAFE_ID.test(activation.activationId) ||
      !SHA256.test(skillSha256 ?? "") ||
      activation.projectBinding?.workspaceId !== workspace.workspaceId ||
      activation.projectBinding?.projectRevision !== workspace.workspaceRevision ||
      projectHash !== workspace.configSha256
    ) {
      throw new WorkspaceTaskStoreError(
        "preflight.activation_binding_required",
        "Preflight requires the currently activated Skill to match this Workspace revision and configuration.",
        409,
      );
    }
    return {
      activationId: activation.activationId,
      effectiveSkillSha256: skillSha256,
    };
  }

  async function ensurePreflightRoot(paths) {
    const type = await pathType(paths.preflights);
    if (type === "missing") await mkdir(paths.preflights, { mode: 0o700 });
    else if (type !== "directory") {
      throw new WorkspaceTaskStoreError("preflight.store_unsafe", "Task Preflight path is unsafe.", 409);
    }
  }

  async function revise({ projectRoot, taskId, baseTask, delta, source, review } = {}) {
    const resolved = await resolveTask(projectRoot, taskId);
    return withTaskLock(resolved, async () => {
      const currentState = await readTaskState(resolved);
      const active = validateActiveTask(
        await readJson(
          resolved.paths.activeTask,
          "task.active_task_corrupt",
          "Active Task reference is not valid JSON.",
        ),
        resolved.workspace.workspaceId,
      );
      if (
        !baseTask || active.taskId !== baseTask.taskId ||
        active.taskRevision !== baseTask.taskRevision || active.taskSha256 !== baseTask.taskSha256 ||
        active.taskId !== resolved.taskId
      ) {
        throw new WorkspaceTaskStoreError(
          "revision_delta.base_task_stale",
          "Revision Delta must be based on the current active immutable Task Revision.",
          409,
        );
      }
      const baseArtifact = validateRevisionArtifact(
        await readJson(
          taskRevisionFile(resolved.paths, active.taskRevision),
          "task.task_revision_corrupt",
          "Task Revision is not valid JSON.",
        ),
        active,
      );
      const normalizedDelta = normalizeRevisionDeltaInput(delta, WorkspaceTaskStoreError);
      const candidate = validateBoundedTaskRevision(
        baseArtifact.task,
        normalizedDelta.task,
        WorkspaceTaskStoreError,
      );
      const taskRevision = currentState.metadata.nextTaskRevision;
      const taskSha256 = taskCardSha256(candidate);
      if (taskSha256 === active.taskSha256) {
        throw new WorkspaceTaskStoreError(
          "revision_delta.no_change",
          "Revision Delta must produce a different Task contract.",
          409,
        );
      }
      const timestamp = clock().toISOString();
      const resultTask = {
        workspaceId: resolved.workspace.workspaceId,
        taskId: resolved.taskId,
        taskRevision,
        taskSha256,
      };
      const revisionDeltaId = `delta-${timestamp.replace(/[^0-9]/g, "")}-${nonceFactory()}`.toLowerCase();
      const normalizedSource = normalizeSource(source);
      const deltaArtifact = createRevisionDeltaArtifact({
        revisionDeltaId,
        createdAt: timestamp,
        source: normalizedSource,
        baseTask: active,
        resultTask,
        review,
        delta: { ...normalizedDelta, task: candidate },
      }, WorkspaceTaskStoreError);
      const revisionArtifact = {
        schemaVersion: SCHEMA_VERSION,
        owner: OWNER,
        ...resultTask,
        task: candidate,
      };
      const workingCopy = {
        ...currentState.workingCopy,
        workingCopyGeneration: currentState.workingCopy.workingCopyGeneration + 1,
        baseTaskRevision: active.taskRevision,
        updatedAt: timestamp,
        source: normalizedSource,
        task: candidate,
      };
      const metadata = clone(currentState.metadata);
      metadata.updatedAt = timestamp;
      metadata.nextTaskRevision = taskRevision + 1;
      metadata.workingCopyState = {
        workingCopyGeneration: workingCopy.workingCopyGeneration,
        baseTaskRevision: active.taskRevision,
        lifecycleStatus: "frozen",
        validatedWorkingCopyGeneration: workingCopy.workingCopyGeneration,
        validatedTaskSha256: taskSha256,
        frozenTaskRevision: taskRevision,
        revisionDeltaId,
      };
      metadata.taskRevisions[String(active.taskRevision)] = {
        ...metadata.taskRevisions[String(active.taskRevision)],
        supersededBy: taskRevision,
      };
      metadata.taskRevisions[String(taskRevision)] = {
        taskSha256,
        lifecycleStatus: "frozen",
        frozenAt: timestamp,
        source: normalizedSource,
        submittedRuns: [],
        supersedes: active.taskRevision,
        revisionDeltaId,
      };
      const revisionPath = taskRevisionFile(resolved.paths, taskRevision);
      const deltaPath = revisionDeltaFile(resolved.paths, revisionDeltaId);
      const deltaRootType = await pathType(resolved.paths.deltas);
      if (deltaRootType === "missing") await mkdir(resolved.paths.deltas, { mode: 0o700 });
      else if (deltaRootType !== "directory") {
        throw new WorkspaceTaskStoreError("revision_delta.store_unsafe", "Revision Delta storage is unsafe.", 409);
      }
      let revisionWritten = false;
      let deltaWritten = false;
      let workingCopyWritten = false;
      let metadataWritten = false;
      try {
        await writeFile(revisionPath, `${JSON.stringify(revisionArtifact, null, 2)}\n`, {
          encoding: "utf8", flag: "wx", mode: 0o400,
        });
        revisionWritten = true;
        await writeFile(deltaPath, `${JSON.stringify(deltaArtifact, null, 2)}\n`, {
          encoding: "utf8", flag: "wx", mode: 0o400,
        });
        deltaWritten = true;
        await writeJsonAtomic(resolved.paths.workingCopy, workingCopy, nonceFactory());
        workingCopyWritten = true;
        await writeJsonAtomic(resolved.paths.metadata, metadata, nonceFactory());
        metadataWritten = true;
        await writeJsonAtomic(resolved.paths.activeTask, resultTask, nonceFactory());
      } catch (error) {
        if (metadataWritten) await writeJsonAtomic(resolved.paths.metadata, currentState.metadata, nonceFactory());
        if (workingCopyWritten) await writeJsonAtomic(resolved.paths.workingCopy, currentState.workingCopy, nonceFactory());
        if (deltaWritten) await rm(deltaPath, { force: true });
        if (revisionWritten) await rm(revisionPath, { force: true });
        throw error;
      }
      return {
        workspace: publicWorkspace(resolved.workspace),
        workingCopy,
        metadata,
        task: resultTask,
        activeTask: resultTask,
        revisionArtifact,
        revisionDelta: deltaArtifact,
      };
    });
  }

  async function revisionDelta({ projectRoot, taskId, revisionDeltaId } = {}) {
    const resolved = await resolveTask(projectRoot, taskId);
    const path = revisionDeltaFile(resolved.paths, revisionDeltaId);
    if ((await pathType(path)) !== "file") {
      throw new WorkspaceTaskStoreError("revision_delta.not_found", "Revision Delta was not found.", 404);
    }
    return validateRevisionDeltaArtifact(
      await readJson(path, "revision_delta.corrupt", "Revision Delta is not valid JSON."),
      { revisionDeltaId },
      WorkspaceTaskStoreError,
    );
  }

  async function createPreflight({
    projectRoot,
    taskId,
    taskRevision,
    taskSha256,
    preflightResult,
    activation,
  } = {}) {
    const workspace = await projectConfigStore.resolveWorkspace(projectRoot, { register: false });
    const active = await current({ projectRoot });
    if (!active.activeTask || active.activeTask.taskId !== taskId) {
      throw new WorkspaceTaskStoreError(
        "preflight.active_task_mismatch",
        "Preflight can only freeze a receipt for the active immutable Task Revision.",
        409,
      );
    }
    if (
      active.activeTask.taskRevision !== taskRevision ||
      active.activeTask.taskSha256 !== taskSha256
    ) {
      throw new WorkspaceTaskStoreError(
        "preflight.task_reference_stale",
        "The requested Task Revision does not match the active immutable Task reference.",
        409,
      );
    }
    if (
      preflightResult?.ready !== true || !preflightResult.envelope ||
      preflightResult.taskSha256 !== taskSha256 ||
      preflightResult.envelope.taskId !== taskId ||
      preflightResult.envelope.taskSha256 !== taskSha256
    ) {
      throw new WorkspaceTaskStoreError(
        "preflight.result_not_ready",
        "Only a successful Preflight bound to the active Task Revision can be persisted.",
        409,
      );
    }
    const workflow = assertActivationMatchesWorkspace(activation, workspace);
    const timestamp = clock().toISOString();
    const preflightId = `preflight-${timestamp.replace(/[^0-9]/g, "")}-${nonceFactory()}`.toLowerCase();
    const receipt = createPreflightReceipt({
      preflightId,
      createdAt: timestamp,
      task: active.activeTask,
      workflow: {
        workspaceRevision: workspace.workspaceRevision,
        configSha256: workspace.configSha256,
        ...workflow,
      },
      runtimeEnvelope: preflightResult.envelope,
      checks: preflightResult.checks,
      issues: preflightResult.issues,
    });
    const paths = taskPaths(workspace.workspaceRoot, taskId);
    await ensurePreflightRoot(paths);
    try {
      await writeFile(preflightFile(paths, preflightId), `${JSON.stringify(receipt, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o400,
      });
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new WorkspaceTaskStoreError("preflight.id_conflict", "Preflight Receipt already exists.", 409);
      }
      throw error;
    }
    return { workspace: publicWorkspace(workspace), receipt };
  }

  async function preflight({ projectRoot, taskId, preflightId, activation } = {}) {
    const workspace = await projectConfigStore.resolveWorkspace(projectRoot, { register: false });
    const safeTaskId = requireTaskId(taskId);
    const paths = taskPaths(workspace.workspaceRoot, safeTaskId);
    const receiptPath = preflightFile(paths, preflightId);
    if ((await pathType(receiptPath)) !== "file") {
      throw new WorkspaceTaskStoreError("preflight.not_found", "Preflight Receipt was not found.", 404);
    }
    const receipt = validatePreflightReceipt(
      await readJson(receiptPath, "preflight.receipt_corrupt", "Preflight Receipt is not valid JSON."),
      WorkspaceTaskStoreError,
    );
    const currentWorkspace = publicWorkspace(workspace);
    if (
      receipt.task.workspaceId !== workspace.workspaceId ||
      receipt.task.taskId !== safeTaskId ||
      receipt.workflow.workspaceRevision !== workspace.workspaceRevision ||
      receipt.workflow.configSha256 !== workspace.configSha256
    ) {
      throw new WorkspaceTaskStoreError(
        "preflight.workspace_stale",
        "Workspace configuration changed after this Preflight Receipt was created.",
        409,
      );
    }
    const workflow = assertActivationMatchesWorkspace(activation, workspace);
    if (
      receipt.workflow.activationId !== workflow.activationId ||
      receipt.workflow.effectiveSkillSha256 !== workflow.effectiveSkillSha256
    ) {
      throw new WorkspaceTaskStoreError(
        "preflight.activation_stale",
        "Active Skill changed after this Preflight Receipt was created.",
        409,
      );
    }
    const active = await current({ projectRoot });
    if (
      !active.activeTask ||
      active.activeTask.taskId !== receipt.task.taskId ||
      active.activeTask.taskRevision !== receipt.task.taskRevision ||
      active.activeTask.taskSha256 !== receipt.task.taskSha256
    ) {
      throw new WorkspaceTaskStoreError(
        "preflight.task_reference_stale",
        "Active Task Revision changed after this Preflight Receipt was created.",
        409,
      );
    }
    return {
      workspace: currentWorkspace,
      receipt,
      revisionArtifact: active.revisionArtifact,
    };
  }

  async function recordSubmission({
    projectRoot,
    taskId,
    preflightId,
    runId,
    activation,
  } = {}) {
    const bound = await preflight({ projectRoot, taskId, preflightId, activation });
    const safeRunId = requireTaskId(runId, "runId");
    const resolved = await resolveTask(projectRoot, taskId);
    return withTaskLock(resolved, async () => {
      const state = await readTaskState(resolved);
      const revisionKey = String(bound.receipt.task.taskRevision);
      const revision = state.metadata.taskRevisions[revisionKey];
      if (!revision || revision.taskSha256 !== bound.receipt.task.taskSha256) {
        throw new WorkspaceTaskStoreError(
          "task.submission_reference_stale",
          "Task Revision metadata no longer matches the submitted Preflight Receipt.",
          409,
        );
      }
      if (revision.submittedRuns.includes(safeRunId)) {
        return { workspace: publicWorkspace(resolved.workspace), metadata: state.metadata };
      }
      const metadata = clone(state.metadata);
      metadata.updatedAt = clock().toISOString();
      metadata.taskRevisions[revisionKey] = {
        ...metadata.taskRevisions[revisionKey],
        lifecycleStatus: "submitted",
        submittedRuns: [...metadata.taskRevisions[revisionKey].submittedRuns, safeRunId],
      };
      await writeJsonAtomic(resolved.paths.metadata, metadata, nonceFactory());
      return { workspace: publicWorkspace(resolved.workspace), metadata };
    });
  }

  return Object.freeze({
    create,
    createPreflight,
    current,
    freeze,
    list,
    preflight,
    recordSubmission,
    revise,
    revisionDelta,
    validate,
    write,
  });
}
