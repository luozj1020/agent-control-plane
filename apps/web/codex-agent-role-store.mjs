import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
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
const FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.toml$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
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

function validateSourceFileName(value, path) {
  if (typeof value !== "string" || !FILE_PATTERN.test(value) || value.includes("..")) {
    throw new CodexAgentStoreError("agents.invalid_configuration", `${path} is not a safe TOML file name.`);
  }
  return value;
}

function validateSourceHash(value, path) {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new CodexAgentStoreError("agents.invalid_configuration", `${path} is not a valid source hash.`);
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
  const sourceAgents = [];
  const sourceFiles = new Set();
  const sourceByName = new Map();
  for (const [index, entry] of (source.sourceAgents ?? []).entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new CodexAgentStoreError("agents.invalid_configuration", `sourceAgents[${index}] must be an object.`);
    }
    const name = requiredText(entry.name, `sourceAgents[${index}].name`, 64);
    if (!NAME_PATTERN.test(name) || sourceByName.has(name)) {
      throw new CodexAgentStoreError("agents.invalid_configuration", `Source agent name ${name} is unsafe or duplicated.`);
    }
    const fileName = validateSourceFileName(entry.fileName, `sourceAgents[${index}].fileName`);
    if (sourceFiles.has(fileName)) {
      throw new CodexAgentStoreError("agents.invalid_configuration", `Source agent file ${fileName} is duplicated.`);
    }
    const normalized = {
      name,
      fileName,
      hash: validateSourceHash(entry.hash, `sourceAgents[${index}].hash`),
    };
    sourceAgents.push(normalized);
    sourceFiles.add(fileName);
    sourceByName.set(name, normalized);
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
    const inheritedSource = sourceByName.get(name);
    const sourceFileName = agent.sourceFileName == null
      ? inheritedSource?.fileName ?? null
      : validateSourceFileName(agent.sourceFileName, `agents[${index}].sourceFileName`);
    const sourceHash = agent.sourceHash == null
      ? inheritedSource?.hash ?? null
      : validateSourceHash(agent.sourceHash, `agents[${index}].sourceHash`);
    if ((sourceFileName === null) !== (sourceHash === null)) {
      throw new CodexAgentStoreError("agents.invalid_configuration", `Agent ${name} has incomplete source metadata.`);
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
      ...(sourceFileName ? { sourceFileName, sourceHash } : {}),
    };
  });
  return {
    version: 2,
    configurationOrigin: source.configurationOrigin === "existing" ? "existing" : "recommended",
    globalSettings: {
      enabled: global.enabled !== false,
      maxConcurrentThreadsPerSession: global.maxConcurrentThreadsPerSession,
      defaultSubagentModel: defaultModel,
      defaultSubagentReasoningEffort: global.defaultSubagentReasoningEffort,
    },
    agents,
    sourceAgents,
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

const AGENT_TOML_KEYS = Object.freeze({
  name: "name",
  description: "description",
  model: "model",
  model_reasoning_effort: "reasoningEffort",
  sandbox_mode: "sandboxMode",
  developer_instructions: "developerInstructions",
});

function decodeBasicTomlString(value, path) {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      output += character;
      continue;
    }
    const escaped = value[++index];
    const replacements = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
    if (Object.hasOwn(replacements, escaped)) {
      output += replacements[escaped];
      continue;
    }
    const digits = escaped === "u" ? 4 : escaped === "U" ? 8 : 0;
    if (digits > 0) {
      const hexadecimal = value.slice(index + 1, index + 1 + digits);
      if (!new RegExp(`^[a-fA-F0-9]{${digits}}$`).test(hexadecimal)) {
        throw new CodexAgentStoreError("agents.import_unsupported", `${path} contains an invalid Unicode escape.`, 409);
      }
      const codePoint = Number.parseInt(hexadecimal, 16);
      if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
        throw new CodexAgentStoreError("agents.import_unsupported", `${path} contains an invalid Unicode code point.`, 409);
      }
      output += String.fromCodePoint(codePoint);
      index += digits;
      continue;
    }
    throw new CodexAgentStoreError("agents.import_unsupported", `${path} contains an unsupported TOML escape.`, 409);
  }
  return output;
}

