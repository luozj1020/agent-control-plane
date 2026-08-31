import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CodexAgentStoreError,
  createCodexAgentStore,
  mergeCodexAgentConfig,
} from "../codex-agent-store.mjs";

async function withCodexHome(run) {
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-codex-home-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("merges only managed [agents] keys and preserves unrelated configuration", () => {
  const source = [
    'model = "gpt-existing"',
    "",
    "[agents]",
    "enabled = false",
    "max_concurrent_threads_per_session = 2",
    "interrupt_message = false",
    "",
    "[mcp_servers.local]",
    'url = "http://localhost:3000"',
    "",
  ].join("\n");
  const merged = mergeCodexAgentConfig(source);
  assert.equal(merged.changed, true);
  assert.match(merged.content, /model = "gpt-existing"/);
  assert.match(merged.content, /enabled = true/);
  assert.match(merged.content, /max_concurrent_threads_per_session = 6/);
  assert.match(merged.content, /default_subagent_model = "gpt-5\.3-codex-spark"/);
  assert.match(merged.content, /interrupt_message = false/);
  assert.match(merged.content, /\[mcp_servers\.local\]/);
});

test("fresh install writes global settings and seven custom agents", async () => {
  await withCodexHome(async (codexHome) => {
    const store = createCodexAgentStore({ codexHome });
    const before = await store.status();
    assert.equal(before.health, "ready");
    const installed = await store.install();
    assert.equal(installed.changed, true);
    assert.equal(installed.status.health, "installed");
    assert.equal(installed.status.agents.length, 7);
    const config = await readFile(join(codexHome, "config.toml"), "utf8");
    assert.match(config, /\[agents\]/);
    assert.match(config, /default_subagent_model = "gpt-5\.3-codex-spark"/);
    const files = (await readdir(join(codexHome, "agents"))).sort();
    assert.deepEqual(files, [
      "benchmarker.toml",
      "build_fixer.toml",
      "debugger.toml",
      "explorer.toml",
      "reviewer.toml",
      "tester.toml",
      "worker.toml",
    ]);
    assert.match(await readFile(join(codexHome, "agents", "worker.toml"), "utf8"), /gpt-5\.3-codex-spark/);
    assert.match(await readFile(join(codexHome, "agents", "reviewer.toml"), "utf8"), /gpt-5\.6-terra/);
  });
});

test("an installation transaction can restore the pre-install state", async () => {
  await withCodexHome(async (codexHome) => {
    const store = createCodexAgentStore({ codexHome });
    const installed = await store.install();
    assert.equal(installed.status.health, "installed");
    const rolledBack = await installed.rollback();
    assert.equal(rolledBack.status.health, "ready");
    await assert.rejects(readFile(join(codexHome, "config.toml")));
    await assert.rejects(readFile(join(codexHome, "agents", "worker.toml")));
  });
});

test("rollback refuses to overwrite a file changed after installation", async () => {
  await withCodexHome(async (codexHome) => {
    const store = createCodexAgentStore({ codexHome });
    const installed = await store.install();
    const worker = join(codexHome, "agents", "worker.toml");
    await writeFile(worker, "external change\n", "utf8");
    await assert.rejects(
      installed.rollback(),
      (error) => error instanceof CodexAgentStoreError && error.code === "agents.rollback_conflict",
    );
    assert.equal(await readFile(worker, "utf8"), "external change\n");
  });
});

test("existing same-name agents require explicit backup and overwrite", async () => {
  await withCodexHome(async (codexHome) => {
    await mkdir(join(codexHome, "agents"));
    await writeFile(join(codexHome, "config.toml"), 'model = "keep-me"\n', "utf8");
    await writeFile(join(codexHome, "agents", "worker.toml"), "user-owned worker\n", "utf8");
    const store = createCodexAgentStore({ codexHome });
    const status = await store.status();
    assert.equal(status.health, "conflict");
    assert.deepEqual(status.conflicts, ["worker"]);
    await assert.rejects(
      store.install(),
      (error) => error instanceof CodexAgentStoreError && error.code === "agents.overwrite_required",
    );
    assert.equal(await readFile(join(codexHome, "agents", "worker.toml"), "utf8"), "user-owned worker\n");

    const installed = await store.install({ allowOverwrite: true });
    assert.equal(installed.status.health, "installed");
    assert(installed.backupId);
    assert.equal(
      await readFile(
        join(codexHome, ".agent-workflow-switch-agents", "backups", installed.backupId, "agents", "worker.toml"),
        "utf8",
      ),
      "user-owned worker\n",
    );
    assert.match(await readFile(join(codexHome, "config.toml"), "utf8"), /model = "keep-me"/);
  });
});

test("post-install drift fails closed until overwrite is explicitly authorized", async () => {
  await withCodexHome(async (codexHome) => {
    const store = createCodexAgentStore({ codexHome });
    await store.install();
    const worker = join(codexHome, "agents", "worker.toml");
    await writeFile(worker, "tampered\n", "utf8");
    assert.equal((await store.status()).health, "conflict");
    await assert.rejects(
      store.install(),
      (error) => error instanceof CodexAgentStoreError && error.code === "agents.overwrite_required",
    );
    assert.equal(await readFile(worker, "utf8"), "tampered\n");
  });
});

test("concurrent installations are serialized by an identity-scoped lock", async () => {
  await withCodexHome(async (codexHome) => {
    const store = createCodexAgentStore({ codexHome });
    await store.install();
    const lock = join(codexHome, ".agent-workflow-switch-agents", "install.lock");
    await writeFile(lock, "occupied", "utf8");
    await assert.rejects(
      store.install(),
      (error) => error instanceof CodexAgentStoreError && error.code === "agents.locked",
    );
    await rm(lock);
    assert.equal((await store.status()).health, "installed");
  });
});

test("unsupported or duplicate agents tables fail closed", () => {
  assert.throws(
    () => mergeCodexAgentConfig("agents = { enabled = true }\n"),
    (error) => error instanceof CodexAgentStoreError && error.code === "agents.config_unsupported",
  );
  assert.throws(
    () => mergeCodexAgentConfig("[agents]\nenabled = true\n[agents]\nenabled = false\n"),
    (error) => error instanceof CodexAgentStoreError && error.code === "agents.config_unsupported",
  );
});
