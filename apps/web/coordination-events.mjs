import { randomUUID } from "node:crypto";
import { appendFile, lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

export const COORDINATION_EVENT_FILE = "coordination-events.jsonl";
const DEFAULT_MAXIMUM_EVENT_BYTES = 16 * 1024 * 1024;

const EVENT_KINDS = new Set([
  "run_created",
  "agent_invoke_started",
  "agent_invoke_completed",
  "artifact_write",
  "artifact_read",
  "state_transition",
  "review_decision",
  "validation_completed",
  "wake_requested",
  "wake_delivered",
  "interrupt_requested",
]);

const MEASUREMENT_SOURCES = new Set([
  "runtime",
  "filesystem_snapshot",
  "provider_reported",
  "derived",
  "agent_claimed",
]);
const MEASUREMENT_CONFIDENCE = new Set(["observed", "reported", "derived", "unknown"]);
const ENDPOINT_TYPES = new Set([
  "control_plane", "agent", "artifact", "state", "operator", "validator", "transport",
]);
const SAFE_DETAIL_STRINGS = new Set([
  "state", "to", "status", "decision", "classification", "coverage", "tool", "artifactKind",
]);
const SAFE_DETAIL_INTEGERS = new Set(["round", "cycle", "exitCode"]);
const SAFE_DETAIL_BOOLEANS = new Set(["resumed", "interrupted", "timedOut"]);
const SAFE_METADATA_ID = /^[A-Za-z0-9@][A-Za-z0-9@._/:-]{0,239}$/;

export class CoordinationEventError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = "CoordinationEventError";
    this.code = code;
    this.status = status;
  }
}

function nonEmpty(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalInteger(value, label) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer.`);
  }
  return value;
}

export function createCoordinationEvent(input, options = {}) {
  const kind = nonEmpty(input?.kind, "kind");
  if (!EVENT_KINDS.has(kind)) throw new TypeError(`Unknown coordination event kind '${kind}'.`);
  const measurementSource = input.measurementSource ?? "runtime";
  if (!MEASUREMENT_SOURCES.has(measurementSource)) {
    throw new TypeError(`Unknown measurement source '${measurementSource}'.`);
  }
  const now = options.clock?.() ?? Date.now();
  const event = {
    schemaVersion: 1,
    eventId: options.randomUUID?.() ?? randomUUID(),
    recordedAt: new Date(now).toISOString(),
    runId: nonEmpty(input.runId, "runId"),
    mode: nonEmpty(input.mode, "mode"),
    kind,
    actor: {
      type: nonEmpty(input.actor?.type, "actor.type"),
      id: nonEmpty(input.actor?.id, "actor.id"),
    },
    measurement: {
      source: measurementSource,
      confidence: input.confidence ?? (measurementSource === "runtime" ? "observed" : "reported"),
    },
  };
  if (input.target) {
    event.target = {
      type: nonEmpty(input.target.type, "target.type"),
      id: nonEmpty(input.target.id, "target.id"),
    };
  }
  if (input.causationId) event.causationId = nonEmpty(input.causationId, "causationId");
  if (input.correlationId) event.correlationId = nonEmpty(input.correlationId, "correlationId");
  const tokens = optionalInteger(input.tokens, "tokens");
  const bytes = optionalInteger(input.bytes, "bytes");
  const elapsedMilliseconds = optionalInteger(input.elapsedMilliseconds, "elapsedMilliseconds");
  if (tokens !== undefined) event.measurement.tokens = tokens;
  if (bytes !== undefined) event.measurement.bytes = bytes;
  if (elapsedMilliseconds !== undefined) event.measurement.elapsedMilliseconds = elapsedMilliseconds;
  if (input.detail && Object.keys(input.detail).length > 0) event.detail = input.detail;
  return event;
}

export async function appendCoordinationEvent(runDirectory, input, options = {}) {
  const event = createCoordinationEvent(input, options);
  const path = join(runDirectory, COORDINATION_EVENT_FILE);
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new CoordinationEventError(
        "coordination.unsafe_event_file",
        "Coordination event storage must be a regular file.",
      );
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await appendFile(
    path,
    `${JSON.stringify(event)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return event;
}

export async function readCoordinationEvents(runDirectory, options = {}) {
  const path = join(runDirectory, COORDINATION_EVENT_FILE);
  const maximumBytes = Math.max(1, options.maximumBytes ?? DEFAULT_MAXIMUM_EVENT_BYTES);
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return { events: [], invalidLines: 0 };
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new CoordinationEventError(
      "coordination.unsafe_event_file",
      "Coordination event storage must be a regular file.",
    );
  }
  if (metadata.size > maximumBytes) {
    throw new CoordinationEventError(
      "coordination.event_file_too_large",
      `Coordination event storage exceeds ${maximumBytes} bytes.`,
      413,
    );
  }
  const content = await readFile(path, "utf8");
  const events = [];
  let invalidLines = 0;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      invalidLines += 1;
    }
  }
  return { events, invalidLines };
}

