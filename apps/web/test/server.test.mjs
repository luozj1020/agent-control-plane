import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CODEX_OVERNIGHT_CLAUDE_PROFILE } from "../../../packages/contracts/dist/index.js";
import { createAppServer } from "../server.mjs";

async function withServer(run, options = {}) {
  const server = createAppServer(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("serves the application and health endpoint", async () => {
  await withServer(async (baseUrl) => {
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      status: "ok",
      product: "agent-workflow-switch",
    });

    const page = await fetch(baseUrl);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Agent Workflow Switch/);
    assert.match(html, /Token 运行时用量/);
    assert.match(html, /RUNTIME ANALYTICS/);
    assert.match(html, /id="nav-usage"/);
    assert.match(html, /class="usage-view" id="usage-view" hidden/);
    assert.match(html, /模型调用数/);
    assert.match(html, /id="calls-chart"/);
    assert.match(html, /id="runtime-upstream-tokens"/);
    assert.match(html, /id="runtime-downstream-tokens"/);
    assert.match(html, /id="token-dimension"/);
    assert.match(html, /按上下游/);
    assert.match(html, /id="runtime-lane-filter"/);
    assert.match(html, /id="runtime-model-filter"/);
    assert.match(html, /按模型计算消耗/);
    assert.match(html, /id="balanced-config"/);
    assert.match(html, /Balanced 运行控制/);
    assert.match(html, /id="balanced-first-progress-window"/);
    assert.doesNotMatch(html, /总 Token 上限/);
    assert.match(html, /USAGE · ESTIMATED CONTEXT/);
    assert.match(html, /ACTIVATION AUDIT LOG/);
    assert.match(html, /激活记录/);
    assert.match(html, /mode-switch-policy/);
    assert.match(html, /id="skill-preview"/);
    assert.match(html, /id="restore-skill-default"/);
    assert.match(html, /id="interactive-config"/);
    assert.match(html, /Interactive Subagents/);
    assert.match(html, /id="interactive-add-role"/);
    assert.match(html, /id="interactive-reset-roles"/);
    assert.match(html, /developer_instructions/);
    assert.doesNotMatch(html, /<pre id="skill-preview"/);

    const coordinator = await fetch(`${baseUrl}/mode-switch-coordinator.js`);
    assert.equal(coordinator.status, 200);
    assert.match(await coordinator.text(), /createLatestSwitchCoordinator/);
  });
});

test("returns structured usage range errors", async () => {
  const usageMonitor = {
    async collect() {
      const error = new Error("Unsupported usage range 'forever'.");
      error.code = "usage.invalid_range";
      error.status = 400;
      throw error;
    },
  };
  await withServer(
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/usage?range=forever`);
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        error: "usage.invalid_range",
        message: "Unsupported usage range 'forever'.",
      });
    },
    { usageMonitor },
  );
});

test("serves sanitized runtime usage for the requested range", async () => {
  const requested = [];
  const usageMonitor = {
    async collect(range, filters) {
      requested.push([range, filters]);
      return {
        available: true,
        source: "codex-local-sessions",
        range,
        totals: { totalTokens: 42 },
        buckets: [],
        models: [],
        callCoverage: {
          upstream: { status: "active" },
          downstream: { status: "not-connected" },
        },
      };
    },
  };
  await withServer(
    async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/usage?range=7d&lane=downstream&model=claude-test`,
      );
      assert.equal(response.status, 200);
      assert.equal((await response.json()).totals.totalTokens, 42);
      assert.deepEqual(requested, [
        ["7d", { lane: "downstream", model: "claude-test" }],
      ]);
    },
    { usageMonitor },
  );
});

test("serves Balanced policy and persisted run status", async () => {
  const balancedRuntime = {
    async listRuns() {
      return [
        {
          runId: "run-test",
          taskId: "task-test",
          state: "review_pending",
          rounds: 1,
          budgetState: { used: { downstream: 1 }, totalTokens: 42 },
        },
      ];
    },
  };
  await withServer(
    async (baseUrl) => {
      const config = await fetch(`${baseUrl}/api/balanced/config`);
      assert.equal(config.status, 200);
      const configBody = await config.json();
      assert.equal(configBody.policy.id, "balanced-default");
      assert.equal(configBody.policy.contextAcquisitionSeconds, 600);
      assert.equal(configBody.budget.downstreamCalls, 3);
      assert.equal("maxTotalTokens" in configBody.budget, false);
      assert.deepEqual(configBody.budgetLimits.mainReviewCalls, { min: 1, max: 99 });
      assert.deepEqual(configBody.timingLimits.activeWindowSeconds, { min: 30, max: 3600 });
      assert.deepEqual(configBody.adapters, [{ id: "claude-code", displayName: "Claude Code" }]);

      const runs = await fetch(`${baseUrl}/api/balanced/runs`);
      assert.equal(runs.status, 200);
      assert.equal((await runs.json()).runs[0].state, "review_pending");
    },
    { balancedRuntime },
  );
});