function parseTomlValue(rawValue, path) {
  const value = rawValue.trimStart();
  const rejectTrailing = (trailing) => {
    if (!/^\s*(?:#.*)?$/s.test(trailing)) {
      throw new CodexAgentStoreError("agents.import_unsupported", `${path} has unsupported trailing TOML syntax.`, 409);
    }
  };
  if (value.startsWith('"""') || value.startsWith("'''")) {
    const delimiter = value.slice(0, 3);
    const close = value.indexOf(delimiter, 3);
    if (close < 0) throw new CodexAgentStoreError("agents.import_unsupported", `${path} has an unterminated TOML string.`, 409);
    let inner = value.slice(3, close);
    if (inner.startsWith("\r\n")) inner = inner.slice(2);
    else if (inner.startsWith("\n")) inner = inner.slice(1);
    rejectTrailing(value.slice(close + 3));
    return delimiter === "'''" ? inner : decodeBasicTomlString(inner, path);
  }
  if (value.startsWith('"')) {
    let close = -1;
    let escaped = false;
    for (let index = 1; index < value.length; index += 1) {
      if (!escaped && value[index] === '"') {
        close = index;
        break;
      }
      if (!escaped && value[index] === "\\") escaped = true;
      else escaped = false;
    }
    if (close < 0) throw new CodexAgentStoreError("agents.import_unsupported", `${path} has an unterminated TOML string.`, 409);
    rejectTrailing(value.slice(close + 1));
    return decodeBasicTomlString(value.slice(1, close), path);
  }
  if (value.startsWith("'")) {
    const close = value.indexOf("'", 1);
    if (close < 0) throw new CodexAgentStoreError("agents.import_unsupported", `${path} has an unterminated TOML string.`, 409);
    rejectTrailing(value.slice(close + 1));
    return value.slice(1, close);
  }
  const scalar = value.match(/^([^#\r\n]*?)(?:\s+#.*)?$/s)?.[1]?.trim();
  if (scalar === "true") return true;
  if (scalar === "false") return false;
  if (/^[+-]?\d(?:_?\d)*$/.test(scalar ?? "")) return Number.parseInt(scalar.replaceAll("_", ""), 10);
  throw new CodexAgentStoreError("agents.import_unsupported", `${path} uses an unsupported TOML value.`, 409);
}

function scanTomlAssignments(content, { table = null, path = "TOML", keys = null } = {}) {
  if (typeof content !== "string" || content.includes("\0") || Buffer.byteLength(content, "utf8") > 1024 * 1024) {
    throw new CodexAgentStoreError("agents.import_unsupported", `${path} is not a supported text file.`, 409);
  }
  const records = [];
  const lines = [];
  let cursor = 0;
  for (const match of content.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (match[0] === "" && match.index === content.length) continue;
    const raw = match[0];
    lines.push({ start: cursor, end: cursor + raw.length, text: raw.replace(/\r?\n$/, "") });
    cursor += raw.length;
  }
  let active = table === null;
  let tableSeen = false;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const trimmed = line.text.trim();
    if (trimmed.startsWith("[")) {
      const header = trimmed.match(/^\[\s*([A-Za-z0-9_.-]+)\s*\](?:\s*#.*)?$/)?.[1] ?? null;
      active = header === table;
      if (active) {
        if (tableSeen) throw new CodexAgentStoreError("agents.import_unsupported", `${path} contains duplicate [${table}] tables.`, 409);
        tableSeen = true;
      }
      if (table === null) break;
      continue;
    }
    if (!active || trimmed === "" || trimmed.startsWith("#")) continue;
    const assignment = line.text.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!assignment) continue;
    const key = assignment[1];
    const valueColumn = line.text.indexOf(assignment[2], assignment.index + assignment[0].length - assignment[2].length);
    let end = line.end;
    const initial = assignment[2].trimStart();
    if (initial.startsWith('"""') || initial.startsWith("'''")) {
      const delimiter = initial.slice(0, 3);
      const valueStart = line.start + valueColumn;
      const opening = content.indexOf(delimiter, valueStart);
      const closing = content.indexOf(delimiter, opening + 3);
      if (closing < 0) throw new CodexAgentStoreError("agents.import_unsupported", `${path}.${key} has an unterminated TOML string.`, 409);
      while (lineIndex + 1 < lines.length && lines[lineIndex].end <= closing + 3) lineIndex += 1;
      end = lines[lineIndex].end;
    }
    if (keys === null || keys.includes(key)) {
      const rawValue = content.slice(line.start + valueColumn, end).replace(/\r?\n$/, "");
      records.push({ key, value: parseTomlValue(rawValue, `${path}.${key}`), start: line.start, end });
    }
  }
  return records;
}

function assignmentMap(content, options) {
  const values = new Map();
  for (const assignment of scanTomlAssignments(content, options)) {
    if (values.has(assignment.key)) {
      throw new CodexAgentStoreError("agents.import_unsupported", `${options.path}.${assignment.key} is duplicated.`, 409);
    }
    values.set(assignment.key, assignment);
  }
  return values;
}

export function parseCodexAgent(content, fileName) {
  const values = assignmentMap(content, { path: fileName, keys: Object.keys(AGENT_TOML_KEYS) });
  const supported = {};
  for (const [tomlKey, uiKey] of Object.entries(AGENT_TOML_KEYS)) {
    if (values.has(tomlKey)) supported[uiKey] = values.get(tomlKey).value;
  }
  const configuration = getDefaultCodexAgentConfiguration();
  configuration.agents = [{
    name: supported.name,
    description: supported.description,
    model: supported.model ?? null,
    reasoningEffort: supported.reasoningEffort ?? null,
    sandboxMode: supported.sandboxMode ?? null,
    developerInstructions: supported.developerInstructions,
    sourceFileName: validateSourceFileName(fileName, "agent fileName"),
    sourceHash: sha256(content),
  }];
  return validateCodexAgentConfiguration(configuration).agents[0];
}

export function mergeEditableCodexAgent(content, definition) {
  const assignments = assignmentMap(content, {
    path: definition.sourceFileName ?? `${definition.name}.toml`,
    keys: Object.keys(AGENT_TOML_KEYS),
  });
  const removals = [...assignments.values()]
    .filter((entry) => Object.hasOwn(AGENT_TOML_KEYS, entry.key))
    .sort((left, right) => right.start - left.start);
  let preserved = content;
  for (const entry of removals) preserved = preserved.slice(0, entry.start) + preserved.slice(entry.end);
  preserved = preserved.replace(/^(?:\s*\r?\n)+/, "");
  const rendered = renderCodexAgent(definition).trimEnd();
  return `${rendered}\n${preserved.trim() ? `\n${preserved.trimStart()}` : ""}`.replace(/\n*$/, "\n");
}

function readExistingGlobalSettings(content) {
  const defaults = getDefaultCodexAgentConfiguration().globalSettings;
  const keys = ["enabled", "max_concurrent_threads_per_session", "default_subagent_model", "default_subagent_reasoning_effort"];
  const values = assignmentMap(content, { table: "agents", path: "config.toml[agents]", keys });
  const setting = (key, fallback) => values.has(key) ? values.get(key).value : fallback;
  return {
    enabled: setting("enabled", defaults.enabled),
    maxConcurrentThreadsPerSession: setting("max_concurrent_threads_per_session", defaults.maxConcurrentThreadsPerSession),
    defaultSubagentModel: setting("default_subagent_model", defaults.defaultSubagentModel),
    defaultSubagentReasoningEffort: setting("default_subagent_reasoning_effort", defaults.defaultSubagentReasoningEffort),
  };
}

function sameEditableAgent(left, right) {
  return ["name", "description", "model", "reasoningEffort", "sandboxMode", "developerInstructions"]
    .every((key) => (left[key] ?? null) === (right[key] ?? null));
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
    if (manifest && (manifest.owner !== OWNER || ![1, 2, 3].includes(manifest.schemaVersion))) {
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

  async function readConfigurationFromDisk(configType, agentsType) {
    const configContent = configType === "file" ? await readFile(paths.config, "utf8") : "";
    const globalSettings = readExistingGlobalSettings(configContent);
    const entries = agentsType === "directory"
      ? (await readdir(paths.agents, { withFileTypes: true }))
        .filter((entry) => entry.name.endsWith(".toml"))
        .sort((left, right) => left.name.localeCompare(right.name))
      : [];
    if (entries.length > MAX_AGENTS) {
      throw new CodexAgentStoreError("agents.import_unsupported", `Codex agents contains more than ${MAX_AGENTS} TOML roles.`, 409);
    }
    for (const entry of entries) {
      if (!entry.isFile()) {
        throw new CodexAgentStoreError("agents.unsafe_agent", `${entry.name} is not a regular file.`, 409);
      }
      validateSourceFileName(entry.name, "agent fileName");
    }
    if (entries.length === 0) {
      const recommended = getDefaultCodexAgentConfiguration();
      return validateCodexAgentConfiguration({
        ...recommended,
        configurationOrigin: "recommended",
        globalSettings,
        sourceAgents: [],
      });
    }
    const agents = [];
    for (const entry of entries) {
      const content = await readFile(join(paths.agents, entry.name), "utf8");
      agents.push(parseCodexAgent(content, entry.name));
    }
    const sourceAgents = agents.map((agent) => ({
      name: agent.name,
      fileName: agent.sourceFileName,
      hash: agent.sourceHash,
    }));
    return validateCodexAgentConfiguration({
      version: 2,
      configurationOrigin: "existing",
      globalSettings,
      agents,
      sourceAgents,
    });
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
    const configuration = configurationInput === undefined
      ? await readConfigurationFromDisk(configType, agentsType)
      : validateCodexAgentConfiguration(configurationInput);
    const currentConfig = configType === "file" ? await readFile(paths.config, "utf8") : "";
    const merged = mergeEditableCodexAgentConfig(currentConfig, configuration.globalSettings);
    const agents = [];
    const conflicts = [];
    const stale = [];
    for (const agent of configuration.agents) {
      const fileName = agent.sourceFileName ?? manifest?.agentFiles?.[agent.name] ?? `${agent.name}.toml`;
      validateSourceFileName(fileName, `Agent ${agent.name} fileName`);
      const target = join(paths.agents, fileName);
      const type = agentsType === "missing" ? "missing" : await pathType(target);
      if (type === "missing") {
        const status = agent.sourceHash ? "stale" : "missing";
        agents.push({ name: agent.name, status });
        if (status === "stale") stale.push(agent.name);
        continue;
      }
      if (type !== "file") throw new CodexAgentStoreError("agents.unsafe_agent", `${fileName} is not a regular file.`, 409);
      const currentContent = await readFile(target, "utf8");
      const currentHash = sha256(currentContent);
      if (agent.sourceHash && currentHash !== agent.sourceHash) {
        agents.push({ name: agent.name, status: "stale" });
        stale.push(agent.name);
      } else if (agent.sourceHash) {
        const currentAgent = parseCodexAgent(currentContent, fileName);
        const status = sameEditableAgent(currentAgent, agent)
          ? manifest?.agents?.[agent.name] === currentHash ? "installed" : "imported"
          : "modified";
        agents.push({ name: agent.name, status });
      } else if (manifest?.agents?.[agent.name] === currentHash) {
        const currentAgent = parseCodexAgent(currentContent, fileName);
        agents.push({ name: agent.name, status: sameEditableAgent(currentAgent, agent) ? "installed" : "update-available" });
      } else {
        agents.push({ name: agent.name, status: "conflict" });
        conflicts.push(agent.name);
      }
    }
    const desiredNames = new Set(configuration.agents.map((agent) => agent.name));
    const retainedFiles = new Set(configuration.agents.map((agent) => agent.sourceFileName).filter(Boolean));
    const removals = [];
    const removalFiles = new Set();
    for (const source of configuration.sourceAgents) {
      if (retainedFiles.has(source.fileName)) continue;
      const target = join(paths.agents, source.fileName);
      const type = agentsType === "missing" ? "missing" : await pathType(target);
      if (type === "missing") removals.push({ name: source.name, fileName: source.fileName, status: "already-removed" });
      else if (type !== "file") throw new CodexAgentStoreError("agents.unsafe_agent", `${source.fileName} is not a regular file.`, 409);
      else if (sha256(await readFile(target, "utf8")) === source.hash) removals.push({ name: source.name, fileName: source.fileName, status: "remove" });
      else removals.push({ name: source.name, fileName: source.fileName, status: "conflict" });
      removalFiles.add(source.fileName);
    }
    for (const [name, installedHash] of Object.entries(manifest?.agents ?? {})) {
      if (desiredNames.has(name)) continue;
      const fileName = manifest?.agentFiles?.[name] ?? `${name}.toml`;
      if (retainedFiles.has(fileName) || removalFiles.has(fileName)) continue;
      const target = join(paths.agents, fileName);
      const type = agentsType === "missing" ? "missing" : await pathType(target);
      if (type === "missing") {
        removals.push({ name, fileName, status: "already-removed" });
      } else if (type !== "file") {
        throw new CodexAgentStoreError("agents.unsafe_agent", `${fileName} is not a regular file.`, 409);
      } else if (sha256(await readFile(target, "utf8")) === installedHash) {
        removals.push({ name, fileName, status: "remove" });
      } else {
        removals.push({ name, fileName, status: "conflict" });
        conflicts.push(name);
      }
    }
    const allInstalled = agents.every((agent) => agent.status === "installed") && removals.every((removal) => removal.status === "already-removed");
    return {
      writeEnabled: true,
      health: stale.length > 0 ? "agents.source_changed" : allInstalled && !merged.changed ? "installed" : conflicts.length > 0 ? "conflict" : "ready",
      codexHome,
      configPath: paths.config,
      agentsDir: paths.agents,
      configStatus: merged.changed ? "update-required" : "installed",
      requiresOverwrite: conflicts.length > 0,
      conflicts: [...new Set(conflicts)],
      stale,
      removals,
      preset: getDefaultCodexAgentConfiguration(),
      configuration,
      catalog: clone(CATALOG),
      agents,
      configurationOrigin: configuration.configurationOrigin,
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
      if ((before.stale ?? []).length > 0) {
        throw new CodexAgentStoreError("agents.source_changed", `Imported agent files changed after they were loaded: ${before.stale.join(", ")}. Reload before activating.`, 409);
      }
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
      const rendered = new Map();
      const agentFiles = new Map();
      const changes = [];
      if (merged.changed) {
        changes.push({ action: "write", path: paths.config, previous: configType === "file" ? currentConfig : null, content: merged.content, backupName: "config.toml" });
      }
      for (const agent of normalized.agents) {
        const fileName = agent.sourceFileName ?? manifest?.agentFiles?.[agent.name] ?? `${agent.name}.toml`;
        validateSourceFileName(fileName, `Agent ${agent.name} fileName`);
        const target = join(paths.agents, fileName);
        const type = await pathType(target);
        if (type !== "missing" && type !== "file") throw new CodexAgentStoreError("agents.unsafe_agent", `${fileName} is not a regular file.`, 409);
        const previous = type === "file" ? await readFile(target, "utf8") : null;
        if (agent.sourceHash && (previous === null || sha256(previous) !== agent.sourceHash)) {
          throw new CodexAgentStoreError("agents.source_changed", `Imported agent file ${fileName} changed after it was loaded. Reload before activating.`, 409);
        }
        const content = agent.sourceHash
          ? mergeEditableCodexAgent(previous, agent)
          : renderCodexAgent(agent);
        rendered.set(agent.name, content);
        agentFiles.set(agent.name, fileName);
        if (previous === content) continue;
        const owned = previous !== null && (
          agent.sourceHash === sha256(previous) || manifest?.agents?.[agent.name] === sha256(previous)
        );
        if (previous !== null && !owned && !allowOverwrite) {
          throw new CodexAgentStoreError("agents.overwrite_required", `Existing ${fileName} requires explicit backup and overwrite.`, 409);
        }
        changes.push({ action: "write", path: target, previous, content, backupName: join("agents", fileName) });
      }
      for (const removal of before.removals.filter((entry) => entry.status === "remove")) {
        const fileName = removal.fileName ?? `${removal.name}.toml`;
        const target = join(paths.agents, fileName);
        changes.push({ action: "delete", path: target, previous: await readFile(target, "utf8"), content: null, backupName: join("agents", fileName) });
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
        const installedAgents = normalized.agents.map((agent) => ({
          ...agent,
          sourceFileName: agentFiles.get(agent.name),
          sourceHash: sha256(rendered.get(agent.name)),
        }));
        const installedConfiguration = validateCodexAgentConfiguration({
          ...normalized,
          configurationOrigin: "existing",
          agents: installedAgents,
          sourceAgents: installedAgents.map((agent) => ({
            name: agent.name,
            fileName: agent.sourceFileName,
            hash: agent.sourceHash,
          })),
        });
        const nextManifest = {
          schemaVersion: 3,
          owner: OWNER,
          presetVersion: 2,
          installedAt,
          backupId: backupId ?? manifest?.backupId ?? null,
          configuration: installedConfiguration,
          agentFiles: Object.fromEntries(agentFiles),
          agents: Object.fromEntries(installedAgents.map((agent) => [agent.name, agent.sourceHash])),
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
          status: await inspect(installedConfiguration),
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
