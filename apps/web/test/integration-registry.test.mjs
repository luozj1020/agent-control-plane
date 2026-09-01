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
        return { exitCode: 0, stdout: "1.2.0\nraw-output-must-not-return", stderr: "", timedOut: false };
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
  });
});

test("plans use argv arrays and remain non-executable for CodeGraph project and MCP changes", async () => {
  await withFixture(async ({ bin, project }) => {
    const registry = createIntegrationRegistry({
      defaultProjectRoot: project,
      environment: { PATH: bin },
      async commandRunner() {
        return { exitCode: 0, stdout: "1.2.0\n", stderr: "", timedOut: false };
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
    projectMarker: null,
    permissions: {},
    harnessSupport: [],
  };
  assert.throws(
    () => createIntegrationRegistry({ manifests: [{ ...base, projectMarker: "../unsafe" }] }),
    (error) => error instanceof IntegrationRegistryError && error.code === "integration.manifest_invalid",
  );
  assert.throws(
    () => createIntegrationRegistry({ manifests: [base, { ...base }] }),
    (error) => error instanceof IntegrationRegistryError && error.code === "integration.manifest_invalid",
  );
});
