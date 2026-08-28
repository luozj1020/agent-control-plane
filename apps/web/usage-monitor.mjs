import { createReadStream } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

const RANGE_CONFIG = Object.freeze({
  "1h": Object.freeze({ durationMs: 60 * 60 * 1000, bucketMs: 5 * 60 * 1000 }),
  "24h": Object.freeze({ durationMs: 24 * 60 * 60 * 1000, bucketMs: 60 * 60 * 1000 }),
  "7d": Object.freeze({ durationMs: 7 * 24 * 60 * 60 * 1000, bucketMs: 24 * 60 * 60 * 1000 }),
  "30d": Object.freeze({ durationMs: 30 * 24 * 60 * 60 * 1000, bucketMs: 24 * 60 * 60 * 1000 }),
});

const EMPTY_TOTALS = Object.freeze({
  inputTokens: 0,
  cachedInputTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
  requests: 0,
  modelCalls: 0,
  upstreamCalls: 0,
  downstreamCalls: 0,
  upstreamTokens: 0,
  downstreamTokens: 0,
});

function finiteToken(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function addUsage(target, event) {
  target.inputTokens += event.inputTokens;
  target.cachedInputTokens += event.cachedInputTokens;
  target.uncachedInputTokens += event.uncachedInputTokens;
  target.outputTokens += event.outputTokens;
  target.reasoningOutputTokens += event.reasoningOutputTokens;
  target.totalTokens += event.totalTokens;
  target.requests += 1;
  target.modelCalls += 1;
  if (event.lane === "downstream") {
    target.downstreamCalls += 1;
    target.downstreamTokens += event.totalTokens;
  } else {
    target.upstreamCalls += 1;
    target.upstreamTokens += event.totalTokens;
  }
}

function emptyUsage() {
  return { ...EMPTY_TOTALS };
}

async function directoryType(path) {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) return "symlink";
    if (metadata.isDirectory()) return "directory";
    return "other";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

async function listRolloutFiles(root, maximumFiles) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (
        entry.isFile() &&
        entry.name.startsWith("rollout-") &&
        entry.name.endsWith(".jsonl")
      ) {
        files.push(path);
        if (files.length > maximumFiles) {
          throw new Error(`Codex usage file count exceeds ${maximumFiles}.`);
        }
      }
    }
  }
  return files;
}

function extractUsageEvent(record, currentModel, sessionKey) {
  if (record?.type !== "event_msg" || record?.payload?.type !== "token_count") {
    return null;
  }
  const usage = record.payload.info?.last_token_usage ?? record.payload.usage?.last_token_usage;
  const timestamp = Date.parse(record.timestamp);
  if (!usage || !Number.isFinite(timestamp)) return null;

  const inputTokens = finiteToken(usage.input_tokens);
  const cachedInputTokens = Math.min(inputTokens, finiteToken(usage.cached_input_tokens));
  const outputTokens = finiteToken(usage.output_tokens);
  return {
    timestamp,
    sessionKey,
    model: currentModel ?? "unknown",
    lane: "upstream",
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens: inputTokens - cachedInputTokens,
    outputTokens,
    reasoningOutputTokens: Math.min(
      outputTokens,
      finiteToken(usage.reasoning_output_tokens),
    ),
    totalTokens: finiteToken(usage.total_tokens) || inputTokens + outputTokens,
  };
}

function processLine(cache, line, sessionKey) {
  if (line.length === 0) return;
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    cache.parseErrors += 1;
    return;
  }
  if (
    record?.type === "turn_context" &&
    typeof record.payload?.model === "string" &&
    record.payload.model.length > 0
  ) {
    cache.currentModel = record.payload.model;
    return;
  }
  const event = extractUsageEvent(record, cache.currentModel, sessionKey);
  if (event) cache.events.push(event);
}

async function refreshFile(path, metadata, existing) {
  let cache = existing;
  if (!cache || metadata.size < cache.offset) {
    cache = {
      offset: 0,
      pending: Buffer.alloc(0),
      currentModel: null,
      events: [],
      parseErrors: 0,
      mtimeMs: 0,
    };
  }
  if (metadata.size === cache.offset && metadata.mtimeMs === cache.mtimeMs) return cache;
  if (metadata.size === cache.offset) {
    cache.mtimeMs = metadata.mtimeMs;
    return cache;
  }

  let pending = cache.pending;
  const stream = createReadStream(path, { start: cache.offset, end: metadata.size - 1 });
  for await (const chunk of stream) {
    let data = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
    let newline = data.indexOf(0x0a);
    while (newline >= 0) {
      processLine(cache, data.subarray(0, newline).toString("utf8"), basename(path));
      data = data.subarray(newline + 1);
      newline = data.indexOf(0x0a);
    }
    pending = Buffer.from(data);
  }
  cache.pending = pending;
  cache.offset = metadata.size;
  cache.mtimeMs = metadata.mtimeMs;
  return cache;
}

