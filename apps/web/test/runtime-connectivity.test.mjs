import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  ConnectivityProbeError,
  probeDownstreamConnectivity,
} from "../runtime-connectivity.mjs";

function localProtocolAdapter(overrides = {}) {
  return {
    id: "local-protocol",
    displayName: "Local protocol fixture",
    command: process.execPath,
    requiresNetwork: false,
    providerEnvironmentPrefixes: [],
    buildConnectivityArgs() {
      return ["-e", [
        "console.log(JSON.stringify({type:'system',subtype:'init'}));",
        "console.log(JSON.stringify({type:'result',usage:{input_tokens:3,output_tokens:2}}));",
      ].join("")];
    },
    ...overrides,
  };
}

test("active connectivity probe returns metadata and usage without returning model content", async () => {
  const result = await probeDownstreamConnectivity({
    adapterId: "local-protocol",
    worktree: tmpdir(),
    timeoutSeconds: 5,
    runtimeEnvironment: {
      executionEnvironment: "host",
      proxyMode: "direct",
      isolationMode: "provider-scoped",
      networkDiagnostics: "metadata",
    },
  }, {
    adapters: [localProtocolAdapter()],
    environment: {
      PATH: process.env.PATH,
      HTTPS_PROXY: "http://user:secret@proxy.example:8080",
      UNRELATED_SECRET: "do-not-return",
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.attempted, true);
  assert.equal(result.consumedCall, true);
  assert.equal(result.streamInitialized, true);
  assert.equal(result.resultReceived, true);
  assert.equal(result.usageAvailable, true);
  assert.equal(result.usage.totalTokens, 5);
  assert.equal(result.activity.parsedEvents, 2);
  assert.equal(result.proxyMode, "direct");
  assert.doesNotMatch(JSON.stringify(result), /CONNECTION_OK|user:secret|do-not-return/);
});

test("restricted network sandbox returns a host handoff without launching the adapter", async () => {
  const result = await probeDownstreamConnectivity({
    adapterId: "local-protocol",
    worktree: tmpdir(),
    runtimeEnvironment: { executionEnvironment: "auto", proxyMode: "inherit" },
  }, {
    adapters: [localProtocolAdapter({ requiresNetwork: true })],
    environment: {
      PATH: process.env.PATH,
      CODEX_SANDBOX_NETWORK_DISABLED: "1",
      HTTPS_PROXY: "http://proxy.example:8080",
    },
    spawnProcess() {
      throw new Error("probe must not spawn in a restricted sandbox");
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.attempted, false);
  assert.equal(result.consumedCall, false);
  assert.equal(result.failureCategory, "sandbox-network-host-handoff");
  assert.equal(result.activity.stdoutBytes, 0);
});

test("a terminal error event is classified even when the CLI exits zero", async () => {
  const result = await probeDownstreamConnectivity({
    adapterId: "local-protocol",
    worktree: tmpdir(),
    timeoutSeconds: 5,
    runtimeEnvironment: { executionEnvironment: "host", proxyMode: "direct" },
  }, {
    adapters: [localProtocolAdapter({
      buildConnectivityArgs() {
        return ["-e", "console.log(JSON.stringify({type:'result',is_error:true,result:'Authentication failed'}))"];
      },
    })],
    environment: { PATH: process.env.PATH },
  });

  assert.equal(result.success, false);
  assert.equal(result.resultReceived, true);
  assert.equal(result.failureCategory, "authentication-failure");
  assert.doesNotMatch(JSON.stringify(result), /Authentication failed/);
});

test("active connectivity probe validates adapter protocol and timeout bounds", async () => {
  await assert.rejects(
    probeDownstreamConnectivity({
      adapterId: "unsupported",
      worktree: tmpdir(),
    }, {
      adapters: [{ id: "unsupported", command: process.execPath }],
    }),
    (error) => error instanceof ConnectivityProbeError && error.code === "connectivity.adapter_unsupported",
  );
  await assert.rejects(
    probeDownstreamConnectivity({
      adapterId: "local-protocol",
      worktree: tmpdir(),
      timeoutSeconds: 1,
    }, {
      adapters: [localProtocolAdapter()],
    }),
    (error) => error instanceof ConnectivityProbeError && error.code === "connectivity.timeout_invalid",
  );
});
