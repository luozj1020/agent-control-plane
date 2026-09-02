import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MANIFEST_SCHEMA_VERSION = 1;
const COMMAND_TIMEOUT_MILLISECONDS = 5000;
const COMMAND_OUTPUT_LIMIT = 32 * 1024;
const HARNESS_IDS = new Set(["codex", "claude-code", "cursor", "opencode"]);
const DIAGNOSTIC_ENVIRONMENT_NAMES = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "LC_ALL", "TZ",
  "TMPDIR", "TEMP", "TMP", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME",
  "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "SYSTEMROOT", "COMSPEC", "PATHEXT",
]);
const CODEGRAPH_TARGETS = Object.freeze({
  codex: "codex",
  "claude-code": "claude",
  cursor: "cursor",
  opencode: "opencode",
});

const BUILTIN_MANIFESTS = Object.freeze([
  Object.freeze({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    id: "codegraph-cli",
    manifestVersion: "1.0.0",
    kind: "local-tool",
    displayName: "CodeGraph CLI",
    summary: "本地代码索引、符号检索与调用链分析。项目索引由用户明确初始化。",
    capabilities: Object.freeze(["code-search", "call-graph", "impact-analysis"]),
    discovery: Object.freeze({ command: "codegraph", versionArgs: Object.freeze(["--version"]) }),
    project: Object.freeze({
      marker: ".codegraph",
      probe: Object.freeze({
        args: Object.freeze(["status", "{projectRoot}", "-j"]),
        parser: "codegraph-status-v1",
      }),
    }),
    permissions: Object.freeze({ filesystem: "repository-read", network: "install-only" }),
    harnessSupport: Object.freeze([
      Object.freeze({ id: "codex", displayName: "Codex", support: "cli-and-mcp" }),
      Object.freeze({ id: "claude-code", displayName: "Claude Code", support: "cli-and-mcp" }),
      Object.freeze({ id: "cursor", displayName: "Cursor", support: "mcp" }),
      Object.freeze({ id: "opencode", displayName: "OpenCode", support: "cli-and-mcp" }),
    ]),
  }),
  Object.freeze({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    id: "codegraph-mcp",
    manifestVersion: "1.0.0",
    kind: "mcp-server",
    displayName: "CodeGraph MCP",
    summary: "将已安装的 CodeGraph 投影到所选 Harness 的 MCP 配置。",
    capabilities: Object.freeze(["mcp-tools", "code-search", "call-graph"]),
    discovery: Object.freeze({ command: "codegraph", versionArgs: Object.freeze(["--version"]) }),
    project: Object.freeze({
      marker: ".codegraph",
      probe: Object.freeze({
        args: Object.freeze(["status", "{projectRoot}", "-j"]),
        parser: "codegraph-status-v1",
      }),
    }),
    permissions: Object.freeze({ filesystem: "harness-config-write", network: "none" }),
    harnessSupport: Object.freeze([
      Object.freeze({ id: "codex", displayName: "Codex", support: "native-mcp-config" }),
      Object.freeze({ id: "claude-code", displayName: "Claude Code", support: "native-mcp-config" }),
      Object.freeze({ id: "cursor", displayName: "Cursor", support: "native-mcp-config" }),
      Object.freeze({ id: "opencode", displayName: "OpenCode", support: "native-mcp-config" }),
    ]),
  }),
  Object.freeze({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    id: "custom-mcp-server",
    manifestVersion: "1.0.0",
    kind: "mcp-server",
    displayName: "自定义 MCP Server",
    summary: "统一登记 MCP 命令、参数和环境变量名称，再由 Harness Adapter 生成配置。",
    capabilities: Object.freeze(["mcp-registration", "harness-projection"]),
    discovery: null,
    project: null,
    permissions: Object.freeze({ filesystem: "harness-config-write", network: "server-defined" }),
    harnessSupport: Object.freeze([
      Object.freeze({ id: "codex", displayName: "Codex", support: "projection-reserved" }),
      Object.freeze({ id: "claude-code", displayName: "Claude Code", support: "projection-reserved" }),
      Object.freeze({ id: "cursor", displayName: "Cursor", support: "projection-reserved" }),
      Object.freeze({ id: "opencode", displayName: "OpenCode", support: "projection-reserved" }),
    ]),
  }),
]);

