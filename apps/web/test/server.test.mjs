import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CODEX_OVERNIGHT_CLAUDE_PROFILE } from "../../../packages/contracts/dist/index.js";
import { createAppServer, resolveLocalCodexPaths } from "../server.mjs";
import { taskCardSha256 } from "../execution-receipt.mjs";

async function withServer(run, options = {}) {
  const server = createAppServer(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("local entrypoint discovers the current user's Codex home with explicit and preview overrides", () => {
  assert.deepEqual(resolveLocalCodexPaths({}, "/home/tester"), {
    codexHome: "/home/tester/.codex",
    skillsDir: "/home/tester/.codex/skills",
    source: "auto",
  });
  assert.deepEqual(resolveLocalCodexPaths({
    AGENT_WORKFLOW_CODEX_HOME: "/opt/codex",
    AGENT_WORKFLOW_SKILLS_DIR: "/opt/codex/custom-skills",
  }, "/home/tester"), {
    codexHome: "/opt/codex",
    skillsDir: "/opt/codex/custom-skills",
    source: "explicit",
  });
  assert.deepEqual(resolveLocalCodexPaths({ AGENT_WORKFLOW_PREVIEW_ONLY: "1" }, "/home/tester"), {
    codexHome: undefined,
    skillsDir: undefined,
    source: "preview-only",
  });
});

test("serves the application and health endpoint", async () => {
  await withServer(async (baseUrl) => {
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      status: "ok",
      product: "ai-coding-workflow-control-plane",
    });

    const page = await fetch(baseUrl);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /AI Coding Workflow Control Plane/);
    assert.match(html, /Token 运行时用量/);
    assert.match(html, /RUNTIME ANALYTICS/);
    assert.match(html, /id="runtime-load-status"/);
    assert.match(html, /id="nav-usage"/);
    assert.doesNotMatch(html, /id="nav-coordination"/);
    assert.match(html, /id="nav-task-card"/);
    assert.match(html, /id="nav-integrations"/);
    assert.match(html, /class="integrations-view" id="integrations-view" hidden/);
    assert.match(html, /id="integrations-project-root"/);
    assert.match(html, /id="integrations-project-browse"/);
    assert.match(html, /id="integration-list"/);
    assert.match(html, /id="workflow-source-panel"/);
    assert.match(html, /id="workflow-source-version"/);
    assert.match(html, /id="workflow-source-diagnose"/);
    assert.match(html, /内置 Workflow Core 契约/);
    assert.match(html, /id="project-config-browse"/);
    assert.match(html, /工具与集成/);
    assert.match(html, /class="task-card-view" id="task-card-view" hidden/);
    assert.match(html, /id="task-card-editor"/);
    assert.match(html, /id="task-card-form"/);
    assert.match(html, /id="task-card-editor-switch"/);
    assert.match(html, /id="task-card-undo"/);
    assert.match(html, /id="task-card-preflight-run"/);
    assert.match(html, /id="task-card-connectivity-run"/);
    assert.match(html, /主动连接诊断 · 1 次调用/);
    assert.match(html, /id="task-card-connectivity-result"/);
    assert.match(html, /id="task-card-execution-environment"/);
    assert.match(html, /id="task-card-proxy-mode"/);
    assert.match(html, /id="task-card-environment-isolation"/);
    assert.match(html, /id="task-card-network-diagnostics"/);
    assert.match(html, /id="task-card-markdown"/);
    assert.match(html, /上游 Agent 创建并冻结合同/);
    assert.match(html, /id="task-card-inspector"/);
    assert.match(html, /id="task-card-lifecycle-state"/);
    assert.match(html, /id="task-card-task-select"/);
    assert.match(html, /id="task-card-save-working-copy"/);
    assert.match(html, /id="task-card-validate-working-copy"/);
    assert.match(html, /id="task-card-freeze"/);
    assert.match(html, /尚无上游 Agent 创建的任务合同/);
    assert.match(html, /class="usage-view" id="usage-view" hidden/);
    assert.match(html, /class="coordination-view" id="coordination-view" hidden/);
    assert.match(html, /id="coordination-run-list"/);
    assert.match(html, /id="coordination-reads-allowed"/);
    assert.match(html, /id="coordination-max-reader-fanout"/);
    assert.match(html, /id="coordination-detail-panel"/);
    assert.match(html, /id="coordination-graph-shell"/);
    assert.match(html, /id="coordination-event-list"/);
    assert.match(html, /“不支持”、部分审计与 0 严格区分/);
    assert.match(html, /模型调用数/);
    assert.match(html, /id="calls-chart"/);
    assert.match(html, /id="runtime-upstream-tokens"/);
    assert.match(html, /id="runtime-downstream-tokens"/);
    assert.match(html, /id="token-dimension"/);
    assert.match(html, /按上下游/);
    assert.match(html, /id="runtime-lane-filter"/);
    assert.match(html, /id="runtime-model-filter"/);
    assert.match(html, /按模型计算消耗/);
    assert.match(html, /id="balanced-config"/);
    assert.match(html, /Balanced 运行控制/);
    assert.match(html, /id="balanced-first-progress-window"/);
    assert.match(html, /id="project-config-root"/);
    assert.match(html, /id="project-config-browse"/);
    assert.match(html, /id="project-config-migrate"/);
    assert.match(html, /id="project-config-workspace"/);
    assert.match(html, /id="project-config-publish"/);
    assert.match(html, /id="project-current-name"/);
    assert.match(html, /id="project-current-active"/);
    assert.match(html, /id="project-current-activate"/);
    assert.match(html, /id="project-current-run-action"/);
    assert.match(html, /id="project-current-integrations"/);
    assert.match(html, /id="recent-project-list"/);
    assert.match(html, /id="recent-project-refresh"/);
    assert.match(html, /id="history-scope-filter"/);
    assert.match(html, /id="project-skill-appendix"/);
    assert.match(html, /保存 Workspace 配置/);
    assert.match(html, /高级 · 仓库配置（实验性）/);
    assert.doesNotMatch(html, /总 Token 上限/);
    assert.match(html, /USAGE · ESTIMATED CONTEXT/);
    assert.match(html, /ACTIVATION &amp; RUNTIME ACTIVITY/);
    assert.match(html, /活动记录/);
    assert.match(html, /id="history-run-list"/);
    assert.match(html, /mode-switch-policy/);
    assert.match(html, /id="skill-preview"/);
    assert.match(html, /id="restore-skill-default"/);
    assert.match(html, /id="interactive-config"/);
    assert.match(html, /Interactive Subagents/);
    assert.match(html, /id="interactive-add-role"/);
    assert.match(html, /id="interactive-reset-roles"/);
    assert.match(html, /id="interactive-undo"/);
    assert.match(html, /id="interactive-redo"/);
    assert.match(html, /id="interactive-revert"/);
    assert.match(html, /id="interactive-agent-list"[\s\S]*id="interactive-add-role"/);
    assert.match(html, /developer_instructions/);
    assert.doesNotMatch(html, /<pre id="skill-preview"/);

    const coordinator = await fetch(`${baseUrl}/mode-switch-coordinator.js`);
    assert.equal(coordinator.status, 200);
    assert.match(await coordinator.text(), /createLatestSwitchCoordinator/);

    const styles = await fetch(`${baseUrl}/styles.css`);
    assert.equal(styles.status, 200);
    const css = await styles.text();
    assert.match(css, /Readability floor/);
    assert.match(css, /body \{ font-size: 14px/);
    assert.match(css, /\.interactive-role-tag \{ font-size: 12px/);
  });
});

test("directory picker API opens only after an explicit local request", async () => {
  const calls = [];
  const directoryPicker = {
    async choose(input) {
      calls.push(input);
      return {
        selected: true,
        projectRoot: "/workspace/project",
        provider: "test-picker",
      };
    },
  };
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/system/select-directory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initialDirectory: "/workspace" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      selected: true,
      projectRoot: "/workspace/project",
      provider: "test-picker",
    });
    assert.deepEqual(calls, [{ initialDirectory: "/workspace" }]);

    const rejected = await fetch(`${baseUrl}/api/system/select-directory`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example",
      },
      body: "{}",
    });
    assert.equal(rejected.status, 403);
    assert.equal(calls.length, 1);
  }, { directoryPicker });
});

