import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendCoordinationEvent,
  COORDINATION_EVENT_FILE,
  coordinationDetailForRun,
  coordinationSummaryForRun,
  createCoordinationEvent,
  readCoordinationEvents,
  summarizeCoordinationEvents,
} from "../coordination-events.mjs";

test("coordination events are content-free, append-only runtime evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "coordination-events-"));
  try {
    const options = { clock: () => Date.parse("2026-09-01T00:00:00.000Z"), randomUUID: () => "event-1" };
    const event = await appendCoordinationEvent(root, {
      runId: "run-1",
      mode: "balanced",
      kind: "agent_invoke_started",
      actor: { type: "control_plane", id: "balanced-runner" },
      target: { type: "agent", id: "claude-code" },
      correlationId: "round-1",
      detail: { round: 1 },
    }, options);
    assert.equal(event.eventId, "event-1");
    assert.equal(event.measurement.source, "runtime");

    await appendCoordinationEvent(root, {
      runId: "run-1",
      mode: "balanced",
      kind: "artifact_write",
      actor: { type: "control_plane", id: "balanced-runner" },
      target: { type: "artifact", id: "balanced-review.json" },
      bytes: 42,
    }, { ...options, randomUUID: () => "event-2" });

    await appendCoordinationEvent(root, {
      runId: "run-1",
      mode: "balanced",
      kind: "artifact_read",
      actor: { type: "agent", id: "claude-code" },
      target: { type: "artifact", id: "secret.txt" },
      detail: { classification: "out-of-scope", coverage: "partial-event-audit" },
    }, { ...options, randomUUID: () => "event-3" });

    const { events, invalidLines } = await readCoordinationEvents(root);
    assert.equal(events.length, 3);
    assert.equal(invalidLines, 0);
    const summary = await coordinationSummaryForRun(root, {
      runId: "run-1",
      mode: "balanced",
      containment: { read: "partial-event-audit", write: "post-run-audit", eventSource: "test" },
    });
    assert.equal(summary.agentInvocations, 1);
    assert.equal(summary.artifactWrites, 1);
    assert.equal(summary.artifactReads, 1);
    assert.equal(summary.readViolations, 1);
    assert.deepEqual(summary.readClassifications, {
      allowed: 0,
      outOfScope: 1,
      forbidden: 0,
      unknown: 0,
    });
    assert.equal(summary.topology.uniqueReadArtifacts, 1);
    assert.equal(summary.topology.repeatedArtifactReads, 0);
    assert.equal(summary.topology.maxArtifactReaderFanOut, 1);
    assert.equal(summary.coverage.invoke, "observed");
    assert.equal(summary.coverage.read, "observed");
    assert.equal(summary.coverage.message, "unsupported");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("coordination event validation rejects unknown kinds and negative measurements", () => {
  const base = {
    runId: "run-1",
    mode: "overnight",
    actor: { type: "control_plane", id: "runner" },
  };
  assert.throws(() => createCoordinationEvent({ ...base, kind: "unknown_event" }), /Unknown coordination event kind/);
  assert.throws(() => createCoordinationEvent({ ...base, kind: "artifact_write", bytes: -1 }), /non-negative integer/);
});

test("exact adapter guarantees remain enforced even when a run has no read or write events", () => {
  const summary = summarizeCoordinationEvents([], {
    runId: "run-exact",
    mode: "overnight",
    containment: { read: "exact-paths", write: "exact-paths", eventSource: "sandbox" },
  });
  assert.equal(summary.coverage.read, "enforced");
  assert.equal(summary.coverage.write, "enforced");
  assert.equal(summary.artifactReads, 0);
  assert.equal(summary.artifactWrites, 0);
});

test("topology metrics count observed relationships, reuse, and reader fan-out", () => {
  const read = (actor, target, classification) => createCoordinationEvent({
    runId: "run-topology",
    mode: "balanced",
    kind: "artifact_read",
    actor: { type: "agent", id: actor },
    target: { type: "artifact", id: target },
    detail: { classification },
  });
  const summary = summarizeCoordinationEvents([
    read("builder", "shared.json", "allowed"),
    read("builder", "shared.json", "allowed"),
    read("reviewer", "shared.json", "allowed"),
    read("builder", "secret.txt", "forbidden"),
  ], {
    runId: "run-topology",
    mode: "balanced",
    containment: { read: "partial-event-audit", write: "post-run-audit", eventSource: "test" },
  });
  assert.deepEqual(summary.readClassifications, {
    allowed: 3,
    outOfScope: 0,
    forbidden: 1,
    unknown: 0,
  });
  assert.equal(summary.readViolations, 1);
  assert.deepEqual(summary.topology, {
    nodeCount: 4,
    relationshipCount: 3,
    agentNodes: 2,
    artifactNodes: 2,
    uniqueReadArtifacts: 2,
    repeatedArtifactReads: 2,
    artifactReaderLinks: 3,
    maxArtifactReaderFanOut: 2,
  });
});

test("run detail is bounded and strips unapproved or malformed metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "coordination-detail-"));
  try {
    const base = {
      runId: "run-detail",
      mode: "overnight",
      actor: { type: "agent", id: "builder" },
      target: { type: "artifact", id: "app.txt" },
    };
    await appendCoordinationEvent(root, {
      ...base,
      kind: "artifact_read",
      detail: { classification: "allowed", state: "leaked prompt with spaces" },
    }, { randomUUID: () => "event-1" });
    await appendCoordinationEvent(root, { ...base, kind: "artifact_read" }, { randomUUID: () => "event-2" });
    await appendCoordinationEvent(root, { ...base, kind: "artifact_write" }, { randomUUID: () => "event-3" });
    const rejected = createCoordinationEvent({ ...base, kind: "artifact_read" }, { randomUUID: () => "event-4" });
    rejected.target.id = "secret=value";
    await appendFile(
      join(root, COORDINATION_EVENT_FILE),
      `${JSON.stringify(rejected)}\nnot-json\n`,
      "utf8",
    );
    const detail = await coordinationDetailForRun(root, {
      runId: "run-detail",
      mode: "overnight",
      containment: { read: "partial-event-audit", write: "post-run-audit", eventSource: "test" },
    }, { maximumEvents: 2 });
    assert.equal(detail.timeline.totalEvents, 3);
    assert.equal(detail.timeline.returnedEvents, 2);
    assert.equal(detail.timeline.offset, 1);
    assert.equal(detail.timeline.truncated, true);
    assert.equal(detail.timeline.invalidLines, 1);
    assert.equal(detail.timeline.rejectedEvents, 1);
    assert.doesNotMatch(JSON.stringify(detail), /leaked prompt|secret=value/);
    assert.equal(detail.graph.scope, "returned-events");
    assert.equal(detail.graph.edges.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("coordination storage rejects symlinks and configured byte overflow", async () => {
  const root = await mkdtemp(join(tmpdir(), "coordination-storage-"));
  try {
    const actual = join(root, "actual.jsonl");
    await writeFile(actual, "{}\n", "utf8");
    await symlink(actual, join(root, COORDINATION_EVENT_FILE));
    await assert.rejects(
      readCoordinationEvents(root),
      (error) => error.code === "coordination.unsafe_event_file",
    );
    await rm(join(root, COORDINATION_EVENT_FILE));
    await writeFile(join(root, COORDINATION_EVENT_FILE), "12345678901", "utf8");
    await assert.rejects(
      readCoordinationEvents(root, { maximumBytes: 10 }),
      (error) => error.code === "coordination.event_file_too_large" && error.status === 413,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