export class IntegrationRegistryError extends Error {
  constructor(code, message, status = 400, path = null) {
    super(message);
    this.name = "IntegrationRegistryError";
    this.code = code;
    this.status = status;
    if (path) this.path = path;
  }
}

async function defaultCommandRunner(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.environment,
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MILLISECONDS,
      maxBuffer: COMMAND_OUTPUT_LIMIT,
      windowsHide: true,
    });
    return { exitCode: 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "", timedOut: false };
  } catch (error) {
    return {
      exitCode: Number.isInteger(error?.code) ? error.code : null,
      stdout: typeof error?.stdout === "string" ? error.stdout : "",
      stderr: typeof error?.stderr === "string" ? error.stderr : "",
      timedOut: error?.killed === true || error?.code === "ETIMEDOUT",
      spawnErrorCode: typeof error?.code === "string" ? error.code : null,
    };
  }
}

function diagnosticEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name, value]) => DIAGNOSTIC_ENVIRONMENT_NAMES.has(name) && value !== undefined,
    ),
  );
}

function publicManifest(manifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    manifestVersion: manifest.manifestVersion,
    kind: manifest.kind,
    displayName: manifest.displayName,
    summary: manifest.summary,
    capabilities: [...manifest.capabilities],
    project: manifest.project
      ? {
          marker: manifest.project.marker,
          probe: manifest.project.probe
            ? { parser: manifest.project.probe.parser }
            : null,
        }
      : null,
    permissions: { ...manifest.permissions },
    harnessSupport: manifest.harnessSupport.map((entry) => ({ ...entry })),
  };
}

function validateManifest(manifest, seenIds) {
  const fail = (message) => {
    throw new IntegrationRegistryError(
      "integration.manifest_invalid",
      message,
      500,
      "manifest",
    );
  };
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail("Integration Manifest must be an object.");
  }
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    fail(`Integration Manifest schemaVersion must be ${MANIFEST_SCHEMA_VERSION}.`);
  }
  if (typeof manifest.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.id)) {
    fail("Integration Manifest id must be lowercase kebab-case.");
  }
  if (seenIds.has(manifest.id)) fail(`Duplicate Integration Manifest id '${manifest.id}'.`);
  seenIds.add(manifest.id);
  if (typeof manifest.manifestVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(manifest.manifestVersion)) {
    fail(`Integration Manifest '${manifest.id}' must use a semantic manifestVersion.`);
  }
  if (!["local-tool", "mcp-server"].includes(manifest.kind)) {
    fail(`Integration Manifest '${manifest.id}' has an unsupported kind.`);
  }
  if (typeof manifest.displayName !== "string" || !manifest.displayName.trim()) {
    fail(`Integration Manifest '${manifest.id}' requires displayName.`);
  }
  if (typeof manifest.summary !== "string" || !manifest.summary.trim()) {
    fail(`Integration Manifest '${manifest.id}' requires summary.`);
  }
  if (
    !Array.isArray(manifest.capabilities) ||
    manifest.capabilities.some((value) => typeof value !== "string" || !/^[a-z0-9-]+$/.test(value))
  ) {
    fail(`Integration Manifest '${manifest.id}' has invalid capabilities.`);
  }
  if (manifest.discovery !== null) {
    if (
      !manifest.discovery ||
      typeof manifest.discovery.command !== "string" ||
      !manifest.discovery.command ||
      !Array.isArray(manifest.discovery.versionArgs) ||
      manifest.discovery.versionArgs.some((value) => typeof value !== "string")
    ) {
      fail(`Integration Manifest '${manifest.id}' has invalid discovery metadata.`);
    }
  }
  if (manifest.project !== null) {
    if (
      !manifest.project ||
      typeof manifest.project.marker !== "string" ||
      !/^[A-Za-z0-9._-]+$/.test(manifest.project.marker) ||
      manifest.project.marker === ".."
    ) {
      fail(`Integration Manifest '${manifest.id}' has unsafe project metadata.`);
    }
    const probe = manifest.project.probe;
    if (
      probe !== null &&
      (!probe || probe.parser !== "codegraph-status-v1" || !Array.isArray(probe.args) ||
        probe.args.some((value) => typeof value !== "string") ||
        !probe.args.includes("{projectRoot}"))
    ) {
      fail(`Integration Manifest '${manifest.id}' has invalid project probe metadata.`);
    }
  }
  if (!manifest.permissions || typeof manifest.permissions !== "object") {
    fail(`Integration Manifest '${manifest.id}' requires permissions metadata.`);
  }
  if (
    !Array.isArray(manifest.harnessSupport) ||
    manifest.harnessSupport.some((entry) =>
      !entry || !HARNESS_IDS.has(entry.id) || typeof entry.displayName !== "string" ||
      typeof entry.support !== "string"
    )
  ) {
    fail(`Integration Manifest '${manifest.id}' has invalid Harness support.`);
  }
}

