import { createReadStream } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

function finiteToken(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

async function pathType(path) {
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

async function listJsonlFiles(root, maximumFiles) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(path);
        if (files.length > maximumFiles) {
          const error = new Error(`Claude usage file count exceeds ${maximumFiles}.`);
          error.code = "claude.file-limit";
          throw error;
        }
      }
    }
  }
  return files;
}

function candidateFromRecord(record, currentSessionId) {
  if (record?.type !== "assistant") return null;
  const message = record.message;
  const usage = message?.usage;
  const timestamp = Date.parse(record.timestamp);
  if (
    typeof message?.id !== "string" ||
    message.id.length === 0 ||
    !usage ||
    !Number.isFinite(timestamp)
  ) {
    return null;
  }

  const inputTokens = finiteToken(usage.input_tokens);
  const cachedInputTokens = finiteToken(usage.cache_read_input_tokens);
  const cacheCreationTokens = finiteToken(usage.cache_creation_input_tokens);
  const outputTokens = finiteToken(usage.output_tokens);
  if (inputTokens + cachedInputTokens + cacheCreationTokens + outputTokens === 0) return null;
  return {
    messageId: message.id,
    timestamp,
    sessionId: currentSessionId,
    model:
      typeof message.model === "string" && message.model.length > 0
        ? message.model
        : "unknown",
    inputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    complete: typeof message.stop_reason === "string" && message.stop_reason.length > 0,
  };
}

function shouldReplace(existing, candidate) {
  if (!existing) return true;
  if (candidate.complete !== existing.complete) return candidate.complete;
  return candidate.outputTokens > existing.outputTokens;
}

function processLine(cache, line) {
  if (line.length === 0) return;
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    cache.parseErrors += 1;
    return;
  }
  if (typeof record?.sessionId === "string" && record.sessionId.length > 0) {
    cache.currentSessionId = record.sessionId;
  }
  const candidate = candidateFromRecord(record, cache.currentSessionId);
  if (!candidate) return;
  const existing = cache.messages.get(candidate.messageId);
  if (shouldReplace(existing, candidate)) cache.messages.set(candidate.messageId, candidate);
}

async function refreshFile(path, metadata, existing) {
  let cache = existing;
  if (!cache || metadata.size < cache.offset) {
    cache = {
      offset: 0,
      pending: Buffer.alloc(0),
      currentSessionId: null,
      messages: new Map(),
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
      processLine(cache, data.subarray(0, newline).toString("utf8"));
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

function eventFromCandidate(candidate) {
  const uncachedInputTokens = candidate.inputTokens + candidate.cacheCreationTokens;
  const inputTokens = uncachedInputTokens + candidate.cachedInputTokens;
  return {
    timestamp: candidate.timestamp,
    sessionKey: candidate.sessionId ? `claude:${candidate.sessionId}` : null,
    model: candidate.model,
    lane: "downstream",
    inputTokens,
    cachedInputTokens: candidate.cachedInputTokens,
    uncachedInputTokens,
    outputTokens: candidate.outputTokens,
    reasoningOutputTokens: 0,
    totalTokens: inputTokens + candidate.outputTokens,
  };
}

function unavailable(status, reason) {
  return {
    id: "claude-local",
    lane: "downstream",
    status,
    source: "claude-local-sessions",
    reason,
    attribution: "agent-level",
    events: [],
    diagnostics: { filesDiscovered: 0, filesRead: 0, parseErrors: 0, eventsRead: 0 },
  };
}

export function createClaudeUsageSource(options = {}) {
  const configured =
    options.projectsDir ??
    process.env.AGENT_WORKFLOW_CLAUDE_PROJECTS_DIR ??
    join(homedir(), ".claude", "projects");
  if (!isAbsolute(configured)) {
    throw new Error("Claude projects directory must be absolute.");
  }
  const projectsDir = resolve(configured);
  const maximumFiles = options.maximumFiles ?? 5000;
  const maximumEvents = options.maximumEvents ?? 100_000;
  if (!Number.isInteger(maximumFiles) || maximumFiles < 1) {
    throw new Error("Claude maximumFiles must be a positive integer.");
  }
  if (!Number.isInteger(maximumEvents) || maximumEvents < 1) {
    throw new Error("Claude maximumEvents must be a positive integer.");
  }
  const cacheByPath = new Map();
  let collectionQueue = Promise.resolve();

  async function collectSnapshot({ startMs, endMs }) {
    const type = await pathType(projectsDir);
    if (type === "missing") return unavailable("not-connected", "sessions-directory-missing");
    if (type !== "directory") return unavailable("unavailable", `unsafe-sessions-${type}`);

    const files = await listJsonlFiles(projectsDir, maximumFiles);
    const activePaths = new Set(files);
    for (const cachedPath of cacheByPath.keys()) {
      if (!activePaths.has(cachedPath)) cacheByPath.delete(cachedPath);
    }
    const caches = [];
    for (const path of files) {
      const metadata = await stat(path);
      const cache = await refreshFile(path, metadata, cacheByPath.get(path));
      cacheByPath.set(path, cache);
      caches.push(cache);
    }

    const messages = new Map();
    for (const cache of caches) {
      for (const candidate of cache.messages.values()) {
        if (candidate.timestamp < startMs || candidate.timestamp >= endMs) continue;
        const existing = messages.get(candidate.messageId);
        if (shouldReplace(existing, candidate)) messages.set(candidate.messageId, candidate);
        if (messages.size > maximumEvents) {
          return unavailable("unavailable", "event-limit-exceeded");
        }
      }
    }
    const events = [...messages.values()].map(eventFromCandidate);
    return {
      id: "claude-local",
      lane: "downstream",
      status: "active",
      source: "claude-local-sessions",
      attribution: "agent-level",
      events,
      diagnostics: {
        filesDiscovered: files.length,
        filesRead: caches.length,
        parseErrors: caches.reduce((sum, cache) => sum + cache.parseErrors, 0),
        eventsRead: events.length,
      },
    };
  }

  function collect(window) {
    const result = collectionQueue.then(() => collectSnapshot(window));
    collectionQueue = result.catch(() => undefined);
    return result;
  }

  return Object.freeze({ id: "claude-local", lane: "downstream", collect });
}
