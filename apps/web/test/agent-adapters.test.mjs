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
    assert(events.some((event) => event.type === "task-directed"));
    assert(events.some((event) => event.type === "completion-ready"));
    assert.match(await readFile(join(root, "stdout.jsonl"), "utf8"), /message-1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