async function findExecutable(command, environment) {
  const candidates = isAbsolute(command) || command.includes("/") || command.includes("\\")
    ? [command]
    : String(environment.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => join(directory, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through PATH without invoking a shell.
    }
  }
  return null;
}

async function projectMarkerState(projectRoot, project) {
  const marker = project?.marker ?? null;
  if (!marker) return { configured: null, marker: null, markerState: "not-applicable" };
  try {
    const metadata = await lstat(join(projectRoot, marker));
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      return { configured: false, marker, markerState: "unsafe" };
    }
    return { configured: true, marker, markerState: "directory" };
  } catch (error) {
    if (error?.code === "ENOENT") return { configured: false, marker, markerState: "missing" };
    return { configured: false, marker, markerState: "unavailable" };
  }
}

function cleanVersion(stdout) {
  const firstLine = String(stdout ?? "").split(/\r?\n/, 1)[0]?.trim() ?? "";
  return /^[A-Za-z0-9][A-Za-z0-9._+ -]{0,80}$/.test(firstLine) ? firstLine : null;
}

async function validateProjectRoot(value, fallback) {
  const candidate = typeof value === "string" && value.trim() ? value.trim() : fallback;
  if (typeof candidate !== "string" || !isAbsolute(candidate)) {
    throw new IntegrationRegistryError(
      "integration.project_root_invalid",
      "projectRoot must be an absolute directory path.",
      400,
      "projectRoot",
    );
  }
  const projectRoot = resolve(candidate);
  try {
    const metadata = await stat(projectRoot);
    if (!metadata.isDirectory()) throw new Error("not-directory");
  } catch {
    throw new IntegrationRegistryError(
      "integration.project_root_unavailable",
      "projectRoot must be an accessible directory.",
      400,
      "projectRoot",
    );
  }
  return projectRoot;
}

function pendingChangeCount(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const counts = ["added", "modified", "removed"].map((key) => value[key]);
  if (counts.some((entry) => !Number.isSafeInteger(entry) || entry < 0)) return null;
  return counts.reduce((sum, entry) => sum + entry, 0);
}

function codegraphProjectStatus(result, projectRoot, marker) {
  if (result.exitCode !== 0) {
    return {
      health: "unhealthy",
      initialized: null,
      verified: false,
      identityMatches: null,
      pendingChanges: null,
      reindexRecommended: null,
      reason: result.timedOut ? "probe-timeout" : "probe-failed",
    };
  }
  let value;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    return {
      health: "unhealthy",
      initialized: null,
      verified: false,
      identityMatches: null,
      pendingChanges: null,
      reindexRecommended: null,
      reason: "invalid-status-json",
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      health: "unhealthy",
      initialized: null,
      verified: false,
      identityMatches: null,
      pendingChanges: null,
      reindexRecommended: null,
      reason: "invalid-status-shape",
    };
  }
  if (value.initialized !== true) {
    return {
      health: "not-initialized",
      initialized: false,
      verified: true,
      identityMatches: null,
      pendingChanges: pendingChangeCount(value.pendingChanges),
      reindexRecommended: value.index?.reindexRecommended === true,
      reason: "probe-reports-uninitialized",
    };
  }
  const observedPath = typeof value.projectPath === "string" && isAbsolute(value.projectPath)
    ? resolve(value.projectPath)
    : null;
  const identityMatches = observedPath === null ? null : observedPath === projectRoot;
  const pendingChanges = pendingChangeCount(value.pendingChanges);
  const reindexRecommended = typeof value.index?.reindexRecommended === "boolean"
    ? value.index.reindexRecommended
    : null;
  if (identityMatches !== true || value.worktreeMismatch === true) {
    return {
      health: identityMatches === false || value.worktreeMismatch === true
        ? "identity-mismatch"
        : "identity-unverified",
      initialized: true,
      verified: false,
      identityMatches,
      pendingChanges,
      reindexRecommended,
      reason: value.worktreeMismatch === true ? "worktree-mismatch" : "project-identity-unavailable",
    };
  }
  return {
    health: pendingChanges === null && reindexRecommended === null
      ? "ready-with-unknown-drift"
      : pendingChanges > 0 || reindexRecommended === true ? "sync-required" : "ready",
    initialized: true,
    verified: true,
    identityMatches: true,
    pendingChanges,
    reindexRecommended,
    reason: reindexRecommended === true
      ? "reindex-recommended"
      : pendingChanges === null
      ? "pending-changes-unavailable"
      : pendingChanges > 0 ? "pending-changes" : null,
    marker,
  };
}

