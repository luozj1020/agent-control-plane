import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createUsageMonitor } from "../usage-monitor.mjs";

async function withSessions(run) {
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-usage-"));
  const day = join(root, "2026", "08", "28");
  await mkdir(day, { recursive: true });
  const file = join(day, "rollout-test-session.jsonl");
  try {
    await run({ file, root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function turn(timestamp, model) {
  return { timestamp, type: "turn_context", payload: { model } };
}

function usage(timestamp, values) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: values.input,
          cached_input_tokens: values.cached,
          output_tokens: values.output,
          reasoning_output_tokens: values.reasoning ?? 0,
          total_tokens: values.input + values.output,
        },
      },
    },
  };
}

function jsonLines(records, finalNewline = true) {
  const content = records.map((record) => JSON.stringify(record)).join("\n");
  return finalNewline ? `${content}\n` : content;
}

test("aggregates runtime usage without retaining prompts or responses", async () => {
  await withSessions(async ({ file, root }) => {
    await writeFile(
      file,
      jsonLines([
        turn("2026-08-28T10:00:00.000Z", "gpt-runtime-a"),
        {
          timestamp: "2026-08-28T10:01:00.000Z",
          type: "response_item",
          payload: { content: "PRIVATE_PROMPT_SENTINEL" },
        },
        usage("2026-08-28T10:05:00.000Z", {
          input: 100,
          cached: 60,
          output: 20,
          reasoning: 5,
        }),
        turn("2026-08-28T11:00:00.000Z", "gpt-runtime-b"),
        usage("2026-08-28T11:10:00.000Z", {
          input: 50,
          cached: 10,
          output: 10,
          reasoning: 2,
        }),
      ]),
      "utf8",
    );
    const monitor = createUsageMonitor({
      sessionsDir: root,
      now: () => new Date("2026-08-28T12:00:00.000Z"),
    });
    const result = await monitor.collect("24h");

    assert.equal(result.available, true);
    assert.deepEqual(result.filters, { lane: "all", model: null });
    assert.deepEqual(result.totals, {
      inputTokens: 150,
      cachedInputTokens: 70,
      uncachedInputTokens: 80,
      outputTokens: 30,
      reasoningOutputTokens: 7,
      totalTokens: 180,
      requests: 2,
      modelCalls: 2,
      upstreamCalls: 2,
      downstreamCalls: 0,
      upstreamTokens: 180,
      downstreamTokens: 0,
      sessions: 1,
      cacheRate: 70 / 150,
    });
    assert.deepEqual(
      result.models.map((entry) => [entry.model, entry.totalTokens]),
      [
        ["gpt-runtime-a", 120],
        ["gpt-runtime-b", 60],
      ],
    );
    assert.deepEqual(result.modelOptions, [
      { model: "gpt-runtime-a", totalTokens: 120, modelCalls: 1 },
      { model: "gpt-runtime-b", totalTokens: 60, modelCalls: 1 },
    ]);
    assert.equal(
      result.buckets.reduce((sum, bucket) => sum + bucket.totalTokens, 0),
      180,
    );
    assert.equal(result.totals.modelCalls, 2);
    assert.equal(result.totals.upstreamCalls, 2);
    assert.equal(result.totals.downstreamCalls, 0);
    assert.equal(result.totals.upstreamTokens, 180);
    assert.equal(result.totals.downstreamTokens, 0);
    assert.equal(
      result.buckets.reduce((sum, bucket) => sum + bucket.modelCalls, 0),
      2,
    );
    assert.equal(
      result.buckets.reduce((sum, bucket) => sum + bucket.upstreamTokens, 0),
      180,
    );
    assert.deepEqual(result.callCoverage, {
      upstream: { status: "active", source: "codex-local-sessions" },
      downstream: { status: "not-connected", source: null },
    });
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROMPT_SENTINEL/);
  });
});

