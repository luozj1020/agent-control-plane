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
import { homedir } from "node:os";
import { basename, isAbsolute, join, parse, resolve } from "node:path";

import {
  BALANCED_BUDGET_LIMITS,
  BALANCED_TIMING_LIMITS,
  BUILTIN_MODE_CATALOG,
  EXAMPLE_AGENTS,
} from "../../packages/contracts/dist/index.js";

const OWNER = "agent-control-plane";
const REPOSITORY_SCHEMA_VERSION = 2;
const LOCAL_SCHEMA_VERSION = 1;
const LEGACY_SCHEMA_VERSION = 1;
const CONTROL_DIRECTORY = ".agent-control-plane";
const PROJECT_FILE = "project.json";
const WORKFLOW_FILE = "workflow.json";
const HISTORY_DIRECTORY = "history";
const LOCK_FILE = "project.lock";
const INSTALLATION_FILE = "installation.json";
const BINDING_FILE = "binding.json";
const STATE_FILE = "state.json";
const RECENT_FILE = "recent.json";
const MAX_RECENT_PROJECTS = 20;
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

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

function sha256(value) {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function sharedConfigSha256(projectId, overrides) {
  return sha256({ projectId, overrides });
}

function effectiveConfigSha256(projectId, sharedOverrides, localOverrides) {
  return sha256({ projectId, sharedOverrides, localOverrides });
}

function effectiveOverrides(sharedOverrides, localOverrides) {
  return { ...clone(sharedOverrides), ...clone(localOverrides) };
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
    !value || ![LEGACY_SCHEMA_VERSION, REPOSITORY_SCHEMA_VERSION].includes(value.schemaVersion) ||
    value.owner !== OWNER || !safeIdentifier(value.projectId)
  ) {
    throw new ProjectConfigError("project.identity_invalid", "Project identity is invalid or not product-owned.", 409);
  }
  if (
    value.createdAt !== undefined &&
    (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)))
  ) {
    throw new ProjectConfigError("project.identity_invalid", "Project identity timestamp is invalid.", 409);
  }
  return value;
}

function validateRepositoryWorkflow(value) {
  if (
    !value || value.schemaVersion !== REPOSITORY_SCHEMA_VERSION || value.owner !== OWNER
  ) {
    throw new ProjectConfigError("project.workflow_invalid", "Shared project workflow configuration is invalid.", 409);
  }
  return { ...value, overrides: validateOverrides(value.overrides) };
}

function validateLegacyWorkflow(value) {
  if (
    !value || value.schemaVersion !== LEGACY_SCHEMA_VERSION || value.owner !== OWNER ||
    !Number.isSafeInteger(value.revision) || value.revision < 0 ||
    typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))
  ) {
    throw new ProjectConfigError("project.workflow_invalid", "Legacy project workflow configuration is invalid.", 409);
  }
  return { ...value, overrides: validateOverrides(value.overrides) };
}

function validateInstallation(value) {
  if (
    !value || value.schemaVersion !== LOCAL_SCHEMA_VERSION || value.owner !== OWNER ||
    !safeIdentifier(value.installationId)
  ) {
    throw new ProjectConfigError("project.installation_invalid", "Local control-plane installation identity is invalid.", 409);
  }
  return value;
}

function validateBinding(value, expected) {
  if (
    !value || value.schemaVersion !== LOCAL_SCHEMA_VERSION || value.owner !== OWNER ||
    !safeIdentifier(value.workspaceId) || !safeIdentifier(value.projectId) ||
    typeof value.projectRoot !== "string" || !isAbsolute(value.projectRoot) ||
    value.workspaceId !== expected.workspaceId || value.projectId !== expected.projectId ||
    value.projectRoot !== expected.projectRoot
  ) {
    throw new ProjectConfigError("project.binding_invalid", "Local workspace binding is invalid.", 409);
  }
  return value;
}

function validateState(value, expected) {
  if (
    !value || value.schemaVersion !== LOCAL_SCHEMA_VERSION || value.owner !== OWNER ||
    value.workspaceId !== expected.workspaceId || value.projectId !== expected.projectId ||
    !Number.isSafeInteger(value.revision) || value.revision < 0 ||
    typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))
  ) {
    throw new ProjectConfigError("project.state_invalid", "Local workspace state is invalid.", 409);
  }
  return { ...value, localOverrides: validateOverrides(value.localOverrides) };
}

