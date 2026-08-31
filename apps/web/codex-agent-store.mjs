import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

const OWNER = "agent-workflow-switch";
const CONTROL_DIRECTORY = ".agent-workflow-switch-agents";
const OWNER_FILE = "owner.json";
const MANIFEST_FILE = "manifest.json";
const CONFIG_FILE = "config.toml";
const PRESET_VERSION = 1;

const GLOBAL_SETTINGS = Object.freeze({
  enabled: true,
  maxConcurrentThreadsPerSession: 6,
  defaultSubagentModel: "gpt-5.3-codex-spark",
  defaultSubagentReasoningEffort: "medium",
});

const AGENT_DEFINITIONS = Object.freeze([
  {
    name: "worker",
    description: "Execution-focused coding worker. Use for implementation, bug fixes, refactoring, builds, tests, and other concrete coding tasks.",
    model: "gpt-5.3-codex-spark",
    reasoningEffort: "medium",
    instructions: [
      "You are an execution-focused coding worker.",
      "Follow the parent agent's plan.",
      "Focus on implementing requested changes, fixing bugs, editing code, running targeted builds and tests, keeping changes focused, and reporting exact changes and results.",
      "Do not unnecessarily redesign architecture or broaden scope. Escalate architectural uncertainty to the parent agent.",
    ].join("\n\n"),
  },
  {
    name: "explorer",
    description: "Fast read-only codebase explorer. Use for locating files, symbols, implementations, call paths, tests, configuration, and benchmarks.",
    model: "gpt-5.3-codex-spark",
    reasoningEffort: "medium",
    sandboxMode: "read-only",
    instructions: [
      "Stay in exploration mode.",
      "Locate relevant files, definitions, usages, real execution paths, data flow, tests, benchmarks, and similar implementations.",
      "Prefer fast search and targeted reads over broad scans. Do not edit files or make architectural decisions.",
      "Return concise evidence with file paths and symbol names to the parent agent.",
    ].join("\n\n"),
  },
  {
    name: "tester",
    description: "Testing specialist. Use for running targeted tests, reproducing failures, analyzing test logs, and validating implementations.",
    model: "gpt-5.3-codex-spark",
    reasoningEffort: "medium",
    instructions: [
      "Focus on validation and testing.",
      "Identify relevant tests, reproduce failures, inspect logs, isolate failing components, verify fixes, and report exact commands and results.",
      "Avoid modifying implementation code unless explicitly requested. Return concise evidence to the parent agent.",
    ].join("\n\n"),
  },
  {
    name: "debugger",
    description: "Debugging specialist. Use for compiler errors, crashes, runtime failures, incorrect behavior, failing tests, and difficult bug investigation.",
    model: "gpt-5.3-codex-spark",
    reasoningEffort: "medium",
    instructions: [
      "Investigate failures systematically.",
      "Reproduce the failure, identify the first meaningful error, trace the execution path, inspect logs and stack traces, and separate root causes from secondary errors.",
      "Do not make broad architectural changes. Report reproduction, evidence, likely root cause, affected files or symbols, and the recommended next action.",
    ].join("\n\n"),
  },
  {
    name: "benchmarker",
    description: "Performance benchmark specialist. Use for running benchmarks, comparing performance, analyzing regressions, and collecting performance evidence.",
    model: "gpt-5.3-codex-spark",
    reasoningEffort: "medium",
    instructions: [
      "Focus on measurable performance evidence.",
      "Run controlled comparisons, inspect variance and measurement noise, investigate regressions and scaling behavior, and organize results clearly.",
      "Do not optimize blindly. Report commands, assumptions, baselines, modified results, relative changes, suspicious cases, and evidence-backed conclusions.",
    ].join("\n\n"),
  },
  {
    name: "build_fixer",
    description: "Build and compilation specialist. Use for compiler errors, linker errors, dependency problems, CMake, Bazel, Ninja, Make, and build-system failures.",
    model: "gpt-5.3-codex-spark",
    reasoningEffort: "medium",
    instructions: [
      "Focus on build failures and identify the earliest meaningful failure instead of chasing secondary errors.",
      "Inspect compiler and linker diagnostics, dependencies, and build configuration. Make only small targeted build fixes when appropriate.",
      "Report exact commands, errors, fixes, and validation results.",
    ].join("\n\n"),
  },
  {
    name: "reviewer",
    description: "Code reviewer focused on correctness, regressions, edge cases, performance risks, concurrency, and missing tests.",
    model: "gpt-5.6-terra",
    reasoningEffort: "high",
    sandboxMode: "read-only",
    instructions: [
      "Review completed changes like a code owner.",
      "Prioritize correctness, behavior regressions, edge cases, concurrency, lifetime and ownership, performance regressions, missing tests, and mismatch with requested behavior.",
      "Do not edit code. Lead with concrete findings, reference files and symbols, and avoid style-only comments unless they reveal a real problem.",
    ].join("\n\n"),
  },
]);

