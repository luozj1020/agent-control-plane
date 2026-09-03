export const RUN_CREATION_STATES = Object.freeze({
  created: "created",
  ready: "ready",
  running: "running",
  submissionLinkFailed: "submission_link_failed",
});

const VALID_STATES = new Set(Object.values(RUN_CREATION_STATES));

function timestamp(clock) {
  return new Date(clock()).toISOString();
}

export function createRunCreation(clock = Date.now, { linked = false } = {}) {
  const createdAt = timestamp(clock);
  return {
    schemaVersion: 1,
    state: linked ? RUN_CREATION_STATES.ready : RUN_CREATION_STATES.created,
    createdAt,
    readyAt: linked ? createdAt : null,
    runningAt: null,
    submissionLink: {
      attempts: 0,
      lastAttemptedAt: null,
      linkedAt: linked ? createdAt : null,
      failure: null,
    },
  };
}

function corruptRunCreation(ErrorType) {
  if (ErrorType) {
    return new ErrorType(
      "runtime.corrupt_run",
      "Run creation metadata is invalid.",
      409,
    );
  }
  return new TypeError("Run creation metadata is invalid.");
}

function validTimestamp(value, { nullable = false } = {}) {
  return (nullable && value === null) || (
    typeof value === "string" && Number.isFinite(Date.parse(value))
  );
}

export function normalizedRunCreation(metadata, ErrorType = null) {
  const value = metadata?.runCreation;
  if (value !== undefined) {
    const link = value?.submissionLink;
    const failure = link?.failure;
    const validFailure = failure === null || (
      failure && typeof failure === "object" &&
      typeof failure.code === "string" && failure.code.length > 0 &&
      failure.stage === "submission-link" &&
      typeof failure.retryable === "boolean" &&
      Number.isSafeInteger(failure.attemptCount) && failure.attemptCount >= 1 &&
      validTimestamp(failure.lastAttemptedAt) && validTimestamp(failure.recordedAt)
    );
    if (
      value?.schemaVersion !== 1 || !VALID_STATES.has(value.state) ||
      !validTimestamp(value.createdAt) || !validTimestamp(value.readyAt, { nullable: true }) ||
      !validTimestamp(value.runningAt, { nullable: true }) ||
      !link || typeof link !== "object" ||
      !Number.isSafeInteger(link.attempts) || link.attempts < 0 ||
      !validTimestamp(link.lastAttemptedAt, { nullable: true }) ||
      !validTimestamp(link.linkedAt, { nullable: true }) || !validFailure
    ) {
      throw corruptRunCreation(ErrorType);
    }
    return value;
  }
  // Runs created before the creation FSM already crossed this boundary. Treat
  // them as legacy-running without rewriting their immutable history.
  return {
    schemaVersion: 1,
    state: RUN_CREATION_STATES.running,
    createdAt: metadata?.createdAt ?? null,
    readyAt: metadata?.createdAt ?? null,
    runningAt: metadata?.createdAt ?? null,
    submissionLink: {
      attempts: 0,
      lastAttemptedAt: null,
      linkedAt: metadata?.createdAt ?? null,
      failure: null,
    },
    legacyInferred: true,
  };
}

export function beginSubmissionLink(metadata, clock = Date.now) {
  const current = normalizedRunCreation(metadata);
  if (current.state === RUN_CREATION_STATES.ready || current.state === RUN_CREATION_STATES.running) {
    metadata.runCreation = current;
    return { alreadyLinked: true, runCreation: current };
  }
  if (!new Set([RUN_CREATION_STATES.created, RUN_CREATION_STATES.submissionLinkFailed]).has(current.state)) {
    throw new Error(`Run creation state '${current.state}' cannot link submission metadata.`);
  }
  metadata.runCreation = {
    ...current,
    state: RUN_CREATION_STATES.created,
    submissionLink: {
      ...current.submissionLink,
      attempts: current.submissionLink.attempts + 1,
      lastAttemptedAt: timestamp(clock),
      failure: null,
    },
  };
  return { alreadyLinked: false, runCreation: metadata.runCreation };
}

export function completeSubmissionLink(metadata, clock = Date.now) {
  const current = normalizedRunCreation(metadata);
  if (current.state === RUN_CREATION_STATES.running) return current;
  const linkedAt = timestamp(clock);
  metadata.runCreation = {
    ...current,
    state: RUN_CREATION_STATES.ready,
    readyAt: current.readyAt ?? linkedAt,
    submissionLink: {
      ...current.submissionLink,
      linkedAt,
      failure: null,
    },
  };
  return metadata.runCreation;
}

export function failSubmissionLink(metadata, clock = Date.now, options = {}) {
  const current = normalizedRunCreation(metadata);
  const recordedAt = timestamp(clock);
  metadata.runCreation = {
    ...current,
    state: RUN_CREATION_STATES.submissionLinkFailed,
    submissionLink: {
      ...current.submissionLink,
      failure: {
        code: options.code ?? "task_store_write_failed",
        stage: "submission-link",
        retryable: options.retryable !== false,
        attemptCount: current.submissionLink.attempts,
        lastAttemptedAt: current.submissionLink.lastAttemptedAt,
        recordedAt,
      },
    },
  };
  return metadata.runCreation;
}

export function classifySubmissionLinkFailure(error) {
  if (error?.code === "runtime.submission_link_required") {
    return { code: "submission_link_handler_missing", retryable: false };
  }
  if (new Set([
    "preflight.not_found",
    "preflight.receipt_corrupt",
    "task.submission_reference_stale",
  ]).has(error?.code)) {
    return { code: "submission_reference_invalid", retryable: false };
  }
  return { code: "task_store_write_failed", retryable: true };
}

export function assertRunReady(metadata, ErrorType) {
  const current = normalizedRunCreation(metadata, ErrorType);
  if (!new Set([RUN_CREATION_STATES.ready, RUN_CREATION_STATES.running]).has(current.state)) {
    throw new ErrorType(
      "runtime.run_not_ready",
      `Run creation state '${current.state}' does not permit downstream execution.`,
      409,
      { runCreation: current },
    );
  }
  return current;
}

export function markRunRunning(metadata, clock = Date.now) {
  const current = normalizedRunCreation(metadata);
  if (current.state === RUN_CREATION_STATES.running) return current;
  if (current.state !== RUN_CREATION_STATES.ready) {
    throw new Error(`Run creation state '${current.state}' cannot enter running.`);
  }
  metadata.runCreation = {
    ...current,
    state: RUN_CREATION_STATES.running,
    runningAt: timestamp(clock),
  };
  return metadata.runCreation;
}