test("active connectivity endpoint forwards only the explicit diagnostic request", async () => {
  let received = null;
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/runtime/connectivity-probe`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({
        adapterId: "claude-code",
        worktree: tmpdir(),
        timeoutSeconds: 60,
        runtimeEnvironment: { proxyMode: "direct" },
      }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.kind, "downstream-connectivity-probe");
    assert.equal(result.success, true);
    assert.equal(result.activity.stdoutBytes, 42);
    assert.deepEqual(received, {
      adapterId: "claude-code",
      worktree: tmpdir(),
      timeoutSeconds: 60,
      runtimeEnvironment: { proxyMode: "direct" },
    });
  }, {
    async connectivityProbe(input) {
      received = input;
      return {
        schemaVersion: 1,
        kind: "downstream-connectivity-probe",
        adapterId: input.adapterId,
        success: true,
        activity: { stdoutBytes: 42, stderrBytes: 0, parsedEvents: 2 },
      };
    },
  });
});

test("integration APIs expose discovery, diagnostics, and non-executable plans", async () => {
  const calls = [];
  const integrationRegistry = {
    async list(input) {
      calls.push(["list", input]);
      return {
        schemaVersion: 1,
        projectRoot: input.projectRoot,
        integrations: [],
        safety: { installExecutionEnabled: false },
      };
    },
    async diagnose(id, input) {
      calls.push(["diagnose", id, input]);
      return { schemaVersion: 1, integrationId: id, health: "ready", checks: [] };
    },
    async plan(id, input) {
      calls.push(["plan", id, input]);
      return { schemaVersion: 1, integrationId: id, executable: false, steps: [] };
    },
  };
  await withServer(async (baseUrl) => {
    const projectRoot = tmpdir();
    const listed = await fetch(
      `${baseUrl}/api/integrations?projectRoot=${encodeURIComponent(projectRoot)}`,
    );
    assert.equal(listed.status, 200);
    assert.equal((await listed.json()).safety.installExecutionEnabled, false);

    const diagnosed = await fetch(`${baseUrl}/api/integrations/codegraph-cli/diagnose`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ projectRoot }),
    });
    assert.equal(diagnosed.status, 200);
    assert.equal((await diagnosed.json()).health, "ready");

    const planned = await fetch(`${baseUrl}/api/integrations/codegraph-mcp/plan`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ projectRoot, harnessId: "codex", scope: "global" }),
    });
    assert.equal(planned.status, 200);
    assert.equal((await planned.json()).executable, false);

    const rejected = await fetch(`${baseUrl}/api/integrations/codegraph-cli/diagnose`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://attacker.example" },
      body: JSON.stringify({ projectRoot }),
    });
    assert.equal(rejected.status, 403);
    assert.equal((await rejected.json()).error, "request.untrusted_origin");
    assert.deepEqual(calls, [
      ["list", { projectRoot }],
      ["diagnose", "codegraph-cli", { projectRoot }],
      ["plan", "codegraph-mcp", { projectRoot, harnessId: "codex", scope: "global" }],
    ]);
  }, { integrationRegistry });
});

test("workspace APIs expose local open, explicit repository enablement, saves, and restore", async () => {
  const calls = [];
  const projectConfigStore = {
    async inspect(projectRoot) {
      calls.push(["inspect", projectRoot]);
      return { schemaVersion: 1, projectRoot, initialized: false, overrides: {}, history: [] };
    },
    async initialize(projectRoot) {
      calls.push(["initialize", projectRoot]);
      return { schemaVersion: 1, projectRoot, initialized: true, revision: 0, overrides: {}, history: [] };
    },
    async open(projectRoot) {
      calls.push(["open", projectRoot]);
      return { schemaVersion: 2, projectRoot, initialized: true, revision: 0, overrides: {}, history: [] };
    },
    async recent() {
      calls.push(["recent"]);
      return { schemaVersion: 1, projects: [{ projectRoot: "/tmp/project", displayName: "project" }], corruptEntries: 0 };
    },
    async migrate(projectRoot) {
      calls.push(["migrate", projectRoot]);
      return { schemaVersion: 2, projectRoot, initialized: true, migrationRequired: false, revision: 0 };
    },
    async save(input) {
      calls.push(["save", input]);
      return { schemaVersion: 1, ...input, initialized: true, revision: 1, history: [{ revision: 0 }] };
    },
    async restore(input) {
      calls.push(["restore", input]);
      return { schemaVersion: 1, projectRoot: input.projectRoot, initialized: true, revision: 2, overrides: {}, history: [] };
    },
  };
  await withServer(async (baseUrl) => {
    const projectRoot = tmpdir();
    const inspected = await fetch(
      `${baseUrl}/api/projects/current?projectRoot=${encodeURIComponent(projectRoot)}`,
    );
    assert.equal(inspected.status, 200);
    assert.equal((await inspected.json()).initialized, false);

    const recent = await fetch(`${baseUrl}/api/projects/recent`);
    assert.equal(recent.status, 200);
    assert.equal((await recent.json()).projects.length, 1);

    const opened = await fetch(`${baseUrl}/api/projects/open`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ projectRoot }),
    });
    assert.equal(opened.status, 200);

    const initialized = await fetch(`${baseUrl}/api/projects/initialize`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ projectRoot }),
    });
    assert.equal(initialized.status, 200);

    const migrated = await fetch(`${baseUrl}/api/projects/migrate`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ projectRoot }),
    });
    assert.equal(migrated.status, 200);

    const saved = await fetch(`${baseUrl}/api/projects/current`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({
        projectRoot,
        expectedRevision: 0,
        expectedSharedConfigSha256: "a".repeat(64),
        scope: "local",
        overrides: { modeId: "balanced" },
      }),
    });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).revision, 1);

    const restored = await fetch(`${baseUrl}/api/projects/restore`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({
        projectRoot,
        expectedRevision: 1,
        expectedSharedConfigSha256: "a".repeat(64),
        revision: 0,
      }),
    });
    assert.equal(restored.status, 200);

    const rejected = await fetch(`${baseUrl}/api/projects/initialize`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://attacker.example" },
      body: JSON.stringify({ projectRoot }),
    });
    assert.equal(rejected.status, 403);
    const rejectedOpen = await fetch(`${baseUrl}/api/projects/open`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://attacker.example" },
      body: JSON.stringify({ projectRoot }),
    });
    assert.equal(rejectedOpen.status, 403);
    assert.deepEqual(calls, [
      ["inspect", projectRoot],
      ["recent"],
      ["open", projectRoot],
      ["initialize", projectRoot],
      ["migrate", projectRoot],
      ["save", {
        projectRoot,
        expectedRevision: 0,
        expectedSharedConfigSha256: "a".repeat(64),
        overrides: { modeId: "balanced" },
        scope: "local",
      }],
      ["restore", {
        projectRoot,
        expectedRevision: 1,
        expectedSharedConfigSha256: "a".repeat(64),
        revision: 0,
      }],
    ]);
  }, { projectConfigStore });
});

test("workspace Task APIs preserve explicit lifecycle names and protect every mutation", async () => {
  const calls = [];
  const workspaceTaskStore = {
    async list(input) {
      calls.push(["list", input]);
      return { activeTask: null, tasks: [], corruptEntries: 0 };
    },
    async create(input) {
      calls.push(["create", input]);
      return { workingCopy: { workingCopyGeneration: 1, baseTaskRevision: null } };
    },
    async write(input) {
      calls.push(["write", input]);
      return { workingCopy: { workingCopyGeneration: 2, baseTaskRevision: null } };
    },
    async validate(input) {
      calls.push(["validate", input]);
      return { valid: true, workingCopyGeneration: input.expectedWorkingCopyGeneration };
    },
    async freeze(input) {
      calls.push(["freeze", input]);
      return {
        task: {
          taskId: input.taskId,
          taskRevision: 1,
          taskSha256: "a".repeat(64),
        },
      };
    },
    async current(input) {
      calls.push(["current", input]);
      return { activeTask: null };
    },
  };
  await withServer(async (baseUrl) => {
    const projectRoot = tmpdir();
    const source = { kind: "upstream-agent", actor: "codex" };
    const task = { id: "task-1" };
    const listed = await fetch(
      `${baseUrl}/api/workspace-tasks?projectRoot=${encodeURIComponent(projectRoot)}`,
    );
    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json()).tasks, []);
    const created = await fetch(`${baseUrl}/api/workspace-tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ projectRoot, taskId: "task-1", task, source }),
    });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).workingCopy.workingCopyGeneration, 1);

    const written = await fetch(`${baseUrl}/api/workspace-tasks/working-copy`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({
        projectRoot,
        taskId: "task-1",
        expectedWorkingCopyGeneration: 1,
        task,
        source,
      }),
    });
    assert.equal(written.status, 200);
    assert.equal((await written.json()).workingCopy.workingCopyGeneration, 2);

    for (const action of ["validate", "freeze"]) {
      const response = await fetch(`${baseUrl}/api/workspace-tasks/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: baseUrl },
        body: JSON.stringify({
          projectRoot,
          taskId: "task-1",
          expectedWorkingCopyGeneration: 2,
        }),
      });
      assert.equal(response.status, 200);
    }

    const current = await fetch(
      `${baseUrl}/api/workspace-tasks/current?projectRoot=${encodeURIComponent(projectRoot)}`,
    );
    assert.equal(current.status, 200);
    assert.equal((await current.json()).activeTask, null);

    const rejected = await fetch(`${baseUrl}/api/workspace-tasks/freeze`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example",
      },
      body: JSON.stringify({
        projectRoot,
        taskId: "task-1",
        expectedWorkingCopyGeneration: 2,
      }),
    });
    assert.equal(rejected.status, 403);
    assert.deepEqual(calls, [
      ["list", { projectRoot }],
      ["create", { projectRoot, taskId: "task-1", task, source }],
      ["write", {
        projectRoot,
        taskId: "task-1",
        expectedWorkingCopyGeneration: 1,
        task,
        source,
      }],
      ["validate", {
        projectRoot,
        taskId: "task-1",
        expectedWorkingCopyGeneration: 2,
      }],
      ["freeze", {
        projectRoot,
        taskId: "task-1",
        expectedWorkingCopyGeneration: 2,
      }],
      ["current", { projectRoot }],
    ]);
  }, { workspaceTaskStore });
});

test("workflow core APIs expose compatibility and protect explicit diagnosis", async () => {
  const calls = [];
  const workflowCoreAdapter = {
    async status() {
      calls.push("status");
      return {
        schemaVersion: 1,
        sourceId: "agent-control-plane/workflow-core",
        available: true,
        compatible: true,
        health: "compatible",
        contractVersion: "1.1.0",
        drift: [],
      };
    },
    async diagnose() {
      calls.push("diagnose");
      return { schemaVersion: 1, health: "compatible", checks: [] };
    },
  };
  await withServer(async (baseUrl) => {
    const status = await fetch(`${baseUrl}/api/workflow-core`);
    assert.equal(status.status, 200);
    assert.equal((await status.json()).contractVersion, "1.1.0");

    const diagnosed = await fetch(`${baseUrl}/api/workflow-core/diagnose`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: "{}",
    });
    assert.equal(diagnosed.status, 200);
    assert.equal((await diagnosed.json()).health, "compatible");

    const rejected = await fetch(`${baseUrl}/api/workflow-core/diagnose`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://attacker.example" },
      body: "{}",
    });
    assert.equal(rejected.status, 403);
    assert.deepEqual(calls, ["status", "diagnose"]);
  }, { workflowCoreAdapter });
});

test("serves and validates the canonical Task Card used by both delegated modes", async () => {
  await withServer(async (baseUrl) => {
    const templateResponse = await fetch(`${baseUrl}/api/task-card/template`);
    assert.equal(templateResponse.status, 200);
    const template = await templateResponse.json();
    assert.equal(template.task.id, "task-id");
    assert.equal(template.task.schema_version, 1);
    assert.match(template.projections.audit, /^# Task Card/m);
    assert.match(template.projections.execution, /execution-card-v1/);

    const schemaResponse = await fetch(`${baseUrl}/api/task-card/schema`);
    assert.equal(schemaResponse.status, 200);
    const schema = await schemaResponse.json();
    assert.equal(schema.title, "Task Card v1");
    assert.equal(schema.properties.schema_version.const, 1);
    assert.ok(schema.required.includes("stop_conditions"));

    const validResponse = await fetch(`${baseUrl}/api/task-card/validate`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({
        ...template.task,
        id: "api-task",
        goal: "Validate one bounded behavior.",
        validation: [{ id: "tests", command: ["npm", "test"] }],
      }),
    });
    assert.equal(validResponse.status, 200);
    const valid = await validResponse.json();
    assert.equal(valid.valid, true);
    assert.equal(valid.migrated, false);
    assert.equal(valid.task.id, "api-task");
    assert.match(valid.projections.audit, /Validate one bounded behavior\./);

    const legacyResponse = await fetch(`${baseUrl}/api/task-card/validate`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({
        id: "legacy-api",
        objective: "Migrate the old API contract.",
        acceptance: ["It is migrated."],
        allowedPaths: ["src/**"],
        forbiddenPaths: [],
        validationCommands: [],
      }),
    });
    assert.equal(legacyResponse.status, 200);
    const legacy = await legacyResponse.json();
    assert.equal(legacy.migrated, true);
    assert.equal(legacy.task.schema_version, 1);

    const invalidResponse = await fetch(`${baseUrl}/api/task-card/validate`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({
        ...template.task,
        scope: { ...template.task.scope, write_paths: ["../outside"] },
      }),
    });
    assert.equal(invalidResponse.status, 400);
    assert.equal((await invalidResponse.json()).error, "task.unsafe_path");

    const preflightOptionsResponse = await fetch(`${baseUrl}/api/task-card/preflight`);
    assert.equal(preflightOptionsResponse.status, 200);
    const preflightOptions = await preflightOptionsResponse.json();
    assert.ok(preflightOptions.workflowModes.some((entry) => entry.id === "overnight"));
    assert.ok(preflightOptions.adapters.some(
      (entry) => entry.id === "claude-code" && entry.connectivityProbeSupported === true,
    ));
    assert.equal(preflightOptions.runtimeEnvironment.defaults.proxyMode, "direct");

    const preflightResponse = await fetch(`${baseUrl}/api/task-card/preflight`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({
        task: {
          ...template.task,
          validation: [{ id: "tests", command: ["npm", "test"] }],
        },
        workflowMode: "overnight",
        worktree: tmpdir(),
        adapterId: "claude-code",
        strategy: "convergent",
      }),
    });
    assert.equal(preflightResponse.status, 200);
    const preflight = await preflightResponse.json();
    assert.equal(preflight.ready, true);
    assert.equal(preflight.executionReady, false);
    assert.equal(preflight.receipt, null);
    assert.match(preflight.taskSha256, /^[a-f0-9]{64}$/);
    assert.equal(preflight.envelope.strategy, "convergent");
    assert.equal(preflight.envelope.runtimeEnvironment.proxyMode, "direct");
  }, {
    preflightEnvironment: {},
    preflightAdapters: [{
      id: "claude-code",
      displayName: "Claude Code",
      requiresNetwork: true,
      filesystemIsolation: "post-run-only",
    }],
  });
});

test("Workspace Preflight API persists a receipt only for the exact frozen Task and active Skill", async () => {
  const task = {
    schema_version: 1,
    id: "api-frozen-task",
    mode: "builder",
    goal: "Validate the frozen Workspace contract.",
    profiles: ["overnight", "balanced"],
    scope: { write_paths: ["src/**"], read_paths: ["src/**"], forbidden_paths: [] },
    acceptance: [{ id: "acceptance-1", description: "The contract remains hash-bound." }],
    risk: {
      public_api: "no", data_model: "no", security: "no", migration: "no",
      permission: "no", concurrency: "no", cross_module: "no", production_impact: "no",
    },
    handoff: {
      must_do: [], must_not_do: [], may_decide: [], must_report: [],
      stop_condition: ["Stop when the acceptance condition is met."],
    },
    validation: [{ id: "tests", command: ["npm", "test"] }],
    stop_conditions: ["scope_boundary_crossed"],
    extensions: { task_shape: { responsibilities: [], new_modules: [], split_decision: "exception", split_reason: "Bounded single-owner task." } },
  };
  const taskSha256 = taskCardSha256(task);
  const workspaceTaskStore = {
    async current() {
      return {
        revisionArtifact: {
          workspaceId: "workspace-1",
          taskId: task.id,
          taskRevision: 2,
          taskSha256,
          task,
        },
      };
    },
    async createPreflight(input) {
      assert.equal(input.taskRevision, 2);
      assert.equal(input.taskSha256, taskSha256);
      assert.equal(input.activation.activationId, "activation-1");
      return {
        receipt: {
          preflightId: "preflight-1",
          preflightSha256: "e".repeat(64),
          task: { taskRevision: 2 },
        },
      };
    },
  };
  const store = {
    async history() {
      return {
        entries: [{
          historyId: "activation-1",
          isActive: true,
          mode: { id: "overnight" },
          contentSha256: "a".repeat(64),
          projectBinding: {
            projectId: null,
            workspaceId: "workspace-1",
            projectRevision: 4,
            projectConfigSha256: "b".repeat(64),
          },
        }],
      };
    },
  };
  const workflowCoreAdapter = {
    async status() {
      return {
        available: true,
        compatible: true,
        health: "compatible",
        sourceId: "agent-control-plane/workflow-core",
        contractVersion: "1.6.0",
        contractSha256: `sha256:${"c".repeat(64)}`,
      };
    },
    async runtimeProtocol() {
      throw new Error("not used");
    },
  };
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/task-card/preflight`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({
        workspaceTask: {
          projectRoot: tmpdir(),
          taskId: task.id,
          taskRevision: 2,
          taskSha256,
        },
        workflowMode: "overnight",
        worktree: tmpdir(),
        adapterId: "claude-code",
        strategy: "convergent",
      }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ready, true);
    assert.equal(result.executionReady, true);
    assert.equal(result.receipt.preflightId, "preflight-1");
  }, {
    store,
    workspaceTaskStore,
    workflowCoreAdapter,
    preflightEnvironment: {},
    preflightAdapters: [{
      id: "claude-code",
      displayName: "Claude Code",
      requiresNetwork: true,
      filesystemIsolation: "post-run-only",
    }],
  });
});

