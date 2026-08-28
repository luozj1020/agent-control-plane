import { DatabaseSync } from "node:sqlite";
import { copyFile, lstat, mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const REQUIRED_COLUMNS = Object.freeze([
  "request_id",
  "app_type",
  "model",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
  "session_id",
  "created_at",
  "data_source",
]);

const SIDECAR_SUFFIXES = Object.freeze(["-journal", "-wal", "-shm"]);

function finiteToken(value) {
  const number = typeof value === "bigint" ? Number(value) : value;
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

async function pathType(path) {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) return "symlink";
    if (metadata.isFile()) return "file";
    return "other";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

async function sourceFingerprint(databasePath) {
  const parts = [];
  for (const suffix of ["", ...SIDECAR_SUFFIXES]) {
    const path = `${databasePath}${suffix}`;
    const type = await pathType(path);
    if (type === "symlink" || type === "other") {
      const error = new Error(`Unsafe CC Switch database${suffix || ""} path.`);
      error.code = "cc-switch.unsafe-path";
      throw error;
    }
    if (type === "missing") {
      parts.push(`${suffix}:missing`);
      continue;
    }
    const metadata = await stat(path);
    parts.push(`${suffix}:${metadata.size}:${metadata.mtimeMs}`);
  }
  return parts.join("|");
}

function normalizeTimestamp(value) {
  const timestamp = finiteToken(value);
  if (timestamp === 0) return 0;
  return timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
}

function queryRows(database, startMs, endMs, maximumRows) {
  const columns = new Set(
    database.prepare("PRAGMA table_info(proxy_request_logs)").all().map((row) => row.name),
  );
  const missing = REQUIRED_COLUMNS.filter((column) => !columns.has(column));
  if (missing.length > 0) {
    const error = new Error(`CC Switch usage schema is missing: ${missing.join(", ")}.`);
    error.code = "cc-switch.incompatible-schema";
    throw error;
  }

  const startSeconds = Math.floor(startMs / 1000);
  const endSeconds = Math.ceil(endMs / 1000);
  const rows = database
    .prepare(`
      SELECT request_id, model, input_tokens, output_tokens,
             cache_read_tokens, cache_creation_tokens, session_id, created_at
      FROM proxy_request_logs
      WHERE app_type = 'claude'
        AND data_source = 'session_log'
        AND created_at >= ?
        AND created_at < ?
      ORDER BY created_at, request_id
      LIMIT ?
    `)
    .all(startSeconds, endSeconds, maximumRows + 1);
  if (rows.length > maximumRows) {
    const error = new Error(`CC Switch usage row count exceeds ${maximumRows}.`);
    error.code = "cc-switch.row-limit";
    throw error;
  }
  return rows;
}

function readDirect(databasePath, startMs, endMs, maximumRows) {
  const database = new DatabaseSync(databasePath, {
    readOnly: true,
    enableForeignKeyConstraints: false,
  });
  try {
    return queryRows(database, startMs, endMs, maximumRows);
  } finally {
    database.close();
  }
}

async function copyIfRegular(source, destination) {
  const type = await pathType(source);
  if (type === "missing") return;
  if (type !== "file") {
    const error = new Error("Unsafe CC Switch SQLite sidecar path.");
    error.code = "cc-switch.unsafe-path";
    throw error;
  }
  await copyFile(source, destination);
}

async function readSnapshot(
  databasePath,
  startMs,
  endMs,
  expectedFingerprint,
  maximumRows,
) {
  const directory = await mkdtemp(join(tmpdir(), "agent-workflow-cc-switch-"));
  const snapshotPath = join(directory, "cc-switch.db");
  try {
    await copyFile(databasePath, snapshotPath);
    for (const suffix of SIDECAR_SUFFIXES) {
      await copyIfRegular(`${databasePath}${suffix}`, `${snapshotPath}${suffix}`);
    }
    if ((await sourceFingerprint(databasePath)) !== expectedFingerprint) {
      const error = new Error("CC Switch database changed while creating a snapshot.");
      error.code = "cc-switch.snapshot-changed";
      throw error;
    }
    const database = new DatabaseSync(snapshotPath);
    try {
      return queryRows(database, startMs, endMs, maximumRows);
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function eventFromRow(row) {
  const uncachedInputTokens =
    finiteToken(row.input_tokens) + finiteToken(row.cache_creation_tokens);
  const cachedInputTokens = finiteToken(row.cache_read_tokens);
  const inputTokens = uncachedInputTokens + cachedInputTokens;
  const outputTokens = finiteToken(row.output_tokens);
  return {
    timestamp: normalizeTimestamp(row.created_at),
    sessionKey:
      typeof row.session_id === "string" && row.session_id.length > 0
        ? `claude:${row.session_id}`
        : null,
    model:
      typeof row.model === "string" && row.model.length > 0 ? row.model : "unknown",
    lane: "downstream",
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens,
    outputTokens,
    reasoningOutputTokens: 0,
    totalTokens: inputTokens + outputTokens,
  };
}

function unavailable(status, reason) {
  return {
    id: "cc-switch",
    lane: "downstream",
    status,
    source: "cc-switch-session-log",
    reason,
    attribution: "agent-level",
    events: [],
    diagnostics: { eventsRead: 0, snapshotFallback: false },
  };
}

function queryFailureReason(error) {
  if (error?.code === "cc-switch.incompatible-schema") return "incompatible-schema";
  if (error?.code === "cc-switch.row-limit") return "row-limit-exceeded";
  return "database-query-failed";
}

export function createCcSwitchUsageSource(options = {}) {
  const configured =
    options.databasePath ??
    process.env.AGENT_WORKFLOW_CC_SWITCH_DB ??
    join(homedir(), ".cc-switch", "cc-switch.db");
  if (!isAbsolute(configured)) {
    throw new Error("CC Switch database path must be absolute.");
  }
  const maximumRows = options.maximumRows ?? 100_000;
  if (!Number.isInteger(maximumRows) || maximumRows < 1) {
    throw new Error("CC Switch maximumRows must be a positive integer.");
  }
  const databasePath = resolve(configured);
  let cached = null;

  async function collect({ startMs, endMs }) {
    const type = await pathType(databasePath);
    if (type === "missing") return unavailable("not-connected", "database-missing");
    if (type !== "file") return unavailable("unavailable", `unsafe-database-${type}`);

    let fingerprint;
    try {
      fingerprint = await sourceFingerprint(databasePath);
    } catch (error) {
      return unavailable("unavailable", error.code ?? "database-inspection-failed");
    }
    const cacheKey = `${fingerprint}|${startMs}|${endMs}`;
    if (cached?.key === cacheKey) return cached.value;

    let rows;
    let snapshotFallback = false;
    try {
      rows = readDirect(databasePath, startMs, endMs, maximumRows);
    } catch (error) {
      if (!/readonly database/i.test(error?.message ?? "")) {
        return unavailable("unavailable", queryFailureReason(error));
      }
      try {
        rows = await readSnapshot(
          databasePath,
          startMs,
          endMs,
          fingerprint,
          maximumRows,
        );
        snapshotFallback = true;
      } catch (snapshotError) {
        const reason = queryFailureReason(snapshotError);
        return unavailable(
          "unavailable",
          reason === "database-query-failed" ? "snapshot-query-failed" : reason,
        );
      }
    }

    const value = {
      id: "cc-switch",
      lane: "downstream",
      status: "active",
      source: "cc-switch-session-log",
      attribution: "agent-level",
      events: rows.map(eventFromRow).filter((event) => event.timestamp > 0),
      diagnostics: {
        eventsRead: rows.length,
        snapshotFallback,
      },
    };
    cached = { key: cacheKey, value };
    return value;
  }

  return Object.freeze({ id: "cc-switch", lane: "downstream", collect });
}
