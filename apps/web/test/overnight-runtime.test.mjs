import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  OvernightRuntimeError,
  createOvernightRuntime,
  validateConvergentRevision,
  validateImprovementContinuation,
} from "../overnight-runtime.mjs";
import { createTaskCardTemplate, validateTaskCard } from "../task-card.mjs";
import { EMBEDDED_RUNTIME_PROTOCOLS } from "../workflow-runtime-protocol.mjs";

const TEST_CONTRACT_SHA256 = `sha256:${"a".repeat(64)}`;

function protocolProvider(mode) {
  return Promise.resolve({
    sourceId: "agent-control-plane/workflow-core",
    contractVersion: "1.1.0",
    contractSha256: TEST_CONTRACT_SHA256,
    mode,
    strategies: ["convergent", "continuous-improvement"],
    protocol: EMBEDDED_RUNTIME_PROTOCOLS[mode],
  });
}

function task(overrides = {}) {
  const result = createTaskCardTemplate();
  result.id = overrides.id ?? "overnight-test";
  result.goal = overrides.objective ?? overrides.goal ?? "Improve app.txt";
  result.scope.write_paths = overrides.allowedPaths ?? overrides.scope?.write_paths ?? ["app.txt"];
  result.scope.forbidden_paths = overrides.forbiddenPaths ?? overrides.scope?.forbidden_paths ?? ["secret/**"];
  if (overrides.acceptance) {
    result.acceptance = overrides.acceptance.map((item, index) =>
      typeof item === "string"
        ? { id: `acceptance-${index + 1}`, description: item }
        : item);
  } else {
    result.acceptance = [{
      id: "acceptance-1",
      description: "app.txt contains a completed cycle",
    }];
  }
  if (overrides.validationCommands) {
    result.validation = overrides.validationCommands.map((command, index) => ({
      id: `validation-${index + 1}`,
      command,
    }));
  }
  return result;
}

function editingAdapter(options = {}) {
  let calls = 0;
  return {
    id: "fake-builder",
    readContainment: options.readContainment ?? "unsupported",
    writeContainment: "post-run-audit",
    filesystemEventSource: options.readContainment ? "fake-read-events" : null,
    async start(context) {
      calls += 1;
      context.onEvent?.({ type: "task-directed" });
      for (const path of options.observedReads ?? []) {
        context.onEvent?.({
          type: "artifact-read",
          path,
          tool: "Read",
          source: "fake-read-events",
          coverage: options.readContainment ?? "partial-event-audit",
        });
      }
      if (options.path) {
        await writeFile(join(context.worktree, options.path), `cycle-${calls}\n`, "utf8");
      } else {
        const current = await readFile(join(context.worktree, "app.txt"), "utf8");
        await writeFile(join(context.worktree, "app.txt"), `${current}cycle-${calls}\n`, "utf8");
      }
      const result = Promise.resolve({
        exitCode: 0,
        signal: null,
        sessionId: "durable-session",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      });
      return {
        pid: 123,
        identity: { pid: 123, adapter: this.id },
        result,
        sessionId: () => "durable-session",
        async terminate() {},
      };
    },
  };
}

function registry(adapter) {
  return {
    get(id) {
      return id === adapter.id ? adapter : null;
    },
    list() {
      return [{ id: adapter.id, displayName: adapter.id }];
    },
  };
}

