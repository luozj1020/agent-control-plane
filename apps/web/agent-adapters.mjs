import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { once } from "node:events";

import {
  classifyDownstreamFailure,
  resolveRuntimeEnvironment,
} from "./runtime-environment.mjs";

function finiteToken(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function usageFrom(value) {
  if (!value || typeof value !== "object") return null;
  const usage = value.usage ?? value.message?.usage ?? value.result?.usage;
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

function mergeUsage(target, usage) {
  for (const key of Object.keys(target)) target[key] += usage[key] ?? 0;
}

async function terminateProcessGroup(child, graceMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const signal = (name) => {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, name);
      else child.kill(name);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  };
  signal("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, graceMs)),
  ]);
  if (child.exitCode === null && child.signalCode === null) signal("SIGKILL");
}

function taskDirected(record) {
  if (!record || typeof record !== "object") return false;
  if (["assistant", "tool_use", "tool_result"].includes(record.type)) return true;
  const content = record.message?.content;
  return (
    Array.isArray(content) &&
    content.some((entry) =>
      ["text", "thinking", "tool_use", "tool_result"].includes(entry?.type),
    )
  );
}

export function createProcessAdapter(definition) {
  if (!definition || typeof definition.id !== "string" || !definition.id) {
    throw new Error("Adapter id is required.");
  }
  if (typeof definition.command !== "string" || !definition.command) {
    throw new Error(`Adapter '${definition.id}' command is required.`);
  }
  const fixedArgs = Object.freeze([...(definition.args ?? [])]);

  return Object.freeze({
    id: definition.id,
    displayName: definition.displayName ?? definition.id,
    command: definition.command,
    requiresNetwork: definition.requiresNetwork !== false,
    providerEnvironmentPrefixes: Object.freeze([...(definition.providerEnvironmentPrefixes ?? [])]),
    filesystemIsolation: definition.filesystemIsolation ?? "post-run-only",
    async start(context) {
      const runtimeEnvironment = resolveRuntimeEnvironment(context.runtimeEnvironment, {
        environment: process.env,
        providerEnvironmentPrefixes: definition.providerEnvironmentPrefixes ?? [],
        adapterEnvironment: definition.env,
        requiresNetwork: definition.requiresNetwork !== false,
      });
      context.onEvent?.({
        type: "runtime-environment",
        environment: runtimeEnvironment.evidence,
      });
      if (runtimeEnvironment.evidence.hostHandoffRequired) {
        const failureCategory = classifyDownstreamFailure({
          environment: runtimeEnvironment.evidence,
        });
        await Promise.all([
          writeFile(context.stdoutPath, "", { flag: "a", mode: 0o600 }),
          writeFile(context.stderrPath, "", { flag: "a", mode: 0o600 }),
        ]);
        const result = Object.freeze({
          exitCode: null,
          signal: null,
          sessionId: context.resumeSessionId ?? null,
          usage: {
            inputTokens: 0,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
          },
          error: "Network access is restricted in the current sandbox; host execution is required.",
          failureCategory,
          diagnostics: {
            environment: runtimeEnvironment.evidence,
            activity: {
              stdoutBytes: 0,
              stderrBytes: 0,
              parsedEvents: 0,
              streamInitialized: false,
              taskDirectedEvents: 0,
              firstOutputMilliseconds: null,
            },
          },
        });
        context.onEvent?.({ type: "adapter-blocked", failureCategory });
        return Object.freeze({
          pid: null,
          identity: Object.freeze({
            pid: null,
            command: definition.command,
            args: [...fixedArgs],
            worktree: context.worktree,
            processGroup: null,
          }),
          result: Promise.resolve(result),
          usage: () => ({ ...result.usage }),
          sessionId: () => result.sessionId,
          terminate: async () => undefined,
        });
      }

      const args = [...fixedArgs];
      if (context.resumeSessionId) args.push("--resume", context.resumeSessionId);
      const startedAt = Date.now();
      const activity = {
        stdoutBytes: 0,
        stderrBytes: 0,
        parsedEvents: 0,
        streamInitialized: false,
        taskDirectedEvents: 0,
        firstOutputMilliseconds: null,
      };
      let diagnosticTail = "";
      const child = spawn(definition.command, args, {
        cwd: context.worktree,
        detached: process.platform !== "win32",
        env: { ...runtimeEnvironment.environment, PWD: context.worktree },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      context.onEvent?.({
        type: "adapter-started",
        pid: child.pid ?? null,
        proxyMode: runtimeEnvironment.evidence.proxyMode,
        isolationMode: runtimeEnvironment.evidence.isolationMode,
      });
      const parentExitCleanup = () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
          else child.kill("SIGTERM");
        } catch {
          // The child already exited or is no longer visible; normal evidence handles it.
        }
      };
      process.once("exit", parentExitCleanup);
      const stdout = createWriteStream(context.stdoutPath, { flags: "a", mode: 0o600 });
      const stderr = createWriteStream(context.stderrPath, { flags: "a", mode: 0o600 });
      const usage = {
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      };
      const seenMessages = new Set();
      let sessionId = context.resumeSessionId ?? null;
      let pending = "";

      child.stdout.on("data", (chunk) => {
        stdout.write(chunk);
        activity.stdoutBytes += chunk.length;
        if (activity.firstOutputMilliseconds === null) {
          activity.firstOutputMilliseconds = Math.max(0, Date.now() - startedAt);
        }
        context.onEvent?.({ type: "output", stream: "stdout", bytes: chunk.length });
        pending += chunk.toString("utf8");
        let newline = pending.indexOf("\n");
        while (newline >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          newline = pending.indexOf("\n");
          if (!line.trim()) continue;
          let record;
          try {
            record = JSON.parse(line);
          } catch {
            continue;
          }
          activity.parsedEvents += 1;
          if (record.type === "system" && record.subtype === "init") {
            activity.streamInitialized = true;
            context.onEvent?.({ type: "stream-initialized" });
          }
          sessionId = record.session_id ?? record.sessionId ?? sessionId;
          if (taskDirected(record)) {
            activity.taskDirectedEvents += 1;
            context.onEvent?.({ type: "task-directed" });
          }
          if (
            record.type === "implementation_complete" ||
            record.progress?.implementation_complete === true
          ) {
            context.onEvent?.({ type: "implementation-complete" });
          }
          if (record.type === "result") context.onEvent?.({ type: "completion-ready" });
          const recordUsage = usageFrom(record);
          const messageId = record.message?.id ?? record.id ?? null;
          if (recordUsage && record.type !== "result") {
            if (!messageId || !seenMessages.has(messageId)) {
              if (messageId) seenMessages.add(messageId);
              mergeUsage(usage, recordUsage);
              context.onEvent?.({ type: "usage", usage: { ...usage } });
            }
          } else if (recordUsage && usage.totalTokens === 0) {
            mergeUsage(usage, recordUsage);
            context.onEvent?.({ type: "usage", usage: { ...usage } });
          }
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr.write(chunk);
        activity.stderrBytes += chunk.length;
        if (activity.firstOutputMilliseconds === null) {
          activity.firstOutputMilliseconds = Math.max(0, Date.now() - startedAt);
        }
        diagnosticTail = `${diagnosticTail}${chunk.toString("utf8")}`.slice(-32_768);
        context.onEvent?.({ type: "output", stream: "stderr", bytes: chunk.length });
      });
      let finishResult;
      let resultSettled = false;
      const result = new Promise((resolve) => {
        finishResult = (value) => {
          if (resultSettled) return;
          resultSettled = true;
          process.removeListener("exit", parentExitCleanup);
          const failureCategory = classifyDownstreamFailure({
            environment: runtimeEnvironment.evidence,
            diagnosticText: diagnosticTail,
            spawnErrorCode: value.spawnErrorCode,
            error: value.error,
            exitCode: value.exitCode,
            activity,
          });
          const enriched = Object.freeze({
            ...value,
            failureCategory,
            diagnostics: {
              environment: runtimeEnvironment.evidence,
              activity: { ...activity },
            },
          });
          const stdoutFinished = once(stdout, "finish");
          const stderrFinished = once(stderr, "finish");
          stdout.end();
          stderr.end();
          Promise.allSettled([stdoutFinished, stderrFinished]).then(() => {
            context.onEvent?.({
              type: "adapter-finished",
              exitCode: enriched.exitCode,
              failureCategory: enriched.failureCategory,
              activity: enriched.diagnostics.activity,
            });
            resolve(enriched);
          });
        };
      });
      child.on("error", (error) => {
        context.onEvent?.({ type: "adapter-error", message: error.message });
        finishResult({
          exitCode: null,
          signal: null,
          sessionId,
          usage: { ...usage },
          error: error.message,
          spawnErrorCode: error.code ?? null,
        });
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(context.prompt);

      child.once("exit", (exitCode, signal) => {
        finishResult({ exitCode, signal, sessionId, usage: { ...usage } });
      });
      return Object.freeze({
        pid: child.pid ?? null,
        identity: Object.freeze({
          pid: child.pid ?? null,
          command: definition.command,
          args,
          worktree: context.worktree,
          processGroup: process.platform !== "win32" ? child.pid ?? null : null,
        }),
        result,
        usage: () => ({ ...usage }),
        sessionId: () => sessionId,
        terminate: () => terminateProcessGroup(child, context.terminationGraceMs),
      });
    },
  });
}

export function createBuiltInAdapterRegistry(options = {}) {
  const adapters = new Map();
  const claude = createProcessAdapter({
    id: "claude-code",
    displayName: "Claude Code",
    command: options.claudeCommand ?? process.env.AGENT_CONTROL_CLAUDE_COMMAND ?? "claude",
    requiresNetwork: true,
    providerEnvironmentPrefixes: ["ANTHROPIC_", "CLAUDE_", "CC_SWITCH_"],
    args: [
      "--print",
      "--verbose",
      "--output-format",
      "stream-json",
      "--permission-mode",
      "acceptEdits",
    ],
  });
  adapters.set(claude.id, claude);
  for (const adapter of options.adapters ?? []) adapters.set(adapter.id, adapter);
  return Object.freeze({
    get(id) {
      return adapters.get(id) ?? null;
    },
    list() {
      return [...adapters.values()].map(({
        id,
        displayName,
        command,
        requiresNetwork,
        providerEnvironmentPrefixes,
        filesystemIsolation,
      }) => ({
        id,
        displayName,
        command,
        requiresNetwork,
        providerEnvironmentPrefixes,
        filesystemIsolation,
      }));
    },
  });
}
