import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CodexAgentStoreError, getDefaultCodexAgentConfiguration } from "../codex-agent-store.mjs";
import {
  createEditableCodexAgentStore,
  mergeEditableCodexAgent,
  parseCodexAgent,
  renderCodexAgent,
  validateCodexAgentConfiguration,
} from "../codex-agent-role-store.mjs";

async function withCodexHome(run) {
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-editable-agents-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function customConfiguration() {
  const configuration = getDefaultCodexAgentConfiguration();
  configuration.agents = [
    {
      name: "docs_researcher",
      description: "Documentation specialist.",
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      sandboxMode: "read-only",
      developerInstructions: "# Documentation\n\nUse `official docs`.\n\nA triple quote is safe: \"\"\".",
    },
  ];
  return configuration;
}

test("validates editable roles and safely renders Markdown as TOML text", () => {
  const configuration = validateCodexAgentConfiguration(customConfiguration());
  const rendered = renderCodexAgent(configuration.agents[0]);
  assert.match(rendered, /name = "docs_researcher"/);
  assert.match(rendered, /model = "gpt-5\.6-luna"/);
  assert.match(rendered, /developer_instructions = "# Documentation\\n\\nUse/);
  assert.match(rendered, /\\"\\"\\"/);
});

test("parses multiline existing roles and preserves unsupported fields when editing", () => {
  const content = `# owned by the user
name = "docs_researcher"
description = "Documentation specialist."
model = "gpt-5.6-luna"
developer_instructions = """
# Documentation

Use official docs.
"""
custom_flag = ["preserve", "me"]

[mcp_servers.docs]
command = "docs-server"
`;
  const parsed = parseCodexAgent(content, "documentation.toml");
  assert.equal(parsed.name, "docs_researcher");
  assert.match(parsed.developerInstructions, /Use official docs/);
  const merged = mergeEditableCodexAgent(content, { ...parsed, description: "Updated description." });
  assert.match(merged, /description = "Updated description\."/);
  assert.match(merged, /custom_flag = \["preserve", "me"\]/);
  assert.match(merged, /\[mcp_servers\.docs\]/);
});

test("rejects duplicate and unsafe role definitions", () => {
  const duplicate = customConfiguration();
  duplicate.agents.push({ ...duplicate.agents[0] });
  assert.throws(
    () => validateCodexAgentConfiguration(duplicate),
    (error) => error instanceof CodexAgentStoreError && error.code === "agents.invalid_configuration",
  );
  const unsafe = customConfiguration();
  unsafe.agents[0].name = "../escape";
  assert.throws(
    () => validateCodexAgentConfiguration(unsafe),
    (error) => error instanceof CodexAgentStoreError && error.code === "agents.invalid_configuration",
  );
});

test("installs a custom role and persists its editable configuration", async () => {
  await withCodexHome(async (codexHome) => {
    const store = createEditableCodexAgentStore({ codexHome });
    const configuration = customConfiguration();
    const installed = await store.install({ configuration });
    assert.equal(installed.status.health, "installed");
    assert.deepEqual(installed.status.configuration.agents.map((agent) => agent.name), ["docs_researcher"]);
    const content = await readFile(join(codexHome, "agents", "docs_researcher.toml"), "utf8");
    assert.match(content, /gpt-5\.6-luna/);
    assert.match(content, /official docs/);
    const reloaded = await createEditableCodexAgentStore({ codexHome }).status();
    assert.equal(reloaded.configuration.agents[0].developerInstructions, configuration.agents[0].developerInstructions);
  });
});

test("loads recommended roles only when no existing role configuration exists", async () => {
  await withCodexHome(async (codexHome) => {
    const status = await createEditableCodexAgentStore({ codexHome }).status();
    assert.equal(status.health, "ready");
    assert.equal(status.configurationOrigin, "recommended");
    assert.equal(status.configuration.configurationOrigin, "recommended");
    assert.ok(status.configuration.agents.some((agent) => agent.name === "worker"));
    assert.deepEqual(status.configuration.sourceAgents, []);
  });
});

test("does not silently replace an unreadable existing role with recommendations", async () => {
  await withCodexHome(async (codexHome) => {
    await mkdir(join(codexHome, "agents"));
    await writeFile(join(codexHome, "agents", "broken.toml"), `description = "Missing required fields."
developer_instructions = "Do not replace me silently."
`, "utf8");
    const status = await createEditableCodexAgentStore({ codexHome }).status();
    assert.equal(status.health, "agents.invalid_configuration");
    assert.equal(status.configuration, null);
    assert.match(status.error, /Agent name|name must be non-empty text/);
  });
});

test("imports existing roles and global settings, then safely overwrites the original file", async () => {
  await withCodexHome(async (codexHome) => {
    await mkdir(join(codexHome, "agents"));
    await writeFile(join(codexHome, "config.toml"), `[agents]
enabled = true
max_concurrent_threads_per_session = 4
default_subagent_model = "vendor/model-v2"
default_subagent_reasoning_effort = "high"

[projects."/workspace"]
trust_level = "trusted"
`, "utf8");
    const rolePath = join(codexHome, "agents", "my-docs.toml");
    await writeFile(rolePath, `name = "docs_researcher"
description = "Existing docs role."
model = "vendor/model-v2"
developer_instructions = '''
# Existing role

Read primary documentation.
'''
custom_vendor_option = "keep"
`, "utf8");
    const store = createEditableCodexAgentStore({ codexHome });
    const loaded = await store.status();
    assert.equal(loaded.configurationOrigin, "existing");
    assert.equal(loaded.configuration.globalSettings.maxConcurrentThreadsPerSession, 4);
    assert.equal(loaded.configuration.globalSettings.defaultSubagentModel, "vendor/model-v2");
    assert.deepEqual(loaded.configuration.agents.map((agent) => agent.name), ["docs_researcher"]);
    assert.equal(loaded.agents[0].status, "imported");
    loaded.configuration.agents[0].developerInstructions = "# Updated role\n\nUse primary sources.";
    const installed = await store.install({ configuration: loaded.configuration });
    assert.equal(installed.status.health, "installed");
    const written = await readFile(rolePath, "utf8");
    assert.match(written, /Use primary sources/);
    assert.match(written, /custom_vendor_option = "keep"/);
    assert.match(await readFile(join(codexHome, "config.toml"), "utf8"), /\[projects\."\/workspace"\]/);
    assert.ok(installed.backupId);
  });
});

test("refuses activation when an imported role changed after UI loading", async () => {
  await withCodexHome(async (codexHome) => {
    await mkdir(join(codexHome, "agents"));
    const rolePath = join(codexHome, "agents", "worker.toml");
    await writeFile(rolePath, renderCodexAgent(getDefaultCodexAgentConfiguration().agents[0]), "utf8");
    const store = createEditableCodexAgentStore({ codexHome });
    const loaded = await store.status();
    loaded.configuration.agents[0].description = "Edited in UI.";
    await writeFile(rolePath, `${await readFile(rolePath, "utf8")}# changed elsewhere\n`, "utf8");
    await assert.rejects(
      store.install({ configuration: loaded.configuration, allowOverwrite: true }),
      (error) => error instanceof CodexAgentStoreError && error.code === "agents.source_changed",
    );
  });
});

test("deleting a product-managed role removes only the unchanged owned file and backs it up", async () => {
  await withCodexHome(async (codexHome) => {
    const store = createEditableCodexAgentStore({ codexHome });
    const initial = getDefaultCodexAgentConfiguration();
    await store.install({ configuration: initial });
    const next = getDefaultCodexAgentConfiguration();
    next.agents = next.agents.filter((agent) => agent.name !== "worker");
    const planned = await store.status(next);
    assert.deepEqual(planned.removals, [{ name: "worker", fileName: "worker.toml", status: "remove" }]);
    const installed = await store.install({ configuration: next });
    await assert.rejects(readFile(join(codexHome, "agents", "worker.toml")));
    assert.equal(
      typeof await readFile(
        join(codexHome, ".agent-workflow-switch-agents", "backups", installed.backupId, "agents", "worker.toml"),
        "utf8",
      ),
      "string",
    );
    const rolledBack = await installed.rollback();
    assert.equal(rolledBack.status.health, "installed");
    assert.match(await readFile(join(codexHome, "agents", "worker.toml"), "utf8"), /name = "worker"/);
  });
});

test("deleting a role fails closed when its installed file drifted", async () => {
  await withCodexHome(async (codexHome) => {
    const store = createEditableCodexAgentStore({ codexHome });
    await store.install({ configuration: getDefaultCodexAgentConfiguration() });
    const worker = join(codexHome, "agents", "worker.toml");
    await writeFile(worker, "external edit\n", "utf8");
    const next = getDefaultCodexAgentConfiguration();
    next.agents = next.agents.filter((agent) => agent.name !== "worker");
    await assert.rejects(
      store.install({ configuration: next, allowOverwrite: true }),
      (error) => error instanceof CodexAgentStoreError && error.code === "agents.remove_conflict",
    );
    assert.equal(await readFile(worker, "utf8"), "external edit\n");
  });
});
