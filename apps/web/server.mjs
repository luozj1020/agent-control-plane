import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  BALANCED_BUDGET_LIMITS,
  BALANCED_TIMING_LIMITS,
  BUILTIN_MODE_CATALOG,
  EXAMPLE_AGENTS,
  customizeEffectiveSkill,
  resolveEffectiveSkill,
} from "../../packages/contracts/dist/index.js";
import { createCcSwitchUsageSource } from "./cc-switch-usage-source.mjs";
import { createClaudeUsageSource } from "./claude-usage-source.mjs";
import { createPreferredUsageSource } from "./preferred-usage-source.mjs";
import { activityDetail, buildActivityLog } from "./activity-log.mjs";
import { createBalancedRuntime } from "./balanced-runtime.mjs";
import { createOvernightRuntime } from "./overnight-runtime.mjs";
import { createEditableCodexAgentStore } from "./codex-agent-role-store.mjs";
import { createDirectoryPicker } from "./directory-picker.mjs";
import { createIntegrationRegistry } from "./integration-registry.mjs";
import { createProjectConfigStore, ProjectConfigError } from "./project-config-store.mjs";
import { createWorkflowCoreAdapter } from "./workflow-core-adapter.mjs";
import { createSkillStore, SkillStoreError } from "./skill-store.mjs";
import {
  createTaskCardTemplate,
  normalizeTaskCard,
  renderTaskCardMarkdown,
} from "./task-card.mjs";
import {
  WorkspaceTaskStoreError,
  createWorkspaceTaskStore,
} from "./workspace-task-store.mjs";
import {
  preflightTaskCard,
  createTaskCardPreflightAdapters,
  TASK_CARD_PREFLIGHT_OPTIONS,
} from "./task-card-preflight.mjs";
import {
  createClaudeConnectivityAdapter,
  probeDownstreamConnectivity,
} from "./runtime-connectivity.mjs";
import { discoverRuntimeActivation } from "./runtime-activation.mjs";
import { createUsageMonitor } from "./usage-monitor.mjs";

const PUBLIC_ROOT = fileURLToPath(new URL("./public/", import.meta.url));
const CONTRACTS_ROOT = fileURLToPath(
  new URL("../../packages/contracts/dist/", import.meta.url),
);

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

function securityHeaders(contentType) {
  return {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'",
    "content-type": contentType,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

function sendJson(response, status, value, headOnly = false) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    ...securityHeaders("application/json; charset=utf-8"),
    "content-length": Buffer.byteLength(body),
  });
  response.end(headOnly ? undefined : body);
}

function trustedMutationOrigin(request) {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  const host = request.headers.host;
  if (!host || !/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)) return false;
  return origin === `http://${host}`;
}

async function readJsonBody(request) {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") {
    throw new SkillStoreError("request.content_type", "Content-Type must be application/json.", 415);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      throw new SkillStoreError("request.too_large", "Request body exceeds 1 MiB.", 413);
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new SkillStoreError("request.invalid_json", "Request body is not valid JSON.");
  }
}

function resolveWithin(root, relativePath) {
  const normalizedRoot = resolve(root);
  const candidate = resolve(normalizedRoot, relativePath);
  if (candidate !== normalizedRoot && !candidate.startsWith(`${normalizedRoot}${sep}`)) {
    return null;
  }
  return candidate;
}