async function inspectProject(manifest, projectRoot, executable, commandRunner, environment, runProbe) {
  const marker = await projectMarkerState(projectRoot, manifest.project);
  const base = {
    applicable: Boolean(manifest.project),
    marker: marker.marker,
    markerState: marker.markerState,
    initialized: marker.markerState === "missing" || marker.markerState === "unsafe" ? false : null,
    verified: false,
    identityMatches: null,
    pendingChanges: null,
    reindexRecommended: null,
    reason: null,
  };
  if (!manifest.project) return { ...base, health: "not-applicable" };
  if (marker.markerState === "unsafe") return { ...base, health: "blocked", reason: "unsafe-marker" };
  if (marker.markerState === "missing") return { ...base, health: "not-initialized", reason: "marker-missing" };
  if (marker.markerState !== "directory") return { ...base, health: "unavailable", reason: "marker-unavailable" };
  if (!executable) return { ...base, health: "verification-unavailable", reason: "global-tool-missing" };
  if (!runProbe || !manifest.project.probe) return { ...base, health: "marker-present", reason: "probe-not-run" };
  const args = manifest.project.probe.args.map((value) =>
    value === "{projectRoot}" ? projectRoot : value
  );
  const result = await commandRunner(executable, args, { cwd: projectRoot, environment });
  if (manifest.project.probe.parser === "codegraph-status-v1") {
    return {
      ...base,
      ...codegraphProjectStatus(result, projectRoot, marker.marker),
    };
  }
  return { ...base, health: "unsupported", reason: "probe-parser-unsupported" };
}

function healthFor(manifest, global, project) {
  if (manifest.id === "custom-mcp-server") return "registration-required";
  if (global.health === "not-installed") return "not-installed";
  if (global.health !== "available") return "unhealthy";
  if (!project.applicable) return "available";
  if (["blocked", "identity-mismatch"].includes(project.health)) return "blocked";
  if (project.health === "not-initialized") return "project-setup-required";
  if (project.health === "sync-required") return "project-sync-required";
  if (project.health !== "ready") return "project-unhealthy";
  if (manifest.id === "codegraph-mcp") return "ready-to-activate";
  return "ready";
}

function check(id, label, status, detail, layer = "system") {
  return { id, label, status, detail, layer };
}

function requireHarness(value) {
  const harnessId = typeof value === "string" ? value : "codex";
  if (!HARNESS_IDS.has(harnessId)) {
    throw new IntegrationRegistryError(
      "integration.harness_invalid",
      "harnessId must be codex, claude-code, cursor, or opencode.",
      400,
      "harnessId",
    );
  }
  return harnessId;
}

function requireScope(value) {
  const scope = value ?? "global";
  if (!["global", "project"].includes(scope)) {
    throw new IntegrationRegistryError(
      "integration.scope_invalid",
      "scope must be global or project.",
      400,
      "scope",
    );
  }
  return scope;
}

