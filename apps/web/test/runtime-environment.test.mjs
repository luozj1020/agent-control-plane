import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyDownstreamFailure,
  normalizeRuntimeEnvironment,
  resolveRuntimeEnvironment,
} from "../runtime-environment.mjs";

test("provider-scoped environment keeps provider auth but removes unrelated secrets and direct proxies", () => {
  const resolved = resolveRuntimeEnvironment({
    executionEnvironment: "auto",
    proxyMode: "direct",
    isolationMode: "provider-scoped",
    networkDiagnostics: "metadata",
  }, {
    environment: {
      PATH: "/bin",
      HOME: "/home/test",
      HTTPS_PROXY: "http://user:secret@proxy.example:8080",
      NO_PROXY: "localhost",
      ANTHROPIC_API_KEY: "provider-secret",
      UNRELATED_SECRET: "must-not-cross-boundary",
    },
    providerEnvironmentPrefixes: ["ANTHROPIC_"],
  });

  assert.equal(resolved.environment.ANTHROPIC_API_KEY, "provider-secret");
  assert.equal(resolved.environment.UNRELATED_SECRET, undefined);
  assert.equal(resolved.environment.HTTPS_PROXY, undefined);
  assert.equal(resolved.environment.NO_PROXY, undefined);
  assert.equal(resolved.evidence.authConfigured, true);
  assert.deepEqual(resolved.evidence.effectiveProxyVariables, []);
  assert.doesNotMatch(JSON.stringify(resolved.evidence), /provider-secret|user:secret/);
});

test("restricted sandbox requests a host handoff instead of declaring the provider unavailable", () => {
  const resolved = resolveRuntimeEnvironment({ proxyMode: "inherit" }, {
    environment: {
      PATH: "/bin",
      CODEX_SANDBOX_NETWORK_DISABLED: "1",
      HTTPS_PROXY: "http://proxy.example:8080",
    },
    providerEnvironmentPrefixes: ["ANTHROPIC_"],
    requiresNetwork: true,
  });
  assert.equal(resolved.evidence.executionEnvironmentResolved, "sandbox");
  assert.equal(resolved.evidence.hostHandoffRequired, true);
  assert.deepEqual(resolved.evidence.effectiveProxyVariables, ["HTTPS_PROXY"]);
  assert.equal(classifyDownstreamFailure({ environment: resolved.evidence }), "sandbox-network-host-handoff");
});

test("runtime environment rejects unknown fields and failure classification distinguishes transport causes", () => {
  assert.throws(
    () => normalizeRuntimeEnvironment({ rawProxyUrl: "http://secret" }),
    (error) => error.code === "runtime.environment_invalid",
  );
  assert.equal(classifyDownstreamFailure({ diagnosticText: "Could not resolve host" }), "dns-failure");
  assert.equal(classifyDownstreamFailure({ diagnosticText: "Proxy authentication required" }), "proxy-failure");
  assert.equal(classifyDownstreamFailure({ diagnosticText: "workspace is not trusted" }), "workspace-not-trusted");
  assert.equal(classifyDownstreamFailure({ exitCode: 0, activity: { stdoutBytes: 0 } }), "no-response");
});