test("activation API is disabled unless an absolute Skill directory is configured", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: CODEX_OVERNIGHT_CLAUDE_PROFILE }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, "store.preview_only");
  });
});

test("activation API resolves the profile on the server and writes only the managed directory", async () => {
  const skillsDir = await mkdtemp(join(tmpdir(), "agent-workflow-api-"));
  try {
    await withServer(
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/activate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ profile: CODEX_OVERNIGHT_CLAUDE_PROFILE }),
        });
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.changed, true);
        assert.equal(body.activationKind, "activate");
        assert.equal(body.status.active.variantId, "workflow-codex-overnight-claude-code");
        assert.equal(body.status.active.mode.id, "overnight");
        assert.match(
          await readFile(join(skillsDir, "agent-workflow-active", "SKILL.md"), "utf8"),
          /# Overnight/,
        );

        const status = await fetch(`${baseUrl}/api/status`);
        assert.equal((await status.json()).writeEnabled, true);
      },
      { skillsDir },
    );
  } finally {
    await rm(skillsDir, { recursive: true, force: true });
  }
});

test("activation API validates and writes edited Skill content with server-derived metadata", async () => {
  const skillsDir = await mkdtemp(join(tmpdir(), "agent-workflow-api-edited-skill-"));
  const content = [
    "---",
    "name: workflow-codex-overnight-claude-code",
    "description: Customized overnight workflow.",
    "---",
    "",
    "# Customized Overnight",
    "",
    "Keep this user-authored instruction.",
    "",
  ].join("\n");
  try {
    await withServer(
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/activate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ profile: CODEX_OVERNIGHT_CLAUDE_PROFILE, content }),
        });
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.status.active.content, content);
        assert.equal(
          await readFile(join(skillsDir, "agent-workflow-active", "SKILL.md"), "utf8"),
          content,
        );
        assert.notEqual(body.status.active.contentFingerprint, "fnv1a32:00000000");

        const rejected = await fetch(`${baseUrl}/api/activate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            profile: CODEX_OVERNIGHT_CLAUDE_PROFILE,
            content: content.replace(
              "name: workflow-codex-overnight-claude-code",
              "name: forged-skill-name",
            ),
          }),
        });
        assert.equal(rejected.status, 422);
        assert.equal((await rejected.json()).error, "skill.invalid");
        assert.equal(
          await readFile(join(skillsDir, "agent-workflow-active", "SKILL.md"), "utf8"),
          content,
        );
      },
      { skillsDir },
    );
  } finally {
    await rm(skillsDir, { recursive: true, force: true });
  }
});

test("Interactive activation installs global subagents and requires explicit overwrite for conflicts", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "agent-workflow-api-interactive-"));
  const skillsDir = join(codexHome, "skills");
  const agentsDir = join(codexHome, "agents");
  const profile = {
    ...CODEX_OVERNIGHT_CLAUDE_PROFILE,
    id: "codex-interactive-native",
    mode: { id: "interactive", version: "1.0.0" },
    roleBindings: [{ role: "subagent", target: { kind: "main-native" } }],
  };
  try {
    await mkdir(skillsDir);
    await mkdir(agentsDir);
    await writeFile(join(agentsDir, "worker.toml"), "existing worker\n", "utf8");
    await withServer(
      async (baseUrl) => {
        const status = await (await fetch(`${baseUrl}/api/interactive-agents`)).json();
        assert.equal(status.health, "conflict");
        assert.deepEqual(status.conflicts, ["worker"]);

        const blocked = await fetch(`${baseUrl}/api/activate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ profile }),
        });
        assert.equal(blocked.status, 409);
        assert.equal((await blocked.json()).error, "agents.overwrite_required");
        await assert.rejects(readFile(join(skillsDir, "agent-workflow-active", "SKILL.md")));

        const activated = await fetch(`${baseUrl}/api/activate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ profile, allowAgentOverwrite: true }),
        });
        assert.equal(activated.status, 200);
        const body = await activated.json();
        assert.equal(body.status.active.mode.id, "interactive");
        assert.equal(body.interactiveAgentInstall.status.health, "installed");
        assert.match(await readFile(join(agentsDir, "worker.toml"), "utf8"), /gpt-5\.3-codex-spark/);
        assert.match(await readFile(join(agentsDir, "reviewer.toml"), "utf8"), /gpt-5\.6-terra/);
        assert.match(await readFile(join(codexHome, "config.toml"), "utf8"), /max_concurrent_threads_per_session = 6/);
      },
      { skillsDir, codexHome },
    );
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("Interactive planning and activation accept an editable custom role set", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "agent-workflow-api-custom-roles-"));
  const skillsDir = join(codexHome, "skills");
  const profile = {
    ...CODEX_OVERNIGHT_CLAUDE_PROFILE,
    id: "codex-interactive-custom",
    mode: { id: "interactive", version: "1.0.0" },
    roleBindings: [{ role: "subagent", target: { kind: "main-native" } }],
  };
  try {
    await mkdir(skillsDir);
    await withServer(
      async (baseUrl) => {
        const current = await (await fetch(`${baseUrl}/api/interactive-agents`)).json();
        const configuration = current.preset;
        configuration.agents = [{
          name: "docs_researcher",
          description: "Read-only documentation specialist.",
          model: "gpt-5.6-luna",
          reasoningEffort: "medium",
          sandboxMode: "read-only",
          developerInstructions: "# Documentation\n\nVerify APIs and return exact references.",
        }];
        const planned = await fetch(`${baseUrl}/api/interactive-agents/plan`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ configuration }),
        });
        assert.equal(planned.status, 200);
        assert.deepEqual((await planned.json()).agents, [{ name: "docs_researcher", status: "missing" }]);

        const activated = await fetch(`${baseUrl}/api/activate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ profile, interactiveAgents: configuration }),
        });
        assert.equal(activated.status, 200);
        const body = await activated.json();
        assert.deepEqual(body.interactiveAgentInstall.status.configuration.agents.map((agent) => agent.name), ["docs_researcher"]);
        assert.match(await readFile(join(codexHome, "agents", "docs_researcher.toml"), "utf8"), /gpt-5\.6-luna/);
        await assert.rejects(readFile(join(codexHome, "agents", "worker.toml")));
        const skill = await readFile(join(skillsDir, "agent-workflow-active", "SKILL.md"), "utf8");
        assert.match(skill, /do not assume a fixed role list/);
      },
      { skillsDir, codexHome },
    );
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("Interactive agent installation rolls back when Skill activation fails", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "agent-workflow-api-interactive-rollback-"));
  const skillsDir = join(codexHome, "skills");
  const profile = {
    ...CODEX_OVERNIGHT_CLAUDE_PROFILE,
    id: "codex-interactive-rollback",
    mode: { id: "interactive", version: "1.0.0" },
    roleBindings: [{ role: "subagent", target: { kind: "main-native" } }],
  };
  try {
    await mkdir(skillsDir);
    await withServer(
      async (baseUrl) => {
        const first = await fetch(`${baseUrl}/api/activate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ profile: CODEX_OVERNIGHT_CLAUDE_PROFILE }),
        });
        assert.equal(first.status, 200);
        await writeFile(
          join(skillsDir, ".agent-workflow-switch", "activation.lock"),
          "occupied",
          "utf8",
        );
        const blocked = await fetch(`${baseUrl}/api/activate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ profile }),
        });
        assert.equal(blocked.status, 409);
        assert.equal((await blocked.json()).error, "store.locked");
        await assert.rejects(readFile(join(codexHome, "config.toml")));
        await assert.rejects(readFile(join(codexHome, "agents", "worker.toml")));
      },
      { skillsDir, codexHome },
    );
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("failed mode overwrite preserves the currently active Skill", async () => {
  const skillsDir = await mkdtemp(join(tmpdir(), "agent-workflow-api-switch-failure-"));
  try {
    await withServer(
      async (baseUrl) => {
        const activate = (profile) =>
          fetch(`${baseUrl}/api/activate`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ profile }),
          });
        assert.equal((await activate(CODEX_OVERNIGHT_CLAUDE_PROFILE)).status, 200);
        await writeFile(
          join(skillsDir, ".agent-workflow-switch", "activation.lock"),
          "occupied",
          "utf8",
        );
        const balanced = {
          ...CODEX_OVERNIGHT_CLAUDE_PROFILE,
          id: "codex-balanced-blocked",
          mode: { id: "balanced", version: "1.0.0" },
        };
        const blocked = await activate(balanced);
        assert.equal(blocked.status, 409);
        assert.equal((await blocked.json()).error, "store.locked");
        const status = await (await fetch(`${baseUrl}/api/status`)).json();
        assert.equal(status.active.mode.id, "overnight");
      },
      { skillsDir },
    );
  } finally {
    await rm(skillsDir, { recursive: true, force: true });
  }
});

