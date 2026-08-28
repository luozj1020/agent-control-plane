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
    maxTotalTokens: 1000,
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
  return {
    id: "test-task",
    objective: "Update app.txt",
    acceptance: ["app.txt contains the new value"],
    allowedPaths: ["app.txt"],
    forbiddenPaths: ["secret/**"],
    validationCommands: [],
    ...overrides,
  };
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

function editingAdapter() {
  let calls = 0;
  return {
    id: "fake-builder",
    async start(context) {
      calls += 1;
      let finish;
      let finished = false;
      const result = new Promise((resolve) => {
        finish = resolve;
      });
      context.onEvent({ type: "output", bytes: 10 });
      context.onEvent({ type: "task-directed" });
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

test("Token exhaustion blocks acceptance and further revision rounds", async () => {
  await withWorkspace(async ({ runtimeRoot, worktree }) => {
    const adapter = editingAdapter();
    const runtime = createBalancedRuntime({
      runtimeRoot,
      catalog: testCatalog({ maxTotalTokens: 10 }),
      adapters: adapterRegistry(adapter),
    });
    const result = await runtime.run({
      task: task(),
      worktree,
      adapterId: adapter.id,
      policyRef: "balanced-test@1.0.0",
    });
    assert.equal(result.review.roundStatus, "budget_exhausted");
    assert.deepEqual(result.review.allowedDecisions, ["stop"]);
    await assert.rejects(
      runtime.review({ runDirectory: result.runDirectory, decision: "accept" }),
      (error) => error instanceof BalancedRuntimeError && error.code === "review.decision_blocked",
    );
    const stopped = await runtime.review({ runDirectory: result.runDirectory, decision: "stop" });
    assert.equal(stopped.state, "stopped");
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