async function serveFile(request, response, root, relativePath) {
  const filePath = resolveWithin(root, relativePath);
  if (!filePath) {
    response.writeHead(400, securityHeaders("text/plain; charset=utf-8"));
    response.end("Invalid path");
    return;
  }

  try {
    const metadata = await stat(filePath);
    if (!metadata.isFile()) throw new Error("Not a file");
    const contentType = MIME_TYPES.get(extname(filePath)) ?? "application/octet-stream";
    response.writeHead(200, {
      ...securityHeaders(contentType),
      "content-length": metadata.size,
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, securityHeaders("text/plain; charset=utf-8"));
    response.end("Not found");
  }
}

export function createAppServer(options = {}) {
  const store = options.store ?? createSkillStore({ skillsDir: options.skillsDir });
  const inferredCodexHome =
    options.skillsDir && basename(resolve(options.skillsDir)) === "skills"
      ? dirname(resolve(options.skillsDir))
      : undefined;
  const codexAgentStore =
    options.codexAgentStore ??
    createEditableCodexAgentStore({ codexHome: options.codexHome ?? inferredCodexHome });
  const workflowCoreAdapter = options.workflowCoreAdapter ?? createWorkflowCoreAdapter({
    sourceRoot: options.workflowCoreRoot,
  });
  const balancedRuntime = options.balancedRuntime ?? createBalancedRuntime({
    runtimeRoot: options.balancedRuntimeRoot,
    protocolProvider: (mode) => workflowCoreAdapter.runtimeProtocol(mode),
  });
  const overnightRuntime = options.overnightRuntime ?? createOvernightRuntime({
    runtimeRoot: options.overnightRuntimeRoot,
    protocolProvider: (mode) => workflowCoreAdapter.runtimeProtocol(mode),
  });
  async function collectActivity() {
    const [history, balancedRuns, overnightRuns] = await Promise.all([
      store.history(),
      balancedRuntime.listRuns(),
      overnightRuntime.listRuns(),
    ]);
    return buildActivityLog(history, balancedRuns, overnightRuns);
  }
  const preflightAdapters = options.preflightAdapters ??
    createTaskCardPreflightAdapters(process.env);
  const connectivityAdapters = options.connectivityAdapters ?? [
    createClaudeConnectivityAdapter({
      command: process.env.AGENT_CONTROL_CLAUDE_COMMAND ?? "claude",
    }),
  ];
  const connectivityProbe = options.connectivityProbe ?? ((input) =>
    probeDownstreamConnectivity(input, {
      adapters: connectivityAdapters,
      environment: options.preflightEnvironment ?? process.env,
    }));
  const integrationRegistry = options.integrationRegistry ?? createIntegrationRegistry({
    defaultProjectRoot: options.integrationProjectRoot ?? process.cwd(),
    environment: options.integrationEnvironment ?? process.env,
  });
  const projectConfigStore = options.projectConfigStore ?? createProjectConfigStore({
    stateRoot: options.projectStateRoot,
  });
  const workspaceTaskStore = options.workspaceTaskStore ?? (
    typeof projectConfigStore.resolveWorkspace === "function"
      ? createWorkspaceTaskStore({ projectConfigStore })
      : null
  );
  const directoryPicker = options.directoryPicker ?? createDirectoryPicker();
  async function verifiedProjectBinding(input) {
    if (input === undefined || input === null) return null;
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new ProjectConfigError("project.binding_invalid", "Project activation context is invalid.", 422);
    }
    const project = await projectConfigStore.inspect(input.projectRoot);
    if (!project.initialized) {
      throw new ProjectConfigError("project.not_initialized", "Activation requires an opened local workspace.", 409);
    }
    if (project.migrationRequired || !project.workspaceId) {
      throw new ProjectConfigError("project.migration_required", "Migrate project-local state before activation.", 409);
    }
    if (
      input.workspaceId !== project.workspaceId ||
      input.expectedRevision !== project.revision ||
      input.configSha256 !== project.configSha256
    ) {
      throw new ProjectConfigError(
        "project.binding_stale",
        "Project configuration changed after the Effective Skill was resolved.",
        409,
      );
    }
    return {
      binding: {
        projectId: project.projectId,
        workspaceId: project.workspaceId,
        projectRevision: project.revision,
        projectConfigSha256: project.configSha256,
      },
      overrides: project.overrides ?? {},
    };
  }
  function assertProjectProfile(profile, overrides) {
    const builderId = profile?.roleBindings?.find(
      (entry) => entry?.role === "builder" && entry?.target?.kind === "agent",
    )?.target?.agentId;
    const checks = [
      ["modeId", profile?.mode?.id],
      ["mainAgentId", profile?.mainAgentId],
      ["builderAgentId", builderId],
      ["overnightLoopPolicyId", profile?.overnightLoopPolicy?.id],
    ];
    for (const [key, actual] of checks) {
      if (overrides[key] !== undefined && overrides[key] !== actual) {
        throw new ProjectConfigError(
          "project.profile_mismatch",
          `Effective profile does not match project override '${key}'.`,
          409,
          key,
        );
      }
    }
    for (const key of ["balancedBudget", "balancedTiming"]) {
      if (
        overrides[key] !== undefined &&
        !isDeepStrictEqual(overrides[key], profile?.[key])
      ) {
        throw new ProjectConfigError(
          "project.profile_mismatch",
          `Effective profile does not match project override '${key}'.`,
          409,
          key,
        );
      }
    }
  }
  let usageMonitor = options.usageMonitor;
  if (!usageMonitor) {
    let usageSources = options.usageSources;
    if (!usageSources) {
      const downstreamSources = [];
      if (process.env.AGENT_WORKFLOW_CLAUDE_USAGE !== "off") {
        downstreamSources.push(
          createClaudeUsageSource({ projectsDir: options.claudeProjectsDir }),
        );
      }
      if (process.env.AGENT_WORKFLOW_CC_SWITCH_USAGE !== "off") {
        downstreamSources.push(
          createCcSwitchUsageSource({ databasePath: options.ccSwitchDatabasePath }),
        );
      }
      usageSources = [
        createPreferredUsageSource({
          id: "claude-downstream",
          lane: "downstream",
          sources: downstreamSources,
        }),
      ];
    }
    usageMonitor = createUsageMonitor({ sessionsDir: options.sessionsDir, sources: usageSources });
  }
  return createServer(async (request, response) => {
    let requestUrl;
    let pathname;
    try {
      requestUrl = new URL(request.url ?? "/", "http://local");
      pathname = decodeURIComponent(requestUrl.pathname);
    } catch {
      response.writeHead(400, securityHeaders("text/plain; charset=utf-8"));
      response.end("Invalid URL");
      return;
    }

    try {
      if (pathname === "/api/health" && (request.method === "GET" || request.method === "HEAD")) {
        sendJson(
          response,
          200,
          { status: "ok", product: "ai-coding-workflow-control-plane" },
          request.method === "HEAD",
        );
        return;
      }

      if (pathname === "/api/status" && (request.method === "GET" || request.method === "HEAD")) {
        sendJson(response, 200, await store.status(), request.method === "HEAD");
        return;
      }

      if (pathname === "/api/workflow-core" && (request.method === "GET" || request.method === "HEAD")) {
        sendJson(response, 200, await workflowCoreAdapter.status(), request.method === "HEAD");
        return;
      }

      if (pathname === "/api/system/select-directory" && request.method === "POST") {
        if (!trustedMutationOrigin(request)) {
          sendJson(response, 403, { error: "request.untrusted_origin" });
          return;
        }
        const body = await readJsonBody(request);
        sendJson(response, 200, await directoryPicker.choose({
          initialDirectory: body?.initialDirectory,
        }));
        return;
      }

      if (pathname === "/api/workflow-core/diagnose" && request.method === "POST") {
        if (!trustedMutationOrigin(request)) {
          sendJson(response, 403, { error: "request.untrusted_origin" });
          return;
        }
        await readJsonBody(request);
        sendJson(response, 200, await workflowCoreAdapter.diagnose());
        return;
      }

      if (pathname === "/api/integrations" && (request.method === "GET" || request.method === "HEAD")) {
        sendJson(
          response,
          200,
          await integrationRegistry.list({
            projectRoot: requestUrl.searchParams.get("projectRoot") || undefined,
          }),
          request.method === "HEAD",
        );
        return;
      }

      if (pathname === "/api/projects/current" && (request.method === "GET" || request.method === "HEAD")) {
        sendJson(
          response,
          200,
          await projectConfigStore.inspect(requestUrl.searchParams.get("projectRoot")),
          request.method === "HEAD",
        );
        return;
      }

      if (pathname === "/api/projects/recent" && (request.method === "GET" || request.method === "HEAD")) {
        sendJson(response, 200, await projectConfigStore.recent(), request.method === "HEAD");
        return;
      }

      if (pathname === "/api/projects/open" && request.method === "POST") {
        if (!trustedMutationOrigin(request)) {
          sendJson(response, 403, { error: "request.untrusted_origin" });
          return;
        }
        const body = await readJsonBody(request);
        sendJson(response, 200, await projectConfigStore.open(body?.projectRoot));
        return;
      }

      if (pathname === "/api/projects/initialize" && request.method === "POST") {
        if (!trustedMutationOrigin(request)) {
          sendJson(response, 403, { error: "request.untrusted_origin" });
          return;
        }
        const body = await readJsonBody(request);
        sendJson(response, 200, await projectConfigStore.initialize(body?.projectRoot));
        return;
      }

      if (pathname === "/api/projects/migrate" && request.method === "POST") {
        if (!trustedMutationOrigin(request)) {
          sendJson(response, 403, { error: "request.untrusted_origin" });
          return;
        }
        const body = await readJsonBody(request);
        sendJson(response, 200, await projectConfigStore.migrate(body?.projectRoot));
        return;
      }

      if (pathname === "/api/projects/current" && request.method === "PUT") {
        if (!trustedMutationOrigin(request)) {
          sendJson(response, 403, { error: "request.untrusted_origin" });
          return;
        }
        const body = await readJsonBody(request);
        sendJson(response, 200, await projectConfigStore.save({
          projectRoot: body?.projectRoot,
          expectedRevision: body?.expectedRevision,
          expectedSharedConfigSha256: body?.expectedSharedConfigSha256,
          overrides: body?.overrides,
          scope: body?.scope,
        }));
        return;
      }

      if (pathname === "/api/projects/restore" && request.method === "POST") {
        if (!trustedMutationOrigin(request)) {
          sendJson(response, 403, { error: "request.untrusted_origin" });
          return;
        }
        const body = await readJsonBody(request);
        sendJson(response, 200, await projectConfigStore.restore({
          projectRoot: body?.projectRoot,
          expectedRevision: body?.expectedRevision,
          expectedSharedConfigSha256: body?.expectedSharedConfigSha256,
          revision: body?.revision,
        }));
        return;
      }

      if (
        pathname === "/api/workspace-tasks/current" &&
        (request.method === "GET" || request.method === "HEAD")
      ) {
        if (!workspaceTaskStore) {
          sendJson(response, 501, { error: "task.workspace_store_unavailable" }, request.method === "HEAD");
          return;
        }
        const requestedTaskId = requestUrl.searchParams.get("taskId") || undefined;
        sendJson(
          response,
          200,
          await workspaceTaskStore.current({
            projectRoot: requestUrl.searchParams.get("projectRoot"),
            ...(requestedTaskId === undefined ? {} : { taskId: requestedTaskId }),
          }),
          request.method === "HEAD",
        );
        return;
      }

      if (
        pathname === "/api/workspace-tasks" &&
        (request.method === "GET" || request.method === "HEAD")
      ) {
        if (!workspaceTaskStore) {
          sendJson(response, 501, { error: "task.workspace_store_unavailable" }, request.method === "HEAD");
          return;
        }
        sendJson(
          response,
          200,
          await workspaceTaskStore.list({
            projectRoot: requestUrl.searchParams.get("projectRoot"),
          }),
          request.method === "HEAD",
        );
        return;
      }

      if (pathname === "/api/workspace-tasks" && request.method === "POST") {
        if (!trustedMutationOrigin(request)) {
          sendJson(response, 403, { error: "request.untrusted_origin" });
          return;
        }
        if (!workspaceTaskStore) {
          sendJson(response, 501, { error: "task.workspace_store_unavailable" });
          return;
        }
        const body = await readJsonBody(request);
        sendJson(response, 201, await workspaceTaskStore.create({
          projectRoot: body?.projectRoot,
          taskId: body?.taskId,
          task: body?.task,
          source: body?.source,
        }));
        return;
      }

      if (pathname === "/api/workspace-tasks/working-copy" && request.method === "PUT") {
        if (!trustedMutationOrigin(request)) {
          sendJson(response, 403, { error: "request.untrusted_origin" });
          return;
        }
        if (!workspaceTaskStore) {
          sendJson(response, 501, { error: "task.workspace_store_unavailable" });
          return;
        }
        const body = await readJsonBody(request);
        sendJson(response, 200, await workspaceTaskStore.write({
          projectRoot: body?.projectRoot,
          taskId: body?.taskId,
          expectedWorkingCopyGeneration: body?.expectedWorkingCopyGeneration,
          task: body?.task,
          source: body?.source,
        }));
        return;
      }

      if (pathname === "/api/workspace-tasks/edit" && request.method === "POST") {
        if (!trustedMutationOrigin(request)) {
          sendJson(response, 403, { error: "request.untrusted_origin" });
          return;
        }
        if (!workspaceTaskStore) {
          sendJson(response, 501, { error: "task.workspace_store_unavailable" });
          return;
        }
        const body = await readJsonBody(request);
        sendJson(response, 200, await workspaceTaskStore.edit({
          projectRoot: body?.projectRoot,
          taskId: body?.taskId,
          baseTaskRevision: body?.baseTaskRevision,
          source: body?.source,
        }));
        return;
      }

      const workspaceTaskAction = pathname.match(/^\/api\/workspace-tasks\/(validate|freeze)$/);
      if (workspaceTaskAction && request.method === "POST") {
        if (!trustedMutationOrigin(request)) {
          sendJson(response, 403, { error: "request.untrusted_origin" });
          return;
        }
        if (!workspaceTaskStore) {
          sendJson(response, 501, { error: "task.workspace_store_unavailable" });
          return;
        }
        const body = await readJsonBody(request);
        const input = {
          projectRoot: body?.projectRoot,
          taskId: body?.taskId,
          expectedWorkingCopyGeneration: body?.expectedWorkingCopyGeneration,
        };
        sendJson(
          response,
          200,
          workspaceTaskAction[1] === "validate"
            ? await workspaceTaskStore.validate(input)
            : await workspaceTaskStore.freeze(input),
        );
        return;
      }

      const integrationAction = pathname.match(/^\/api\/integrations\/([^/]+)\/(diagnose|plan)$/);
      if (integrationAction && request.method === "POST") {
        if (!trustedMutationOrigin(request)) {
          sendJson(response, 403, { error: "request.untrusted_origin" });
          return;
        }
        const integrationId = integrationAction[1];
        const action = integrationAction[2];
        const body = await readJsonBody(request);
        sendJson(
          response,
          200,
          action === "diagnose"
            ? await integrationRegistry.diagnose(integrationId, body)
            : await integrationRegistry.plan(integrationId, body),
        );
        return;
      }

      if (pathname === "/api/interactive-agents" && (request.method === "GET" || request.method === "HEAD")) {
        sendJson(response, 200, await codexAgentStore.status(), request.method === "HEAD");
        return;
      }

      if (pathname === "/api/interactive-agents/install" && request.method === "POST") {
        if (!trustedMutationOrigin(request)) {
          sendJson(response, 403, { error: "request.untrusted_origin" });
          return;
        }
        const body = await readJsonBody(request);
        sendJson(
          response,
          200,
          await codexAgentStore.install({
            allowOverwrite: body?.allowOverwrite === true,
            configuration: body?.configuration,
          }),
        );
        return;
      }

      if (pathname === "/api/interactive-agents/plan" && request.method === "POST") {
        if (!trustedMutationOrigin(request)) {
          sendJson(response, 403, { error: "request.untrusted_origin" });
          return;
        }
        const body = await readJsonBody(request);
        const plan = await codexAgentStore.status(body?.configuration);
        if (plan.health === "agents.invalid_configuration") {
          sendJson(response, 422, {
            ...plan,
            error: plan.health,
            message: plan.error,
          });
          return;
        }
        sendJson(response, 200, plan);
        return;
      }

      if (pathname === "/api/usage" && (request.method === "GET" || request.method === "HEAD")) {
        const range = requestUrl.searchParams.get("range") ?? "24h";
        const lane = requestUrl.searchParams.get("lane") ?? "all";
        const model = requestUrl.searchParams.get("model") || null;
        sendJson(
          response,
          200,
          await usageMonitor.collect(range, { lane, model }),
          request.method === "HEAD",
        );
        return;
      }

      const coordinationRun = pathname.match(
        /^\/api\/coordination\/(balanced|overnight)\/([a-z0-9][a-z0-9._-]{0,159})$/,
      );
      if (coordinationRun && (request.method === "GET" || request.method === "HEAD")) {
        const [, mode, runId] = coordinationRun;
        const maximumEvents = Math.min(
          500,
          Math.max(1, Number.parseInt(requestUrl.searchParams.get("limit") ?? "200", 10) || 200),
        );
        const runtime = mode === "balanced" ? balancedRuntime : overnightRuntime;
        if (typeof runtime.coordinationDetail !== "function") {
          sendJson(response, 501, { error: "coordination.detail_unsupported" }, request.method === "HEAD");
          return;
        }
        sendJson(
          response,
          200,
          await runtime.coordinationDetail(runId, { maximumEvents }),
          request.method === "HEAD",
        );
        return;
      }

      if (pathname === "/api/coordination" && (request.method === "GET" || request.method === "HEAD")) {
        const [balancedRuns, overnightRuns] = await Promise.all([
          balancedRuntime.listRuns(),
          overnightRuntime.listRuns(),
        ]);
        const requestedMode = requestUrl.searchParams.get("mode") ?? "all";
        const limit = Math.min(200, Math.max(1, Number.parseInt(requestUrl.searchParams.get("limit") ?? "50", 10) || 50));
        const runs = [...balancedRuns, ...overnightRuns]
          .map((run) => run.coordination)
          .filter(Boolean)
          .filter((run) => requestedMode === "all" || run.mode === requestedMode)
          .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
          .slice(0, limit);
        const aggregate = {
          runs: runs.length,
          events: runs.reduce((total, run) => total + run.eventCount, 0),
          agentInvocations: runs.reduce((total, run) => total + run.agentInvocations, 0),
          artifactReads: runs.reduce((total, run) => total + (run.artifactReads ?? 0), 0),
          artifactWrites: runs.reduce((total, run) => total + run.artifactWrites, 0),
          readViolations: runs.reduce((total, run) => total + (run.readViolations ?? 0), 0),
          readClassifications: {
            allowed: runs.reduce((total, run) => total + (run.readClassifications?.allowed ?? 0), 0),
            outOfScope: runs.reduce((total, run) => total + (run.readClassifications?.outOfScope ?? 0), 0),
            forbidden: runs.reduce((total, run) => total + (run.readClassifications?.forbidden ?? 0), 0),
            unknown: runs.reduce((total, run) => total + (run.readClassifications?.unknown ?? 0), 0),
          },
          topology: {
            nodeCount: runs.reduce((total, run) => total + (run.topology?.nodeCount ?? 0), 0),
            relationshipCount: runs.reduce((total, run) => total + (run.topology?.relationshipCount ?? 0), 0),
            uniqueReadArtifacts: runs.reduce((total, run) => total + (run.topology?.uniqueReadArtifacts ?? 0), 0),
            repeatedArtifactReads: runs.reduce((total, run) => total + (run.topology?.repeatedArtifactReads ?? 0), 0),
            artifactReaderLinks: runs.reduce((total, run) => total + (run.topology?.artifactReaderLinks ?? 0), 0),
            maxArtifactReaderFanOut: runs.reduce(
              (maximum, run) => Math.max(maximum, run.topology?.maxArtifactReaderFanOut ?? 0),
              0,
            ),
          },
          stateTransitions: runs.reduce((total, run) => total + run.stateTransitions, 0),
          reviewDecisions: runs.reduce((total, run) => total + run.reviewDecisions, 0),
          validationEvents: runs.reduce((total, run) => total + run.validationEvents, 0),
          wakeEvents: runs.reduce((total, run) => total + run.wakeEvents, 0),
          observedTokens: runs.reduce((total, run) => total + run.observedTokens, 0),
        };
        const coverage = Object.fromEntries(["invoke", "write", "read", "message"].map((dimension) => {
          const values = runs.map((run) => run.coverage?.[dimension]).filter(Boolean);
          const unique = new Set(values);
          const status = values.length === 0
            ? "not-observed"
            : unique.size === 1
              ? values[0]
              : "mixed";
          return [dimension, status];
        }));
        sendJson(
          response,
          200,
          { schemaVersion: 1, generatedAt: new Date().toISOString(), aggregate, coverage, runs },
          request.method === "HEAD",
        );
        return;
      }

      if (
        pathname === "/api/task-card/template" &&
        (request.method === "GET" || request.method === "HEAD")
      ) {
        const task = createTaskCardTemplate();
        sendJson(
          response,
          200,
          {
            task,
            sourceFormat: "task-card-v1",
            projections: {
              audit: renderTaskCardMarkdown(task, { view: "audit" }),
              execution: renderTaskCardMarkdown(task, { view: "execution" }),
            },
          },
          request.method === "HEAD",
        );
        return;
      }

      if (
        pathname === "/api/task-card/schema" &&
        (request.method === "GET" || request.method === "HEAD")
      ) {
        const projected = await workflowCoreAdapter.schema("task-card-v1");
        sendJson(response, 200, projected.schema, request.method === "HEAD");
        return;
      }

      if (pathname === "/api/task-card/validate" && request.method === "POST") {
        if (!trustedMutationOrigin(request)) {
          sendJson(response, 403, { error: "request.untrusted_origin" });
          return;
        }
        const normalized = normalizeTaskCard(await readJsonBody(request));
        sendJson(response, 200, {
          valid: true,
          ...normalized,
          projections: {
            audit: renderTaskCardMarkdown(normalized.task, { view: "audit" }),
            execution: renderTaskCardMarkdown(normalized.task, { view: "execution" }),
          },
        });
        return;
      }

      if (
        pathname === "/api/task-card/preflight" &&
        (request.method === "GET" || request.method === "HEAD")
      ) {
        const diagnosticAdapterIds = new Set(connectivityAdapters.map((adapter) => adapter.id));
        sendJson(
          response,
          200,
          {
            ...TASK_CARD_PREFLIGHT_OPTIONS,
            workflowCore: await workflowCoreAdapter.status(),
            adapters: preflightAdapters.map((adapter) => ({
              ...adapter,
              connectivityProbeSupported: diagnosticAdapterIds.has(adapter.id),
            })),
          },
          request.method === "HEAD",
        );
        return;
      }

      if (pathname === "/api/task-card/preflight" && request.method === "POST") {
        if (!trustedMutationOrigin(request)) {
          sendJson(response, 403, { error: "request.untrusted_origin" });
          return;
        }
        const body = await readJsonBody(request);
        const workspaceTask = body?.workspaceTask;
        let task = body?.task;
        if (workspaceTask !== undefined) {
          if (!workspaceTaskStore) {
            throw new WorkspaceTaskStoreError(
              "task.workspace_store_unavailable",
              "Workspace Task Store is unavailable.",
              501,
            );
          }
          const current = await workspaceTaskStore.current({
            projectRoot: workspaceTask?.projectRoot,
            taskId: workspaceTask?.taskId,
          });
          if (
            !current.revisionArtifact ||
            current.revisionArtifact.taskRevision !== workspaceTask?.taskRevision ||
            current.revisionArtifact.taskSha256 !== workspaceTask?.taskSha256
          ) {
            throw new WorkspaceTaskStoreError(
              "preflight.task_reference_stale",
              "Requested Task reference does not match the immutable Workspace Task Revision.",
              409,
            );
          }
          task = current.revisionArtifact.task;
        }
        const preflight = await preflightTaskCard({ ...body, task }, {
          adapters: preflightAdapters,
          environment: options.preflightEnvironment ?? process.env,
          workflowContract: await workflowCoreAdapter.status(),
        });
        if (workspaceTask === undefined || !preflight.ready) {
          sendJson(response, 200, {
            ...preflight,
            executionReady: false,
            receipt: null,
          });
          return;
        }
        const activation = await discoverRuntimeActivation(body.workflowMode, {
          store,
          environment: options.preflightEnvironment ?? process.env,
        });
        const persisted = await workspaceTaskStore.createPreflight({
          projectRoot: workspaceTask.projectRoot,
          taskId: workspaceTask.taskId,
          taskRevision: workspaceTask.taskRevision,
          taskSha256: workspaceTask.taskSha256,
          preflightResult: preflight,
          activation,
        });
        sendJson(response, 200, {
          ...preflight,
          executionReady: true,
          receipt: persisted.receipt,
        });
        return;
      }

      if (pathname === "/api/runtime/connectivity-probe" && request.method === "POST") {
        if (!trustedMutationOrigin(request)) {
          sendJson(response, 403, { error: "request.untrusted_origin" });
          return;
        }
        sendJson(response, 200, await connectivityProbe(await readJsonBody(request)));
        return;
      }

      if (pathname === "/api/balanced/config" && (request.method === "GET" || request.method === "HEAD")) {
        const mode = BUILTIN_MODE_CATALOG.modes.find((candidate) => candidate.kind === "balanced");
        const policy = BUILTIN_MODE_CATALOG.tunedWindowPolicies.find(
          (candidate) =>
            candidate.id === mode?.tunedWindowPolicy.id &&
            candidate.version === mode?.tunedWindowPolicy.version,
        );
        const budget = BUILTIN_MODE_CATALOG.balancedBudgetPolicies.find(
          (candidate) =>
            candidate.id === mode?.budgetPolicy.id && candidate.version === mode?.budgetPolicy.version,
        );
        sendJson(
          response,
          200,
          {
            mode: mode ? { id: mode.id, version: mode.version } : null,
            policy,
            budget,
            budgetLimits: BALANCED_BUDGET_LIMITS,
            timingLimits: BALANCED_TIMING_LIMITS,
            adapters: EXAMPLE_AGENTS.filter((agent) => agent.capabilities.includes("bounded-execution"))
              .map((agent) => ({ id: agent.id, displayName: agent.displayName })),
          },
          request.method === "HEAD",
        );
        return;
      }

      if (pathname === "/api/balanced/runs" && (request.method === "GET" || request.method === "HEAD")) {
        sendJson(
          response,
          200,
          { runs: await balancedRuntime.listRuns() },
          request.method === "HEAD",
        );
        return;
      }

      if (pathname === "/api/overnight/runs" && (request.method === "GET" || request.method === "HEAD")) {
        sendJson(
          response,
          200,
          { runs: await overnightRuntime.listRuns() },
          request.method === "HEAD",
        );
        return;
      }

      const overnightInterrupt = pathname.match(/^\/api\/overnight\/runs\/([^/]+)\/interrupt$/);
      if (overnightInterrupt && request.method === "POST") {
        if (!trustedMutationOrigin(request)) {
          sendJson(response, 403, { error: "request.untrusted_origin" });
          return;
        }
        sendJson(response, 200, await overnightRuntime.interruptById(overnightInterrupt[1]));
        return;
      }

      if (pathname === "/api/history" && (request.method === "GET" || request.method === "HEAD")) {
        sendJson(response, 200, await store.history(), request.method === "HEAD");
        return;
      }

      if (pathname === "/api/activity" && (request.method === "GET" || request.method === "HEAD")) {
        sendJson(response, 200, await collectActivity(), request.method === "HEAD");
        return;
      }

      const activityEntry = pathname.match(/^\/api\/activity\/([^/]+)$/);
      if (activityEntry && (request.method === "GET" || request.method === "HEAD")) {
        const [detail, activity] = await Promise.all([
          store.historyDetail(activityEntry[1]),
          collectActivity(),
        ]);
        sendJson(
          response,
          200,
          activityDetail(detail, activity),
          request.method === "HEAD",
        );
        return;
      }

      const historyDetail = pathname.match(/^\/api\/history\/([^/]+)$/);
      if (historyDetail && (request.method === "GET" || request.method === "HEAD")) {
        sendJson(
          response,
          200,
          await store.historyDetail(historyDetail[1]),
          request.method === "HEAD",
        );
        return;
      }

      const historyRestore = pathname.match(/^\/api\/history\/([^/]+)\/restore$/);
      if (historyRestore && request.method === "POST") {
        if (!trustedMutationOrigin(request)) {
          sendJson(response, 403, { error: "request.untrusted_origin" });
          return;
        }
        sendJson(response, 200, await store.restoreHistory(historyRestore[1]));
        return;
      }

      if (pathname === "/api/activate" && request.method === "POST") {
        if (!trustedMutationOrigin(request)) {
          sendJson(response, 403, { error: "request.untrusted_origin" });
          return;
        }
        const body = await readJsonBody(request);
        const resolution = resolveEffectiveSkill({
          profile: body?.profile,
          agents: EXAMPLE_AGENTS,
          catalog: BUILTIN_MODE_CATALOG,
        });
        if (!resolution.ok) {
          sendJson(response, 422, { error: "profile.invalid", issues: resolution.issues });
          return;
        }
        const customized =
          body?.content === undefined
            ? resolution
            : customizeEffectiveSkill(resolution.value, body.content);
        if (!customized.ok) {
          sendJson(response, 422, { error: "skill.invalid", issues: customized.issues });
          return;
        }
        const projectContext = await verifiedProjectBinding(body?.projectContext);
        if (projectContext) {
          assertProjectProfile(body?.profile, projectContext.overrides);
          const appendix = projectContext.overrides.skillAppendix?.trim();
          if (appendix && !customized.value.content.includes(appendix)) {
            throw new ProjectConfigError(
              "project.skill_mismatch",
              "Effective Skill is missing the bound project appendix.",
              409,
              "content",
            );
          }
        }
        const activationVariant = projectContext
          ? { ...customized.value, projectBinding: projectContext.binding }
          : customized.value;
        const interactiveAgentInstall =
          activationVariant.mode.id === "interactive"
            ? await codexAgentStore.install({
                allowOverwrite: body?.allowAgentOverwrite === true,
                configuration: body?.interactiveAgents,
              })
            : null;
        let activation;
        try {
          activation = await store.activate(activationVariant);
        } catch (error) {
          if (interactiveAgentInstall?.rollback) await interactiveAgentInstall.rollback();
          throw error;
        }
        sendJson(response, 200, { ...activation, interactiveAgentInstall });
        return;
      }

      if (pathname === "/api/rollback" && request.method === "POST") {
        if (!trustedMutationOrigin(request)) {
          sendJson(response, 403, { error: "request.untrusted_origin" });
          return;
        }
        const body = await readJsonBody(request);
        sendJson(response, 200, await store.rollback(body?.backupId));
        return;
      }
    } catch (error) {
      if (error instanceof SkillStoreError) {
        sendJson(response, error.status, { error: error.code, message: error.message });
        return;
      }
      if (typeof error?.status === "number" && typeof error?.code === "string") {
        sendJson(response, error.status, {
          error: error.code,
          message: error.message,
          ...(error.path ? { path: error.path } : {}),
        });
        return;
      }
      sendJson(response, 500, { error: "server.internal" });
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, {
        ...securityHeaders("text/plain; charset=utf-8"),
        allow: "GET, HEAD",
      });
      response.end("Method not allowed");
      return;
    }

    if (pathname.startsWith("/contracts/")) {
      await serveFile(request, response, CONTRACTS_ROOT, pathname.slice("/contracts/".length));
      return;
    }

    const publicPath = pathname === "/" ? "index.html" : pathname.slice(1);
    await serveFile(request, response, PUBLIC_ROOT, publicPath);
  });
}