test("returns structured usage range errors", async () => {
  const usageMonitor = {
    async collect() {
      const error = new Error("Unsupported usage range 'forever'.");
      error.code = "usage.invalid_range";
      error.status = 400;
      throw error;
    },
  };
  await withServer(
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/usage?range=forever`);
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        error: "usage.invalid_range",
        message: "Unsupported usage range 'forever'.",
      });
    },
    { usageMonitor },
  );
});

test("serves sanitized runtime usage for the requested range", async () => {
  const requested = [];
  const usageMonitor = {
    async collect(range, filters) {
      requested.push([range, filters]);
      return {
        available: true,
        source: "codex-local-sessions",
        range,
        totals: { totalTokens: 42 },
        buckets: [],
        models: [],
        callCoverage: {
          upstream: { status: "active" },
          downstream: { status: "not-connected" },
        },
      };
    },
  };
  await withServer(
    async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/usage?range=7d&lane=downstream&model=claude-test`,
      );
      assert.equal(response.status, 200);
      assert.equal((await response.json()).totals.totalTokens, 42);
      assert.deepEqual(requested, [
        ["7d", { lane: "downstream", model: "claude-test" }],
      ]);
    },
    { usageMonitor },
  );
});

test("serves Balanced policy and persisted run status", async () => {
  const balancedRuntime = {
    async listRuns() {
      return [
        {
          runId: "run-test",
          taskId: "task-test",
          state: "review_pending",
          rounds: 1,
          budgetState: { used: { downstream: 1 }, totalTokens: 42 },
        },
      ];
    },
  };
  await withServer(
    async (baseUrl) => {
      const config = await fetch(`${baseUrl}/api/balanced/config`);
      assert.equal(config.status, 200);
      const configBody = await config.json();
      assert.equal(configBody.policy.id, "balanced-default");
      assert.equal(configBody.policy.contextAcquisitionSeconds, 600);
      assert.equal(configBody.budget.downstreamCalls, 3);
      assert.equal("maxTotalTokens" in configBody.budget, false);
      assert.deepEqual(configBody.budgetLimits.mainReviewCalls, { min: 1, max: 99 });
      assert.deepEqual(configBody.timingLimits.activeWindowSeconds, { min: 30, max: 3600 });
      assert.deepEqual(configBody.adapters, [{ id: "claude-code", displayName: "Claude Code" }]);

      const runs = await fetch(`${baseUrl}/api/balanced/runs`);
      assert.equal(runs.status, 200);
      assert.equal((await runs.json()).runs[0].state, "review_pending");
    },
    { balancedRuntime },
  );
});

