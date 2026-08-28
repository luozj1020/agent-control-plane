import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createClaudeUsageSource } from "../claude-usage-source.mjs";
import { createPreferredUsageSource } from "../preferred-usage-source.mjs";

async function withProjects(run) {
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-claude-usage-"));
  const project = join(root, "project", "session", "subagents");
  await mkdir(project, { recursive: true });
  const file = join(project, "agent.jsonl");
  try {
    await run({ file, root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function assistant(timestamp, id, values, complete = true) {
  return {
    type: "assistant",
    timestamp,
    sessionId: "session-a",
    message: {
      id,
      model: "claude-test",
      stop_reason: complete ? "end_turn" : null,
      content: "PRIVATE_CLAUDE_CONTENT",
      usage: {
        input_tokens: values.input,
        output_tokens: values.output,
        cache_read_input_tokens: values.cacheRead,
        cache_creation_input_tokens: values.cacheCreate,
      },
    },
  };
}

function jsonLines(records, finalNewline = true) {
  const content = records.map((record) => JSON.stringify(record)).join("\n");
  return finalNewline ? `${content}\n` : content;
}

test("reads nested Claude sessions incrementally and deduplicates streaming updates", async () => {
  await withProjects(async ({ file, root }) => {
    await writeFile(
      file,
      jsonLines([
        assistant(
          "2026-08-28T11:10:00.000Z",
          "message-a",
          { input: 3, output: 1, cacheRead: 7, cacheCreate: 11 },
          false,
        ),
        assistant("2026-08-28T11:10:01.000Z", "message-a", {
          input: 3,
          output: 5,
          cacheRead: 7,
          cacheCreate: 11,
        }),
      ]),
      "utf8",
    );
    const source = createClaudeUsageSource({ projectsDir: root });
    const window = {
      startMs: Date.parse("2026-08-28T11:00:00.000Z"),
      endMs: Date.parse("2026-08-28T12:00:00.000Z"),
    };
    const first = await source.collect(window);
    assert.equal(first.status, "active");
    assert.equal(first.source, "claude-local-sessions");
    assert.equal(first.attribution, "agent-level");
    assert.equal(first.events.length, 1);
    assert.deepEqual(first.events[0], {
      timestamp: Date.parse("2026-08-28T11:10:01.000Z"),
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
    assert.doesNotMatch(JSON.stringify(first), /PRIVATE_CLAUDE_CONTENT/);

    const next = assistant("2026-08-28T11:20:00.000Z", "message-b", {
      input: 2,
      output: 4,
      cacheRead: 6,
      cacheCreate: 8,
    });
    await appendFile(file, jsonLines([next], false), "utf8");
    assert.equal((await source.collect(window)).events.length, 1);
    await appendFile(file, "\n", "utf8");
    const completed = await source.collect(window);
    assert.equal(completed.events.length, 2);
    assert.equal(completed.diagnostics.filesRead, 1);
  });
});

test("preferred sources stop at the first active collector and fall back when unavailable", async () => {
  let fallbackCalls = 0;
  const active = {
    id: "local",
    lane: "downstream",
    async collect() {
      return { id: "local", lane: "downstream", status: "active", events: [] };
    },
  };
  const fallback = {
    id: "fallback",
    lane: "downstream",
    async collect() {
      fallbackCalls += 1;
      return { id: "fallback", lane: "downstream", status: "active", events: [] };
    },
  };
  const preferred = createPreferredUsageSource({ sources: [active, fallback] });
  assert.equal((await preferred.collect({ startMs: 0, endMs: 1 })).id, "local");
  assert.equal(fallbackCalls, 0);

  const unavailable = {
    id: "local",
    lane: "downstream",
    async collect() {
      return { id: "local", lane: "downstream", status: "unavailable", events: [] };
    },
  };
  const withFallback = createPreferredUsageSource({ sources: [unavailable, fallback] });
  assert.equal((await withFallback.collect({ startMs: 0, endMs: 1 })).id, "fallback");
  assert.equal(fallbackCalls, 1);
});