function validateSnapshot(value, expected) {
  if (
    !value || value.schemaVersion !== LOCAL_SCHEMA_VERSION || value.owner !== OWNER ||
    value.workspaceId !== expected.workspaceId || value.projectId !== expected.projectId ||
    !Number.isSafeInteger(value.revision) || value.revision < 0 ||
    typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt)) ||
    !["local", "shared", "restore", "migration"].includes(value.action)
  ) {
    throw new ProjectConfigError("project.history_invalid", "Local project history snapshot is invalid.", 409);
  }
  return {
    ...value,
    sharedOverrides: validateOverrides(value.sharedOverrides),
    localOverrides: validateOverrides(value.localOverrides),
  };
}

function validateRecent(value, expected) {
  if (
    !value || value.schemaVersion !== LOCAL_SCHEMA_VERSION || value.owner !== OWNER ||
    value.workspaceId !== expected.workspaceId || value.projectId !== expected.projectId ||
    value.projectRoot !== expected.projectRoot ||
    typeof value.displayName !== "string" || value.displayName.length === 0 || value.displayName.length > 255 ||
    typeof value.lastOpenedAt !== "string" || !Number.isFinite(Date.parse(value.lastOpenedAt)) ||
    !Number.isSafeInteger(value.revision) || value.revision < 0 ||
    typeof value.configSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.configSha256) ||
    (value.modeId !== null && !MODE_IDS.has(value.modeId)) ||
    (value.mainAgentId !== null && !AGENT_IDS.has(value.mainAgentId)) ||
    (value.builderAgentId !== null && !AGENT_IDS.has(value.builderAgentId))
  ) {
    throw new ProjectConfigError("project.recent_invalid", "Recent project metadata is invalid.", 409);
  }
  return value;
}

