import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CodexAgentStoreError, getDefaultCodexAgentConfiguration } from "../codex-agent-store.mjs";
import {
  createEditableCodexAgentStore,
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

test("deleting a product-managed role removes only the unchanged owned file and backs it up", async () => {
  await withCodexHome(async (codexHome) => {
    const store = createEditableCodexAgentStore({ codexHome });
    const initial = getDefaultCodexAgentConfiguration();
    await store.install({ configuration: initial });
    const next = getDefaultCodexAgentConfiguration();
    next.agents = next.agents.filter((agent) => agent.name !== "worker");
    const planned = await store.status(next);
    assert.deepEqual(planned.removals, [{ name: "worker", status: "remove" }]);
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
