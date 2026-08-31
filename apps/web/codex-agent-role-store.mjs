import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

import {
  CodexAgentStoreError,
  getDefaultCodexAgentConfiguration,
} from "./codex-agent-store.mjs";

const OWNER = "agent-workflow-switch";
const CONTROL_DIRECTORY = ".agent-workflow-switch-agents";
const MAX_AGENTS = 32;
const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"]);
const SANDBOXES = Object.freeze(["read-only", "workspace-write"]);

const CATALOG = Object.freeze({
  models: [
    { id: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark" },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { id: "gpt-5.6", label: "GPT-5.6（旗舰别名）" },
  ],
  reasoningEfforts: EFFORTS,
  sandboxModes: SANDBOXES,
  limits: { maxAgents: MAX_AGENTS, maxConcurrentThreads: 32 },
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha256(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function requiredText(value, path, maximumBytes) {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    throw new CodexAgentStoreError("agents.invalid_configuration", `${path} must be non-empty text.`);
  }
  if (Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw new CodexAgentStoreError("agents.invalid_configuration", `${path} is too large.`);
  }
  return value;
}

export function validateCodexAgentConfiguration(input) {
  const source = input ?? getDefaultCodexAgentConfiguration();
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new CodexAgentStoreError("agents.invalid_configuration", "Interactive agent configuration must be an object.");
  }
  const global = source.globalSettings;
  if (!global || typeof global !== "object" || Array.isArray(global)) {
    throw new CodexAgentStoreError("agents.invalid_configuration", "globalSettings is required.");
  }
  if (!Number.isInteger(global.maxConcurrentThreadsPerSession) || global.maxConcurrentThreadsPerSession < 1 || global.maxConcurrentThreadsPerSession > 32) {
    throw new CodexAgentStoreError("agents.invalid_configuration", "maxConcurrentThreadsPerSession must be between 1 and 32.");
  }
  const defaultModel = requiredText(global.defaultSubagentModel, "globalSettings.defaultSubagentModel", 128);
  if (!MODEL_PATTERN.test(defaultModel)) {
    throw new CodexAgentStoreError("agents.invalid_configuration", "The default subagent model ID is invalid.");
  }
  if (!EFFORTS.includes(global.defaultSubagentReasoningEffort)) {
    throw new CodexAgentStoreError("agents.invalid_configuration", "The default subagent reasoning effort is invalid.");
  }
  if (!Array.isArray(source.agents) || source.agents.length < 1 || source.agents.length > MAX_AGENTS) {
    throw new CodexAgentStoreError("agents.invalid_configuration", `agents must contain between 1 and ${MAX_AGENTS} roles.`);
  }
  const names = new Set();
  const agents = source.agents.map((agent, index) => {
    if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
      throw new CodexAgentStoreError("agents.invalid_configuration", `agents[${index}] must be an object.`);
    }
    const name = requiredText(agent.name, `agents[${index}].name`, 64);
    if (!NAME_PATTERN.test(name) || names.has(name)) {
      throw new CodexAgentStoreError("agents.invalid_configuration", `Agent name ${name} is unsafe or duplicated.`);
    }
    names.add(name);
    const model = agent.model == null || agent.model === "" ? null : requiredText(agent.model, `agents[${index}].model`, 128);
    if (model !== null && !MODEL_PATTERN.test(model)) {
      throw new CodexAgentStoreError("agents.invalid_configuration", `Agent ${name} has an invalid model ID.`);
    }
    const reasoningEffort = agent.reasoningEffort == null || agent.reasoningEffort === "" ? null : agent.reasoningEffort;
    if (reasoningEffort !== null && !EFFORTS.includes(reasoningEffort)) {
      throw new CodexAgentStoreError("agents.invalid_configuration", `Agent ${name} has an invalid reasoning effort.`);
    }
    const sandboxMode = agent.sandboxMode == null || agent.sandboxMode === "" ? null : agent.sandboxMode;
    if (sandboxMode !== null && !SANDBOXES.includes(sandboxMode)) {
      throw new CodexAgentStoreError("agents.invalid_configuration", `Agent ${name} has an invalid sandbox mode.`);
    }
    return {
      name,
      description: requiredText(agent.description, `agents[${index}].description`, 4096),
      model,
      reasoningEffort,
      sandboxMode,
      developerInstructions: requiredText(
        agent.developerInstructions ?? agent.instructions,
        `agents[${index}].developerInstructions`,
        65536,
      ),
    };
  });
  return {
    version: 2,
    globalSettings: {
      enabled: global.enabled !== false,
      maxConcurrentThreadsPerSession: global.maxConcurrentThreadsPerSession,
      defaultSubagentModel: defaultModel,
      defaultSubagentReasoningEffort: global.defaultSubagentReasoningEffort,
    },
    agents,
  };
}

export function renderCodexAgent(definition) {
  const lines = [
    `name = ${JSON.stringify(definition.name)}`,
    `description = ${JSON.stringify(definition.description)}`,
  ];
  if (definition.model) lines.push(`model = ${JSON.stringify(definition.model)}`);
  if (definition.reasoningEffort) {
    lines.push(`model_reasoning_effort = ${JSON.stringify(definition.reasoningEffort)}`);
  }
  if (definition.sandboxMode) {
    lines.push(`sandbox_mode = ${JSON.stringify(definition.sandboxMode)}`);
  }
  lines.push(`developer_instructions = ${JSON.stringify(definition.developerInstructions)}`, "");
  return lines.join("\n");
}

function managedConfigValues(settings) {
  return {
    enabled: settings.enabled ? "true" : "false",
    max_concurrent_threads_per_session: String(settings.maxConcurrentThreadsPerSession),
    default_subagent_model: JSON.stringify(settings.defaultSubagentModel),
    default_subagent_reasoning_effort: JSON.stringify(settings.defaultSubagentReasoningEffort),
  };
}

export function mergeEditableCodexAgentConfig(content, settings) {
  if (typeof content !== "string" || content.includes("\0") || Buffer.byteLength(content) > 1024 * 1024) {
    throw new CodexAgentStoreError("agents.config_unsupported", "config.toml is not a supported text file.", 409);
  }
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = content.endsWith("\n");
  const lines = content.length === 0 ? [] : content.split(/\r?\n/);
  if (trailingNewline) lines.pop();
  if (
    lines.some((line) => /^\s*\[\[\s*agents\s*\]\]/.test(line)) ||
    lines.some((line) => /^\s*\[\s*["']agents["']\s*\]/.test(line)) ||
    lines.some((line) => /^\s*agents\s*=/.test(line)) ||
    lines.some((line) => /^\s*["']?agents["']?\.(enabled|max_concurrent_threads_per_session|default_subagent_model|default_subagent_reasoning_effort)\s*=/.test(line))
  ) {
    throw new CodexAgentStoreError("agents.config_unsupported", "config.toml uses an agents table form that cannot be updated safely.", 409);
  }
  const headers = lines.flatMap((line, index) => /^\s*\[\s*agents\s*\]\s*(?:#.*)?$/.test(line) ? [index] : []);
  if (headers.length > 1) {
    throw new CodexAgentStoreError("agents.config_unsupported", "config.toml contains duplicate [agents] tables.", 409);
  }
  let start;
  let end;
  if (headers.length === 1) {
    start = headers[0] + 1;
    end = lines.findIndex((line, index) => index >= start && /^\s*\[/.test(line));
    if (end < 0) end = lines.length;
  } else {
    const nested = lines.findIndex((line) => /^\s*\[\s*agents\./.test(line));
    const insertAt = nested < 0 ? lines.length : nested;
    const prefix = insertAt > 0 && lines[insertAt - 1]?.trim() !== "" ? [""] : [];
    lines.splice(insertAt, 0, ...prefix, "[agents]");
    start = insertAt + prefix.length + 1;
    end = start;
  }
  for (const [key, value] of Object.entries(managedConfigValues(settings))) {
    const matches = [];
    for (let index = start; index < end; index += 1) {
      if (new RegExp(`^\\s*(?:${key}|[\"']${key}[\"'])\\s*=`).test(lines[index] ?? "")) matches.push(index);
    }
    if (matches.length > 1) {
      throw new CodexAgentStoreError("agents.config_unsupported", `config.toml contains duplicate agents.${key} values.`, 409);
    }
    const rendered = `${key} = ${value}`;
    if (matches.length === 1) lines[matches[0]] = rendered;
    else {
      lines.splice(end, 0, rendered);
      end += 1;
    }
  }
  const merged = `${lines.join(newline)}${lines.length > 0 || trailingNewline ? newline : ""}`;
  return { content: merged, changed: merged !== content };
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
      throw new CodexAgentStoreError("agents.corrupt_metadata", `Invalid JSON at ${path}.`, 409);
    }
    throw error;
  }
}

async function atomicWrite(path, content, nonceFactory) {
  const temporary = join(dirname(path), `.tmp-${nonceFactory()}`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch((cleanupError) => {
      if (cleanupError?.code !== "ENOENT") throw cleanupError;
    });
    throw error;
  }
}

export function createEditableCodexAgentStore(options = {}) {
  const configured = options.codexHome;
  if (configured !== undefined && (!isAbsolute(configured) || configured.trim() === "")) {
    throw new CodexAgentStoreError("agents.invalid_root", "AGENT_WORKFLOW_CODEX_HOME must be an absolute path.");
  }
  const codexHome = configured === undefined ? null : resolve(configured);
  if (codexHome && codexHome === parse(codexHome).root) {
    throw new CodexAgentStoreError("agents.invalid_root", "The filesystem root cannot be used as CODEX_HOME.");
  }
  const clock = options.clock ?? (() => new Date());
  const nonceFactory = options.nonceFactory ?? randomUUID;
  const paths = codexHome ? {
    root: codexHome,
    config: join(codexHome, "config.toml"),
    agents: join(codexHome, "agents"),
    control: join(codexHome, CONTROL_DIRECTORY),
    owner: join(codexHome, CONTROL_DIRECTORY, "owner.json"),
    manifest: join(codexHome, CONTROL_DIRECTORY, "manifest.json"),
    backups: join(codexHome, CONTROL_DIRECTORY, "backups"),
    lock: join(codexHome, CONTROL_DIRECTORY, "install.lock"),
  } : null;

  async function readManifest() {
    if (!paths) return null;
    const type = await pathType(paths.control);
    if (type === "missing") return null;
    if (type !== "directory") {
      throw new CodexAgentStoreError("agents.unsafe_control", "Agent control path is not a directory.", 409);
    }
    const owner = await readJson(paths.owner);
    if (!owner || owner.owner !== OWNER || owner.schemaVersion !== 1) {
      throw new CodexAgentStoreError("agents.ownership_conflict", "Agent control directory is not product-owned.", 409);
    }
    const manifest = await readJson(paths.manifest);
    if (manifest && (manifest.owner !== OWNER || ![1, 2].includes(manifest.schemaVersion))) {
      throw new CodexAgentStoreError("agents.corrupt_metadata", "Agent manifest is invalid.", 409);
    }
    return manifest;
  }

  async function ensureDirectories() {
    if (!paths) {
      throw new CodexAgentStoreError("agents.preview_only", "Interactive agent installation is disabled. Set AGENT_WORKFLOW_CODEX_HOME.", 409);
    }
    const rootType = await pathType(paths.root);
    if (rootType === "missing") await mkdir(paths.root, { recursive: true, mode: 0o700 });
    else if (rootType !== "directory") throw new CodexAgentStoreError("agents.unsafe_root", "CODEX_HOME is not a safe directory.", 409);
    const agentsType = await pathType(paths.agents);
    if (agentsType === "missing") await mkdir(paths.agents, { mode: 0o700 });
    else if (agentsType !== "directory") throw new CodexAgentStoreError("agents.unsafe_directory", "Codex agents path is not a directory.", 409);
    const controlType = await pathType(paths.control);
    if (controlType === "missing") {
      await mkdir(paths.control, { mode: 0o700 });
      await writeFile(paths.owner, `${JSON.stringify({ schemaVersion: 1, owner: OWNER }, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } else await readManifest();
    const backupsType = await pathType(paths.backups);
    if (backupsType === "missing") await mkdir(paths.backups, { mode: 0o700 });
    else if (backupsType !== "directory") throw new CodexAgentStoreError("agents.unsafe_backups", "Agent backup path is not a directory.", 409);
  }

  async function inspect(configurationInput) {
    if (!paths) {
      const configuration = validateCodexAgentConfiguration(configurationInput);
      return {
        writeEnabled: false,
        health: "preview-only",
        codexHome: null,
        configPath: null,
        agentsDir: null,
        configStatus: "unavailable",
        requiresOverwrite: false,
        conflicts: [],
        removals: [],
        preset: getDefaultCodexAgentConfiguration(),
        configuration,
        catalog: clone(CATALOG),
        agents: configuration.agents.map((agent) => ({ name: agent.name, status: "unavailable" })),
      };
    }
    const rootType = await pathType(paths.root);
    if (rootType !== "missing" && rootType !== "directory") throw new CodexAgentStoreError("agents.unsafe_root", "CODEX_HOME is not a safe directory.", 409);
    const configType = await pathType(paths.config);
    if (configType !== "missing" && configType !== "file") throw new CodexAgentStoreError("agents.unsafe_config", "config.toml is not a regular file.", 409);
    const agentsType = await pathType(paths.agents);
    if (agentsType !== "missing" && agentsType !== "directory") throw new CodexAgentStoreError("agents.unsafe_directory", "Codex agents path is not a directory.", 409);
    const manifest = await readManifest();
    const configuration = validateCodexAgentConfiguration(configurationInput ?? manifest?.configuration);
    const rendered = new Map(configuration.agents.map((agent) => [agent.name, renderCodexAgent(agent)]));
    const currentConfig = configType === "file" ? await readFile(paths.config, "utf8") : "";
    const merged = mergeEditableCodexAgentConfig(currentConfig, configuration.globalSettings);
    const agents = [];
    const conflicts = [];
    for (const agent of configuration.agents) {
      const target = join(paths.agents, `${agent.name}.toml`);
      const type = agentsType === "missing" ? "missing" : await pathType(target);
      if (type === "missing") {
        agents.push({ name: agent.name, status: "missing" });
        continue;
      }
      if (type !== "file") throw new CodexAgentStoreError("agents.unsafe_agent", `${agent.name}.toml is not a regular file.`, 409);
      const currentHash = sha256(await readFile(target, "utf8"));
      if (currentHash === sha256(rendered.get(agent.name))) agents.push({ name: agent.name, status: "installed" });
      else if (manifest?.agents?.[agent.name] === currentHash) agents.push({ name: agent.name, status: "update-available" });
      else {
        agents.push({ name: agent.name, status: "conflict" });
        conflicts.push(agent.name);
      }
    }
    const desiredNames = new Set(configuration.agents.map((agent) => agent.name));
    const removals = [];
    for (const [name, installedHash] of Object.entries(manifest?.agents ?? {})) {
      if (desiredNames.has(name)) continue;
      const target = join(paths.agents, `${name}.toml`);
      const type = agentsType === "missing" ? "missing" : await pathType(target);
      if (type === "missing") {
        removals.push({ name, status: "already-removed" });
      } else if (type !== "file") {
        throw new CodexAgentStoreError("agents.unsafe_agent", `${name}.toml is not a regular file.`, 409);
      } else if (sha256(await readFile(target, "utf8")) === installedHash) {
        removals.push({ name, status: "remove" });
      } else {
        removals.push({ name, status: "conflict" });
        conflicts.push(name);
      }
    }
    const allInstalled = agents.every((agent) => agent.status === "installed") && removals.every((removal) => removal.status === "already-removed");
    return {
      writeEnabled: true,
      health: allInstalled && !merged.changed ? "installed" : conflicts.length > 0 ? "conflict" : "ready",
      codexHome,
      configPath: paths.config,
      agentsDir: paths.agents,
      configStatus: merged.changed ? "update-required" : "installed",
      requiresOverwrite: conflicts.length > 0,
      conflicts: [...new Set(conflicts)],
      removals,
      preset: getDefaultCodexAgentConfiguration(),
      configuration,
      catalog: clone(CATALOG),
      agents,
      lastInstalledAt: manifest?.installedAt ?? null,
    };
  }

  async function status(configuration) {
    try {
      return await inspect(configuration);
    } catch (error) {
      if (!(error instanceof CodexAgentStoreError)) throw error;
      return {
        writeEnabled: Boolean(paths),
        health: error.code,
        codexHome,
        configPath: paths?.config ?? null,
        agentsDir: paths?.agents ?? null,
        requiresOverwrite: false,
        conflicts: [],
        removals: [],
        preset: getDefaultCodexAgentConfiguration(),
        configuration: null,
        catalog: clone(CATALOG),
        agents: [],
        error: error.message,
      };
    }
  }

  async function withLock(operation) {
    let handle;
    try {
      handle = await open(paths.lock, "wx", 0o600);
    } catch (error) {
      if (error?.code === "EEXIST") throw new CodexAgentStoreError("agents.locked", "Another Interactive agent installation is already running.", 409);
      throw error;
    }
    try {
      return await operation();
    } finally {
      await handle.close();
      await unlink(paths.lock).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
  }

  async function install({ allowOverwrite = false, configuration } = {}) {
    const normalized = validateCodexAgentConfiguration(configuration);
    await ensureDirectories();
    return withLock(async () => {
      const before = await inspect(normalized);
      if (before.conflicts.length > 0 && !allowOverwrite) {
        throw new CodexAgentStoreError("agents.overwrite_required", `Existing custom agents require explicit backup and overwrite: ${before.conflicts.join(", ")}.`, 409);
      }
      const manifest = await readManifest();
      const unsafeRemoval = before.removals.find((removal) => removal.status === "conflict");
      if (unsafeRemoval) {
        throw new CodexAgentStoreError("agents.remove_conflict", `Removed role ${unsafeRemoval.name} was edited outside this product; automatic deletion was refused.`, 409);
      }
      const manifestType = await pathType(paths.manifest);
      const previousManifest = manifestType === "file" ? await readFile(paths.manifest, "utf8") : null;
      const configType = await pathType(paths.config);
      const currentConfig = configType === "file" ? await readFile(paths.config, "utf8") : "";
      const merged = mergeEditableCodexAgentConfig(currentConfig, normalized.globalSettings);
      const rendered = new Map(normalized.agents.map((agent) => [agent.name, renderCodexAgent(agent)]));
      const changes = [];
      if (merged.changed) {
        changes.push({ action: "write", path: paths.config, previous: configType === "file" ? currentConfig : null, content: merged.content, backupName: "config.toml" });
      }
      for (const agent of normalized.agents) {
        const target = join(paths.agents, `${agent.name}.toml`);
        const type = await pathType(target);
        if (type !== "missing" && type !== "file") throw new CodexAgentStoreError("agents.unsafe_agent", `${agent.name}.toml is not a regular file.`, 409);
        const previous = type === "file" ? await readFile(target, "utf8") : null;
        const content = rendered.get(agent.name);
        if (previous === content) continue;
        const owned = previous !== null && manifest?.agents?.[agent.name] === sha256(previous);
        if (previous !== null && !owned && !allowOverwrite) {
          throw new CodexAgentStoreError("agents.overwrite_required", `Existing ${agent.name}.toml requires explicit backup and overwrite.`, 409);
        }
        changes.push({ action: "write", path: target, previous, content, backupName: join("agents", `${agent.name}.toml`) });
      }
      for (const removal of before.removals.filter((entry) => entry.status === "remove")) {
        const target = join(paths.agents, `${removal.name}.toml`);
        changes.push({ action: "delete", path: target, previous: await readFile(target, "utf8"), content: null, backupName: join("agents", `${removal.name}.toml`) });
      }
      let backupId = null;
      if (changes.some((change) => change.previous !== null)) {
        backupId = `${clock().toISOString().replace(/[:.]/g, "-")}-${nonceFactory()}`.toLowerCase();
        const backupRoot = join(paths.backups, backupId);
        await mkdir(backupRoot, { mode: 0o700 });
        for (const change of changes) {
          if (change.previous === null) continue;
          const backupPath = join(backupRoot, change.backupName);
          await mkdir(dirname(backupPath), { recursive: true, mode: 0o700 });
          await writeFile(backupPath, change.previous, { encoding: "utf8", flag: "wx", mode: 0o600 });
        }
        await writeFile(join(backupRoot, "backup.json"), `${JSON.stringify({ schemaVersion: 1, owner: OWNER, backupId, createdAt: clock().toISOString() }, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      }
      const applied = [];
      let nextManifestContent = null;
      try {
        for (const change of changes) {
          if (change.action === "delete") await unlink(change.path);
          else await atomicWrite(change.path, change.content, nonceFactory);
          applied.push(change);
        }
        const installedAt = before.health === "installed" && manifest?.configuration ? manifest.installedAt : clock().toISOString();
        const nextManifest = {
          schemaVersion: 2,
          owner: OWNER,
          presetVersion: 2,
          installedAt,
          backupId: backupId ?? manifest?.backupId ?? null,
          configuration: normalized,
          agents: Object.fromEntries(normalized.agents.map((agent) => [agent.name, sha256(rendered.get(agent.name))])),
        };
        nextManifestContent = `${JSON.stringify(nextManifest, null, 2)}\n`;
        await atomicWrite(paths.manifest, nextManifestContent, nonceFactory);
        const rollback = async () => {
          await ensureDirectories();
          return withLock(async () => {
            for (const change of changes) {
              const type = await pathType(change.path);
              const unchanged = change.action === "delete"
                ? type === "missing"
                : type === "file" && await readFile(change.path, "utf8") === change.content;
              if (!unchanged) throw new CodexAgentStoreError("agents.rollback_conflict", "Interactive agent files changed after installation; automatic rollback was refused.", 409);
            }
            if (await pathType(paths.manifest) !== "file" || await readFile(paths.manifest, "utf8") !== nextManifestContent) {
              throw new CodexAgentStoreError("agents.rollback_conflict", "Interactive agent manifest changed after installation; automatic rollback was refused.", 409);
            }
            for (const change of [...changes].reverse()) {
              if (change.previous === null) {
                await unlink(change.path).catch((error) => {
                  if (error?.code !== "ENOENT") throw error;
                });
              } else await atomicWrite(change.path, change.previous, nonceFactory);
            }
            if (previousManifest === null) {
              await unlink(paths.manifest).catch((error) => {
                if (error?.code !== "ENOENT") throw error;
              });
            } else await atomicWrite(paths.manifest, previousManifest, nonceFactory);
            return { status: await inspect() };
          });
        };
        return {
          changed: changes.length > 0 || previousManifest !== nextManifestContent,
          backupId,
          status: await inspect(normalized),
          rollback,
        };
      } catch (error) {
        for (const change of applied.reverse()) {
          if (change.previous === null) {
            await unlink(change.path).catch((cleanupError) => {
              if (cleanupError?.code !== "ENOENT") throw cleanupError;
            });
          } else await atomicWrite(change.path, change.previous, nonceFactory);
        }
        if (
          nextManifestContent !== null &&
          await pathType(paths.manifest) === "file" &&
          await readFile(paths.manifest, "utf8") === nextManifestContent
        ) {
          if (previousManifest === null) await unlink(paths.manifest);
          else await atomicWrite(paths.manifest, previousManifest, nonceFactory);
        }
        throw error;
      }
    });
  }

  return { install, status };
}