test("rollback API restores a server-generated backup", async () => {
  const skillsDir = await mkdtemp(join(tmpdir(), "agent-workflow-api-rollback-"));
  try {
    await withServer(
      async (baseUrl) => {
        const activate = (profile) =>
          fetch(`${baseUrl}/api/activate`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ profile }),
          });
        const first = await activate(CODEX_OVERNIGHT_CLAUDE_PROFILE);
        assert.equal(first.status, 200);

        const balanced = {
          ...CODEX_OVERNIGHT_CLAUDE_PROFILE,
          id: "codex-balanced-claude",
          mode: { id: "balanced", version: "1.0.0" },
        };
        const second = await activate(balanced);
        assert.equal(second.status, 200);
        const switched = await second.json();
        assert.equal(switched.activationKind, "overwrite");
        assert.equal(switched.status.active.variantId, "workflow-codex-balanced-claude-code");
        assert.equal(switched.status.backups.length, 1);

        const rollback = await fetch(`${baseUrl}/api/rollback`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ backupId: switched.status.backups[0].backupId }),
        });
        assert.equal(rollback.status, 200);
        assert.equal(
          (await rollback.json()).status.active.variantId,
          "workflow-codex-overnight-claude-code",
        );
      },
      { skillsDir },
    );
  } finally {
    await rm(skillsDir, { recursive: true, force: true });
  }
});

