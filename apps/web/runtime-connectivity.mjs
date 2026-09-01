import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import {
  classifyDownstreamFailure,
  resolveRuntimeEnvironment,
} from "./runtime-environment.mjs";

const PROBE_PROMPT = [
  "Reply with exactly CONNECTION_OK.",
  "Do not read files, use tools, modify the workspace, or continue the conversation.",
].join(" ");

const DEFAULT_TIMEOUT_SECONDS = 60;
const MIN_TIMEOUT_SECONDS = 5;
const MAX_TIMEOUT_SECONDS = 120;
const MAX_DIAGNOSTIC_BYTES = 32_768;

export class ConnectivityProbeError extends Error {
  constructor(code, message, status = 400, path = null) {
    super(message);
    this.name = "ConnectivityProbeError";
    this.code = code;
    this.status = status;
    if (path) this.path = path;
  }
}

function finiteToken(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function usageFrom(record) {
  if (!record || typeof record !== "object") return null;
  const usage = record.usage ?? record.message?.usage ?? record.result?.usage;
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = finiteToken(usage.input_tokens);
  const cachedInputTokens =
    finiteToken(usage.cache_read_input_tokens) + finiteToken(usage.cached_input_tokens);
  const cacheCreationTokens = finiteToken(usage.cache_creation_input_tokens);
  const outputTokens = finiteToken(usage.output_tokens);
  return {
    inputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    totalTokens: inputTokens + cachedInputTokens + cacheCreationTokens + outputTokens,
  };
}

function normalizeTimeout(value) {
  const timeout = value ?? DEFAULT_TIMEOUT_SECONDS;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < MIN_TIMEOUT_SECONDS ||
    timeout > MAX_TIMEOUT_SECONDS
  ) {
    throw new ConnectivityProbeError(
      "connectivity.timeout_invalid",
      `timeoutSeconds must be an integer from ${MIN_TIMEOUT_SECONDS} to ${MAX_TIMEOUT_SECONDS}.`,
      400,
      "timeoutSeconds",
    );
  }
  return timeout;
}

async function validateWorktree(value) {
  if (typeof value !== "string" || !value.trim() || !isAbsolute(value.trim())) {
    throw new ConnectivityProbeError(
      "connectivity.worktree_invalid",
      "worktree must be an absolute directory path.",
      400,
      "worktree",
    );
  }
  const worktree = resolve(value.trim());
  try {
    const metadata = await stat(worktree);
    if (!metadata.isDirectory()) throw new Error("not-directory");
  } catch {
    throw new ConnectivityProbeError(
      "connectivity.worktree_unavailable",
      "worktree must be an accessible directory.",
      400,
      "worktree",
    );
  }
  return worktree;
}

