import { isAbsolute, relative, resolve, sep } from "node:path";

export const READ_CONTAINMENT = Object.freeze([
  "exact-paths",
  "partial-event-audit",
  "unsupported",
]);
export const WRITE_CONTAINMENT = Object.freeze([
  "exact-paths",
  "post-run-audit",
  "unsupported",
]);

function selected(value, allowed, fallback, label) {
  const result = value ?? fallback;
  if (!allowed.includes(result)) throw new TypeError(`${label} '${result}' is unsupported.`);
  return result;
}

export function normalizeAdapterContainment(adapter = {}, options = {}) {
  const legacyWrite = adapter.filesystemIsolation === "exact-write-paths"
    ? "exact-paths"
    : adapter.filesystemIsolation === "post-run-only"
      ? "post-run-audit"
      : "unsupported";
  const read = selected(
    adapter.readContainment ?? adapter.containment?.read,
    READ_CONTAINMENT,
    "unsupported",
    "readContainment",
  );
  const write = selected(
    adapter.writeContainment ?? adapter.containment?.write,
    WRITE_CONTAINMENT,
    legacyWrite,
    "writeContainment",
  );
  const eventSource = adapter.filesystemEventSource ?? adapter.containment?.eventSource ?? null;
  if (
    options.requireExtractor !== false &&
    read === "partial-event-audit" &&
    typeof adapter.extractFilesystemEvents !== "function"
  ) {
    throw new TypeError("partial-event-audit requires extractFilesystemEvents(record).");
  }
  return Object.freeze({ read, write, eventSource });
}

export function normalizeObservedArtifactPath(value, worktree) {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) return null;
  const original = value.trim();
  if (/^[A-Za-z]:[\\/]/.test(original) && process.platform !== "win32") return "@outside-worktree";
  const root = resolve(worktree);
  const absolute = isAbsolute(original) ? resolve(original) : resolve(root, original);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) return "@outside-worktree";
  const path = relative(root, absolute).replaceAll("\\", "/");
  return path && path !== "." ? path : null;
}

export function extractClaudeFilesystemEvents(record) {
  const content = record?.message?.content ?? record?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((entry) => {
    if (entry?.type !== "tool_use" || entry?.name !== "Read") return [];
    const path = entry.input?.file_path ?? entry.input?.path;
    return typeof path === "string" && path.trim()
      ? [{ operation: "read", path, tool: "Read" }]
      : [];
  });
}

function globExpression(pattern) {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const wildcard = /[*?]/.test(normalized);
  let expression = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*" && normalized[index + 1] === "*") {
      expression += ".*";
      index += 1;
    } else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${expression}${wildcard ? "" : "(?:/.*)?"}$`);
}

export function classifyObservedRead(task, path) {
  const forbidden = (task.scope.forbidden_paths ?? []).map(globExpression);
  const allowed = [
    ...(task.scope.write_paths ?? []),
    ...(task.scope.read_paths ?? []),
  ].map(globExpression);
  if (forbidden.some((pattern) => pattern.test(path))) return "forbidden";
  if (allowed.some((pattern) => pattern.test(path))) return "allowed";
  return "out-of-scope";
}