test("serves persisted Overnight run and wake state", async () => {
  const interrupted = [];
  const overnightRuntime = {
    async listRuns() {
      return [
        {
          runId: "overnight-run",
          taskId: "overnight-task",
          state: "improvement_cycle_ready",
          strategy: "continuous-improvement",
          cycle: 2,
          adapterId: "claude-code",
          latestWakeSha256: "a".repeat(64),
        },
      ];
    },
    async interruptById(runId) {
      interrupted.push(runId);
      return { runDirectory: "/runtime/overnight-run", state: "interrupt_requested" };
    },
  };
  await withServer(
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/overnight/runs`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.runs[0].state, "improvement_cycle_ready");
      assert.equal(body.runs[0].cycle, 2);
      assert.equal(body.runs[0].latestWakeSha256.length, 64);

      const interruptedResponse = await fetch(
        `${baseUrl}/api/overnight/runs/overnight-run/interrupt`,
        {
          method: "POST",
          headers: { "content-type": "application/json", origin: baseUrl },
          body: "{}",
        },
      );
      assert.equal(interruptedResponse.status, 200);
      assert.equal((await interruptedResponse.json()).state, "interrupt_requested");
      assert.deepEqual(interrupted, ["overnight-run"]);
    },
    { overnightRuntime },
  );
});

test("aggregates coordination telemetry without inventing unsupported reads or messages", async () => {
  const summary = (overrides) => ({
    schemaVersion: 1,
    runId: "run-1",
    mode: "balanced",
    state: "review_pending",
    adapterId: "claude-code",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:01:00.000Z",
    eventCount: 9,
    invalidLines: 0,
    actorCount: 2,
    targetCount: 5,
    agentInvocations: 1,
    artifactReads: 2,
    artifactWrites: 3,
    readViolations: 1,
    readClassifications: { allowed: 1, outOfScope: 1, forbidden: 0, unknown: 0 },
    stateTransitions: 2,
    reviewDecisions: 1,
    validationEvents: 1,
    wakeEvents: 0,
    observedTokens: 42,
    measurementSources: ["runtime"],
    containment: { read: "partial-event-audit", write: "post-run-audit", eventSource: "claude-read" },
    topology: {
      nodeCount: 5,
      relationshipCount: 4,
      agentNodes: 1,
      artifactNodes: 3,
      uniqueReadArtifacts: 2,
      repeatedArtifactReads: 0,
      artifactReaderLinks: 2,
      maxArtifactReaderFanOut: 1,
    },
    coverage: { invoke: "observed", write: "observed", read: "observed", message: "unsupported" },
    ...overrides,
  });
  const balancedRuntime = { async listRuns() { return [{ coordination: summary({}) }]; } };
  const overnightRuntime = {
    async listRuns() {
      return [{ coordination: summary({ runId: "run-2", mode: "overnight", wakeEvents: 2 }) }];
    },
  };
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/coordination`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.aggregate.runs, 2);
    assert.equal(body.aggregate.agentInvocations, 2);
    assert.equal(body.aggregate.artifactReads, 4);
    assert.equal(body.aggregate.readViolations, 2);
    assert.deepEqual(body.aggregate.readClassifications, {
      allowed: 2,
      outOfScope: 2,
      forbidden: 0,
      unknown: 0,
    });
    assert.equal(body.aggregate.topology.nodeCount, 10);
    assert.equal(body.aggregate.topology.relationshipCount, 8);
    assert.equal(body.aggregate.topology.uniqueReadArtifacts, 4);
    assert.equal(body.aggregate.topology.artifactReaderLinks, 4);
    assert.equal(body.aggregate.topology.repeatedArtifactReads, 0);
    assert.equal(body.aggregate.topology.maxArtifactReaderFanOut, 1);
    assert.equal(body.aggregate.wakeEvents, 2);
    assert.equal(body.coverage.read, "observed");
    assert.equal(body.coverage.message, "unsupported");
  }, { balancedRuntime, overnightRuntime });
});