function signalProcess(child, signal) {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

export function createClaudeConnectivityAdapter(options = {}) {
  return Object.freeze({
    id: "claude-code",
    displayName: "Claude Code",
    command: options.command ?? process.env.AGENT_CONTROL_CLAUDE_COMMAND ?? "claude",
    requiresNetwork: true,
    providerEnvironmentPrefixes: Object.freeze(["ANTHROPIC_", "CLAUDE_", "CC_SWITCH_"]),
    buildConnectivityArgs(prompt) {
      return [
        "-p",
        prompt,
        "--bare",
        "--no-session-persistence",
        "--tools",
        "",
        "--output-format",
        "stream-json",
        "--verbose",
      ];
    },
  });
}

export async function probeDownstreamConnectivity(input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ConnectivityProbeError(
      "connectivity.request_invalid",
      "Connectivity probe request must be an object.",
    );
  }
  const adapters = options.adapters ?? [createClaudeConnectivityAdapter()];
  const adapterId = typeof input.adapterId === "string" ? input.adapterId.trim() : "";
  const adapter = adapters.find((candidate) => candidate.id === adapterId);
  if (!adapter || typeof adapter.command !== "string" || !adapter.command) {
    throw new ConnectivityProbeError(
      "connectivity.adapter_unavailable",
      adapterId ? `Adapter '${adapterId}' does not support active diagnostics.` : "An adapter is required.",
      400,
      "adapterId",
    );
  }
  if (typeof adapter.buildConnectivityArgs !== "function") {
    throw new ConnectivityProbeError(
      "connectivity.adapter_unsupported",
      `Adapter '${adapterId}' does not define a connectivity probe protocol.`,
      400,
      "adapterId",
    );
  }

  const worktree = await validateWorktree(input.worktree);
  const timeoutSeconds = normalizeTimeout(input.timeoutSeconds);
  const runtimeEnvironment = resolveRuntimeEnvironment(input.runtimeEnvironment, {
    environment: options.environment ?? process.env,
    providerEnvironmentPrefixes: adapter.providerEnvironmentPrefixes ?? [],
    adapterEnvironment: adapter.env,
    requiresNetwork: adapter.requiresNetwork !== false,
  });
  const baseReceipt = {
    schemaVersion: 1,
    kind: "downstream-connectivity-probe",
    adapterId,
    adapterDisplayName: adapter.displayName ?? adapter.id,
    executionEnvironment: runtimeEnvironment.evidence.executionEnvironmentResolved,
    proxyMode: runtimeEnvironment.evidence.proxyMode,
    isolationMode: runtimeEnvironment.evidence.isolationMode,
    timeoutSeconds,
  };

  if (runtimeEnvironment.evidence.hostHandoffRequired) {
    return Object.freeze({
      ...baseReceipt,
      success: false,
      attempted: false,
      consumedCall: false,
      elapsedMilliseconds: 0,
      exitCode: null,
      signal: null,
      timedOut: false,
      failureCategory: "sandbox-network-host-handoff",
      streamInitialized: false,
      resultReceived: false,
      usageAvailable: false,
      usage: null,
      activity: Object.freeze({ stdoutBytes: 0, stderrBytes: 0, parsedEvents: 0 }),
      testedAt: new Date().toISOString(),
    });
  }

  const startedAt = Date.now();
  const activity = { stdoutBytes: 0, stderrBytes: 0, parsedEvents: 0 };
  let diagnosticTail = "";
  let pending = "";
  let streamInitialized = false;
  let resultReceived = false;
  let resultFailed = false;
  let usage = null;
  let spawned = false;
  let timedOut = false;
  let forceTimer = null;
  const spawnProcess = options.spawnProcess ?? spawn;
  const child = spawnProcess(adapter.command, adapter.buildConnectivityArgs(PROBE_PROMPT), {
    cwd: worktree,
    detached: process.platform !== "win32",
    env: { ...runtimeEnvironment.environment, PWD: worktree },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const processLine = (line) => {
    if (!line.trim()) return;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) return;
    activity.parsedEvents += 1;
    if (record.type === "system" && record.subtype === "init") streamInitialized = true;
    if (record.type === "result") {
      resultReceived = true;
      resultFailed =
        record.is_error === true ||
        (record.error !== undefined && record.error !== null && record.error !== false) ||
        (typeof record.subtype === "string" && /(error|fail)/i.test(record.subtype));
      if (resultFailed) {
        const resultDiagnostic = typeof record.result === "string"
          ? record.result
          : typeof record.error === "string" ? record.error : "";
        diagnosticTail = `${diagnosticTail}${resultDiagnostic}`.slice(-MAX_DIAGNOSTIC_BYTES);
      }
    }
    const observedUsage = usageFrom(record);
    if (observedUsage) usage = observedUsage;
  };

  child.stdout?.on("data", (chunk) => {
    activity.stdoutBytes += chunk.length;
    pending += chunk.toString("utf8");
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      processLine(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
    }
  });
  child.stderr?.on("data", (chunk) => {
    activity.stderrBytes += chunk.length;
    diagnosticTail = `${diagnosticTail}${chunk.toString("utf8")}`.slice(-MAX_DIAGNOSTIC_BYTES);
  });

  const completion = await new Promise((resolveCompletion) => {
    let settled = false;
    let timeoutTimer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceTimer) clearTimeout(forceTimer);
      if (pending) processLine(pending);
      resolveCompletion(value);
    };
    child.once("spawn", () => {
      spawned = true;
    });
    child.once("error", (error) => {
      finish({ exitCode: null, signal: null, error, spawnErrorCode: error.code ?? null });
    });
    child.once("close", (exitCode, signal) => {
      finish({ exitCode, signal, error: null, spawnErrorCode: null });
    });
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      try {
        signalProcess(child, "SIGTERM");
      } catch {
        // The terminal receipt still records the timeout if signaling is unavailable.
      }
      forceTimer = setTimeout(() => {
        try {
          signalProcess(child, "SIGKILL");
        } catch {
          // The process may already be gone.
        }
        finish({ exitCode: null, signal: "SIGKILL", error: null, spawnErrorCode: null });
      }, 1000);
      forceTimer.unref?.();
    }, timeoutSeconds * 1000);
    timeoutTimer.unref?.();
  });

  const success =
    !timedOut && !resultFailed && completion.exitCode === 0 && activity.stdoutBytes > 0;
  const failureCategory = success ? null : classifyDownstreamFailure({
    environment: runtimeEnvironment.evidence,
    diagnosticText: diagnosticTail,
    spawnErrorCode: completion.spawnErrorCode,
    error: completion.error ?? (resultFailed ? true : null),
    exitCode: completion.exitCode,
    signal: completion.signal,
    timedOut,
    activity,
  });
  const usageAvailable = usage !== null;
  return Object.freeze({
    ...baseReceipt,
    success,
    attempted: spawned,
    consumedCall: spawned && (success || streamInitialized || resultReceived || usageAvailable),
    elapsedMilliseconds: Math.max(0, Date.now() - startedAt),
    exitCode: completion.exitCode,
    signal: completion.signal,
    timedOut,
    failureCategory,
    streamInitialized,
    resultReceived,
    usageAvailable,
    usage: usageAvailable ? Object.freeze({ ...usage }) : null,
    activity: Object.freeze({ ...activity }),
    testedAt: new Date().toISOString(),
  });
}
