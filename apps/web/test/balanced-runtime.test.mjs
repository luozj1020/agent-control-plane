import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BUILTIN_MODE_CATALOG } from "../../../packages/contracts/dist/index.js";
import {
  BalancedRuntimeError,
  createBalancedRuntime,
  validateBalancedTask,
} from "../balanced-runtime.mjs";
import { createTaskCardTemplate } from "../task-card.mjs";
import { createPreflightReceipt, taskCardSha256 } from "../execution-receipt.mjs";
import { normalizeRuntimeEnvironment } from "../runtime-environment.mjs";
import { EMBEDDED_RUNTIME_PROTOCOLS } from "../workflow-runtime-protocol.mjs";

const TEST_CONTRACT_SHA256 = `sha256:${"a".repeat(64)}`;

function protocolProvider(mode) {
  return Promise.resolve({
    sourceId: "agent-control-plane/workflow-core",
    contractVersion: "1.1.0",
    contractSha256: TEST_CONTRACT_SHA256,
    mode,
    protocol: EMBEDDED_RUNTIME_PROTOCOLS[mode],
  });
}

async function withWorkspace(run) {
  const root = await mkdtemp(join(tmpdir(), "agent-control-balanced-"));
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

function testCatalog(budget = {}) {
  const policy = {
    ...BUILTIN_MODE_CATALOG.tunedWindowPolicies[0],
    id: "balanced-test",
    version: "1.0.0",
    contextAcquisitionSeconds: 0.08,
    activeWindowSeconds: 0.08,
    firstProgressSeconds: 0.08,
    progressExtensionSeconds: 0.04,
    growingProgressExtensionSeconds: 0.04,
    hardCapSeconds: 0.4,
    noOutputSeconds: 0,
    productIdleSeconds: 0.04,
    completionGraceSeconds: 0.02,
    tailSeconds: 0.1,
    advisorLeadSeconds: 0.02,
    advisorCallTimeoutSeconds: 0.04,
    pollSeconds: 0.01,
  };
  const budgetPolicy = {
    ...BUILTIN_MODE_CATALOG.balancedBudgetPolicies[0],
    id: "balanced-test-budget",
    mainReviewCalls: 2,
    downstreamCalls: 2,
    advisorCalls: 2,
    reservedFinalReviewCalls: 1,
    ...budget,
  };
  return {
    ...BUILTIN_MODE_CATALOG,
    modes: BUILTIN_MODE_CATALOG.modes.map((mode) =>
      mode.kind === "balanced"
        ? {
            ...mode,
            tunedWindowPolicy: { id: policy.id, version: policy.version },
            budgetPolicy: { id: budgetPolicy.id, version: budgetPolicy.version },
          }
        : mode,
    ),
    tunedWindowPolicies: [policy],
    balancedBudgetPolicies: [budgetPolicy],
  };
}

function task(overrides = {}) {
  const result = createTaskCardTemplate();
  result.id = overrides.id ?? "test-task";
  result.goal = overrides.objective ?? overrides.goal ?? "Update app.txt";
  result.scope.write_paths = overrides.allowedPaths ?? overrides.scope?.write_paths ?? ["app.txt"];
  result.scope.forbidden_paths = overrides.forbiddenPaths ?? overrides.scope?.forbidden_paths ?? ["secret/**"];
  if (overrides.acceptance) {
    result.acceptance = overrides.acceptance.map((item, index) =>
      typeof item === "string"
        ? { id: `acceptance-${index + 1}`, description: item }
        : item);
  } else {
    result.acceptance = [{ id: "acceptance-1", description: "app.txt contains the new value" }];
  }
  if (overrides.validationCommands) {
    result.validation = overrides.validationCommands.map((command, index) => ({
      id: `validation-${index + 1}`,
      command,
    }));
  }
  if (overrides.allowNoChanges === true) {
    result.extensions.agent_control_plane = { allow_no_changes: true };
  }
  return result;
}

function adapterRegistry(adapter) {
  return {
    get(id) {
      return id === adapter.id ? adapter : null;
    },
    list() {
      return [{ id: adapter.id, displayName: adapter.id }];
    },
  };
}

test("requires explicit acceptance and bounded relative write scope", () => {
  assert.throws(
    () => validateBalancedTask(task({ acceptance: [] })),
    (error) => error instanceof BalancedRuntimeError && error.code === "task.invalid",
  );
  assert.throws(
    () => validateBalancedTask(task({ allowedPaths: [] })),
    (error) => error instanceof BalancedRuntimeError && error.code === "task.invalid",
  );
  assert.throws(
    () => validateBalancedTask(task({ allowedPaths: ["C:/outside"] })),
    (error) => error instanceof BalancedRuntimeError && error.code === "task.unsafe_path",
  );
});

test("refuses to place Balanced runtime artifacts inside the product worktree", async () => {
  await withWorkspace(async ({ worktree }) => {
    const adapter = editingAdapter();
    const runtime = createBalancedRuntime({
      allowUnboundTaskForTests: true,
      runtimeRoot: join(worktree, "runtime-artifacts"),
      catalog: testCatalog(),
      adapters: adapterRegistry(adapter),
    });
    await assert.rejects(
      runtime.run({
        task: task(),
        worktree,
        adapterId: adapter.id,
        policyRef: "balanced-test@1.0.0",
      }),
      (error) => error instanceof BalancedRuntimeError && error.code === "runtime.unsafe_root",
    );
  });
});

test("runtime rejects budget overrides above the shared product limits", async () => {
  await withWorkspace(async ({ runtimeRoot, worktree }) => {
    const adapter = editingAdapter();
    const runtime = createBalancedRuntime({
      allowUnboundTaskForTests: true,
      runtimeRoot,
      catalog: testCatalog(),
      adapters: adapterRegistry(adapter),
    });
    await assert.rejects(
      runtime.run({
        task: task(),
        worktree,
        adapterId: adapter.id,
        policyRef: "balanced-test@1.0.0",
        budget: { mainReviewCalls: 100 },
      }),
      (error) =>
        error instanceof BalancedRuntimeError &&
        error.code === "runtime.invalid_budget" &&
        error.message.includes("1 to 99"),
    );
  });
});

test("new Balanced runs fail closed without an immutable Preflight Receipt", async () => {
  await withWorkspace(async ({ runtimeRoot, worktree }) => {
    const adapter = editingAdapter();
    const runtime = createBalancedRuntime({
      runtimeRoot,
      catalog: testCatalog(),
      adapters: adapterRegistry(adapter),
      protocolProvider,
    });
    await assert.rejects(
      runtime.run({
        task: task(),
        worktree,
        adapterId: adapter.id,
        policyRef: "balanced-test@1.0.0",
      }),
      (error) => error instanceof BalancedRuntimeError && error.code === "runtime.preflight_required",
    );
  });
});

test("Balanced run snapshots its Preflight Receipt and verifies it on reload", async () => {
  await withWorkspace(async ({ runtimeRoot, worktree }) => {
    const adapter = editingAdapter();
    const runtimeEnvironment = normalizeRuntimeEnvironment();
    const timing = {
      contextAcquisitionSeconds: 45,
      firstProgressSeconds: 40,
      activeWindowSeconds: 50,
      progressExtensionSeconds: 20,
      growingProgressExtensionSeconds: 25,
      hardCapSeconds: 90,
    };
    const budget = {
      mainReviewCalls: 3,
      downstreamCalls: 3,
      advisorCalls: 2,
      reservedFinalReviewCalls: 1,
    };
    const frozenTask = task({ id: "ANNC-123" });
    const taskHash = taskCardSha256(frozenTask);
    const activation = {
      activationId: "activation-1",
      effectiveSkillSha256: "b".repeat(64),
      projectBinding: {
        projectId: null,
        workspaceId: "workspace-1",
        projectRevision: 2,
        projectConfigSha256: "c".repeat(64),
      },
    };
    const receipt = createPreflightReceipt({
      preflightId: "preflight-balanced-1",
      createdAt: "2026-09-03T02:00:00.000Z",
      task: {
        workspaceId: "workspace-1",
        taskId: frozenTask.id,
        taskRevision: 1,
        taskSha256: taskHash,
      },
      workflow: {
        workspaceRevision: 2,
        configSha256: "c".repeat(64),
        activationId: activation.activationId,
        effectiveSkillSha256: activation.effectiveSkillSha256,
      },
      runtimeEnvelope: {
        schemaVersion: 1,
        workflowMode: "balanced",
        taskId: frozenTask.id,
        taskSha256: taskHash,
        worktree,
        adapterId: adapter.id,
        runtimeEnvironment,
        workflowContract: {
          sourceId: "agent-control-plane/workflow-core",
          version: "1.1.0",
          sha256: TEST_CONTRACT_SHA256,
          compatible: true,
        },
        policyRef: "balanced-default@1.0.0",
        timing,
        budget,
      },
      checks: [],
      issues: [],
    });
    const runtime = createBalancedRuntime({
      runtimeRoot,
      adapters: adapterRegistry(adapter),
      protocolProvider,
    });
    const runInput = {
      task: frozenTask,
      worktree,
      adapterId: adapter.id,
      activationId: activation.activationId,
      effectiveSkillSha256: activation.effectiveSkillSha256,
      projectBinding: activation.projectBinding,
      policyRef: "balanced-default@1.0.0",
      timing,
      budget,
      runtimeEnvironment,
      preflightReceipt: receipt,
    };
    let failedRun;
    await assert.rejects(
      runtime.run({
        ...runInput,
        onRunCreated: async () => {
          throw new Error("simulated Task Store I/O failure");
        },
      }),
      (error) => {
        failedRun = error.details;
        return error.code === "runtime.submission_link_failed";
      },
    );
    assert.equal(await readFile(join(worktree, "app.txt"), "utf8"), "before\n");
    const failedStatus = await runtime.status(failedRun.runDirectory);
    assert.equal(failedStatus.runCreation.state, "submission_link_failed");
    assert.equal(failedStatus.runCreation.submissionLink.attempts, 1);
    assert.equal(failedStatus.runCreation.submissionLink.failure.code, "task_store_write_failed");
    assert.equal(failedStatus.rounds, 0);

    const ready = await runtime.linkSubmission(failedRun.runDirectory, async ({ metadata }) => {
      assert.equal(metadata.runId, failedRun.runId);
    });
    assert.equal(ready.runCreation.state, "ready");
    assert.equal(ready.runCreation.submissionLink.attempts, 2);
    const result = await runtime.start(failedRun.runDirectory);
    const status = await runtime.status(result.runDirectory);
    assert.equal(status.executionBinding.task.taskRevision, 1);
    assert.equal(status.executionBinding.preflight.preflightId, "preflight-balanced-1");
    assert.match(status.initialTaskContractSha256, /^[a-f0-9]{64}$/);
    assert.equal(status.runCreation.state, "running");
    assert.equal(status.runCreation.submissionLink.attempts, 2);
    assert.equal(Object.hasOwn(status, "taskSha256"), false);
    assert.match(result.runDirectory, /annc-123/);

    await rm(join(result.runDirectory, "preflight-receipt.json"));
    await assert.rejects(
      runtime.status(result.runDirectory),
      (error) => error.code === "runtime.preflight_receipt_corrupt",
    );
    assert.deepEqual(await runtime.listRuns(), []);
    await assert.rejects(
      runtime.coordinationDetail(status.runId),
      (error) => error.code === "runtime.preflight_receipt_corrupt",
    );
  });
});

test("runtime applies bounded timing overrides to the effective round policy", async () => {
  await withWorkspace(async ({ runtimeRoot, worktree }) => {
    const adapter = editingAdapter();
    const runtime = createBalancedRuntime({
      allowUnboundTaskForTests: true,
      runtimeRoot,
      adapters: adapterRegistry(adapter),
      protocolProvider,
    });
    const timing = {
      contextAcquisitionSeconds: 45,
      firstProgressSeconds: 40,
      activeWindowSeconds: 50,
      progressExtensionSeconds: 20,
      growingProgressExtensionSeconds: 25,
      hardCapSeconds: 90,
    };
    const result = await runtime.run({
      task: task(),
      worktree,
      adapterId: adapter.id,
      policyRef: "balanced-default@1.0.0",
      timing,
    });

    assert.equal(result.review.roundStatus, "review_pending");
    assert.deepEqual(result.review.workflowContract, {
      source: "agent-control-plane/workflow-core",
      version: "1.1.0",
      sha256: TEST_CONTRACT_SHA256,
    });
    for (const [key, value] of Object.entries(timing)) {
      assert.equal(result.review.timeWindowPlan[key], value);
    }
    const coordinationEvents = await readFile(join(result.runDirectory, "coordination-events.jsonl"), "utf8");
    assert.match(coordinationEvents, /"kind":"agent_invoke_started"/);
    assert.match(coordinationEvents, /"kind":"agent_invoke_completed"/);
    assert.match(coordinationEvents, /"kind":"validation_completed"/);
    const runs = await runtime.listRuns();
    assert.equal(runs[0].coordination.agentInvocations, 1);
    assert.equal(runs[0].coordination.coverage.message, "unsupported");
  });
});

test("runtime projects explicit adapter reads into coordination evidence", async () => {
  await withWorkspace(async ({ runtimeRoot, worktree }) => {
    const adapter = editingAdapter({
      readContainment: "partial-event-audit",
      observedReads: ["app.txt", "unscoped.txt"],
    });
    const runtime = createBalancedRuntime({
      allowUnboundTaskForTests: true,
      runtimeRoot,
      adapters: adapterRegistry(adapter),
      protocolProvider,
    });
    await runtime.run({
      task: task(),
      worktree,
      adapterId: adapter.id,
      policyRef: "balanced-default@1.0.0",
    });
    const [run] = await runtime.listRuns();
    assert.equal(run.coordination.artifactReads, 2);
    assert.equal(run.coordination.readViolations, 1);
    assert.equal(run.coordination.coverage.read, "observed");
    assert.equal(run.coordination.containment.read, "partial-event-audit");
    const detail = await runtime.coordinationDetail(run.runId, { maximumEvents: 2 });
    assert.equal(detail.runId, run.runId);
    assert.equal(detail.mode, "balanced");
    assert.equal(detail.timeline.returnedEvents, 2);
    assert.equal(detail.timeline.truncated, true);
  });
});

test("runtime rejects a hard cap shorter than a configured wait window", async () => {
  await withWorkspace(async ({ runtimeRoot, worktree }) => {
    const adapter = editingAdapter();
    const runtime = createBalancedRuntime({
      allowUnboundTaskForTests: true,
      runtimeRoot,
      adapters: adapterRegistry(adapter),
    });
    await assert.rejects(
      runtime.run({
        task: task(),
        worktree,
        adapterId: adapter.id,
        policyRef: "balanced-default@1.0.0",
        timing: {
          contextAcquisitionSeconds: 120,
          firstProgressSeconds: 60,
          activeWindowSeconds: 60,
          progressExtensionSeconds: 30,
          growingProgressExtensionSeconds: 30,
          hardCapSeconds: 90,
        },
      }),
      (error) =>
        error instanceof BalancedRuntimeError && error.code === "runtime.invalid_timing",
    );
  });
});

function editingAdapter(options = {}) {
  let calls = 0;
  return {
    id: "fake-builder",
    readContainment: options.readContainment ?? "unsupported",
    writeContainment: "post-run-audit",
    filesystemEventSource: options.readContainment ? "fake-read-events" : null,
    async start(context) {
      calls += 1;
      let finish;
      let finished = false;
      const result = new Promise((resolve) => {
        finish = resolve;
      });
      context.onEvent({ type: "output", bytes: 10 });
      context.onEvent({ type: "task-directed" });
      for (const path of options.observedReads ?? []) {
        context.onEvent({
          type: "artifact-read",
          path,
          tool: "Read",
          source: "fake-read-events",
          coverage: options.readContainment ?? "partial-event-audit",
        });
      }
      setTimeout(async () => {
        const value = await readFile(join(context.worktree, "app.txt"), "utf8");
        await writeFile(join(context.worktree, "app.txt"), `${value}round-${calls}\n`, "utf8");
        context.onEvent({ type: "task-directed" });
        finished = true;
        finish({
          exitCode: 0,
          signal: null,
          sessionId: "fake-session",
          usage: {
            inputTokens: 10,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 5,
            totalTokens: 15,
          },
        });
      }, 20);
      return {
        pid: 123,
        result,
        usage: () => ({ totalTokens: 0 }),
        sessionId: () => "fake-session",
        async terminate() {
          if (!finished) {
            finished = true;
            finish({ exitCode: null, signal: "SIGTERM", sessionId: "fake-session", usage: { totalTokens: 0 } });
          }
        },
      };
    },
  };
}

test("runs a hash-bound Balanced round and records an accepted review", async () => {
  await withWorkspace(async ({ runtimeRoot, worktree }) => {
    const adapter = editingAdapter();
    const runtime = createBalancedRuntime({
      allowUnboundTaskForTests: true,
      runtimeRoot,
      catalog: testCatalog(),
      adapters: adapterRegistry(adapter),
    });
    const result = await runtime.run({
      task: task(),
      worktree,
      adapterId: adapter.id,
      policyRef: "balanced-test@1.0.0",
    });
    assert.equal(result.review.roundStatus, "review_pending");
    assert.deepEqual(result.review.evidence.changedPaths, ["app.txt"]);
    assert.equal(result.review.evidence.scope.status, "passed");
    assert.deepEqual(
      result.review.evidence.reviewProjection.entries.map(({ path, classification }) => ({
        path,
        classification,
      })),
      [{ path: "app.txt", classification: "allowed" }],
    );
    assert.match(result.review.evidence.reviewProjection.entries[0].beforeSha256, /^[a-f0-9]{64}$/);
    assert.match(result.review.evidence.reviewProjection.entries[0].afterSha256, /^[a-f0-9]{64}$/);
    assert.equal(result.review.evidence.reviewProjection.coverage, "complete");
    assert.equal(result.review.evidence.usage.totalTokens, 15);
    assert.equal(typeof result.review.timeWindowPlan.totalExecutionSecondsObserved, "number");
    assert.equal(result.review.timeWindowPlan.growthExtensionPolicy, "renewable-product-growth-until-hard-cap");

    const accepted = await runtime.review({ runDirectory: result.runDirectory, decision: "accept" });
    assert.equal(accepted.state, "accepted");
    const status = await runtime.status(result.runDirectory);
    assert.equal(status.budgetState.used.downstream, 1);
    assert.equal(status.budgetState.used.main, 1);
    assert.equal(status.budgetState.totalTokens, 15);
  });
});

test("revisions reuse the run and preserve a final-review budget slot", async () => {
  await withWorkspace(async ({ runtimeRoot, worktree }) => {
    const adapter = editingAdapter();
    const runtime = createBalancedRuntime({
      allowUnboundTaskForTests: true,
      runtimeRoot,
      catalog: testCatalog(),
      adapters: adapterRegistry(adapter),
    });
    const initial = await runtime.run({
      task: task(),
      worktree,
      adapterId: adapter.id,
      policyRef: "balanced-test@1.0.0",
    });
    const revised = await runtime.review({
      runDirectory: initial.runDirectory,
      decision: "revise",
      revisionTask: task({ id: "revision-one", objective: "Append the revision marker" }),
    });
    assert.equal(revised.review.round, 2);
    assert.equal(revised.review.roundKind, "revision");
    assert.equal(revised.review.priorReviewSha256, initial.reviewSha256);
    assert.deepEqual(revised.review.allowedDecisions, ["accept", "stop"]);

    const accepted = await runtime.review({ runDirectory: initial.runDirectory, decision: "accept" });
    assert.equal(accepted.state, "accepted");
    const status = await runtime.status(initial.runDirectory);
    assert.equal(status.rounds, 2);
    assert.equal(status.budgetState.used.downstream, 2);
    assert.equal(status.budgetState.used.main, 2);
    assert.equal(status.budgetState.remaining.main, 0);
  });
});

test("review fails closed when product state changed after evidence capture", async () => {
  await withWorkspace(async ({ runtimeRoot, worktree }) => {
    const adapter = editingAdapter();
    const runtime = createBalancedRuntime({
      allowUnboundTaskForTests: true,
      runtimeRoot,
      catalog: testCatalog(),
      adapters: adapterRegistry(adapter),
    });
    const result = await runtime.run({
      task: task(),
      worktree,
      adapterId: adapter.id,
      policyRef: "balanced-test@1.0.0",
    });
    await writeFile(join(worktree, "app.txt"), "changed after review\n", "utf8");
    await assert.rejects(
      runtime.review({ runDirectory: result.runDirectory, decision: "accept" }),
      (error) => error instanceof BalancedRuntimeError && error.code === "review.stale",
    );
  });
});

test("context timeout terminates a stalled adapter and returns runtime_blocked", async () => {
  await withWorkspace(async ({ runtimeRoot, worktree }) => {
    let finish;
    const stalled = {
      id: "stalled-builder",
      async start() {
        return {
          pid: 456,
          result: new Promise((resolve) => {
            finish = resolve;
          }),
          usage: () => ({ totalTokens: 0 }),
          sessionId: () => null,
          async terminate() {
            finish({ exitCode: null, signal: "SIGTERM", sessionId: null, usage: { totalTokens: 0 } });
          },
        };
      },
    };
    const runtime = createBalancedRuntime({
      allowUnboundTaskForTests: true,
      runtimeRoot,
      catalog: testCatalog(),
      adapters: adapterRegistry(stalled),
    });
    const result = await runtime.run({
      task: task({ allowNoChanges: true }),
      worktree,
      adapterId: stalled.id,
      policyRef: "balanced-test@1.0.0",
    });
    assert.equal(result.review.roundStatus, "runtime_blocked");
    assert.equal(result.review.timeWindowPlan.terminationReason, "first_progress_timeout");
  });
});

test("zero advisor budget disables extensions without misclassifying the round budget", async () => {
  await withWorkspace(async ({ runtimeRoot, worktree }) => {
    let finish;
    const stalled = {
      id: "no-advisor-builder",
      async start() {
        return {
          pid: 654,
          result: new Promise((resolve) => {
            finish = resolve;
          }),
          usage: () => ({ totalTokens: 0 }),
          sessionId: () => null,
          async terminate() {
            finish({ exitCode: null, signal: "SIGTERM", sessionId: null, usage: { totalTokens: 0 } });
          },
        };
      },
    };
    const runtime = createBalancedRuntime({
      allowUnboundTaskForTests: true,
      runtimeRoot,
      catalog: testCatalog({ advisorCalls: 0 }),
      adapters: adapterRegistry(stalled),
    });
    const result = await runtime.run({
      task: task({ allowNoChanges: true }),
      worktree,
      adapterId: stalled.id,
      policyRef: "balanced-test@1.0.0",
    });

    assert.equal(result.review.roundStatus, "runtime_blocked");
    assert.equal(result.review.timeWindowPlan.terminationReason, "first_progress_timeout");
    assert.equal(result.review.evidence.budget.used.advisor, 0);
  });
});

test("an explicit downstream no-response classification becomes runtime_blocked", async () => {
  await withWorkspace(async ({ runtimeRoot, worktree }) => {
    const silent = {
      id: "silent-builder",
      async start() {
        return {
          pid: 321,
          result: Promise.resolve({
            exitCode: 0,
            signal: null,
            sessionId: null,
            usage: { totalTokens: 0 },
            failureCategory: "no-response",
            diagnostics: { activity: { stdoutBytes: 0, stderrBytes: 0 } },
          }),
          usage: () => ({ totalTokens: 0 }),
          sessionId: () => null,
          async terminate() {},
        };
      },
    };
    const runtime = createBalancedRuntime({
      allowUnboundTaskForTests: true,
      runtimeRoot,
      catalog: testCatalog(),
      adapters: adapterRegistry(silent),
    });
    const result = await runtime.run({
      task: task({ allowNoChanges: true }),
      worktree,
      adapterId: silent.id,
      policyRef: "balanced-test@1.0.0",
    });
    assert.equal(result.review.roundStatus, "runtime_blocked");
    assert.equal(result.review.timeWindowPlan.terminationReason, "no-response");
    assert.equal(result.review.evidence.adapter.failureCategory, "no-response");
  });
});

test("downstream Token usage is observed but never used as a termination budget", async () => {
  await withWorkspace(async ({ runtimeRoot, worktree }) => {
    const adapter = editingAdapter();
    const runtime = createBalancedRuntime({
      allowUnboundTaskForTests: true,
      runtimeRoot,
      catalog: testCatalog(),
      adapters: adapterRegistry(adapter),
    });
    const result = await runtime.run({
      task: task(),
      worktree,
      adapterId: adapter.id,
      policyRef: "balanced-test@1.0.0",
    });
    assert.equal(result.review.roundStatus, "review_pending");
    assert.equal(result.review.evidence.usage.totalTokens, 15);
    assert.equal("maxTotalTokens" in result.review.evidence.budget.limits, false);
    assert.equal("tokens" in result.review.evidence.budget.remaining, false);
  });
});

test("scope violations cannot be accepted", async () => {
  await withWorkspace(async ({ runtimeRoot, worktree }) => {
    const adapter = {
      id: "scope-breaking-builder",
      async start(context) {
        const result = (async () => {
          await writeFile(join(context.worktree, "outside.txt"), "outside\n", "utf8");
          return { exitCode: 0, signal: null, sessionId: null, usage: { totalTokens: 1 } };
        })();
        return {
          pid: 789,
          result,
          usage: () => ({ totalTokens: 0 }),
          sessionId: () => null,
          async terminate() {},
        };
      },
    };
    const runtime = createBalancedRuntime({
      allowUnboundTaskForTests: true,
      runtimeRoot,
      catalog: testCatalog(),
      adapters: adapterRegistry(adapter),
    });
    const result = await runtime.run({
      task: task(),
      worktree,
      adapterId: adapter.id,
      policyRef: "balanced-test@1.0.0",
    });
    assert.equal(result.review.roundStatus, "scope_violation");
    assert.deepEqual(result.review.evidence.scope.violations, ["outside.txt"]);
    assert(!result.review.allowedDecisions.includes("accept"));
  });
});

test("invalidates an advisor decision when the product changes during evaluation", async () => {
  await withWorkspace(async ({ runtimeRoot, worktree }) => {
    let finish;
    let advisorStarted;
    let advisorDidStart = false;
    const advisorStartedPromise = new Promise((resolve) => {
      advisorStarted = resolve;
    });
    const adapter = {
      id: "advisor-race-builder",
      async start(context) {
        let terminated = false;
        const result = new Promise((resolve) => {
          finish = resolve;
        });
        context.onEvent({ type: "task-directed" });
        const activity = advisorStartedPromise.then(async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          if (terminated) return;
          await writeFile(join(context.worktree, "app.txt"), "changed during advice\n", "utf8");
          context.onEvent({ type: "task-directed" });
          await new Promise((resolve) => setTimeout(resolve, 40));
          if (terminated) return;
          finish({
            exitCode: 0,
            signal: null,
            sessionId: "advisor-race-session",
            usage: { totalTokens: 1 },
          });
        });
        return {
          pid: 987,
          result,
          usage: () => ({ totalTokens: 0 }),
          sessionId: () => "advisor-race-session",
          async terminate() {
            terminated = true;
            if (advisorDidStart) await activity;
            finish({ exitCode: null, signal: "SIGTERM", sessionId: null, usage: { totalTokens: 0 } });
          },
        };
      },
    };
    const advisor = {
      id: "slow-stop-advisor",
      async evaluate() {
        advisorDidStart = true;
        advisorStarted();
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { decision: "stop", reason: "stale-stop" };
      },
    };
    const runtime = createBalancedRuntime({
      allowUnboundTaskForTests: true,
      runtimeRoot,
      catalog: testCatalog(),
      adapters: adapterRegistry(adapter),
      advisor,
    });
    const result = await runtime.run({
      task: task(),
      worktree,
      adapterId: adapter.id,
      policyRef: "balanced-test@1.0.0",
    });

    assert.equal(result.review.roundStatus, "review_pending");
    assert.deepEqual(result.review.evidence.changedPaths, ["app.txt"]);
    const events = (await readFile(join(result.runDirectory, "rounds", "001", "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const started = events.find((event) => event.type === "extension-evaluation-started");
    assert(started);
    assert(Date.parse(started.activeDeadline) > Date.parse(started.recordedAt));
    assert(events.some((event) => event.type === "extension-evaluation-invalidated"));
    assert.equal(result.review.evidence.budget.used.advisor, 0);
  });
});