async function withWorkspace(run) {
  const root = await mkdtemp(join(tmpdir(), "agent-control-overnight-"));
  const worktree = join(root, "worktree");
  const runtimeRoot = join(root, "runs");
  await mkdir(worktree);
  await writeFile(join(worktree, "app.txt"), "before\n", "utf8");
  try {
    await run({ root, runtimeRoot, worktree });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("convergent strategy writes hash-bound wake evidence and accepts terminal review", async () => {
  await withWorkspace(async ({ runtimeRoot, worktree }) => {
    const adapter = editingAdapter();
    const runtime = createOvernightRuntime({
      runtimeRoot,
      adapters: registry(adapter),
      pollMilliseconds: 1,
      protocolProvider,
    });
    const created = await runtime.createRun({
      task: task(),
      worktree,
      adapterId: adapter.id,
      strategy: "convergent",
    });
    assert.equal(created.metadata.state, "submitted");
    assert.deepEqual(created.metadata.workflowContract, {
      source: "agent-control-plane/workflow-core",
      version: "1.1.0",
      sha256: TEST_CONTRACT_SHA256,
    });

    const result = await runtime.executeCycle(created.runDirectory);
    assert.equal(result.state, "revision_pending");
    assert.deepEqual(result.wake.allowedDecisions, ["accept", "revise", "stop"]);
    assert.match(result.wakeSha256, /^[a-f0-9]{64}$/);
    assert.equal(result.delivery.status, "scheduled");
    assert.equal(result.delivery.adapterId, "durable-file");
    const delivery = JSON.parse(await readFile(join(created.runDirectory, "wake-delivery.json"), "utf8"));
    assert.equal(delivery.wakeId, result.wakeSha256);
    const evidence = JSON.parse(await readFile(result.wake.evidencePath, "utf8"));
    assert.equal(evidence.reviewProjection.coverage, "complete");
    assert.deepEqual(evidence.reviewProjection.violations, []);
    assert.equal(evidence.process.sessionId, "durable-session");

    const accepted = await runtime.review({
      runDirectory: created.runDirectory,
      decision: "accept",
    });
    assert.equal(accepted.state, "accepted");
    assert.equal((await runtime.status(created.runDirectory)).state, "accepted");
    await assert.rejects(
      runtime.review({ runDirectory: created.runDirectory, decision: "accept" }),
      (error) => error instanceof OvernightRuntimeError && error.code === "review.stale_wake",
    );
    const monitorEvents = await readFile(join(created.runDirectory, "monitor-events.jsonl"), "utf8");
    assert.match(monitorEvents, /"type":"adapter-activity"/);
    assert.match(monitorEvents, /"type":"wake-requested"/);
    assert.match(monitorEvents, /"type":"wake-delivery-recorded"/);
    const coordinationEvents = await readFile(join(created.runDirectory, "coordination-events.jsonl"), "utf8");
    assert.match(coordinationEvents, /"kind":"agent_invoke_started"/);
    assert.match(coordinationEvents, /"kind":"agent_invoke_completed"/);
    assert.match(coordinationEvents, /"kind":"artifact_write"/);
    assert.match(coordinationEvents, /"kind":"review_decision"/);
    const runs = await runtime.listRuns();
    assert.equal(runs[0].coordination.agentInvocations, 1);
    assert.equal(runs[0].coordination.coverage.read, "unsupported");
  });
});

test("convergent revisions fail closed when objective, acceptance, or scope expands", () => {
  const previous = task();
  assert.throws(
    () => validateConvergentRevision(previous, task({ allowedPaths: ["app.txt", "lib/**"] })),
    (error) => error instanceof OvernightRuntimeError && error.code === "revision.expanded",
  );
  assert.throws(
    () => validateConvergentRevision(previous, task({ acceptance: [...previous.acceptance, "new metric"] })),
    (error) => error instanceof OvernightRuntimeError && error.code === "revision.expanded",
  );
  assert.throws(
    () => validateConvergentRevision(previous, task({ objective: "Redesign everything" })),
    (error) => error instanceof OvernightRuntimeError && error.code === "revision.expanded",
  );
  const readExpansion = task();
  readExpansion.scope.read_paths = ["private/**"];
  assert.throws(
    () => validateConvergentRevision(previous, readExpansion),
    (error) => error instanceof OvernightRuntimeError && error.code === "revision.expanded",
  );
});

test("runtime records observed reads and classifies forbidden or out-of-scope paths", async () => {
  await withWorkspace(async ({ runtimeRoot, worktree }) => {
    const adapter = editingAdapter({
      readContainment: "partial-event-audit",
      observedReads: ["app.txt", "secret/key.txt", "@outside-worktree"],
    });
    const runtime = createOvernightRuntime({ runtimeRoot, adapters: registry(adapter), pollMilliseconds: 1 });
    const created = await runtime.createRun({
      task: task(),
      worktree,
      adapterId: adapter.id,
      strategy: "convergent",
    });
    await runtime.executeCycle(created.runDirectory);
    const [run] = await runtime.listRuns();
    assert.equal(run.coordination.artifactReads, 3);
    assert.equal(run.coordination.readViolations, 2);
    assert.equal(run.coordination.coverage.read, "observed");
    assert.equal(run.coordination.containment.read, "partial-event-audit");
    const detail = await runtime.coordinationDetail(run.runId, { maximumEvents: 2 });
    assert.equal(detail.runId, run.runId);
    assert.equal(detail.mode, "overnight");
    assert.equal(detail.timeline.returnedEvents, 2);
    assert.equal(detail.timeline.truncated, true);
  });
});

test("continuous improvement preserves metric floor and explicitly declares added paths", async () => {
  await withWorkspace(async ({ runtimeRoot, worktree }) => {
    const adapter = editingAdapter();
    const runtime = createOvernightRuntime({ runtimeRoot, adapters: registry(adapter), pollMilliseconds: 1 });
    const initial = task();
    const created = await runtime.createRun({
      task: initial,
      worktree,
      adapterId: adapter.id,
      strategy: "continuous-improvement",
    });
    const first = await runtime.executeCycle(created.runDirectory);
    assert.equal(first.state, "improvement_cycle_ready");
    assert.deepEqual(first.wake.allowedDecisions, ["continue", "revise", "stop"]);
    const scaffold = await runtime.nextTemplate(created.runDirectory);
    const canonicalInitial = validateTaskCard(initial);
    assert.deepEqual(scaffold.task.acceptance, canonicalInitial.acceptance);
    assert.deepEqual(scaffold.task.scope.forbidden_paths, canonicalInitial.scope.forbidden_paths);
    assert.deepEqual(scaffold.added_paths, []);

    const continuation = {
      rationale: "A second bounded file enables the next measurable improvement.",
      expected_gain: "Preserve the baseline and add one documented improvement.",
      rollback_boundary: "Revert only cycle 2 changes.",
      added_paths: ["notes.txt"],
      task: task({ allowedPaths: ["app.txt", "notes.txt"] }),
    };
    const reviewed = await runtime.review({
      runDirectory: created.runDirectory,
      decision: "continue",
      continuation,
    });
    assert.equal(reviewed.state, "submitted");
    assert.equal(reviewed.cycle, 2);
    assert.equal(reviewed.resumeRequired, true);

    const interrupted = await runtime.interruptById(created.metadata.runId);
    assert.equal(interrupted.state, "interrupted");
    assert.equal((await runtime.status(created.runDirectory)).state, "interrupted");
  });
});

test("continuous continuation cannot remove the original metric floor or hide scope additions", () => {
  const initial = task();
  assert.throws(
    () =>
      validateImprovementContinuation(initial, initial, {
        rationale: "change",
        expectedGain: "gain",
        rollbackBoundary: "cycle",
        addedPaths: [],
        task: task({ acceptance: ["replacement metric"] }),
      }),
    (error) =>
      error instanceof OvernightRuntimeError && error.code === "continuation.metric_floor_removed",
  );
  assert.throws(
    () =>
      validateImprovementContinuation(initial, initial, {
        rationale: "change",
        expectedGain: "gain",
        rollbackBoundary: "cycle",
        addedPaths: [],
        task: task({ allowedPaths: ["app.txt", "hidden.txt"] }),
      }),
    (error) =>
      error instanceof OvernightRuntimeError && error.code === "continuation.expansion_mismatch",
  );
});

test("out-of-scope downstream changes become a durable scope-violation wake", async () => {
  await withWorkspace(async ({ runtimeRoot, worktree }) => {
    const adapter = editingAdapter({ path: "outside.txt" });
    const runtime = createOvernightRuntime({ runtimeRoot, adapters: registry(adapter), pollMilliseconds: 1 });
    const created = await runtime.createRun({
      task: task(),
      worktree,
      adapterId: adapter.id,
      strategy: "convergent",
    });
    const result = await runtime.executeCycle(created.runDirectory);
    assert.equal(result.state, "scope_violation");
    assert.deepEqual(result.wake.allowedDecisions, ["stop"]);
    assert.deepEqual(
      JSON.parse(await readFile(result.wake.evidencePath, "utf8")).reviewProjection.violations,
      ["outside.txt"],
    );
  });
});

test("an explicit downstream no-response classification becomes a runtime-blocked wake", async () => {
  await withWorkspace(async ({ runtimeRoot, worktree }) => {
    const silent = {
      id: "silent-builder",
      async start() {
        return {
          pid: 789,
          result: Promise.resolve({
            exitCode: 0,
            signal: null,
            sessionId: null,
            usage: { totalTokens: 0 },
            failureCategory: "no-response",
            diagnostics: { activity: { stdoutBytes: 0, stderrBytes: 0 } },
          }),
          sessionId: () => null,
          async terminate() {},
        };
      },
    };
    const runtime = createOvernightRuntime({
      runtimeRoot,
      adapters: registry(silent),
      pollMilliseconds: 1,
    });
    const created = await runtime.createRun({
      task: task(),
      worktree,
      adapterId: silent.id,
      strategy: "convergent",
    });
    const result = await runtime.executeCycle(created.runDirectory);
    assert.equal(result.state, "runtime_blocked");
    const evidence = JSON.parse(await readFile(result.wake.evidencePath, "utf8"));
    assert.equal(evidence.process.failureCategory, "no-response");
    assert.equal(evidence.process.diagnostics.activity.stdoutBytes, 0);
  });
});