test("serves bounded metadata-only coordination detail for a safe run identity", async () => {
  const calls = [];
  const detail = {
    schemaVersion: 1,
    runId: "run-1",
    mode: "balanced",
    summary: { eventCount: 1 },
    timeline: {
      totalEvents: 1,
      returnedEvents: 1,
      offset: 0,
      truncated: false,
      invalidLines: 0,
      rejectedEvents: 0,
      events: [],
    },
    graph: { scope: "returned-events", nodes: [], edges: [] },
  };
  const balancedRuntime = {
    async listRuns() { return []; },
    async coordinationDetail(runId, options) {
      calls.push({ runId, options });
      return detail;
    },
  };
  const overnightRuntime = { async listRuns() { return []; } };
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/coordination/balanced/run-1?limit=9999`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), detail);
    assert.deepEqual(calls, [{ runId: "run-1", options: { maximumEvents: 500 } }]);

    const unsafe = await fetch(`${baseUrl}/api/coordination/balanced/%2e%2e`);
    assert.notEqual(unsafe.status, 200);
    assert.equal(calls.length, 1);
  }, { balancedRuntime, overnightRuntime });
});

test("activation API is disabled unless an absolute Skill directory is configured", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: CODEX_OVERNIGHT_CLAUDE_PROFILE }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, "store.preview_only");
  });
});

test("activation API resolves the profile on the server and writes only the managed directory", async () => {
  const skillsDir = await mkdtemp(join(tmpdir(), "agent-workflow-api-"));
  try {
    await withServer(
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/activate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ profile: CODEX_OVERNIGHT_CLAUDE_PROFILE }),
        });
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.changed, true);
        assert.equal(body.activationKind, "activate");
        assert.equal(
          body.status.active.variantId,
          "workflow-codex-overnight-convergent-claude-code",
        );
        assert.deepEqual(body.status.active.overnightLoopPolicy, {
          id: "overnight-convergent",
          version: "1.0.0",
        });
        assert.equal(body.status.active.mode.id, "overnight");
        assert.match(
          await readFile(join(skillsDir, "agent-workflow-active", "SKILL.md"), "utf8"),
          /# Workflow/,
        );

        const status = await fetch(`${baseUrl}/api/status`);
        assert.equal((await status.json()).writeEnabled, true);
      },
      { skillsDir },
    );
  } finally {
    await rm(skillsDir, { recursive: true, force: true });
  }
});

test("activation API validates and writes edited Skill content with server-derived metadata", async () => {
  const skillsDir = await mkdtemp(join(tmpdir(), "agent-workflow-api-edited-skill-"));
  const content = [
    "---",
    "name: agent-workflow-active",
    "description: Customized overnight workflow.",
    "---",
    "",
    "# Customized Overnight",
    "",
    "Keep this user-authored instruction.",
    "",
  ].join("\n");
  try {
    await withServer(
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/activate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ profile: CODEX_OVERNIGHT_CLAUDE_PROFILE, content }),
        });
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.status.active.content, content);
        assert.equal(
          await readFile(join(skillsDir, "agent-workflow-active", "SKILL.md"), "utf8"),
          content,
        );
        assert.notEqual(body.status.active.contentFingerprint, "fnv1a32:00000000");

        const rejected = await fetch(`${baseUrl}/api/activate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            profile: CODEX_OVERNIGHT_CLAUDE_PROFILE,
            content: content.replace(
              "name: agent-workflow-active",
              "name: forged-skill-name",
            ),
          }),
        });
        assert.equal(rejected.status, 422);
        assert.equal((await rejected.json()).error, "skill.invalid");
        assert.equal(
          await readFile(join(skillsDir, "agent-workflow-active", "SKILL.md"), "utf8"),
          content,
        );
      },
      { skillsDir },
    );
  } finally {
    await rm(skillsDir, { recursive: true, force: true });
  }
});

