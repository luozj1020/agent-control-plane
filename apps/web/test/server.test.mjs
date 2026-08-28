import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
    assert.match(html, /LOCAL RUNTIME ANALYTICS/);
    assert.match(html, /USAGE · ESTIMATED CONTEXT/);
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
    async collect(range) {
      requested.push(range);
      return {
        available: true,
        source: "codex-local-sessions",
        range,
        totals: { totalTokens: 42 },
        buckets: [],
        models: [],
      };
    },
  };
  await withServer(
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/usage?range=7d`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).totals.totalTokens, 42);
      assert.deepEqual(requested, ["7d"]);
    },
    { usageMonitor },
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
        assert.equal(body.status.active.variantId, "workflow-codex-overnight-claude-code");
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
