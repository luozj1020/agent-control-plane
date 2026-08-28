import assert from "node:assert/strict";
import test from "node:test";

import { diffSkillContent } from "../skill-diff.mjs";

test("describes the changes required to restore a snapshot", () => {
  const result = diffSkillContent("alpha\ncurrent\nomega\n", "alpha\nhistorical\nomega\n");
  assert.equal(result.available, true);
  assert.deepEqual(result.summary, { added: 1, removed: 1, unchanged: 2 });
  assert.deepEqual(
    result.lines.map((line) => [line.kind, line.text]),
    [
      ["same", "alpha"],
      ["add", "historical"],
      ["remove", "current"],
      ["same", "omega"],
    ],
  );
});

test("fails safely when a line matrix would be too large", () => {
  const content = Array.from({ length: 501 }, (_, index) => `line-${index}`).join("\n");
  const result = diffSkillContent(content, content);
  assert.equal(result.available, false);
  assert.equal(result.reason, "diff-too-large");
  assert.deepEqual(result.lines, []);
});