test("incrementally reads appended JSONL bytes without double counting", async () => {
  await withSessions(async ({ file, root }) => {
    await writeFile(
      file,
      jsonLines([
        turn("2026-08-28T11:00:00.000Z", "gpt-runtime"),
        usage("2026-08-28T11:05:00.000Z", {
          input: 10,
          cached: 2,
          output: 3,
        }),
      ]),
      "utf8",
    );
    const monitor = createUsageMonitor({
      sessionsDir: root,
      now: () => new Date("2026-08-28T12:00:00.000Z"),
    });
    assert.equal((await monitor.collect("1h")).totals.requests, 1);

    await appendFile(
      file,
      jsonLines([
        usage("2026-08-28T11:15:00.000Z", {
          input: 20,
          cached: 5,
          output: 4,
        }),
      ]),
      "utf8",
    );
    const second = await monitor.collect("1h");
    assert.equal(second.totals.requests, 2);
    assert.equal(second.totals.totalTokens, 37);
    assert.equal((await monitor.collect("1h")).totals.totalTokens, 37);
  });
});

test("holds an incomplete final line until the writer completes it", async () => {
  await withSessions(async ({ file, root }) => {
    const record = usage("2026-08-28T11:30:00.000Z", {
      input: 12,
      cached: 4,
      output: 2,
    });
    await writeFile(file, jsonLines([record], false), "utf8");
    const monitor = createUsageMonitor({
      sessionsDir: root,
      now: () => new Date("2026-08-28T12:00:00.000Z"),
    });
    assert.equal((await monitor.collect("1h")).totals.requests, 0);
    await appendFile(file, "\n", "utf8");
    assert.equal((await monitor.collect("1h")).totals.requests, 1);
  });
});

test("serializes simultaneous snapshots without duplicating cached events", async () => {
  await withSessions(async ({ file, root }) => {
    await writeFile(
      file,
      jsonLines([
        usage("2026-08-28T11:30:00.000Z", {
          input: 30,
          cached: 10,
          output: 5,
        }),
      ]),
      "utf8",
    );
    const monitor = createUsageMonitor({
      sessionsDir: root,
      now: () => new Date("2026-08-28T12:00:00.000Z"),
    });
    const snapshots = await Promise.all([
      monitor.collect("1h"),
      monitor.collect("1h"),
      monitor.collect("1h"),
    ]);
    assert.deepEqual(
      snapshots.map((snapshot) => snapshot.totals.totalTokens),
      [35, 35, 35],
    );
  });
});

test("range selection excludes older runtime events", async () => {
  await withSessions(async ({ file, root }) => {
    await writeFile(
      file,
      jsonLines([
        usage("2026-08-28T09:00:00.000Z", {
          input: 100,
          cached: 0,
          output: 10,
        }),
        usage("2026-08-28T11:30:00.000Z", {
          input: 20,
          cached: 0,
          output: 2,
        }),
      ]),
      "utf8",
    );
    const monitor = createUsageMonitor({
      sessionsDir: root,
      now: () => new Date("2026-08-28T12:00:00.000Z"),
    });
    assert.equal((await monitor.collect("1h")).totals.totalTokens, 22);
    assert.equal((await monitor.collect("24h")).totals.totalTokens, 132);
  });
});