function projectEndpoint(value) {
  if (!ENDPOINT_TYPES.has(value?.type) || !SAFE_METADATA_ID.test(value?.id ?? "")) return null;
  return { type: value.type, id: value.id };
}

function projectEventDetail(detail) {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return undefined;
  const result = {};
  for (const [key, value] of Object.entries(detail)) {
    if (SAFE_DETAIL_STRINGS.has(key) && typeof value === "string" && SAFE_METADATA_ID.test(value)) {
      result[key] = value;
    } else if (
      SAFE_DETAIL_INTEGERS.has(key) && Number.isSafeInteger(value) &&
      (key === "exitCode" || value >= 0)
    ) {
      result[key] = value;
    } else if (SAFE_DETAIL_BOOLEANS.has(key) && typeof value === "boolean") {
      result[key] = value;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function projectCoordinationEvent(event, expected, sequence) {
  if (
    !event || event.schemaVersion !== 1 || !EVENT_KINDS.has(event.kind) ||
    event.runId !== expected.runId || event.mode !== expected.mode ||
    !SAFE_METADATA_ID.test(event.eventId ?? "") ||
    !Number.isFinite(Date.parse(event.recordedAt ?? ""))
  ) return null;
  const actor = projectEndpoint(event.actor);
  const target = event.target === undefined ? undefined : projectEndpoint(event.target);
  if (!actor || (event.target !== undefined && !target)) return null;
  const source = event.measurement?.source;
  const confidence = event.measurement?.confidence;
  if (!MEASUREMENT_SOURCES.has(source) || !MEASUREMENT_CONFIDENCE.has(confidence)) return null;
  const measurement = { source, confidence };
  for (const key of ["tokens", "bytes", "elapsedMilliseconds"]) {
    if (Number.isSafeInteger(event.measurement?.[key]) && event.measurement[key] >= 0) {
      measurement[key] = event.measurement[key];
    }
  }
  const projected = {
    sequence,
    eventId: event.eventId,
    recordedAt: event.recordedAt,
    kind: event.kind,
    actor,
    measurement,
  };
  if (target) projected.target = target;
  if (typeof event.correlationId === "string" && SAFE_METADATA_ID.test(event.correlationId)) {
    projected.correlationId = event.correlationId;
  }
  const detail = projectEventDetail(event.detail);
  if (detail) projected.detail = detail;
  return projected;
}

function projectEvents(events, metadata) {
  const expected = {
    runId: metadata.runId ?? events[0]?.runId,
    mode: metadata.mode ?? events[0]?.mode,
  };
  const projected = [];
  let rejectedEvents = 0;
  for (let index = 0; index < events.length; index += 1) {
    const event = projectCoordinationEvent(events[index], expected, index + 1);
    if (event) projected.push(event);
    else rejectedEvents += 1;
  }
  return { projected, rejectedEvents };
}

function graphForEvents(events) {
  const nodes = new Map();
  const edges = [];
  const addNode = (endpoint) => {
    const key = `${endpoint.type}:${endpoint.id}`;
    if (!nodes.has(key)) nodes.set(key, { id: key, type: endpoint.type, label: endpoint.id });
    return key;
  };
  for (const event of events) {
    const source = addNode(event.actor);
    if (!event.target) continue;
    const target = addNode(event.target);
    edges.push({
      id: event.eventId,
      sequence: event.sequence,
      recordedAt: event.recordedAt,
      kind: event.kind,
      source,
      target,
    });
  }
  return { scope: "returned-events", nodes: [...nodes.values()], edges };
}

export async function coordinationDetailForRun(runDirectory, metadata = {}, options = {}) {
  const { events, invalidLines } = await readCoordinationEvents(runDirectory);
  const { projected, rejectedEvents } = projectEvents(events, metadata);
  const maximumEvents = Math.min(500, Math.max(1, options.maximumEvents ?? 200));
  const offset = Math.max(0, projected.length - maximumEvents);
  const selected = projected.slice(offset);
  return {
    schemaVersion: 1,
    runId: metadata.runId ?? projected[0]?.runId ?? null,
    mode: metadata.mode ?? null,
    summary: summarizeCoordinationEvents(projected, metadata, invalidLines + rejectedEvents),
    timeline: {
      totalEvents: projected.length,
      returnedEvents: selected.length,
      offset,
      truncated: offset > 0,
      invalidLines,
      rejectedEvents,
      events: selected,
    },
    graph: graphForEvents(selected),
  };
}

export function summarizeCoordinationEvents(events, metadata = {}, invalidLines = 0) {
  const counts = Object.fromEntries([...EVENT_KINDS].map((kind) => [kind, 0]));
  const actors = new Set();
  const targets = new Set();
  const nodes = new Set();
  const relationships = new Set();
  const sources = new Set();
  let observedTokens = 0;
  for (const event of events) {
    if (counts[event.kind] !== undefined) counts[event.kind] += 1;
    const actor = event.actor?.type && event.actor?.id ? `${event.actor.type}:${event.actor.id}` : null;
    const target = event.target?.type && event.target?.id ? `${event.target.type}:${event.target.id}` : null;
    if (actor) {
      actors.add(actor);
      nodes.add(actor);
    }
    if (target) {
      targets.add(target);
      nodes.add(target);
    }
    if (actor && target) relationships.add(`${event.kind}:${actor}->${target}`);
    if (event.measurement?.source) sources.add(event.measurement.source);
    if (Number.isSafeInteger(event.measurement?.tokens)) observedTokens += event.measurement.tokens;
  }
  const hasReadInstrumentation = events.some((event) => event.kind === "artifact_read");
  const readEvents = events.filter((event) => event.kind === "artifact_read");
  const readClassifications = { allowed: 0, outOfScope: 0, forbidden: 0, unknown: 0 };
  const readArtifacts = new Set();
  const artifactReaders = new Map();
  for (const event of readEvents) {
    const classification = event.detail?.classification;
    if (classification === "allowed") readClassifications.allowed += 1;
    else if (classification === "out-of-scope") readClassifications.outOfScope += 1;
    else if (classification === "forbidden") readClassifications.forbidden += 1;
    else readClassifications.unknown += 1;
    if (event.target?.type !== "artifact" || !event.target.id) continue;
    readArtifacts.add(event.target.id);
    if (!artifactReaders.has(event.target.id)) artifactReaders.set(event.target.id, new Set());
    if (event.actor?.type && event.actor?.id) {
      artifactReaders.get(event.target.id).add(`${event.actor.type}:${event.actor.id}`);
    }
  }
  const readViolations = readEvents.filter(
    (event) => event.detail?.classification && event.detail.classification !== "allowed",
  ).length;
  const readContainment = metadata.containment?.read ?? "unsupported";
  const writeContainment = metadata.containment?.write ?? "unsupported";
  return {
    schemaVersion: 1,
    runId: metadata.runId ?? events[0]?.runId ?? null,
    mode: metadata.mode ?? events[0]?.mode ?? null,
    state: metadata.state ?? null,
    adapterId: metadata.adapterId ?? null,
    createdAt: metadata.createdAt ?? events[0]?.recordedAt ?? null,
    updatedAt: metadata.updatedAt ?? events.at(-1)?.recordedAt ?? null,
    eventCount: events.length,
    invalidLines,
    actorCount: actors.size,
    targetCount: targets.size,
    agentInvocations: counts.agent_invoke_started,
    artifactWrites: counts.artifact_write,
    artifactReads: counts.artifact_read,
    readViolations,
    readClassifications,
    stateTransitions: counts.state_transition,
    reviewDecisions: counts.review_decision,
    validationEvents: counts.validation_completed,
    wakeEvents: counts.wake_requested + counts.wake_delivered,
    observedTokens,
    measurementSources: [...sources].sort(),
    containment: metadata.containment ?? { read: "unsupported", write: "unsupported", eventSource: null },
    topology: {
      nodeCount: nodes.size,
      relationshipCount: relationships.size,
      agentNodes: [...nodes].filter((value) => value.startsWith("agent:")).length,
      artifactNodes: [...nodes].filter((value) => value.startsWith("artifact:")).length,
      uniqueReadArtifacts: readArtifacts.size,
      repeatedArtifactReads: Math.max(0, readEvents.length - readArtifacts.size),
      artifactReaderLinks: [...artifactReaders.values()].reduce((total, readers) => total + readers.size, 0),
      maxArtifactReaderFanOut: Math.max(0, ...[...artifactReaders.values()].map((readers) => readers.size)),
    },
    coverage: {
      invoke: counts.agent_invoke_started > 0 ? "observed" : "not-observed",
      write: writeContainment === "exact-paths"
        ? "enforced"
        : counts.artifact_write > 0 ? "observed" : "not-observed",
      read: readContainment === "exact-paths"
        ? "enforced"
        : hasReadInstrumentation
          ? "observed"
          : readContainment === "partial-event-audit"
            ? "not-observed"
            : "unsupported",
      message: "unsupported",
    },
  };
}

export async function coordinationSummaryForRun(runDirectory, metadata = {}) {
  const { events, invalidLines } = await readCoordinationEvents(runDirectory);
  const { projected, rejectedEvents } = projectEvents(events, metadata);
  return summarizeCoordinationEvents(projected, metadata, invalidLines + rejectedEvents);
}