test("history API exposes diffs and restores a selected immutable snapshot", async () => {
  const skillsDir = await mkdtemp(join(tmpdir(), "agent-workflow-api-history-"));
  try {
    await withServer(
      async (baseUrl) => {
        const activate = (profile) =>
          fetch(`${baseUrl}/api/activate`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ profile }),
          });
        assert.equal((await activate(CODEX_OVERNIGHT_CLAUDE_PROFILE)).status, 200);
        const balanced = {
          ...CODEX_OVERNIGHT_CLAUDE_PROFILE,
          id: "codex-balanced-history",
          mode: { id: "balanced", version: "1.0.0" },
        };
        assert.equal((await activate(balanced)).status, 200);

        const historyResponse = await fetch(`${baseUrl}/api/history`);
        assert.equal(historyResponse.status, 200);
        const history = await historyResponse.json();
        assert.equal(history.entries.length, 2);
        const overnight = history.entries.find((entry) => entry.mode.id === "overnight");
        assert(overnight);

        const detailResponse = await fetch(
          `${baseUrl}/api/history/${encodeURIComponent(overnight.historyId)}`,
        );
        assert.equal(detailResponse.status, 200);
        const detail = await detailResponse.json();
        assert.equal(detail.diff.direction, "current-to-snapshot");
        assert(detail.diff.summary.added > 0);
        assert(detail.fieldChanges.some((change) => change.field === "mode"));

        const restore = await fetch(
          `${baseUrl}/api/history/${encodeURIComponent(overnight.historyId)}/restore`,
          { method: "POST" },
        );
        assert.equal(restore.status, 200);
        assert.equal((await restore.json()).status.active.variantId, overnight.variantId);
        assert.equal((await (await fetch(`${baseUrl}/api/history`)).json()).entries.length, 3);
      },
      { skillsDir },
    );
  } finally {
    await rm(skillsDir, { recursive: true, force: true });
  }
});

test("history restore rejects cross-origin requests", async () => {
  const store = {
    status: async () => ({ writeEnabled: true }),
    history: async () => ({ available: true, entries: [] }),
    restoreHistory: async () => {
      throw new Error("must not be called");
    },
  };
  await withServer(
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/history/snapshot/restore`, {
        method: "POST",
        headers: { origin: "https://malicious.example" },
      });
      assert.equal(response.status, 403);
    },
    { store },
  );
});

test("mutation API rejects cross-origin requests", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/activate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://malicious.example",
      },
      body: JSON.stringify({ profile: CODEX_OVERNIGHT_CLAUDE_PROFILE }),
    });
    assert.equal(response.status, 403);
  });
});

test("mutation API rejects DNS-rebinding style host and origin pairs", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/activate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "malicious.example",
        origin: "http://malicious.example",
      },
      body: JSON.stringify({ profile: CODEX_OVERNIGHT_CLAUDE_PROFILE }),
    });
    assert.equal(response.status, 403);
  });
});

test("serves the browser-compatible contracts build", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/contracts/index.js`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /resolveEffectiveSkill/);
  });
});

test("fails closed for traversal and unsupported methods", async () => {
  await withServer(async (baseUrl) => {
    const traversal = await fetch(`${baseUrl}/contracts/%2e%2e/package.json`);
    assert.notEqual(traversal.status, 200);

    const post = await fetch(`${baseUrl}/api/health`, { method: "POST" });
    assert.equal(post.status, 405);
  });
});