test("activation binds a server-verified project revision and rejects stale project context", async () => {
  const skillsDir = await mkdtemp(join(tmpdir(), "agent-workflow-api-project-binding-"));
  const projectRoot = tmpdir();
  const project = {
    initialized: true,
    projectRoot,
    projectId: null,
    repositoryConfigEnabled: false,
    workspaceId: "workspace-1",
    migrationRequired: false,
    revision: 4,
    configSha256: "c".repeat(64),
    overrides: { modeId: "overnight" },
    history: [],
  };
  const projectConfigStore = {
    async inspect(input) {
      assert.equal(input, projectRoot);
      return project;
    },
  };
  try {
    await withServer(async (baseUrl) => {
      const activate = (configSha256) => fetch(`${baseUrl}/api/activate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profile: CODEX_OVERNIGHT_CLAUDE_PROFILE,
          projectContext: { projectRoot, workspaceId: "workspace-1", expectedRevision: 4, configSha256 },
        }),
      });
      const stale = await activate("d".repeat(64));
      assert.equal(stale.status, 409);
      assert.equal((await stale.json()).error, "project.binding_stale");

      const wrongWorkspace = await fetch(`${baseUrl}/api/activate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profile: CODEX_OVERNIGHT_CLAUDE_PROFILE,
          projectContext: {
            projectRoot,
            workspaceId: "workspace-other",
            expectedRevision: 4,
            configSha256: project.configSha256,
          },
        }),
      });
      assert.equal(wrongWorkspace.status, 409);
      assert.equal((await wrongWorkspace.json()).error, "project.binding_stale");

      const mismatchedProfile = await fetch(`${baseUrl}/api/activate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profile: {
            ...CODEX_OVERNIGHT_CLAUDE_PROFILE,
            mode: { id: "balanced", version: "1.0.0" },
          },
          projectContext: {
            projectRoot,
            workspaceId: "workspace-1",
            expectedRevision: 4,
            configSha256: project.configSha256,
          },
        }),
      });
      assert.equal(mismatchedProfile.status, 409);
      assert.equal((await mismatchedProfile.json()).error, "project.profile_mismatch");

      const response = await activate(project.configSha256);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body.status.active.projectBinding, {
        projectId: null,
        workspaceId: "workspace-1",
        projectRevision: 4,
        projectConfigSha256: "c".repeat(64),
      });
      const history = await (await fetch(`${baseUrl}/api/history`)).json();
      assert.deepEqual(history.entries[0].projectBinding, body.status.active.projectBinding);
    }, { skillsDir, projectConfigStore });
  } finally {
    await rm(skillsDir, { recursive: true, force: true });
  }
});

test("Interactive API imports existing roles and still requires explicit overwrite for a replacement preset", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "agent-workflow-api-interactive-"));
  const skillsDir = join(codexHome, "skills");
  const agentsDir = join(codexHome, "agents");
  const profile = {
    ...CODEX_OVERNIGHT_CLAUDE_PROFILE,
    id: "codex-interactive-native",
    mode: { id: "interactive", version: "1.0.0" },
    roleBindings: [{ role: "subagent", target: { kind: "main-native" } }],
  };
  try {
    await mkdir(skillsDir);
    await mkdir(agentsDir);
    await writeFile(join(agentsDir, "worker.toml"), `name = "worker"
description = "Existing worker role."
model = "vendor/worker-v2"
developer_instructions = "Keep the existing workflow."
`, "utf8");
    await withServer(
      async (baseUrl) => {
        const status = await (await fetch(`${baseUrl}/api/interactive-agents`)).json();
        assert.equal(status.health, "ready");
        assert.equal(status.configurationOrigin, "existing");
        assert.deepEqual(status.agents, [{ name: "worker", status: "imported" }]);

        const blocked = await fetch(`${baseUrl}/api/activate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ profile, interactiveAgents: status.preset }),
        });
        assert.equal(blocked.status, 409);
        assert.equal((await blocked.json()).error, "agents.overwrite_required");
        await assert.rejects(readFile(join(skillsDir, "agent-workflow-active", "SKILL.md")));

        const activated = await fetch(`${baseUrl}/api/activate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ profile, interactiveAgents: status.preset, allowAgentOverwrite: true }),
        });
        assert.equal(activated.status, 200);
        const body = await activated.json();
        assert.equal(body.status.active.mode.id, "interactive");
        assert.equal(body.interactiveAgentInstall.status.health, "installed");
        assert.match(await readFile(join(agentsDir, "worker.toml"), "utf8"), /gpt-5\.3-codex-spark/);
        assert.match(await readFile(join(agentsDir, "reviewer.toml"), "utf8"), /gpt-5\.6-terra/);
        assert.match(await readFile(join(codexHome, "config.toml"), "utf8"), /max_concurrent_threads_per_session = 6/);
      },
      { skillsDir, codexHome },
    );
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("Interactive planning and activation accept an editable custom role set", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "agent-workflow-api-custom-roles-"));
  const skillsDir = join(codexHome, "skills");
  const profile = {
    ...CODEX_OVERNIGHT_CLAUDE_PROFILE,
    id: "codex-interactive-custom",
    mode: { id: "interactive", version: "1.0.0" },
    roleBindings: [{ role: "subagent", target: { kind: "main-native" } }],
  };
  try {
    await mkdir(skillsDir);
    await withServer(
      async (baseUrl) => {
        const current = await (await fetch(`${baseUrl}/api/interactive-agents`)).json();
        const configuration = current.preset;
        configuration.agents = [{
          name: "docs_researcher",
          description: "Read-only documentation specialist.",
          model: "gpt-5.6-luna",
          reasoningEffort: "medium",
          sandboxMode: "read-only",
          developerInstructions: "# Documentation\n\nVerify APIs and return exact references.",
        }];
        const planned = await fetch(`${baseUrl}/api/interactive-agents/plan`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ configuration }),
        });
        assert.equal(planned.status, 200);
        assert.deepEqual((await planned.json()).agents, [{ name: "docs_researcher", status: "missing" }]);

        const activated = await fetch(`${baseUrl}/api/activate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ profile, interactiveAgents: configuration }),
        });
        assert.equal(activated.status, 200);
        const body = await activated.json();
        assert.deepEqual(body.interactiveAgentInstall.status.configuration.agents.map((agent) => agent.name), ["docs_researcher"]);
        assert.match(await readFile(join(codexHome, "agents", "docs_researcher.toml"), "utf8"), /gpt-5\.6-luna/);
        await assert.rejects(readFile(join(codexHome, "agents", "worker.toml")));
        const skill = await readFile(join(skillsDir, "agent-workflow-active", "SKILL.md"), "utf8");
        assert.match(skill, /Do not assume a fixed role list or model/);
      },
      { skillsDir, codexHome },
    );
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("Interactive agent installation rolls back when Skill activation fails", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "agent-workflow-api-interactive-rollback-"));
  const skillsDir = join(codexHome, "skills");
  const profile = {
    ...CODEX_OVERNIGHT_CLAUDE_PROFILE,
    id: "codex-interactive-rollback",
    mode: { id: "interactive", version: "1.0.0" },
    roleBindings: [{ role: "subagent", target: { kind: "main-native" } }],
  };
  try {
    await mkdir(skillsDir);
    await withServer(
      async (baseUrl) => {
        const first = await fetch(`${baseUrl}/api/activate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ profile: CODEX_OVERNIGHT_CLAUDE_PROFILE }),
        });
        assert.equal(first.status, 200);
        await writeFile(
          join(skillsDir, ".agent-workflow-switch", "activation.lock"),
          "occupied",
          "utf8",
        );
        const blocked = await fetch(`${baseUrl}/api/activate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ profile }),
        });
        assert.equal(blocked.status, 409);
        assert.equal((await blocked.json()).error, "store.locked");
        await assert.rejects(readFile(join(codexHome, "config.toml")));
        await assert.rejects(readFile(join(codexHome, "agents", "worker.toml")));
      },
      { skillsDir, codexHome },
    );
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("failed mode overwrite preserves the currently active Skill", async () => {
  const skillsDir = await mkdtemp(join(tmpdir(), "agent-workflow-api-switch-failure-"));
  try {
    await withServer(
      async (baseUrl) => {
        const activate = (profile) =>
          fetch(`${baseUrl}/api/activate`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ profile }),
          });
        assert.equal((await activate(CODEX_OVERNIGHT_CLAUDE_PROFILE)).status, 200);
        await writeFile(
          join(skillsDir, ".agent-workflow-switch", "activation.lock"),
          "occupied",
          "utf8",
        );
        const balanced = {
          ...CODEX_OVERNIGHT_CLAUDE_PROFILE,
          id: "codex-balanced-blocked",
          mode: { id: "balanced", version: "1.0.0" },
        };
        const blocked = await activate(balanced);
        assert.equal(blocked.status, 409);
        assert.equal((await blocked.json()).error, "store.locked");
        const status = await (await fetch(`${baseUrl}/api/status`)).json();
        assert.equal(status.active.mode.id, "overnight");
      },
      { skillsDir },
    );
  } finally {
    await rm(skillsDir, { recursive: true, force: true });
  }
});

