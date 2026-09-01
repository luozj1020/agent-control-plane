import { spawn } from "node:child_process";

function requireDefinition(definition) {
  if (!definition || typeof definition.id !== "string" || !definition.id) {
    throw new Error("Wake adapter id is required.");
  }
  return definition;
}

export function createDurableFileWakeAdapter() {
  return Object.freeze({
    id: "durable-file",
    displayName: "Durable wake file",
    async deliver(context) {
      return Object.freeze({
        status: "scheduled",
        wakeId: context.wakeId,
        transport: "durable-file",
        detail: "A harness may consume the hash-bound wake request and open the next upstream episode.",
      });
    },
  });
}

export function createProcessWakeAdapter(definitionInput) {
  const definition = requireDefinition(definitionInput);
  if (typeof definition.command !== "string" || !definition.command) {
    throw new Error(`Wake adapter '${definition.id}' command is required.`);
  }
  if (!(definition.args ?? []).every((value) => typeof value === "string" && !value.includes("\0"))) {
    throw new Error(`Wake adapter '${definition.id}' args must be strings.`);
  }
  const fixedArgs = Object.freeze([...(definition.args ?? [])]);
  return Object.freeze({
    id: definition.id,
    displayName: definition.displayName ?? definition.id,
    async deliver(context) {
      const args = [
        ...fixedArgs,
        "--wake-request",
        context.wakePath,
        "--wake-sha256",
        context.wakeId,
      ];
      const child = spawn(definition.command, args, {
        cwd: context.worktree,
        detached: process.platform !== "win32",
        env: { ...process.env, ...(definition.env ?? {}) },
        stdio: "ignore",
        windowsHide: true,
      });
      await new Promise((resolveSpawn, rejectSpawn) => {
        child.once("spawn", resolveSpawn);
        child.once("error", rejectSpawn);
      });
      child.unref();
      return Object.freeze({
        status: "delivered",
        wakeId: context.wakeId,
        transport: "detached-process",
        pid: child.pid ?? null,
      });
    },
  });
}

export function createWakeAdapterRegistry(options = {}) {
  const adapters = new Map();
  const durable = createDurableFileWakeAdapter();
  adapters.set(durable.id, durable);
  for (const adapter of options.adapters ?? []) {
    requireDefinition(adapter);
    adapters.set(adapter.id, adapter);
  }
  return Object.freeze({
    get(id) {
      return adapters.get(id) ?? null;
    },
    list() {
      return [...adapters.values()].map(({ id, displayName }) => ({ id, displayName }));
    },
  });
}