export function createIntegrationRegistry(options = {}) {
  const manifests = [...(options.manifests ?? BUILTIN_MANIFESTS)];
  const seenManifestIds = new Set();
  for (const manifest of manifests) validateManifest(manifest, seenManifestIds);
  const environment = options.environment ?? process.env;
  const commandEnvironment = diagnosticEnvironment(environment);
  const defaultProjectRoot = resolve(options.defaultProjectRoot ?? process.cwd());
  const commandRunner = options.commandRunner ?? defaultCommandRunner;

  async function inspect(manifest, projectRoot, runVersion = true) {
    const executable = manifest.discovery
      ? await findExecutable(manifest.discovery.command, environment)
      : null;
    let version = null;
    let commandHealthy = false;
    let timedOut = false;
    if (executable && runVersion) {
      const result = await commandRunner(executable, [...manifest.discovery.versionArgs], {
        cwd: projectRoot,
        environment: commandEnvironment,
      });
      commandHealthy = result.exitCode === 0;
      timedOut = result.timedOut === true;
      if (commandHealthy) version = cleanVersion(result.stdout);
    } else if (executable) {
      commandHealthy = true;
    }
    const global = {
      applicable: Boolean(manifest.discovery),
      health: manifest.id === "custom-mcp-server"
        ? "registration-required"
        : !executable ? "not-installed" : commandHealthy ? "available" : "unhealthy",
      available: manifest.id === "custom-mcp-server" ? null : Boolean(executable && commandHealthy),
      command: manifest.discovery?.command ?? null,
      commandHealthy: manifest.discovery ? commandHealthy : null,
      version,
      timedOut,
      reason: manifest.id === "custom-mcp-server"
        ? "definition-required"
        : !executable ? "command-not-found" : commandHealthy ? null : timedOut ? "version-timeout" : "version-failed",
    };
    const project = await inspectProject(
      manifest,
      projectRoot,
      executable,
      commandRunner,
      commandEnvironment,
      runVersion,
    );
    const health = healthFor(manifest, global, project);
    return {
      manifest: publicManifest(manifest),
      status: {
        health,
        global,
        project,
        effective: {
          health,
          ready: health === "ready" || health === "available",
          blockingLayer: ["not-installed", "unhealthy", "registration-required"].includes(health)
            ? "global"
            : ["project-setup-required", "project-sync-required", "project-unhealthy", "blocked"].includes(health)
              ? "project"
              : health === "ready-to-activate" ? "harness" : null,
        },
        // Compatibility aliases for clients written against Manifest schema v1.
        installed: Boolean(executable),
        commandHealthy,
        version,
        projectConfigured: project.markerState === "directory",
        projectMarker: project.marker,
        projectMarkerState: project.markerState,
        timedOut,
      },
    };
  }

  function manifestById(id) {
    const manifest = manifests.find((candidate) => candidate.id === id);
    if (!manifest) {
      throw new IntegrationRegistryError(
        "integration.not_found",
        `Unknown integration '${id}'.`,
        404,
        "integrationId",
      );
    }
    return manifest;
  }

  return Object.freeze({
    async list(input = {}) {
      const projectRoot = await validateProjectRoot(input.projectRoot, defaultProjectRoot);
      const integrations = [];
      for (const manifest of manifests) integrations.push(await inspect(manifest, projectRoot));
      const summary = {
        total: integrations.length,
        globalAvailable: integrations.filter((entry) => entry.status.global.available === true).length,
        globalUnavailable: integrations.filter((entry) => entry.status.global.available === false).length,
        globalUnknown: integrations.filter((entry) => entry.status.global.available === null).length,
        projectInitialized: new Set(integrations.filter((entry) =>
          entry.status.project.applicable && entry.status.project.initialized === true &&
          entry.status.project.verified === true
        ).map((entry) => entry.status.project.marker)).size,
        projectNotInitialized: new Set(integrations.filter((entry) =>
          entry.status.project.applicable && entry.status.project.initialized === false
        ).map((entry) => entry.status.project.marker)).size,
        projectUnknown: new Set(integrations.filter((entry) =>
          entry.status.project.applicable && entry.status.project.initialized === null
        ).map((entry) => entry.status.project.marker)).size,
        ready: integrations.filter((entry) => entry.status.effective.ready).length,
      };
      return {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        projectRoot,
        integrations,
        summary,
        safety: {
          installExecutionEnabled: false,
          plansRequireConfirmation: true,
          secretsPersisted: false,
        },
      };
    },

    async diagnose(id, input = {}) {
      const manifest = manifestById(id);
      const projectRoot = await validateProjectRoot(input.projectRoot, defaultProjectRoot);
      const inspected = await inspect(manifest, projectRoot);
      const checks = [
        check(
          "manifest",
          "Integration Manifest",
          "passed",
          `${manifest.id}@${manifest.manifestVersion}`,
          "system",
        ),
      ];
      if (manifest.discovery) {
        checks.push(check(
          "executable",
          "本地命令",
          inspected.status.installed ? "passed" : "failed",
          inspected.status.installed ? `${manifest.discovery.command} 可执行` : `${manifest.discovery.command} 未找到`,
          "global",
        ));
        checks.push(check(
          "version",
          "版本握手",
          inspected.status.version
            ? "passed"
            : inspected.status.commandHealthy ? "warning" : inspected.status.installed ? "failed" : "skipped",
          inspected.status.version ?? (inspected.status.timedOut ? "诊断超时" : "版本不可见"),
          "global",
        ));
      } else {
        checks.push(check("definition", "Server 定义", "pending", "等待登记命令、argv 与环境变量名称", "global"));
      }
      if (manifest.project) {
        const project = inspected.status.project;
        checks.push(check(
          "project-marker",
          "项目标记",
          project.markerState === "directory" ? "passed" : project.markerState === "unsafe" ? "failed" : "pending",
          project.markerState === "directory"
            ? `${project.marker}/ 已存在`
            : project.markerState === "unsafe"
              ? `${project.marker} 不是安全目录`
              : `尚未创建 ${project.marker}/`,
          "project",
        ));
        const projectCheckStatus = project.health === "ready"
          ? "passed"
          : project.health === "sync-required" || project.health === "ready-with-unknown-drift"
            ? "warning"
            : project.health === "not-initialized"
              ? "pending"
              : project.health === "verification-unavailable" ? "skipped" : "failed";
        checks.push(check(
          "project-probe",
          "项目初始化与身份",
          projectCheckStatus,
          project.health === "ready"
            ? "初始化完成，索引身份与当前项目一致"
            : project.health === "sync-required"
              ? project.reindexRecommended === true
                ? "索引身份有效，当前工具建议重建索引"
                : `索引身份有效，存在 ${project.pendingChanges} 项待同步变更`
              : project.health === "not-initialized"
                ? "当前项目尚未初始化"
                : project.health === "verification-unavailable"
                  ? "全局工具不可用，无法验证项目初始化状态"
                : `项目探针：${project.health}${project.reason ? ` (${project.reason})` : ""}`,
          "project",
        ));
      }
      return {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        integrationId: id,
        projectRoot,
        health: inspected.status.health,
        global: inspected.status.global,
        project: inspected.status.project,
        effective: inspected.status.effective,
        checks,
        testedAt: new Date().toISOString(),
        contentCaptured: false,
      };
    },

    async plan(id, input = {}) {
      const manifest = manifestById(id);
      const projectRoot = await validateProjectRoot(input.projectRoot, defaultProjectRoot);
      const harnessId = requireHarness(input.harnessId);
      const scope = requireScope(input.scope);
      const inspected = await inspect(manifest, projectRoot);
      const steps = [];
      if (inspected.status.projectMarkerState === "unsafe") {
        steps.push({
          id: "unsafe-project-marker",
          kind: "blocked",
          summary: `${manifest.project?.marker ?? "项目标记"} 不是安全目录；拒绝生成任何写入命令。`,
          cwd: projectRoot,
          argv: null,
          mutates: [],
          requiresNetwork: false,
        });
      } else if (id === "codegraph-cli") {
        if (inspected.status.global.available !== true) {
          steps.push({
            id: "install-cli",
            kind: "manual",
            summary: "CodeGraph CLI 尚未安装；需要先选择受信任的软件来源。",
            cwd: null,
            argv: null,
            mutates: ["system-toolchain"],
            requiresNetwork: true,
          });
        } else if (inspected.status.project.health === "not-initialized") {
          steps.push({
            id: "initialize-index",
            kind: "argv",
            summary: "为当前项目创建本地 CodeGraph 索引。",
            cwd: projectRoot,
            argv: [manifest.discovery.command, "init", projectRoot],
            mutates: [join(projectRoot, ".codegraph")],
            requiresNetwork: false,
          });
        } else if (inspected.status.project.health !== "ready" && inspected.status.project.health !== "sync-required") {
          steps.push({
            id: "project-status-blocked",
            kind: "blocked",
            summary: "当前项目索引存在，但初始化或项目身份未通过验证。请先运行只读诊断。",
            cwd: projectRoot,
            argv: null,
            mutates: [],
            requiresNetwork: false,
          });
        } else {
          steps.push({
            id: "sync-index",
            kind: "argv",
            summary: "同步当前项目的本地 CodeGraph 索引。",
            cwd: projectRoot,
            argv: [manifest.discovery.command, "sync", projectRoot],
            mutates: [join(projectRoot, ".codegraph")],
            requiresNetwork: false,
          });
        }
      } else if (id === "codegraph-mcp") {
        if (inspected.status.global.available !== true) {
          steps.push({
            id: "dependency",
            kind: "blocked",
            summary: "需要先安装 CodeGraph CLI。",
            cwd: projectRoot,
            argv: null,
            mutates: [],
            requiresNetwork: false,
          });
        } else if (inspected.status.project.health === "not-initialized") {
          steps.push({
            id: "project-dependency",
            kind: "blocked",
            summary: "需要先在当前项目初始化 CodeGraph 索引。",
            cwd: projectRoot,
            argv: null,
            mutates: [],
            requiresNetwork: false,
          });
        } else if (inspected.status.project.health !== "ready") {
          steps.push({
            id: "project-not-ready",
            kind: "blocked",
            summary: inspected.status.project.health === "sync-required"
              ? "当前项目索引待同步或重建；完成后再激活 CodeGraph MCP。"
              : "当前项目索引状态无法验证；请先运行只读诊断。",
            cwd: projectRoot,
            argv: null,
            mutates: [],
            requiresNetwork: false,
          });
        } else {
          steps.push({
            id: "project-config-preview",
            kind: "argv-preview",
            summary: `生成 ${harnessId} 的 MCP 配置预览，不写文件。`,
            cwd: projectRoot,
            argv: [manifest.discovery.command, "install", "--print-config", CODEGRAPH_TARGETS[harnessId]],
            mutates: [],
            requiresNetwork: false,
          });
          steps.push({
            id: "activate-mcp",
            kind: "argv",
            summary: `确认后写入 ${harnessId} 的 ${scope === "global" ? "全局" : "项目级"} MCP 配置。`,
            cwd: projectRoot,
            argv: [
              manifest.discovery.command,
              "install",
              "--target",
              CODEGRAPH_TARGETS[harnessId],
              "--location",
              scope === "global" ? "global" : "local",
              "--yes",
              "--no-permissions",
            ],
            mutates: [`${harnessId}:${scope}:mcp-config`],
            requiresNetwork: false,
          });
        }
      } else {
        steps.push({
          id: "register-server",
          kind: "configuration",
          summary: "登记 MCP Server 的 executable、argv、环境变量名称和权限声明。",
          cwd: null,
          argv: null,
          mutates: ["integration-registry"],
          requiresNetwork: false,
        });
        steps.push({
          id: "project-config",
          kind: "reserved",
          summary: `由 ${harnessId} Adapter 生成 ${scope === "global" ? "全局" : "项目级"}配置。`,
          cwd: projectRoot,
          argv: null,
          mutates: [`${harnessId}:${scope}:mcp-config`],
          requiresNetwork: false,
        });
      }
      return {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        kind: "integration-install-plan",
        integrationId: id,
        manifestVersion: manifest.manifestVersion,
        projectRoot,
        harnessId,
        scope,
        currentStatus: {
          global: inspected.status.global,
          project: inspected.status.project,
          effective: inspected.status.effective,
        },
        executable: false,
        requiresConfirmation: true,
        rollbackRequired: steps.some((step) => step.mutates.length > 0),
        steps,
      };
    },
  });
}

export function builtinIntegrationManifests() {
  return BUILTIN_MANIFESTS.map(publicManifest);
}
