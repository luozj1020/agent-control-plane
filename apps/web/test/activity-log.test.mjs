import assert from "node:assert/strict";
import test from "node:test";

import { activityDetail, buildActivityLog } from "../activity-log.mjs";

const activation = (overrides = {}) => ({
  historyId: "activation-1",
  recordedAt: "2026-09-01T00:00:00.000Z",
  mode: { id: "balanced", version: "1.0.0" },
  targetAdapterId: "claude-code",
  contentSha256: "a".repeat(64),
  ...overrides,
});

const run = (overrides = {}) => ({
  runId: "run-1",
  adapterId: "claude-code",
  state: "review_pending",
  createdAt: "2026-09-01T00:10:00.000Z",
  coordination: { eventCount: 4 },
  ...overrides,
});

test("groups explicitly linked runs under their immutable activation", () => {
  const history = { available: true, entries: [activation()] };
  const activity = buildActivityLog(history, [run({ activationId: "activation-1" })], []);

  assert.equal(activity.entries[0].runs.length, 1);
  assert.deepEqual(activity.entries[0].runs[0].association, {
    status: "linked",
    activationId: "activation-1",
    source: "explicit",
    confidence: "exact",
  });
  assert.equal(activity.activitySummary.events, 4);
  assert.equal(activity.activitySummary.unlinkedRuns, 0);
});

test("uses Skill hash before conservative temporal inference", () => {
  const history = {
    available: true,
    entries: [
      activation({ historyId: "activation-old", recordedAt: "2026-09-01T00:00:00.000Z" }),
      activation({
        historyId: "activation-new",
        recordedAt: "2026-09-01T00:05:00.000Z",
        contentSha256: "b".repeat(64),
      }),
    ],
  };
  const exact = run({ runId: "exact", effectiveSkillSha256: "a".repeat(64) });
  const inferred = run({ runId: "inferred" });
  const activity = buildActivityLog(history, [exact, inferred], []);

  assert.equal(activity.entries[0].runs[0].runId, "exact");
  assert.equal(activity.entries[0].runs[0].association.source, "skill-hash");
  assert.equal(activity.entries[1].runs[0].runId, "inferred");
  assert.equal(activity.entries[1].runs[0].association.source, "temporal-mode");
  assert.equal(activity.entries[1].runs[0].association.confidence, "inferred");
});

test("does not hide stale explicit links behind inferred associations", () => {
  const history = { available: true, entries: [activation()] };
  const activity = buildActivityLog(
    history,
    [run({ activationId: "missing-activation" })],
    [run({ runId: "overnight-1" })],
  );

  assert.equal(activity.unlinkedRuns.length, 2);
  assert.equal(activity.unlinkedRuns[0].association.status, "unlinked");
  assert(activity.unlinkedRuns.some(
    (entry) => entry.association.reason === "activation-not-found",
  ));
  assert(activity.unlinkedRuns.some(
    (entry) => entry.association.reason === "no-prior-compatible-activation",
  ));
});

test("project-bound runs cannot attach to an activation from another project revision", () => {
  const projectBinding = {
    projectId: "project-1",
    projectRevision: 3,
    projectConfigSha256: "c".repeat(64),
  };
  const history = { available: true, entries: [activation({ projectBinding })] };
  const activity = buildActivityLog(history, [run({
    activationId: "activation-1",
    projectBinding: { ...projectBinding, projectRevision: 2 },
  })], []);

  assert.equal(activity.entries[0].runs.length, 0);
  assert.equal(activity.unlinkedRuns[0].association.reason, "activation-project-mismatch");
  assert.equal(activity.activitySummary.projects, 1);
});

test("activity detail carries only runs associated with the selected activation", () => {
  const history = { available: true, entries: [activation()] };
  const activity = buildActivityLog(history, [run()], []);
  const detail = activityDetail(
    { entry: activation(), fieldChanges: [], diff: { available: true } },
    activity,
  );

  assert.equal(detail.runs.length, 1);
  assert.equal(detail.entry.runs.length, 1);
  assert.equal(detail.activitySummary.runs, 1);
});
