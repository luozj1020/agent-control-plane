import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  IntegrationRegistryError,
  createIntegrationRegistry,
} from "../integration-registry.mjs";

async function withFixture(run) {
  const root = await mkdtemp(join(tmpdir(), "agent-control-integrations-"));
  const bin = join(root, "bin");
  const project = join(root, "project");
  await mkdir(bin);
  await mkdir(project);
  const command = join(bin, "codegraph");
  await writeFile(command, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(command, 0o755);
  try {
    await run({ root, bin, project, command });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("registry discovers CodeGraph and reports a safe project marker without exposing command output", async () => {
  await withFixture(async ({ bin, project, command }) => {
    await mkdir(join(project, ".codegraph"));
    const calls = [];
    const registry = createIntegrationRegistry({
      defaultProjectRoot: project,
      environment: { PATH: bin, PRIVATE_VALUE: "must-not-return" },
      async commandRunner(executable, args, options) {
        calls.push({
          executable,
          args,
          cwd: options.cwd,
          privateValue: options.environment.PRIVATE_VALUE,
        });
        return {
          exitCode: 0,
          stdout: args[0] === "--version"
            ? "1.2.0\nraw-output-must-not-return"
            : JSON.stringify({
                initialized: true,
                projectPath: project,
                worktreeMismatch: false,
                pendingChanges: { added: 0, modified: 0, removed: 0 },
              }),
          stderr: "",
          timedOut: false,
        };
      },
    });

    const result = await registry.list();
    assert.equal(result.projectRoot, project);
    assert.equal(result.safety.installExecutionEnabled, false);
    const codegraph = result.integrations.find((entry) => entry.manifest.id === "codegraph-cli");
    assert.equal(codegraph.status.health, "ready");
    assert.equal(codegraph.status.installed, true);
    assert.equal(codegraph.status.version, "1.2.0");
    assert.equal(codegraph.status.projectConfigured, true);
    assert.equal(codegraph.status.global.health, "available");
    assert.equal(codegraph.status.project.health, "ready");
    assert.equal(codegraph.status.project.initialized, true);
    assert.equal(codegraph.status.project.verified, true);
    assert.equal(codegraph.status.effective.ready, true);
    assert.equal(result.summary.globalAvailable, 2);
    assert.equal(result.summary.projectInitialized, 1);
    assert.deepEqual(calls[0], {
      executable: command,
      args: ["--version"],
      cwd: project,
      privateValue: undefined,
    });
    assert.doesNotMatch(JSON.stringify(result), /raw-output|must-not-return/);

    const diagnostic = await registry.diagnose("codegraph-cli", { projectRoot: project });
    assert.equal(diagnostic.health, "ready");
    assert.equal(diagnostic.contentCaptured, false);
    assert.ok(diagnostic.checks.every((entry) => entry.status === "passed"));
    assert.ok(diagnostic.checks.some((entry) => entry.layer === "global"));
    assert.ok(diagnostic.checks.some((entry) => entry.layer === "project"));
  });
});

test("registry distinguishes project drift, missing initialization, and unavailable global tools", async () => {
  await withFixture(async ({ bin, project }) => {
    await mkdir(join(project, ".codegraph"));
    const registry = createIntegrationRegistry({
      defaultProjectRoot: project,
      environment: { PATH: bin },
      async commandRunner(_executable, args) {
        return {
          exitCode: 0,
          stdout: args[0] === "--version"
            ? "1.2.0\n"
            : JSON.stringify({
                initialized: true,
                projectPath: project,
                worktreeMismatch: false,
                pendingChanges: { added: 1, modified: 2, removed: 0 },
              }),
          stderr: "",
          timedOut: false,
        };
      },
    });
    const result = await registry.list();
    const codegraph = result.integrations.find((entry) => entry.manifest.id === "codegraph-cli");
    assert.equal(codegraph.status.health, "project-sync-required");
    assert.equal(codegraph.status.project.health, "sync-required");
    assert.equal(codegraph.status.project.pendingChanges, 3);
    assert.equal(codegraph.status.effective.blockingLayer, "project");
    assert.equal(result.summary.projectInitialized, 1);
    assert.equal(result.summary.ready, 0);
    const blockedMcpPlan = await registry.plan("codegraph-mcp", { projectRoot: project });
    assert.equal(blockedMcpPlan.steps[0].id, "project-not-ready");
    assert.equal(blockedMcpPlan.steps[0].kind, "blocked");
    assert.equal(blockedMcpPlan.steps[0].argv, null);

    const unavailable = createIntegrationRegistry({
      defaultProjectRoot: project,
      environment: { PATH: join(project, "missing-bin") },
    });
    const unavailableResult = await unavailable.list();
    const unavailableCodegraph = unavailableResult.integrations.find(
      (entry) => entry.manifest.id === "codegraph-cli",
    );
    assert.equal(unavailableCodegraph.status.global.health, "not-installed");
    assert.equal(unavailableCodegraph.status.project.health, "verification-unavailable");
    assert.equal(unavailableCodegraph.status.project.initialized, null);
    assert.equal(unavailableCodegraph.status.effective.blockingLayer, "global");
  });
});

test("plans use argv arrays and remain non-executable for CodeGraph project and MCP changes", async () => {
  await withFixture(async ({ bin, project }) => {
    const registry = createIntegrationRegistry({
      defaultProjectRoot: project,
      environment: { PATH: bin },
      async commandRunner(_executable, args) {
        return {
          exitCode: 0,
          stdout: args[0] === "--version"
            ? "1.2.0\n"
            : JSON.stringify({
                initialized: true,
                projectPath: project,
                worktreeMismatch: false,
                pendingChanges: { added: 0, modified: 0, removed: 0 },
                index: { reindexRecommended: false },
              }),
          stderr: "",
          timedOut: false,
        };
      },
    });

    const projectPlan = await registry.plan("codegraph-cli", {
      projectRoot: project,
      harnessId: "codex",
      scope: "project",
    });
    assert.equal(projectPlan.executable, false);
    assert.equal(projectPlan.requiresConfirmation, true);
    assert.equal(projectPlan.steps[0].cwd, project);
    assert.deepEqual(projectPlan.steps[0].argv, ["codegraph", "init", project]);
    assert.deepEqual(projectPlan.steps[0].mutates, [join(project, ".codegraph")]);

    await mkdir(join(project, ".codegraph"));
    const mcpPlan = await registry.plan("codegraph-mcp", {
      projectRoot: project,
      harnessId: "claude-code",
      scope: "global",
    });
    assert.deepEqual(mcpPlan.steps[0].argv, ["codegraph", "install", "--print-config", "claude"]);
    assert.deepEqual(mcpPlan.steps[1].argv, [
      "codegraph", "install", "--target", "claude", "--location", "global", "--yes",
      "--no-permissions",
    ]);
    assert.equal(mcpPlan.rollbackRequired, true);
  });
});

test("registry fails closed for unsafe markers, unknown integrations, and unsupported harnesses", async () => {
  await withFixture(async ({ root, bin, project }) => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, join(project, ".codegraph"), "dir");
    const registry = createIntegrationRegistry({
      defaultProjectRoot: project,
      environment: { PATH: bin },
      async commandRunner() {
        return { exitCode: 0, stdout: "1.2.0\n", stderr: "", timedOut: false };
      },
    });

    const result = await registry.list();
    const codegraph = result.integrations.find((entry) => entry.manifest.id === "codegraph-cli");
    assert.equal(codegraph.status.health, "blocked");
    assert.equal(codegraph.status.projectMarkerState, "unsafe");
    const blockedPlan = await registry.plan("codegraph-cli", { projectRoot: project });
    assert.equal(blockedPlan.steps[0].kind, "blocked");
    assert.equal(blockedPlan.steps[0].argv, null);
    await assert.rejects(
      registry.diagnose("missing", { projectRoot: project }),
      (error) => error instanceof IntegrationRegistryError && error.code === "integration.not_found",
    );
    await assert.rejects(
      registry.plan("custom-mcp-server", {
        projectRoot: project,
        harnessId: "unknown",
      }),
      (error) => error instanceof IntegrationRegistryError && error.code === "integration.harness_invalid",
    );
  });
});

test("registry rejects malformed or duplicate Integration Manifests at startup", () => {
  const base = {
    schemaVersion: 1,
    id: "valid-tool",
    manifestVersion: "1.0.0",
    kind: "local-tool",
    displayName: "Valid",
    summary: "Valid manifest.",
    capabilities: [],
    discovery: null,
    project: null,
    permissions: {},
    harnessSupport: [],
  };
  assert.throws(
    () => createIntegrationRegistry({
      manifests: [{ ...base, project: { marker: "../unsafe", probe: null } }],
    }),
    (error) => error instanceof IntegrationRegistryError && error.code === "integration.manifest_invalid",
  );
  assert.throws(
    () => createIntegrationRegistry({ manifests: [base, { ...base }] }),
    (error) => error instanceof IntegrationRegistryError && error.code === "integration.manifest_invalid",
  );
});