export function createUsageMonitor(options = {}) {
  const configured =
    options.sessionsDir ??
    process.env.AGENT_WORKFLOW_CODEX_SESSIONS_DIR ??
    join(homedir(), ".codex", "sessions");
  if (!isAbsolute(configured)) {
    throw new Error("Codex sessions directory must be an absolute path.");
  }
  const sessionsDir = resolve(configured);
  const now = options.now ?? (() => new Date());
  const maximumFiles = options.maximumFiles ?? 5000;
  const additionalSources = Object.freeze([...(options.sources ?? [])]);
  const cacheByPath = new Map();
  let collectionQueue = Promise.resolve();

  async function collectSnapshot(range) {
    const config = RANGE_CONFIG[range];
    if (!config) {
      const error = new Error(`Unsupported usage range '${range}'.`);
      error.code = "usage.invalid_range";
      error.status = 400;
      throw error;
    }

    const currentTime = now();
    const currentMs = currentTime.getTime();
    const endMs = Math.ceil(currentMs / config.bucketMs) * config.bucketMs;
    const startMs = endMs - config.durationMs;
    const type = await directoryType(sessionsDir);
    const upstreamCoverage =
      type === "directory"
        ? { status: "active", source: "codex-local-sessions" }
        : { status: "unavailable", source: "codex-local-sessions" };
    const files = type === "directory" ? await listRolloutFiles(sessionsDir, maximumFiles) : [];
    const activePaths = new Set(files);
    for (const cachedPath of cacheByPath.keys()) {
      if (!activePaths.has(cachedPath)) cacheByPath.delete(cachedPath);
    }
    const consideredCaches = [];
    for (const path of files) {
      const metadata = await stat(path);
      const existing = cacheByPath.get(path);
      const cache = await refreshFile(path, metadata, existing);
      cacheByPath.set(path, cache);
      consideredCaches.push(cache);
    }

    const sourceResults = await Promise.all(
      additionalSources.map(async (source) => {
        try {
          return await source.collect({ startMs, endMs });
        } catch {
          return {
            id: source.id ?? "unknown",
            lane: source.lane ?? "downstream",
            status: "unavailable",
            source: source.id ?? null,
            reason: "collector-failed",
            attribution: "unavailable",
            events: [],
            diagnostics: { eventsRead: 0 },
          };
        }
      }),
    );

    const bucketCount = Math.ceil(config.durationMs / config.bucketMs);
    const buckets = Array.from({ length: bucketCount }, (_, index) => ({
      start: new Date(startMs + index * config.bucketMs).toISOString(),
      end: new Date(startMs + (index + 1) * config.bucketMs).toISOString(),
      ...emptyUsage(),
    }));
    const totals = emptyUsage();
    const models = new Map();
    const sessions = new Set();

    for (const cache of consideredCaches) {
      for (const event of cache.events) {
        if (event.timestamp < startMs || event.timestamp >= endMs) continue;
        const index = Math.floor((event.timestamp - startMs) / config.bucketMs);
        const bucket = buckets[index];
        if (!bucket) continue;
        addUsage(bucket, event);
        addUsage(totals, event);
        if (event.sessionKey) sessions.add(event.sessionKey);
        const modelUsage = models.get(event.model) ?? emptyUsage();
        addUsage(modelUsage, event);
        models.set(event.model, modelUsage);
      }
    }

    for (const result of sourceResults) {
      if (result.status !== "active") continue;
      for (const event of result.events ?? []) {
        if (event.timestamp < startMs || event.timestamp >= endMs) continue;
        const index = Math.floor((event.timestamp - startMs) / config.bucketMs);
        const bucket = buckets[index];
        if (!bucket) continue;
        addUsage(bucket, event);
        addUsage(totals, event);
        if (event.sessionKey) sessions.add(event.sessionKey);
        const modelUsage = models.get(event.model) ?? emptyUsage();
        addUsage(modelUsage, event);
        models.set(event.model, modelUsage);
      }
    }

    const downstreamResult =
      sourceResults.find(
        (result) => result.lane === "downstream" && result.status === "active",
      ) ?? sourceResults.find((result) => result.lane === "downstream");
    const downstreamCoverage = downstreamResult
      ? {
          status: downstreamResult.status,
          source: downstreamResult.source ?? downstreamResult.id ?? null,
          ...(downstreamResult.reason ? { reason: downstreamResult.reason } : {}),
          ...(downstreamResult.attribution
            ? { attribution: downstreamResult.attribution }
            : {}),
        }
      : { status: "not-connected", source: null };
    const available =
      upstreamCoverage.status === "active" || downstreamCoverage.status === "active";

    return {
      available,
      source: "local-agent-usage",
      range,
      generatedAt: currentTime.toISOString(),
      privacy: "usage-events-only",
      callCoverage: {
        upstream: upstreamCoverage,
        downstream: downstreamCoverage,
      },
      totals: {
        ...totals,
        sessions: sessions.size,
        cacheRate:
          totals.inputTokens === 0 ? 0 : totals.cachedInputTokens / totals.inputTokens,
      },
      buckets,
      models: [...models.entries()]
        .map(([model, usage]) => ({ model, ...usage }))
        .sort((left, right) => right.totalTokens - left.totalTokens),
      diagnostics: {
        filesDiscovered: files.length,
        filesRead: consideredCaches.length,
        parseErrors: consideredCaches.reduce((sum, cache) => sum + cache.parseErrors, 0),
        sources: sourceResults.map((result) => ({
          id: result.id,
          lane: result.lane,
          status: result.status,
          source: result.source,
          reason: result.reason ?? null,
          attribution: result.attribution ?? null,
          eventsRead: result.diagnostics?.eventsRead ?? 0,
          snapshotFallback: result.diagnostics?.snapshotFallback ?? false,
        })),
      },
      ...(!available
        ? {
            reason:
              type === "missing" ? "sessions-directory-missing" : `unsafe-sessions-${type}`,
          }
        : {}),
    };
  }

  function collect(range = "24h") {
    const result = collectionQueue.then(() => collectSnapshot(range));
    collectionQueue = result.catch(() => undefined);
    return result;
  }

  return Object.freeze({ collect, ranges: Object.keys(RANGE_CONFIG) });
}
