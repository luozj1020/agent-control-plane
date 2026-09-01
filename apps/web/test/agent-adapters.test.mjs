import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createProcessAdapter } from "../agent-adapters.mjs";

test("process adapters stream activity, session identity, and deduplicated usage", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-control-adapter-"));
  try {
    const script = [
      "process.stdin.resume();",
      "process.stdin.on('end',()=>{",
      "console.log(JSON.stringify({type:'assistant',session_id:'session-test',message:{id:'message-1',content:[{type:'tool_use'}],usage:{input_tokens:10,output_tokens:5}}}));",
      "console.log(JSON.stringify({type:'result',session_id:'session-test',usage:{input_tokens:10,output_tokens:5}}));",
      "});",
    ].join("");
    const adapter = createProcessAdapter({
      id: "test-process",
      command: process.execPath,
      args: ["-e", script],
      requiresNetwork: false,
    });
    const events = [];
    const controller = await adapter.start({
      worktree: root,
      prompt: "test prompt",
      stdoutPath: join(root, "stdout.jsonl"),
      stderrPath: join(root, "stderr.log"),
      onEvent(event) {
        events.push(event);
      },
    });
    const result = await controller.result;
    assert.equal(result.exitCode, 0);
    assert.equal(result.sessionId, "session-test");
    assert.equal(result.usage.totalTokens, 15);
    assert.equal(result.failureCategory, null);
    assert.equal(result.diagnostics.activity.streamInitialized, false);
    assert.ok(result.diagnostics.activity.stdoutBytes > 0);
    assert(events.some((event) => event.type === "task-directed"));
    assert(events.some((event) => event.type === "completion-ready"));
    assert.match(await readFile(join(root, "stdout.jsonl"), "utf8"), /message-1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("network adapters fail closed with a host handoff inside a restricted sandbox", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-control-adapter-sandbox-"));
  try {
    const adapter = createProcessAdapter({
      id: "network-process",
      command: process.execPath,
      args: ["-e", "process.exit(99)"],
      requiresNetwork: true,
      providerEnvironmentPrefixes: ["TEST_PROVIDER_"],
    });
    const events = [];
    const controller = await adapter.start({
      worktree: root,
      prompt: "must not be dispatched",
      stdoutPath: join(root, "stdout.jsonl"),
      stderrPath: join(root, "stderr.log"),
      runtimeEnvironment: { executionEnvironment: "sandbox" },
      onEvent(event) {
        events.push(event);
      },
    });
    const result = await controller.result;
    assert.equal(controller.pid, null);
    assert.equal(result.exitCode, null);
    assert.equal(result.failureCategory, "sandbox-network-host-handoff");
    assert.equal(result.diagnostics.environment.hostHandoffRequired, true);
    assert(events.some((event) => event.type === "adapter-blocked"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("process adapters expose partial read coverage without inferring hidden reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-control-adapter-read-"));
  try {
    const script = [
      "process.stdin.resume();",
      "process.stdin.on('end',()=>{",
      "console.log(JSON.stringify({type:'assistant',message:{content:[",
      "{type:'tool_use',name:'Read',input:{file_path:'src/app.js'}},",
      "{type:'tool_use',name:'Bash',input:{command:'cat hidden.txt'}}",
      "]}}));",
      "});",
    ].join("");
    const adapter = createProcessAdapter({
      id: "read-aware-process",
      command: process.execPath,
      args: ["-e", script],
      requiresNetwork: false,
      readContainment: "partial-event-audit",
      writeContainment: "post-run-audit",
      filesystemEventSource: "test-explicit-read-v1",
      extractFilesystemEvents(record) {
        return (record.message?.content ?? []).flatMap((entry) =>
          entry.type === "tool_use" && entry.name === "Read"
            ? [{ operation: "read", path: entry.input.file_path, tool: entry.name }]
            : []);
      },
    });
    const events = [];
    const controller = await adapter.start({
      worktree: root,
      prompt: "test prompt",
      stdoutPath: join(root, "stdout.jsonl"),
      stderrPath: join(root, "stderr.log"),
      onEvent(event) { events.push(event); },
    });
    await controller.result;
    assert.equal(adapter.containment.read, "partial-event-audit");
    assert.deepEqual(events.filter((event) => event.type === "artifact-read"), [{
      type: "artifact-read",
      path: "src/app.js",
      tool: "Read",
      source: "test-explicit-read-v1",
      coverage: "partial-event-audit",
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
