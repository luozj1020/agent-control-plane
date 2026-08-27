import assert from "node:assert/strict";
import test from "node:test";

import { createAppServer } from "../server.mjs";

async function withServer(run) {
  const server = createAppServer();
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
    assert.match(await page.text(), /Agent Workflow Switch/);
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