test("rollback API restores a server-generated backup", async () => {
  const skillsDir = await mkdtemp(join(tmpdir(), "agent-workflow-api-rollback-"));
  try {
    await withServer(
      async (baseUrl) => {
        const activate = (profile) =>
          fetch(`${baseUrl}/api/activate`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ profile }),
          });
        const first = await activate(CODEX_OVERNIGHT_CLAUDE_PROFILE);
        assert.equal(first.status, 200);

        const balanced = {
          ...CODEX_OVERNIGHT_CLAUDE_PROFILE,
          id: "codex-balanced-claude",
          mode: { id: "balanced", version: "1.0.0" },
        };
        const second = await activate(balanced);
        assert.equal(second.status, 200);
        const switched = await second.json();
        assert.equal(switched.activationKind, "overwrite");
        assert.equal(switched.status.active.variantId, "workflow-codex-balanced-claude-code");
        assert.equal(switched.status.backups.length, 1);

        const rollback = await fetch(`${baseUrl}/api/rollback`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ backupId: switched.status.backups[0].backupId }),
        });
        assert.equal(rollback.status, 200);
        assert.equal(
          (await rollback.json()).status.active.variantId,
          "workflow-codex-overnight-convergent-claude-code",
        );
      },
      { skillsDir },
    );
  } finally {
    await rm(skillsDir, { recursive: true, force: true });
  }
});