test("combines an injected downstream source with upstream Codex usage", async () => {
  await withSessions(async ({ file, root }) => {
    await writeFile(
      file,
      jsonLines([
        usage("2026-08-28T11:10:00.000Z", {
          input: 10,
          cached: 2,
          output: 3,
        }),
      ]),
      "utf8",
    );
    const downstream = {
      id: "cc-switch",
      lane: "downstream",
      async collect() {
        return {
          id: "cc-switch",
          lane: "downstream",
          status: "active",
          source: "cc-switch-session-log",
          attribution: "agent-level",
          events: [
            {
              timestamp: Date.parse("2026-08-28T11:20:00.000Z"),
              sessionKey: "claude:session-a",
              model: "claude-test",
              lane: "downstream",
              inputTokens: 20,
              cachedInputTokens: 12,
              uncachedInputTokens: 8,
              outputTokens: 4,
              reasoningOutputTokens: 0,
              totalTokens: 24,
            },
          ],
          diagnostics: { eventsRead: 1, snapshotFallback: true },
        };
      },
    };
    const monitor = createUsageMonitor({
      sessionsDir: root,
      sources: [downstream],
      now: () => new Date("2026-08-28T12:00:00.000Z"),
    });
    const result = await monitor.collect("1h");

    assert.equal(result.totals.totalTokens, 37);
    assert.equal(result.totals.modelCalls, 2);
    assert.equal(result.totals.upstreamCalls, 1);
    assert.equal(result.totals.downstreamCalls, 1);
    assert.equal(result.totals.upstreamTokens, 13);
    assert.equal(result.totals.downstreamTokens, 24);
    assert.equal(
      result.buckets.reduce((sum, bucket) => sum + bucket.downstreamTokens, 0),
      24,
    );
    assert.equal(result.totals.sessions, 2);
    assert.deepEqual(result.callCoverage.downstream, {
      status: "active",
      source: "cc-switch-session-log",
      attribution: "agent-level",
    });
    assert.deepEqual(result.diagnostics.sources, [
      {
        id: "cc-switch",
        lane: "downstream",
        status: "active",
        source: "cc-switch-session-log",
        reason: null,
        attribution: "agent-level",
        eventsRead: 1,
        snapshotFallback: true,
      },
    ]);

    const upstream = await monitor.collect("1h", { lane: "upstream" });
    assert.equal(upstream.totals.totalTokens, 13);
    assert.equal(upstream.totals.upstreamCalls, 1);
    assert.equal(upstream.totals.downstreamCalls, 0);
    assert.deepEqual(upstream.modelOptions, [
      { model: "unknown", totalTokens: 13, modelCalls: 1 },
    ]);

    const downstreamOnly = await monitor.collect("1h", {
      lane: "downstream",
      model: "claude-test",
    });
    assert.deepEqual(downstreamOnly.filters, {
      lane: "downstream",
      model: "claude-test",
    });
    assert.equal(downstreamOnly.totals.totalTokens, 24);
    assert.equal(downstreamOnly.totals.upstreamCalls, 0);
    assert.equal(downstreamOnly.totals.downstreamCalls, 1);
    assert.deepEqual(
      downstreamOnly.models.map((entry) => [entry.model, entry.totalTokens]),
      [["claude-test", 24]],
    );
    assert.equal(
      downstreamOnly.buckets.reduce((sum, bucket) => sum + bucket.totalTokens, 0),
      24,
    );
  });
});

test("keeps downstream usage available when the Codex directory is missing", async () => {
  const monitor = createUsageMonitor({
    sessionsDir: join(tmpdir(), "agent-workflow-upstream-missing"),
    sources: [
      {
        id: "cc-switch",
        lane: "downstream",
        async collect() {
          return {
            id: "cc-switch",
            lane: "downstream",
            status: "active",
            source: "cc-switch-session-log",
            events: [],
            diagnostics: { eventsRead: 0 },
          };
        },
      },
    ],
    now: () => new Date("2026-08-28T12:00:00.000Z"),
  });
  const result = await monitor.collect("1h");
  assert.equal(result.available, true);
  assert.equal(result.callCoverage.upstream.status, "unavailable");
  assert.equal(result.callCoverage.downstream.status, "active");
});

test("missing sessions directory is reported as unavailable", async () => {
  const monitor = createUsageMonitor({
    sessionsDir: join(tmpdir(), "agent-workflow-definitely-missing"),
    now: () => new Date("2026-08-28T12:00:00.000Z"),
  });
  const result = await monitor.collect("24h");
  assert.equal(result.available, false);
  assert.equal(result.reason, "sessions-directory-missing");
});

test("unknown ranges fail closed", async () => {
  const monitor = createUsageMonitor({ sessionsDir: tmpdir() });
  await assert.rejects(
    monitor.collect("forever"),
    (error) => error.code === "usage.invalid_range" && error.status === 400,
  );
});

test("unknown usage lanes fail closed", async () => {
  const monitor = createUsageMonitor({ sessionsDir: tmpdir() });
  await assert.rejects(
    monitor.collect("24h", { lane: "sideways" }),
    (error) => error.code === "usage.invalid_filter" && error.status === 400,
  );
});