export class CodexAgentStoreError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "CodexAgentStoreError";
    this.code = code;
    this.status = status;
  }
}

function sha256(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
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

function renderAgent(definition) {
  const lines = [
    `name = ${JSON.stringify(definition.name)}`,
    "",
    `description = ${JSON.stringify(definition.description)}`,
    "",
    `model = ${JSON.stringify(definition.model)}`,
    `model_reasoning_effort = ${JSON.stringify(definition.reasoningEffort)}`,
  ];
  if (definition.sandboxMode) {
    lines.push(`sandbox_mode = ${JSON.stringify(definition.sandboxMode)}`);
  }
  lines.push("", "developer_instructions = \"\"\"", definition.instructions, "\"\"\"", "");
  return lines.join("\n");
}

const RENDERED_AGENTS = new Map(
  AGENT_DEFINITIONS.map((definition) => [definition.name, renderAgent(definition)]),
);

function publicPreset() {
  return {
    version: PRESET_VERSION,
    globalSettings: GLOBAL_SETTINGS,
    agents: AGENT_DEFINITIONS.map((definition) => ({
      name: definition.name,
      description: definition.description,
      model: definition.model,
      reasoningEffort: definition.reasoningEffort,
      sandboxMode: definition.sandboxMode ?? null,
    })),
  };
}

const CONFIG_VALUES = Object.freeze({
  enabled: "true",
  max_concurrent_threads_per_session: String(GLOBAL_SETTINGS.maxConcurrentThreadsPerSession),
  default_subagent_model: JSON.stringify(GLOBAL_SETTINGS.defaultSubagentModel),
  default_subagent_reasoning_effort: JSON.stringify(
    GLOBAL_SETTINGS.defaultSubagentReasoningEffort,
  ),
});

export function mergeCodexAgentConfig(content) {
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
    throw new CodexAgentStoreError(
      "agents.config_unsupported",
      "config.toml uses an agents table form that cannot be updated safely.",
      409,
    );
  }

  const exactHeaders = lines.flatMap((line, index) =>
    /^\s*\[\s*agents\s*\]\s*(?:#.*)?$/.test(line) ? [index] : [],
  );
  if (exactHeaders.length > 1) {
    throw new CodexAgentStoreError(
      "agents.config_unsupported",
      "config.toml contains duplicate [agents] tables.",
      409,
    );
  }

  let start;
  let end;
  if (exactHeaders.length === 1) {
    start = exactHeaders[0] + 1;
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

  for (const [key, value] of Object.entries(CONFIG_VALUES)) {
    const matches = [];
    for (let index = start; index < end; index += 1) {
      if (new RegExp(`^\\s*(?:${key}|[\"']${key}[\"'])\\s*=`).test(lines[index] ?? "")) {
        matches.push(index);
      }
    }
    if (matches.length > 1) {
      throw new CodexAgentStoreError(
        "agents.config_unsupported",
        `config.toml contains duplicate agents.${key} values.`,
        409,
      );
    }
    const rendered = `${key} = ${value}`;
    if (matches.length === 1) {
      lines[matches[0]] = rendered;
    } else {
      lines.splice(end, 0, rendered);
      end += 1;
    }
  }

  const merged = `${lines.join(newline)}${lines.length > 0 || trailingNewline ? newline : ""}`;
  return { content: merged, changed: merged !== content };
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

export function createCodexAgentStore(options = {}) {
  const configured = options.codexHome;
  if (configured !== undefined && (!isAbsolute(configured) || configured.trim() === "")) {
    throw new CodexAgentStoreError(
      "agents.invalid_root",
      "AGENT_WORKFLOW_CODEX_HOME must be an absolute path.",
    );
  }
  const codexHome = configured === undefined ? null : resolve(configured);
  if (codexHome && codexHome === parse(codexHome).root) {
    throw new CodexAgentStoreError("agents.invalid_root", "The filesystem root cannot be used as CODEX_HOME.");
  }
  const clock = options.clock ?? (() => new Date());
  const nonceFactory = options.nonceFactory ?? randomUUID;
  const paths = codexHome
    ? {
        root: codexHome,
        config: join(codexHome, CONFIG_FILE),
        agents: join(codexHome, "agents"),
        control: join(codexHome, CONTROL_DIRECTORY),
        owner: join(codexHome, CONTROL_DIRECTORY, OWNER_FILE),
        manifest: join(codexHome, CONTROL_DIRECTORY, MANIFEST_FILE),
        backups: join(codexHome, CONTROL_DIRECTORY, "backups"),
        lock: join(codexHome, CONTROL_DIRECTORY, "install.lock"),
      }
    : null;

  async function readManifest() {
    if (!paths) return null;
    const controlType = await pathType(paths.control);
    if (controlType === "missing") return null;
    if (controlType !== "directory") {
      throw new CodexAgentStoreError("agents.unsafe_control", "Agent control path is not a directory.", 409);
    }
    const owner = await readJson(paths.owner);
    if (!owner || owner.owner !== OWNER || owner.schemaVersion !== 1) {
      throw new CodexAgentStoreError("agents.ownership_conflict", "Agent control directory is not product-owned.", 409);
    }
    const manifest = await readJson(paths.manifest);
    if (manifest && (manifest.owner !== OWNER || manifest.schemaVersion !== 1)) {
      throw new CodexAgentStoreError("agents.corrupt_metadata", "Agent manifest is invalid.", 409);
    }
    return manifest;
  }

  async function ensureDirectories() {
    if (!paths) {
      throw new CodexAgentStoreError(
        "agents.preview_only",
        "Interactive agent installation is disabled. Set AGENT_WORKFLOW_CODEX_HOME.",
        409,
      );
    }
    const rootType = await pathType(paths.root);
    if (rootType === "missing") await mkdir(paths.root, { recursive: true, mode: 0o700 });
    else if (rootType !== "directory") {
      throw new CodexAgentStoreError("agents.unsafe_root", "CODEX_HOME is not a safe directory.", 409);
    }
    const agentsType = await pathType(paths.agents);
    if (agentsType === "missing") await mkdir(paths.agents, { mode: 0o700 });
    else if (agentsType !== "directory") {
      throw new CodexAgentStoreError("agents.unsafe_directory", "Codex agents path is not a directory.", 409);
    }
    const controlType = await pathType(paths.control);
    if (controlType === "missing") {
      await mkdir(paths.control, { mode: 0o700 });
      await writeFile(
        paths.owner,
        `${JSON.stringify({ schemaVersion: 1, owner: OWNER }, null, 2)}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
    } else {
      await readManifest();
    }
    const backupsType = await pathType(paths.backups);
    if (backupsType === "missing") await mkdir(paths.backups, { mode: 0o700 });
    else if (backupsType !== "directory") {
      throw new CodexAgentStoreError("agents.unsafe_backups", "Agent backup path is not a directory.", 409);
    }
  }

  async function inspect() {
    if (!paths || !codexHome) {
      return {
        writeEnabled: false,
        health: "preview-only",
        codexHome: null,
        configPath: null,
        agentsDir: null,
        requiresOverwrite: false,
        conflicts: [],
        preset: publicPreset(),
        agents: AGENT_DEFINITIONS.map((agent) => ({ name: agent.name, status: "unavailable" })),
      };
    }
    const rootType = await pathType(paths.root);
    if (rootType !== "missing" && rootType !== "directory") {
      throw new CodexAgentStoreError("agents.unsafe_root", "CODEX_HOME is not a safe directory.", 409);
    }
    const configType = await pathType(paths.config);
    if (configType !== "missing" && configType !== "file") {
      throw new CodexAgentStoreError("agents.unsafe_config", "config.toml is not a regular file.", 409);
    }
    const agentsType = await pathType(paths.agents);
    if (agentsType !== "missing" && agentsType !== "directory") {
      throw new CodexAgentStoreError("agents.unsafe_directory", "Codex agents path is not a directory.", 409);
    }
    const config = configType === "file" ? await readFile(paths.config, "utf8") : "";
    const merged = mergeCodexAgentConfig(config);
    const manifest = await readManifest();
    const agents = [];
    const conflicts = [];
    for (const definition of AGENT_DEFINITIONS) {
      const path = join(paths.agents, `${definition.name}.toml`);
      const type = agentsType === "missing" ? "missing" : await pathType(path);
      if (type === "missing") {
        agents.push({ name: definition.name, status: "missing" });
        continue;
      }
      if (type !== "file") {
        throw new CodexAgentStoreError(
          "agents.unsafe_agent",
          `${definition.name}.toml is not a regular file.`,
          409,
        );
      }
      const content = await readFile(path, "utf8");
      const currentHash = sha256(content);
      const desiredHash = sha256(RENDERED_AGENTS.get(definition.name));
      if (currentHash === desiredHash) {
        agents.push({ name: definition.name, status: "installed" });
      } else if (manifest?.agents?.[definition.name] === currentHash) {
        agents.push({ name: definition.name, status: "update-available" });
      } else {
        agents.push({ name: definition.name, status: "conflict" });
        conflicts.push(definition.name);
      }
    }
    const allInstalled = agents.every((agent) => agent.status === "installed");
    return {
      writeEnabled: true,
      health: allInstalled && !merged.changed ? "installed" : conflicts.length > 0 ? "conflict" : "ready",
      codexHome,
      configPath: paths.config,
      agentsDir: paths.agents,
      configStatus: merged.changed ? "update-required" : "installed",
      requiresOverwrite: conflicts.length > 0,
      conflicts,
      preset: publicPreset(),
      agents,
      lastInstalledAt: manifest?.installedAt ?? null,
    };
  }

  async function status() {
    try {
      return await inspect();
    } catch (error) {
      if (error instanceof CodexAgentStoreError) {
        return {
          writeEnabled: Boolean(paths),
          health: error.code,
          codexHome,
          configPath: paths?.config ?? null,
          agentsDir: paths?.agents ?? null,
          requiresOverwrite: false,
          conflicts: [],
          preset: publicPreset(),
          agents: [],
          error: error.message,
        };
      }
      throw error;
    }
  }

  async function withLock(operation) {
    let handle;
    try {
      handle = await open(paths.lock, "wx", 0o600);
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new CodexAgentStoreError(
          "agents.locked",
          "Another Interactive agent installation is already running.",
          409,
        );
      }
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

  async function install({ allowOverwrite = false } = {}) {
    await ensureDirectories();
    return withLock(async () => {
    const before = await inspect();
    if (before.conflicts.length > 0 && !allowOverwrite) {
      throw new CodexAgentStoreError(
        "agents.overwrite_required",
        `Existing custom agents require explicit backup and overwrite: ${before.conflicts.join(", ")}.`,
        409,
      );
    }
    const manifest = await readManifest();
    const manifestType = await pathType(paths.manifest);
    const previousManifestContent =
      manifestType === "file" ? await readFile(paths.manifest, "utf8") : null;
    const configType = await pathType(paths.config);
    const config = configType === "file" ? await readFile(paths.config, "utf8") : "";
    const merged = mergeCodexAgentConfig(config);
    const changes = [];
    if (merged.changed) changes.push({ path: paths.config, previous: configType === "file" ? config : null, content: merged.content, backupName: CONFIG_FILE });
    for (const definition of AGENT_DEFINITIONS) {
      const path = join(paths.agents, `${definition.name}.toml`);
      const type = await pathType(path);
      if (type !== "missing" && type !== "file") {
        throw new CodexAgentStoreError("agents.unsafe_agent", `${definition.name}.toml is not a regular file.`, 409);
      }
      const previous = type === "file" ? await readFile(path, "utf8") : null;
      const content = RENDERED_AGENTS.get(definition.name);
      if (previous === content) continue;
      const currentHash = previous === null ? null : sha256(previous);
      const productOwned = currentHash !== null && manifest?.agents?.[definition.name] === currentHash;
      if (previous !== null && !productOwned && !allowOverwrite) {
        throw new CodexAgentStoreError(
          "agents.overwrite_required",
          `Existing ${definition.name}.toml requires explicit backup and overwrite.`,
          409,
        );
      }
      changes.push({ path, previous, content, backupName: join("agents", `${definition.name}.toml`) });
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
      await writeFile(
        join(backupRoot, "backup.json"),
        `${JSON.stringify({ schemaVersion: 1, owner: OWNER, backupId, createdAt: clock().toISOString() }, null, 2)}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
    }

    const applied = [];
    try {
      for (const change of changes) {
        await atomicWrite(change.path, change.content, nonceFactory);
        applied.push(change);
      }
      const installedAt = clock().toISOString();
      const nextManifest = {
        schemaVersion: 1,
        owner: OWNER,
        presetVersion: PRESET_VERSION,
        installedAt,
        backupId,
        agents: Object.fromEntries(
          AGENT_DEFINITIONS.map((definition) => [
            definition.name,
            sha256(RENDERED_AGENTS.get(definition.name)),
          ]),
        ),
      };
      const nextManifestContent = `${JSON.stringify(nextManifest, null, 2)}\n`;
      await atomicWrite(paths.manifest, nextManifestContent, nonceFactory);

      const rollback = async () => {
        await ensureDirectories();
        return withLock(async () => {
          for (const change of changes) {
            const type = await pathType(change.path);
            if (type !== "file" || (await readFile(change.path, "utf8")) !== change.content) {
              throw new CodexAgentStoreError(
                "agents.rollback_conflict",
                "Interactive agent files changed after installation; automatic rollback was refused.",
                409,
              );
            }
          }
          if (
            (await pathType(paths.manifest)) !== "file" ||
            (await readFile(paths.manifest, "utf8")) !== nextManifestContent
          ) {
            throw new CodexAgentStoreError(
              "agents.rollback_conflict",
              "Interactive agent manifest changed after installation; automatic rollback was refused.",
              409,
            );
          }
          for (const change of [...changes].reverse()) {
            if (change.previous === null) {
              await unlink(change.path).catch((cleanupError) => {
                if (cleanupError?.code !== "ENOENT") throw cleanupError;
              });
            } else {
              await atomicWrite(change.path, change.previous, nonceFactory);
            }
          }
          if (previousManifestContent === null) {
            await unlink(paths.manifest).catch((cleanupError) => {
              if (cleanupError?.code !== "ENOENT") throw cleanupError;
            });
          } else {
            await atomicWrite(paths.manifest, previousManifestContent, nonceFactory);
          }
          return { status: await inspect() };
        });
      };

      return {
        changed: changes.length > 0,
        backupId,
        status: await inspect(),
        rollback,
      };
    } catch (error) {
      for (const change of applied.reverse()) {
        if (change.previous === null) {
          await unlink(change.path).catch((cleanupError) => {
            if (cleanupError?.code !== "ENOENT") throw cleanupError;
          });
        } else {
          await atomicWrite(change.path, change.previous, nonceFactory);
        }
      }
      throw error;
    }
    });
  }

  return { install, status };
}