test("history API exposes diffs and restores a selected immutable snapshot", async () => {
  const skillsDir = await mkdtemp(join(tmpdir(), "agent-workflow-api-history-"));
  try {
    await withServer(
      async (baseUrl) => {
        const activate = (profile) =>
          fetch(`${baseUrl}/api/activate`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ profile }),
          });
        assert.equal((await activate(CODEX_OVERNIGHT_CLAUDE_PROFILE)).status, 200);
        const balanced = {
          ...CODEX_OVERNIGHT_CLAUDE_PROFILE,
          id: "codex-balanced-history",
          mode: { id: "balanced", version: "1.0.0" },
        };
        assert.equal((await activate(balanced)).status, 200);

        const historyResponse = await fetch(`${baseUrl}/api/history`);
        assert.equal(historyResponse.status, 200);
        const history = await historyResponse.json();
        assert.equal(history.entries.length, 2);
        const overnight = history.entries.find((entry) => entry.mode.id === "overnight");
        assert(overnight);

        const detailResponse = await fetch(
          `${baseUrl}/api/history/${encodeURIComponent(overnight.historyId)}`,
        );
        assert.equal(detailResponse.status, 200);
        const detail = await detailResponse.json();
        assert.equal(detail.diff.direction, "current-to-snapshot");
        assert(detail.diff.summary.added > 0);
        assert(detail.fieldChanges.some((change) => change.field === "mode"));

        const restore = await fetch(
          `${baseUrl}/api/history/${encodeURIComponent(overnight.historyId)}/restore`,
          { method: "POST" },
        );
        assert.equal(restore.status, 200);
        assert.equal((await restore.json()).status.active.variantId, overnight.variantId);
        assert.equal((await (await fetch(`${baseUrl}/api/history`)).json()).entries.length, 3);
      },
      { skillsDir },
    );
  } finally {
    await rm(skillsDir, { recursive: true, force: true });
  }
});

test("activity API groups runtime coordination under its activation snapshot", async () => {
  const entry = {
    historyId: "activation-1",
    action: "activate",
    recordedAt: "2026-09-01T00:00:00.000Z",
    activatedAt: "2026-09-01T00:00:00.000Z",
    variantId: "balanced-variant",
    mode: { id: "balanced", version: "1.0.0" },
    profileId: "balanced-profile",
    mainAgentId: "codex",
    targetAdapterId: "claude-code",
    includedAgentIds: ["claude-code"],
    contentSha256: "a".repeat(64),
  };
  const store = {
    async history() {
      return { available: true, active: null, entries: [entry], corruptEntries: 0 };
    },
    async historyDetail(historyId) {
      assert.equal(historyId, entry.historyId);
      return {
        entry,
        active: null,
        fieldChanges: [],
        diff: { available: true, summary: { added: 0, removed: 0 }, lines: [] },
      };
    },
  };
  const balancedRuntime = {
    async listRuns() {
      return [{
        runId: "run-1",
        activationId: entry.historyId,
        createdAt: "2026-09-01T00:01:00.000Z",
        state: "review_pending",
        adapterId: "claude-code",
        coordination: { eventCount: 3 },
      }];
    },
  };
  const overnightRuntime = { async listRuns() { return []; } };

  await withServer(async (baseUrl) => {
    const activityResponse = await fetch(`${baseUrl}/api/activity`);
    assert.equal(activityResponse.status, 200);
    const activity = await activityResponse.json();
    assert.equal(activity.entries[0].runs[0].runId, "run-1");
    assert.equal(activity.entries[0].runs[0].association.source, "explicit");
    assert.equal(activity.activitySummary.linkedRuns, 1);

    const detailResponse = await fetch(`${baseUrl}/api/activity/${entry.historyId}`);
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json();
    assert.equal(detail.runs.length, 1);
    assert.equal(detail.runs[0].association.activationId, entry.historyId);
  }, { store, balancedRuntime, overnightRuntime });
});

test("history restore rejects cross-origin requests", async () => {
  const store = {
    status: async () => ({ writeEnabled: true }),
    history: async () => ({ available: true, entries: [] }),
    restoreHistory: async () => {
      throw new Error("must not be called");
    },
  };
  await withServer(
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/history/snapshot/restore`, {
        method: "POST",
        headers: { origin: "https://malicious.example" },
      });
      assert.equal(response.status, 403);
    },
    { store },
  );
});

test("mutation API rejects cross-origin requests", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/activate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://malicious.example",
      },
      body: JSON.stringify({ profile: CODEX_OVERNIGHT_CLAUDE_PROFILE }),
    });
    assert.equal(response.status, 403);
  });
});

test("mutation API rejects DNS-rebinding style host and origin pairs", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/activate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "malicious.example",
        origin: "http://malicious.example",
      },
      body: JSON.stringify({ profile: CODEX_OVERNIGHT_CLAUDE_PROFILE }),
    });
    assert.equal(response.status, 403);
  });
});

test("serves the browser-compatible contracts build", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/contracts/index.js`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /resolveEffectiveSkill/);
  });
});

test("fails closed for traversal and unsupported methods", async () => {
  await withServer(async (baseUrl) => {
    const traversal = await fetch(`${baseUrl}/contracts/%2e%2e/package.json`);
    assert.notEqual(traversal.status, 200);

    const post = await fetch(`${baseUrl}/api/health`, { method: "POST" });
    assert.equal(post.status, 405);
  });
});
