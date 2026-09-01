import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyObservedRead,
  extractClaudeFilesystemEvents,
  normalizeAdapterContainment,
  normalizeObservedArtifactPath,
} from "../adapter-containment.mjs";

test("adapter containment keeps read and write guarantees independent", () => {
  assert.deepEqual(normalizeAdapterContainment({ filesystemIsolation: "exact-write-paths" }), {
    read: "unsupported",
    write: "exact-paths",
    eventSource: null,
  });
  assert.throws(
    () => normalizeAdapterContainment({ readContainment: "partial-event-audit" }),
    /requires extractFilesystemEvents/,
  );
  const extractor = () => [];
  assert.deepEqual(normalizeAdapterContainment({
    readContainment: "partial-event-audit",
    writeContainment: "post-run-audit",
    filesystemEventSource: "test-source",
    extractFilesystemEvents: extractor,
  }), {
    read: "partial-event-audit",
    write: "post-run-audit",
    eventSource: "test-source",
  });
});

test("observed artifact paths are relative and outside-worktree reads remain visible", () => {
  assert.equal(normalizeObservedArtifactPath("src/app.js", "/workspace"), "src/app.js");
  assert.equal(normalizeObservedArtifactPath("/workspace/test/app.test.js", "/workspace"), "test/app.test.js");
  assert.equal(normalizeObservedArtifactPath("../secret.txt", "/workspace"), "@outside-worktree");
  assert.equal(normalizeObservedArtifactPath("/etc/passwd", "/workspace"), "@outside-worktree");
  assert.equal(normalizeObservedArtifactPath("", "/workspace"), null);
});

test("Claude extraction audits only explicit Read tool events", () => {
  const events = extractClaudeFilesystemEvents({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", name: "Read", input: { file_path: "src/app.js" } },
        { type: "tool_use", name: "Bash", input: { command: "sed -n 1p hidden.txt" } },
        { type: "text", text: "Read another.txt" },
      ],
    },
  });
  assert.deepEqual(events, [{ operation: "read", path: "src/app.js", tool: "Read" }]);
});

test("read classification gives forbidden paths priority over allowed scope", () => {
  const task = {
    scope: {
      write_paths: ["src/**"],
      read_paths: ["docs/**", "src/generated/**"],
      forbidden_paths: ["src/generated/secrets/**"],
    },
  };
  assert.equal(classifyObservedRead(task, "src/app.js"), "allowed");
  assert.equal(classifyObservedRead(task, "docs/spec.md"), "allowed");
  assert.equal(classifyObservedRead(task, "src/generated/secrets/key.txt"), "forbidden");
  assert.equal(classifyObservedRead(task, "package.json"), "out-of-scope");
  assert.equal(classifyObservedRead(task, "@outside-worktree"), "out-of-scope");
});
