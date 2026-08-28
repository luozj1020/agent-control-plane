import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCcSwitchUsageSource } from "../cc-switch-usage-source.mjs";

async function withDatabase(run, schema = true) {
  const directory = await mkdtemp(join(tmpdir(), "agent-workflow-cc-switch-test-"));
  const databasePath = join(directory, "cc-switch.db");
  const database = new DatabaseSync(databasePath);
  if (schema) {
    database.exec(`
      CREATE TABLE proxy_request_logs (
        request_id TEXT PRIMARY KEY,
        app_type TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_creation_tokens INTEGER NOT NULL,
        session_id TEXT,
        created_at INTEGER NOT NULL,
        data_source TEXT NOT NULL
      )
    `);
  }
  try {
    await run({ database, databasePath, directory });
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function insert(database, values) {
  database
    .prepare(`
      INSERT INTO proxy_request_logs (
        request_id, app_type, model, input_tokens, output_tokens,
        cache_read_tokens, cache_creation_tokens, session_id, created_at, data_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      values.id,
      values.app,
      values.model,
      values.input,
      values.output,
      values.cacheRead,
      values.cacheCreate,
      values.session,
      values.createdAt,
      values.source,
    );
}

test("imports only Claude session rows and normalizes cache tokens", async () => {
  await withDatabase(async ({ database, databasePath }) => {
    insert(database, {
      id: "claude-session",
      app: "claude",
      model: "claude-test",
      input: 3,
      output: 5,
      cacheRead: 7,
      cacheCreate: 11,
      session: "session-a",
      createdAt: 1_787_918_400,
      source: "session_log",
    });
    insert(database, {
      id: "claude-proxy",
      app: "claude",
      model: "claude-proxy",
      input: 100,
      output: 100,
      cacheRead: 0,
      cacheCreate: 0,
      session: "session-b",
      createdAt: 1_787_918_400,
      source: "proxy",
    });
    insert(database, {
      id: "codex-session",
      app: "codex",
      model: "gpt-test",
      input: 100,
      output: 100,
      cacheRead: 0,
      cacheCreate: 0,
      session: "session-c",
      createdAt: 1_787_918_400,
      source: "codex_session",
    });

    const source = createCcSwitchUsageSource({ databasePath });
    const result = await source.collect({
      startMs: Date.parse("2026-08-27T00:00:00.000Z"),
      endMs: Date.parse("2026-08-29T00:00:00.000Z"),
    });

    assert.equal(result.status, "active");
    assert.equal(result.source, "cc-switch-session-log");
    assert.equal(result.attribution, "agent-level");
    assert.equal(result.events.length, 1);
    assert.deepEqual(result.events[0], {
      timestamp: 1_787_918_400_000,
      sessionKey: "claude:session-a",
      model: "claude-test",
      lane: "downstream",
      inputTokens: 21,
      cachedInputTokens: 7,
      uncachedInputTokens: 14,
      outputTokens: 5,
      reasoningOutputTokens: 0,
      totalTokens: 26,
    });
    assert.equal(result.diagnostics.eventsRead, 1);
    assert.doesNotMatch(JSON.stringify(result), /claude-session/);
  });
});

test("reports a missing database without creating it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-workflow-cc-switch-missing-"));
  const databasePath = join(directory, "missing.db");
  try {
    const result = await createCcSwitchUsageSource({ databasePath }).collect({
      startMs: 0,
      endMs: Date.now(),
    });
    assert.equal(result.status, "not-connected");
    assert.equal(result.reason, "database-missing");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails closed instead of returning a partial result when the row limit is exceeded", async () => {
  await withDatabase(async ({ database, databasePath }) => {
    for (const id of ["first", "second"]) {
      insert(database, {
        id,
        app: "claude",
        model: "claude-test",
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheCreate: 0,
        session: id,
        createdAt: 1_787_918_400,
        source: "session_log",
      });
    }
    const result = await createCcSwitchUsageSource({
      databasePath,
      maximumRows: 1,
    }).collect({
      startMs: Date.parse("2026-08-27T00:00:00.000Z"),
      endMs: Date.parse("2026-08-29T00:00:00.000Z"),
    });
    assert.equal(result.status, "unavailable");
    assert.equal(result.reason, "row-limit-exceeded");
    assert.deepEqual(result.events, []);
  });
});

test("fails closed for an incompatible schema and a symlink database", async () => {
  await withDatabase(async ({ databasePath, directory }) => {
    const incompatible = await createCcSwitchUsageSource({ databasePath }).collect({
      startMs: 0,
      endMs: Date.now(),
    });
    assert.equal(incompatible.status, "unavailable");
    assert.equal(incompatible.reason, "incompatible-schema");

    const linkPath = join(directory, "linked.db");
    await symlink(databasePath, linkPath);
    const linked = await createCcSwitchUsageSource({ databasePath: linkPath }).collect({
      startMs: 0,
      endMs: Date.now(),
    });
    assert.equal(linked.status, "unavailable");
    assert.equal(linked.reason, "unsafe-database-symlink");
  }, false);
});