function isEntryPoint() {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

export function resolveLocalCodexPaths(environment = process.env, userHome = homedir()) {
  if (environment.AGENT_WORKFLOW_PREVIEW_ONLY === "1") {
    return { codexHome: undefined, skillsDir: undefined, source: "preview-only" };
  }
  const explicitCodexHome = environment.AGENT_WORKFLOW_CODEX_HOME?.trim();
  const explicitSkillsDir = environment.AGENT_WORKFLOW_SKILLS_DIR?.trim();
  const codexHome = resolve(explicitCodexHome || join(userHome, ".codex"));
  return {
    codexHome,
    skillsDir: resolve(explicitSkillsDir || join(codexHome, "skills")),
    source: explicitCodexHome || explicitSkillsDir ? "explicit" : "auto",
  };
}

if (isEntryPoint()) {
  const host = process.env.AGENT_WORKFLOW_HOST ?? "127.0.0.1";
  const parsedPort = Number.parseInt(process.env.AGENT_WORKFLOW_PORT ?? "4173", 10);
  const port = Number.isInteger(parsedPort) && parsedPort >= 0 ? parsedPort : 4173;
  const localPaths = resolveLocalCodexPaths();
  if (
    localPaths.skillsDir &&
    host !== "127.0.0.1" &&
    host !== "localhost" &&
    host !== "::1"
  ) {
    throw new Error("Filesystem activation may only listen on a loopback host.");
  }
  const server = createAppServer({
    skillsDir: localPaths.skillsDir,
    codexHome: localPaths.codexHome,
  });
  server.listen(port, host, () => {
    const address = server.address();
    const activePort = typeof address === "object" && address ? address.port : port;
    const storage = localPaths.codexHome ? ` · Codex home: ${localPaths.codexHome}` : " · preview only";
    process.stdout.write(`AI Coding Workflow Control Plane: http://${host}:${activePort}${storage}\n`);
  });
}
