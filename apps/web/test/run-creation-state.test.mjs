import assert from "node:assert/strict";
import test from "node:test";

import {
  assertRunReady,
  beginSubmissionLink,
  classifySubmissionLinkFailure,
  completeSubmissionLink,
  createRunCreation,
  failSubmissionLink,
  markRunRunning,
  normalizedRunCreation,
} from "../run-creation-state.mjs";

class TestError extends Error {
  constructor(code, message, status, details) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

test("Run Creation state gates downstream until submission linking is ready", () => {
  let now = Date.parse("2026-09-03T00:00:00.000Z");
  const clock = () => now;
  const metadata = { createdAt: new Date(now).toISOString(), runCreation: createRunCreation(clock) };

  assert.throws(
    () => assertRunReady(metadata, TestError),
    (error) => error.code === "runtime.run_not_ready" && error.details.runCreation.state === "created",
  );

  beginSubmissionLink(metadata, clock);
  assert.equal(metadata.runCreation.submissionLink.attempts, 1);
  now += 1000;
  failSubmissionLink(metadata, clock);
  assert.equal(metadata.runCreation.state, "submission_link_failed");
  assert.equal(metadata.runCreation.submissionLink.failure.stage, "submission-link");
  assert.equal(metadata.runCreation.submissionLink.failure.attemptCount, 1);

  now += 1000;
  beginSubmissionLink(metadata, clock);
  assert.equal(metadata.runCreation.submissionLink.attempts, 2);
  completeSubmissionLink(metadata, clock);
  assert.equal(assertRunReady(metadata, TestError).state, "ready");

  now += 1000;
  markRunRunning(metadata, clock);
  assert.equal(metadata.runCreation.state, "running");
  assert.equal(beginSubmissionLink(metadata, clock).alreadyLinked, true);
});

test("legacy runs are inferred as already running without rewriting their evidence", () => {
  const legacy = normalizedRunCreation({ createdAt: "2026-09-02T00:00:00.000Z" });
  assert.equal(legacy.state, "running");
  assert.equal(legacy.legacyInferred, true);
});

test("present but malformed creation metadata fails closed instead of becoming legacy-running", () => {
  assert.throws(
    () => normalizedRunCreation({
      createdAt: "2026-09-02T00:00:00.000Z",
      runCreation: { schemaVersion: 1, state: "unknown" },
    }, TestError),
    (error) => error.code === "runtime.corrupt_run",
  );
});

test("submission failure classification exposes retryability without exception text", () => {
  assert.deepEqual(classifySubmissionLinkFailure({ code: "EIO", message: "secret path" }), {
    code: "task_store_write_failed",
    retryable: true,
  });
  assert.deepEqual(classifySubmissionLinkFailure({ code: "preflight.not_found" }), {
    code: "submission_reference_invalid",
    retryable: false,
  });
});