export function createProjectConfigStore(options = {}) {
  const clock = options.clock ?? (() => new Date());
  const nonceFactory = options.nonceFactory ?? randomUUID;
  const configuredStateRoot = options.stateRoot ??
    process.env.AGENT_CONTROL_PROJECT_STATE_DIR ??
    join(homedir(), ".agent-control-plane", "workspaces");
  if (!isAbsolute(configuredStateRoot)) {
    throw new ProjectConfigError("project.state_root_invalid", "Project state root must be absolute.", 500);
  }
  const stateRoot = resolve(configuredStateRoot);
  if (stateRoot === parse(stateRoot).root) {
    throw new ProjectConfigError("project.state_root_invalid", "Filesystem root cannot store project state.", 500);
  }

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
    if (canonical === parse(canonical).root) {
      throw new ProjectConfigError("project.root_invalid", "Filesystem root cannot be initialized as a project.", 400, "projectRoot");
    }
    const metadata = await stat(canonical);
    if (!metadata.isDirectory()) {
      throw new ProjectConfigError("project.root_unavailable", "projectRoot must be a directory.", 400, "projectRoot");
    }
    return canonical;
  }

  function repositoryPaths(projectRoot) {
    const control = join(projectRoot, CONTROL_DIRECTORY);
    return {
      control,
      identity: join(control, PROJECT_FILE),
      workflow: join(control, WORKFLOW_FILE),
      legacyHistory: join(control, HISTORY_DIRECTORY),
      legacyLock: join(control, LOCK_FILE),
    };
  }

  async function readRepository(projectRoot) {
    const paths = repositoryPaths(projectRoot);
    const controlType = await pathType(paths.control);
    if (controlType === "missing") return null;
    if (controlType !== "directory") {
      throw new ProjectConfigError("project.control_unsafe", "Project control path is not a safe directory.", 409);
    }
    if ((await pathType(paths.identity)) !== "file") {
      throw new ProjectConfigError("project.identity_unsafe", "Project identity must be a regular file.", 409);
    }
    if ((await pathType(paths.workflow)) !== "file") {
      throw new ProjectConfigError("project.workflow_unsafe", "Project workflow configuration must be a regular file.", 409);
    }
    const identity = validateIdentity(await readJson(paths.identity));
    const rawWorkflow = await readJson(paths.workflow);
    const legacy = rawWorkflow?.schemaVersion === LEGACY_SCHEMA_VERSION;
    const workflow = legacy
      ? validateLegacyWorkflow(rawWorkflow)
      : validateRepositoryWorkflow(rawWorkflow);
    if (!legacy && identity.schemaVersion !== REPOSITORY_SCHEMA_VERSION) {
      throw new ProjectConfigError("project.schema_mismatch", "Project identity and workflow schema versions differ.", 409);
    }
    return { identity, legacy, paths, workflow };
  }

  async function ensureStateRoot() {
    const type = await pathType(stateRoot);
    if (type === "missing") await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    else if (type !== "directory") {
      throw new ProjectConfigError("project.state_root_unsafe", "Local project state root is not a safe directory.", 409);
    }
    const installationPath = join(stateRoot, INSTALLATION_FILE);
    const installationType = await pathType(installationPath);
    if (installationType === "missing") {
      try {
        await writeFile(installationPath, `${JSON.stringify({
          schemaVersion: LOCAL_SCHEMA_VERSION,
          owner: OWNER,
          installationId: `installation-${nonceFactory().toLowerCase()}`,
        }, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    } else if (installationType !== "file") {
      throw new ProjectConfigError("project.installation_unsafe", "Local installation identity is unsafe.", 409);
    }
    return validateInstallation(await readJson(installationPath));
  }

  async function workspaceDescriptor(projectRoot, projectId) {
    const installation = await ensureStateRoot();
    const workspaceId = `workspace-${sha256({
      installationId: installation.installationId,
      projectRoot,
    }).slice(0, 32)}`;
    const root = join(stateRoot, workspaceId);
    return {
      binding: join(root, BINDING_FILE),
      history: join(root, HISTORY_DIRECTORY),
      lock: join(root, LOCK_FILE),
      projectId,
      projectRoot,
      root,
      recent: join(root, RECENT_FILE),
      state: join(root, STATE_FILE),
      workspaceId,
    };
  }

  async function createWorkspace(descriptor, initial = {}) {
    const type = await pathType(descriptor.root);
    if (type !== "missing") return;
    const temporary = `${descriptor.root}.tmp-${nonceFactory()}`;
    await mkdir(temporary, { mode: 0o700 });
    try {
      await mkdir(join(temporary, HISTORY_DIRECTORY), { mode: 0o700 });
      await writeFile(join(temporary, BINDING_FILE), `${JSON.stringify({
        schemaVersion: LOCAL_SCHEMA_VERSION,
        owner: OWNER,
        workspaceId: descriptor.workspaceId,
        projectId: descriptor.projectId,
        projectRoot: descriptor.projectRoot,
      }, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await writeFile(join(temporary, STATE_FILE), `${JSON.stringify({
        schemaVersion: LOCAL_SCHEMA_VERSION,
        owner: OWNER,
        workspaceId: descriptor.workspaceId,
        projectId: descriptor.projectId,
        revision: initial.revision ?? 0,
        updatedAt: initial.updatedAt ?? clock().toISOString(),
        localOverrides: initial.localOverrides ?? {},
      }, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporary, descriptor.root);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      if (error?.code !== "EEXIST") throw error;
    }
  }

  async function readWorkspace(projectRoot, projectId, initial = {}) {
    const descriptor = await workspaceDescriptor(projectRoot, projectId);
    await createWorkspace(descriptor, initial);
    if ((await pathType(descriptor.root)) !== "directory") {
      throw new ProjectConfigError("project.workspace_unsafe", "Local workspace state is unsafe.", 409);
    }
    if ((await pathType(descriptor.history)) !== "directory") {
      throw new ProjectConfigError("project.history_unsafe", "Local workspace history is unsafe.", 409);
    }
    if ((await pathType(descriptor.binding)) !== "file" || (await pathType(descriptor.state)) !== "file") {
      throw new ProjectConfigError("project.workspace_invalid", "Local workspace state is incomplete.", 409);
    }
    const expected = {
      projectId,
      projectRoot,
      workspaceId: descriptor.workspaceId,
    };
    const binding = validateBinding(await readJson(descriptor.binding), expected);
    const state = validateState(await readJson(descriptor.state), expected);
    return { binding, descriptor, state };
  }

  async function listHistory(workspace) {
    const entries = await readdir(workspace.descriptor.history, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^revision-\d+\.json$/.test(entry.name)) continue;
      try {
        const snapshot = validateSnapshot(
          await readJson(join(workspace.descriptor.history, entry.name)),
          workspace.binding,
        );
        result.push({
          revision: snapshot.revision,
          updatedAt: snapshot.updatedAt,
          action: snapshot.action,
        });
      } catch (error) {
        if (!(error instanceof ProjectConfigError)) throw error;
      }
    }
    return result.sort((left, right) => right.revision - left.revision);
  }

  function publicLegacy(projectRoot, repository) {
    const sharedOverrides = clone(repository.workflow.overrides);
    return {
      schemaVersion: REPOSITORY_SCHEMA_VERSION,
      storageVersion: LEGACY_SCHEMA_VERSION,
      projectRoot,
      initialized: true,
      migrationRequired: true,
      projectId: repository.identity.projectId,
      workspaceId: null,
      revision: repository.workflow.revision,
      sharedConfigSha256: sharedConfigSha256(repository.identity.projectId, sharedOverrides),
      configSha256: effectiveConfigSha256(repository.identity.projectId, sharedOverrides, {}),
      overrides: sharedOverrides,
      sharedOverrides,
      localOverrides: {},
      history: [],
    };
  }

  async function publicCurrent(projectRoot, repository, workspace) {
    const sharedOverrides = clone(repository.workflow.overrides);
    const localOverrides = clone(workspace.state.localOverrides);
    return {
      schemaVersion: REPOSITORY_SCHEMA_VERSION,
      storageVersion: REPOSITORY_SCHEMA_VERSION,
      projectRoot,
      initialized: true,
      migrationRequired: false,
      projectId: repository.identity.projectId,
      workspaceId: workspace.binding.workspaceId,
      revision: workspace.state.revision,
      sharedConfigSha256: sharedConfigSha256(repository.identity.projectId, sharedOverrides),
      configSha256: effectiveConfigSha256(
        repository.identity.projectId,
        sharedOverrides,
        localOverrides,
      ),
      overrides: effectiveOverrides(sharedOverrides, localOverrides),
      sharedOverrides,
      localOverrides,
      history: await listHistory(workspace),
    };
  }

  async function touchRecent(state) {
    if (!state?.initialized || state.migrationRequired || !state.workspaceId) return state;
    const descriptor = await workspaceDescriptor(state.projectRoot, state.projectId);
    const lastOpenedAt = clock().toISOString();
    const recent = {
      schemaVersion: LOCAL_SCHEMA_VERSION,
      owner: OWNER,
      projectId: state.projectId,
      workspaceId: state.workspaceId,
      projectRoot: state.projectRoot,
      displayName: basename(state.projectRoot),
      lastOpenedAt,
      revision: state.revision,
      configSha256: state.configSha256,
      modeId: state.overrides.modeId ?? null,
      mainAgentId: state.overrides.mainAgentId ?? null,
      builderAgentId: state.overrides.builderAgentId ?? null,
    };
    await writeJsonAtomic(descriptor.recent, recent, nonceFactory());
    return { ...state, lastOpenedAt };
  }

  async function openProject(input) {
    return touchRecent(await inspect(input));
  }

  async function recent() {
    await ensureStateRoot();
    const entries = await readdir(stateRoot, { withFileTypes: true });
    const projects = [];
    let corruptEntries = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^workspace-[a-f0-9]{32}$/.test(entry.name)) continue;
      const root = join(stateRoot, entry.name);
      try {
        const bindingPath = join(root, BINDING_FILE);
        const statePath = join(root, STATE_FILE);
        const recentPath = join(root, RECENT_FILE);
        if ((await pathType(bindingPath)) !== "file" || (await pathType(statePath)) !== "file") {
          throw new ProjectConfigError("project.workspace_invalid", "Recent workspace state is incomplete.", 409);
        }
        const recentType = await pathType(recentPath);
        if (!new Set(["missing", "file"]).has(recentType)) {
          throw new ProjectConfigError("project.recent_invalid", "Recent project metadata is unsafe.", 409);
        }
        const binding = await readJson(bindingPath);
        if (!binding || binding.workspaceId !== entry.name) {
          throw new ProjectConfigError("project.binding_invalid", "Recent workspace binding is invalid.", 409);
        }
        const expected = {
          projectId: binding.projectId,
          projectRoot: binding.projectRoot,
          workspaceId: binding.workspaceId,
        };
        validateBinding(binding, expected);
        const state = validateState(await readJson(statePath), expected);
        const rawRecent = recentType === "file" ? await readJson(recentPath) : null;
        let metadata;
        if (rawRecent) {
          metadata = validateRecent(rawRecent, expected);
        } else {
          let overrides = state.localOverrides;
          let configSha256 = null;
          if ((await pathType(binding.projectRoot)) === "directory") {
            const repository = await readRepository(binding.projectRoot);
            if (
              repository && !repository.legacy &&
              repository.identity.projectId === binding.projectId
            ) {
              overrides = effectiveOverrides(repository.workflow.overrides, state.localOverrides);
              configSha256 = effectiveConfigSha256(
                binding.projectId,
                repository.workflow.overrides,
                state.localOverrides,
              );
            }
          }
          metadata = {
            projectId: binding.projectId,
            workspaceId: binding.workspaceId,
            projectRoot: binding.projectRoot,
            displayName: basename(binding.projectRoot),
            lastOpenedAt: state.updatedAt,
            revision: state.revision,
            configSha256,
            modeId: overrides.modeId ?? null,
            mainAgentId: overrides.mainAgentId ?? null,
            builderAgentId: overrides.builderAgentId ?? null,
          };
        }
        projects.push({
          projectId: metadata.projectId,
          workspaceId: metadata.workspaceId,
          projectRoot: metadata.projectRoot,
          displayName: metadata.displayName,
          lastOpenedAt: metadata.lastOpenedAt,
          revision: metadata.revision,
          configSha256: metadata.configSha256,
          modeId: metadata.modeId,
          mainAgentId: metadata.mainAgentId,
          builderAgentId: metadata.builderAgentId,
          available: (await pathType(metadata.projectRoot)) === "directory",
        });
      } catch (error) {
        if (!(error instanceof ProjectConfigError) && error?.code !== "ENOENT") throw error;
        corruptEntries += 1;
      }
    }
    projects.sort((left, right) => right.lastOpenedAt.localeCompare(left.lastOpenedAt));
    return {
      schemaVersion: LOCAL_SCHEMA_VERSION,
      projects: projects.slice(0, MAX_RECENT_PROJECTS),
      corruptEntries,
    };
  }

  async function inspect(input) {
    const projectRoot = await requireProjectRoot(input);
    const repository = await readRepository(projectRoot);
    if (!repository) {
      return {
        schemaVersion: REPOSITORY_SCHEMA_VERSION,
        storageVersion: null,
        projectRoot,
        initialized: false,
        migrationRequired: false,
        projectId: null,
        workspaceId: null,
        revision: null,
        sharedConfigSha256: null,
        configSha256: null,
        overrides: {},
        sharedOverrides: {},
        localOverrides: {},
        history: [],
      };
    }
    if (repository.legacy) return publicLegacy(projectRoot, repository);
    const workspace = await readWorkspace(projectRoot, repository.identity.projectId);
    return publicCurrent(projectRoot, repository, workspace);
  }

  async function initialize(input) {
    const projectRoot = await requireProjectRoot(input);
    const existing = await readRepository(projectRoot);
    if (existing) return openProject(projectRoot);
    const paths = repositoryPaths(projectRoot);
    const temporary = join(projectRoot, `${CONTROL_DIRECTORY}.tmp-${nonceFactory()}`);
    await mkdir(temporary, { mode: 0o700 });
    const projectId = `project-${nonceFactory().toLowerCase()}`;
    try {
      await writeFile(join(temporary, PROJECT_FILE), `${JSON.stringify({
        schemaVersion: REPOSITORY_SCHEMA_VERSION,
        owner: OWNER,
        projectId,
      }, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await writeFile(join(temporary, WORKFLOW_FILE), `${JSON.stringify({
        schemaVersion: REPOSITORY_SCHEMA_VERSION,
        owner: OWNER,
        overrides: {},
      }, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporary, paths.control);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
    await readWorkspace(projectRoot, projectId);
    return openProject(projectRoot);
  }

  async function withLock(descriptor, operation) {
    let handle;
    try {
      handle = await open(descriptor.lock, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquiredAt: clock().toISOString() })}\n`);
    } catch (error) {
      await handle?.close();
      if (handle) await rm(descriptor.lock, { force: true });
      if (error?.code === "EEXIST") {
        throw new ProjectConfigError("project.locked", "Another local workspace configuration write is active.", 409);
      }
      throw error;
    }
    try {
      return await operation();
    } finally {
      await handle?.close();
      await rm(descriptor.lock, { force: true });
    }
  }

  async function writeSnapshot(workspace, repository, action) {
    const snapshot = {
      schemaVersion: LOCAL_SCHEMA_VERSION,
      owner: OWNER,
      workspaceId: workspace.binding.workspaceId,
      projectId: workspace.binding.projectId,
      revision: workspace.state.revision,
      updatedAt: workspace.state.updatedAt,
      action,
      sharedOverrides: clone(repository.workflow.overrides),
      localOverrides: clone(workspace.state.localOverrides),
    };
    const path = join(workspace.descriptor.history, `revision-${snapshot.revision}.json`);
    try {
      await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = validateSnapshot(await readJson(path), workspace.binding);
      if (sha256(existing) !== sha256(snapshot)) {
        throw new ProjectConfigError("project.history_conflict", "Existing local history does not match the current revision.", 409);
      }
    }
  }

  async function commitConfiguration({
    projectRoot,
    repository,
    workspace,
    expectedRevision,
    expectedSharedConfigSha256,
    nextSharedOverrides,
    nextLocalOverrides,
    action,
  }) {
    const state = await withLock(workspace.descriptor, async () => {
      const currentRepository = await readRepository(projectRoot);
      if (!currentRepository || currentRepository.legacy) {
        throw new ProjectConfigError("project.migration_required", "Migrate the project before changing configuration.", 409);
      }
      const currentWorkspace = await readWorkspace(projectRoot, currentRepository.identity.projectId);
      if (expectedRevision !== currentWorkspace.state.revision) {
        throw new ProjectConfigError("project.revision_conflict", "Local project configuration changed after it was loaded.", 409);
      }
      const currentSharedHash = sharedConfigSha256(
        currentRepository.identity.projectId,
        currentRepository.workflow.overrides,
      );
      if (
        typeof expectedSharedConfigSha256 !== "string" ||
        expectedSharedConfigSha256 !== currentSharedHash
      ) {
        throw new ProjectConfigError("project.shared_conflict", "Shared project policy changed after it was loaded.", 409);
      }
      await writeSnapshot(currentWorkspace, currentRepository, action);
      if (sha256(nextSharedOverrides) !== sha256(currentRepository.workflow.overrides)) {
        await writeJsonAtomic(currentRepository.paths.workflow, {
          schemaVersion: REPOSITORY_SCHEMA_VERSION,
          owner: OWNER,
          overrides: nextSharedOverrides,
        }, nonceFactory());
      }
      await writeJsonAtomic(currentWorkspace.descriptor.state, {
        schemaVersion: LOCAL_SCHEMA_VERSION,
        owner: OWNER,
        workspaceId: currentWorkspace.binding.workspaceId,
        projectId: currentWorkspace.binding.projectId,
        revision: currentWorkspace.state.revision + 1,
        updatedAt: clock().toISOString(),
        localOverrides: nextLocalOverrides,
      }, nonceFactory());
      return inspect(projectRoot);
    });
    return touchRecent(state);
  }

  async function save({
    projectRoot: input,
    expectedRevision,
    expectedSharedConfigSha256,
    overrides,
    scope = "local",
  }) {
    if (!new Set(["local", "shared"]).has(scope)) {
      throw new ProjectConfigError("project.scope_invalid", "Project override scope must be local or shared.", 422, "scope");
    }
    const projectRoot = await requireProjectRoot(input);
    const repository = await readRepository(projectRoot);
    if (!repository) {
      throw new ProjectConfigError("project.not_initialized", "Initialize the project before saving overrides.", 409);
    }
    if (repository.legacy) {
      throw new ProjectConfigError("project.migration_required", "Migrate the project before saving overrides.", 409);
    }
    const workspace = await readWorkspace(projectRoot, repository.identity.projectId);
    const next = validateOverrides(overrides);
    return commitConfiguration({
      projectRoot,
      repository,
      workspace,
      expectedRevision,
      expectedSharedConfigSha256,
      nextSharedOverrides: scope === "shared" ? next : repository.workflow.overrides,
      nextLocalOverrides: scope === "shared" ? {} : next,
      action: scope,
    });
  }

  async function restore({
    projectRoot: input,
    expectedRevision,
    expectedSharedConfigSha256,
    revision,
  }) {
    const projectRoot = await requireProjectRoot(input);
    const repository = await readRepository(projectRoot);
    if (!repository || repository.legacy) {
      throw new ProjectConfigError("project.migration_required", "Migrate the project before restoring local history.", 409);
    }
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new ProjectConfigError("project.history_invalid", "revision must be a non-negative integer.", 400);
    }
    const workspace = await readWorkspace(projectRoot, repository.identity.projectId);
    const rawSnapshot = await readJson(join(workspace.descriptor.history, `revision-${revision}.json`));
    if (!rawSnapshot) {
      throw new ProjectConfigError("project.history_not_found", "Local project revision was not found.", 404);
    }
    const snapshot = validateSnapshot(rawSnapshot, workspace.binding);
    return commitConfiguration({
      projectRoot,
      repository,
      workspace,
      expectedRevision,
      expectedSharedConfigSha256,
      nextSharedOverrides: snapshot.sharedOverrides,
      nextLocalOverrides: snapshot.localOverrides,
      action: "restore",
    });
  }

  async function migrate(input) {
    const projectRoot = await requireProjectRoot(input);
    const repository = await readRepository(projectRoot);
    if (!repository) {
      throw new ProjectConfigError("project.not_initialized", "Project is not initialized.", 409);
    }
    if (!repository.legacy) return { ...(await openProject(projectRoot)), migration: null };
    if ((await pathType(repository.paths.legacyLock)) !== "missing") {
      throw new ProjectConfigError("project.legacy_locked", "Legacy project state has an active or stale lock; verify the writer before migration.", 409);
    }
    const historyType = await pathType(repository.paths.legacyHistory);
    if (!new Set(["missing", "directory"]).has(historyType)) {
      throw new ProjectConfigError("project.history_unsafe", "Legacy project history is unsafe.", 409);
    }
    const workspace = await readWorkspace(projectRoot, repository.identity.projectId, {
      revision: repository.workflow.revision,
      updatedAt: repository.workflow.updatedAt,
      localOverrides: {},
    });
    let movedHistory = 0;
    if (historyType === "directory") {
      const entries = await readdir(repository.paths.legacyHistory, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !/^revision-\d+\.json$/.test(entry.name)) continue;
        const legacy = validateLegacyWorkflow(await readJson(join(repository.paths.legacyHistory, entry.name)));
        const snapshot = {
          schemaVersion: LOCAL_SCHEMA_VERSION,
          owner: OWNER,
          workspaceId: workspace.binding.workspaceId,
          projectId: workspace.binding.projectId,
          revision: legacy.revision,
          updatedAt: legacy.updatedAt,
          action: "migration",
          sharedOverrides: legacy.overrides,
          localOverrides: {},
        };
        await writeJsonAtomic(
          join(workspace.descriptor.history, `revision-${legacy.revision}.json`),
          snapshot,
          nonceFactory(),
        );
        movedHistory += 1;
      }
    }
    await writeJsonAtomic(repository.paths.identity, {
      schemaVersion: REPOSITORY_SCHEMA_VERSION,
      owner: OWNER,
      projectId: repository.identity.projectId,
    }, nonceFactory());
    await writeJsonAtomic(repository.paths.workflow, {
      schemaVersion: REPOSITORY_SCHEMA_VERSION,
      owner: OWNER,
      overrides: repository.workflow.overrides,
    }, nonceFactory());
    if (historyType === "directory") {
      await rm(repository.paths.legacyHistory, { recursive: true });
    }
    return {
      ...(await openProject(projectRoot)),
      migration: {
        movedHistory,
        localStateRoot: workspace.descriptor.root,
      },
    };
  }

  return Object.freeze({ initialize, inspect, migrate, open: openProject, recent, restore, save });
}
