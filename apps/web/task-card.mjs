const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const TASK_MODES = new Set(["builder", "checker-test", "mixed-exception", "control-plane"]);
const RISK_VALUES = new Set(["no", "yes", "unknown"]);
const RISK_KEYS = [
  "public_api", "data_model", "security", "migration", "permission",
  "concurrency", "cross_module", "production_impact",
];
const TOP_LEVEL_KEYS = new Set([
  "schema_version", "id", "mode", "goal", "profiles", "scope", "acceptance",
  "risk", "handoff", "validation", "stop_conditions", "extensions",
]);
const LEGACY_KEYS = new Set([
  "id", "objective", "acceptance", "allowedPaths", "forbiddenPaths",
  "validationCommands", "allowNoChanges",
]);
const SCOPE_KEYS = new Set(["write_paths", "read_paths", "forbidden_paths"]);
const ACCEPTANCE_KEYS = new Set(["id", "description", "validation_id"]);
const HANDOFF_KEYS = new Set([
  "must_do", "must_not_do", "may_decide", "must_report", "stop_condition",
]);
const VALIDATION_KEYS = new Set(["id", "command", "description", "local_allowed"]);
const TASK_SHAPE_KEYS = new Set([
  "responsibilities", "new_modules", "split_decision", "split_reason",
]);
const COMPLEX_GATE_KEYS = new Set([
  "enabled", "counterexamples", "fail_closed_conditions", "not_applicable_reason",
]);
const DEFAULT_STOP_CONDITIONS = Object.freeze([
  "scope_boundary_crossed", "acceptance_unreachable", "external_blocker",
]);
const COMPLEX_GATE_MARKERS = [
  "aggregation", "aggregate", "eligibility", "quorum", "fallback",
  "acceptance gate", "gate logic", "admission gate", "fail-closed",
  "聚合", "门禁", "门控", "验收逻辑", "资格", "回退", "失败关闭",
];

export class TaskCardError extends Error {
  constructor(code, message, status = 400, path = null) {
    super(message);
    this.name = "TaskCardError";
    this.code = code;
    this.status = status;
    this.path = path;
  }
}

function fail(code, message, path = null) {
  throw new TaskCardError(code, message, 400, path);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertKnownKeys(value, keys, path) {
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) {
      fail("task.unknown_field", `Unknown field '${path}.${key}'.`, `${path}.${key}`);
    }
  }
}

function text(value, path, { maximum = 16_384 } = {}) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    fail("task.invalid", `${path} must be a non-empty string.`, path);
  }
  return value.trim();
}

function identifier(value, path) {
  const result = text(value, path, { maximum: 160 });
  if (!SAFE_ID.test(result)) {
    fail(
      "task.invalid_id",
      `${path} must start with an ASCII letter or digit and contain only letters, digits, '.', '_', or '-'.`,
      path,
    );
  }
  return result;
}

function textArray(value, path, { minimum = 0, maximum = 512 } = {}) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    fail(
      "task.invalid",
      `${path} must contain ${minimum === 0 ? "an array of" : `at least ${minimum}`} text item(s).`,
      path,
    );
  }
  return value.map((item, index) => text(item, `${path}[${index}]`, { maximum: 4096 }));
}

function normalizePath(value, path) {
  const original = text(value, path, { maximum: 4096 });
  const normalized = original.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/");
  if (
    !normalized || normalized === "." || normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..") ||
    normalized.includes("\0")
  ) {
    fail("task.unsafe_path", `${path} must stay relative to the worktree.`, path);
  }
  return normalized;
}

function pathArray(value, path, { minimum = 0 } = {}) {
  const values = textArray(value, path, { minimum });
  return values.map((item, index) => normalizePath(item, `${path}[${index}]`));
}

function unique(values, path) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) fail("task.duplicate_id", `${path} contains duplicate id '${value}'.`, path);
    seen.add(value);
  }
}

function validateScope(value) {
  if (!isObject(value)) fail("task.invalid", "scope must be an object.", "scope");
  assertKnownKeys(value, SCOPE_KEYS, "scope");
  return {
    write_paths: pathArray(value.write_paths, "scope.write_paths", { minimum: 1 }),
    ...(value.read_paths === undefined ? {} : {
      read_paths: pathArray(value.read_paths, "scope.read_paths"),
    }),
    ...(value.forbidden_paths === undefined ? {} : {
      forbidden_paths: pathArray(value.forbidden_paths, "scope.forbidden_paths"),
    }),
  };
}

function validateAcceptance(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 512) {
    fail("task.invalid", "acceptance must be a non-empty array.", "acceptance");
  }
  const result = value.map((item, index) => {
    const path = `acceptance[${index}]`;
    if (!isObject(item)) fail("task.invalid", `${path} must be an object.`, path);
    assertKnownKeys(item, ACCEPTANCE_KEYS, path);
    return {
      id: identifier(item.id, `${path}.id`),
      description: text(item.description, `${path}.description`, { maximum: 4096 }),
      ...(item.validation_id === undefined ? {} : {
        validation_id: identifier(item.validation_id, `${path}.validation_id`),
      }),
    };
  });
  unique(result.map((item) => item.id), "acceptance");
  return result;
}

function validateRisk(value) {
  if (!isObject(value)) fail("task.invalid", "risk must be an object.", "risk");
  assertKnownKeys(value, new Set(RISK_KEYS), "risk");
  const result = {};
  for (const key of RISK_KEYS) {
    if (value[key] === undefined) continue;
    if (!RISK_VALUES.has(value[key])) {
      fail("task.invalid", `risk.${key} must be 'no', 'yes', or 'unknown'.`, `risk.${key}`);
    }
    result[key] = value[key];
  }
  return result;
}

function validateHandoff(value) {
  if (!isObject(value)) fail("task.invalid", "handoff must be an object.", "handoff");
  assertKnownKeys(value, HANDOFF_KEYS, "handoff");
  const result = {};
  for (const key of HANDOFF_KEYS) {
    if (value[key] !== undefined) result[key] = textArray(value[key], `handoff.${key}`);
  }
  return result;
}

function validateCommands(value) {
  if (!Array.isArray(value) || value.length > 512) {
    fail("task.invalid", "validation must be an array.", "validation");
  }
  const result = value.map((item, index) => {
    const path = `validation[${index}]`;
    if (!isObject(item)) fail("task.invalid", `${path} must be an object.`, path);
    assertKnownKeys(item, VALIDATION_KEYS, path);
    const command = textArray(item.command, `${path}.command`, { minimum: 1, maximum: 64 });
    if (item.local_allowed !== undefined && typeof item.local_allowed !== "boolean") {
      fail("task.invalid", `${path}.local_allowed must be boolean.`, `${path}.local_allowed`);
    }
    return {
      id: identifier(item.id, `${path}.id`),
      command,
      ...(item.description === undefined ? {} : {
        description: text(item.description, `${path}.description`, { maximum: 4096 }),
      }),
      ...(item.local_allowed === undefined ? {} : { local_allowed: item.local_allowed }),
    };
  });
  unique(result.map((item) => item.id), "validation");
  return result;
}

function validateExtensions(value) {
  if (value === undefined) return {};
  if (!isObject(value)) fail("task.invalid", "extensions must be an object.", "extensions");
  const result = structuredClone(value);
  if (value.task_shape !== undefined) {
    if (!isObject(value.task_shape)) {
      fail("task.invalid", "extensions.task_shape must be an object.", "extensions.task_shape");
    }
    assertKnownKeys(value.task_shape, TASK_SHAPE_KEYS, "extensions.task_shape");
    for (const key of ["responsibilities", "new_modules"]) {
      if (value.task_shape[key] !== undefined) {
        result.task_shape[key] = textArray(value.task_shape[key], `extensions.task_shape.${key}`);
      }
    }
    if (
      value.task_shape.split_decision !== undefined &&
      !new Set(["split", "exception"]).has(value.task_shape.split_decision)
    ) {
      fail(
        "task.invalid",
        "extensions.task_shape.split_decision must be 'split' or 'exception'.",
        "extensions.task_shape.split_decision",
      );
    }
    if (value.task_shape.split_decision !== undefined) {
      result.task_shape.split_reason = text(
        value.task_shape.split_reason,
        "extensions.task_shape.split_reason",
      );
    }
  }
  if (value.complex_gate_contract !== undefined) {
    const gate = value.complex_gate_contract;
    if (!isObject(gate)) {
      fail(
        "task.invalid",
        "extensions.complex_gate_contract must be an object.",
        "extensions.complex_gate_contract",
      );
    }
    assertKnownKeys(gate, COMPLEX_GATE_KEYS, "extensions.complex_gate_contract");
    if (typeof gate.enabled !== "boolean") {
      fail(
        "task.invalid",
        "extensions.complex_gate_contract.enabled must be boolean.",
        "extensions.complex_gate_contract.enabled",
      );
    }
    if (gate.enabled) {
      result.complex_gate_contract.counterexamples = textArray(
        gate.counterexamples,
        "extensions.complex_gate_contract.counterexamples",
        { minimum: 2 },
      );
      result.complex_gate_contract.fail_closed_conditions = textArray(
        gate.fail_closed_conditions,
        "extensions.complex_gate_contract.fail_closed_conditions",
        { minimum: 1 },
      );
    } else {
      result.complex_gate_contract.not_applicable_reason = text(
        gate.not_applicable_reason,
        "extensions.complex_gate_contract.not_applicable_reason",
      );
    }
  }
  if (value.agent_control_plane !== undefined) {
    const extension = value.agent_control_plane;
    if (!isObject(extension)) {
      fail(
        "task.invalid",
        "extensions.agent_control_plane must be an object.",
        "extensions.agent_control_plane",
      );
    }
    assertKnownKeys(extension, new Set(["allow_no_changes"]), "extensions.agent_control_plane");
    if (extension.allow_no_changes !== undefined && typeof extension.allow_no_changes !== "boolean") {
      fail(
        "task.invalid",
        "extensions.agent_control_plane.allow_no_changes must be boolean.",
        "extensions.agent_control_plane.allow_no_changes",
      );
    }
  }
  return result;
}

function validateCanonicalTaskCard(task) {
  if (!isObject(task)) fail("task.invalid", "Task Card must be an object.");
  assertKnownKeys(task, TOP_LEVEL_KEYS, "task");
  if (task.schema_version !== 1) {
    fail("task.unsupported_schema", "schema_version must be exactly 1.", "schema_version");
  }
  if (!TASK_MODES.has(task.mode)) {
    fail("task.invalid", `mode must be one of: ${[...TASK_MODES].join(", ")}.`, "mode");
  }
  const profiles = textArray(task.profiles, "profiles", { minimum: 1, maximum: 64 });
  unique(profiles, "profiles");
  const acceptance = validateAcceptance(task.acceptance);
  const validation = validateCommands(task.validation);
  const validationIds = new Set(validation.map((item) => item.id));
  for (const item of acceptance) {
    if (item.validation_id && !validationIds.has(item.validation_id)) {
      fail(
        "task.invalid_reference",
        `Acceptance '${item.id}' references unknown validation '${item.validation_id}'.`,
        `acceptance.${item.id}.validation_id`,
      );
    }
  }
  const canonical = {
    schema_version: 1,
    id: identifier(task.id, "id"),
    mode: task.mode,
    goal: text(task.goal, "goal"),
    profiles,
    scope: validateScope(task.scope),
    acceptance,
    risk: validateRisk(task.risk),
    handoff: validateHandoff(task.handoff),
    validation,
    stop_conditions: textArray(task.stop_conditions, "stop_conditions"),
    extensions: validateExtensions(task.extensions),
  };
  const gateText = [
    canonical.goal,
    ...canonical.acceptance.map((item) => item.description),
    ...(canonical.extensions.task_shape?.responsibilities ?? []),
  ].join("\n").toLowerCase();
  if (
    COMPLEX_GATE_MARKERS.some((marker) => gateText.includes(marker)) &&
    canonical.extensions.complex_gate_contract === undefined
  ) {
    fail(
      "task.complex_gate_required",
      "extensions.complex_gate_contract is required for explicit aggregation, gate, or fallback semantics.",
      "extensions.complex_gate_contract",
    );
  }
  return deepFreeze(canonical);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function legacyRisk() {
  return Object.fromEntries(RISK_KEYS.map((key) => [key, "unknown"]));
}

function migrateLegacyTaskCard(task) {
  assertKnownKeys(task, LEGACY_KEYS, "legacy_task");
  const legacyAcceptance = textArray(task.acceptance, "legacy_task.acceptance", { minimum: 1 });
  const commands = task.validationCommands === undefined ? [] : task.validationCommands;
  if (!Array.isArray(commands)) {
    fail(
      "task.invalid",
      "legacy_task.validationCommands must be an array.",
      "legacy_task.validationCommands",
    );
  }
  return {
    schema_version: 1,
    id: task.id,
    mode: "builder",
    goal: task.objective,
    profiles: ["base"],
    scope: {
      write_paths: task.allowedPaths,
      read_paths: [],
      forbidden_paths: task.forbiddenPaths ?? [],
    },
    acceptance: legacyAcceptance.map((description, index) => ({
      id: `acceptance-${index + 1}`,
      description,
    })),
    risk: legacyRisk(),
    handoff: {
      must_do: ["Complete the declared goal and acceptance criteria."],
      must_not_do: ["Modify paths outside the declared scope."],
      may_decide: [],
      must_report: ["Changed paths", "Validation results", "Remaining risks"],
    },
    validation: commands.map((command, index) => ({
      id: `validation-${index + 1}`,
      command,
      description: `Migrated validation command ${index + 1}.`,
      local_allowed: true,
    })),
    stop_conditions: [...DEFAULT_STOP_CONDITIONS],
    extensions: task.allowNoChanges === true
      ? { agent_control_plane: { allow_no_changes: true } }
      : {},
  };
}

export function normalizeTaskCard(task, options = {}) {
  const allowLegacy = options.allowLegacy !== false;
  if (!isObject(task)) fail("task.invalid", "Task Card must be an object.");
  const legacy = task.schema_version === undefined && Object.hasOwn(task, "objective");
  if (legacy && !allowLegacy) {
    fail(
      "task.legacy_not_allowed",
      "legacy-v0 Task Cards must be migrated before this operation.",
    );
  }
  const canonical = validateCanonicalTaskCard(legacy ? migrateLegacyTaskCard(task) : task);
  return Object.freeze({
    task: canonical,
    migrated: legacy,
    sourceFormat: legacy ? "legacy-v0" : "task-card-v1",
  });
}

export function validateTaskCard(task, options) {
  return normalizeTaskCard(task, options).task;
}

export function createTaskCardTemplate() {
  return {
    schema_version: 1,
    id: "task-id",
    mode: "builder",
    goal: "Replace with one bounded outcome.",
    profiles: ["base"],
    scope: {
      write_paths: ["src/**"],
      read_paths: [],
      forbidden_paths: [".env", "secrets/**"],
    },
    acceptance: [{
      id: "acceptance-1",
      description: "Replace with one observable acceptance criterion.",
    }],
    risk: legacyRisk(),
    handoff: {
      must_do: ["Implement the bounded goal and collect deterministic evidence."],
      must_not_do: ["Modify files outside scope or broaden product semantics."],
      may_decide: ["Choose implementation details within the frozen contract."],
      must_report: ["Changed paths", "Validation results", "Remaining risks"],
    },
    validation: [],
    stop_conditions: [...DEFAULT_STOP_CONDITIONS],
    extensions: {},
  };
}

function markdownList(values, emptyLabel = "None") {
  if (values.length === 0) return `- ${emptyLabel}`;
  return values.map((value) => `- ${String(value).replaceAll("\n", "\n  ")}`).join("\n");
}

function markdownTable(headers, rows) {
  if (rows.length === 0) return "_(none)_";
  const escape = (value) => String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", "<br>");
  return [
    `| ${headers.map(escape).join(" | ")} |`,
    `|${headers.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${row.map(escape).join(" | ")} |`),
  ].join("\n");
}

function renderScope(scope) {
  const sections = [];
  for (const [key, label] of [
    ["write_paths", "Write paths"],
    ["read_paths", "Read paths"],
    ["forbidden_paths", "Forbidden paths"],
  ]) {
    if (scope[key]?.length) sections.push(`**${label}:**\n${markdownList(scope[key])}`);
  }
  return sections.join("\n\n");
}

function renderValidation(validation) {
  if (validation.length === 0) return "_(none)_";
  return validation.map((item) => {
    const description = item.description ? ` — ${item.description}` : "";
    const local = item.local_allowed === false ? " (local execution disabled)" : "";
    return `- **${item.id}:** \`${JSON.stringify(item.command)}\`${description}${local}`;
  }).join("\n");
}

function renderComplexGate(task) {
  const gate = task.extensions.complex_gate_contract;
  if (!gate?.enabled) return "";
  return [
    "## Complex Gate Contract", "",
    `**Counterexamples that must remain rejected:**\n${markdownList(gate.counterexamples)}`,
    "",
    `**Fail-closed conditions:**\n${markdownList(gate.fail_closed_conditions)}`,
  ].join("\n");
}

export function renderTaskCardMarkdown(taskInput, options = {}) {
  const task = validateTaskCard(taskInput);
  const view = options.view ?? "audit";
  if (!new Set(["audit", "execution"]).has(view)) {
    fail("task.invalid_view", "Task Card view must be 'audit' or 'execution'.");
  }
  const sections = [
    view === "execution"
      ? `<!-- agent-control-plane-execution-card-v1; task-mode=${task.mode} -->\n# Task: ${task.id}`
      : `# Task Card: ${task.goal}`,
    "",
  ];
  if (view === "audit") {
    sections.push(
      "## Task Identity", "",
      markdownTable(["Field", "Value"], [
        ["ID", task.id], ["Mode", task.mode], ["Schema Version", task.schema_version],
        ["Profiles", task.profiles.join(", ")],
      ]), "",
    );
  }
  sections.push(
    "## Goal", "", task.goal, "", "## Scope", "", renderScope(task.scope), "",
  );
  const complexGate = renderComplexGate(task);
  if (complexGate) sections.push(complexGate, "");
  sections.push(
    "## Acceptance Criteria", "",
    markdownTable(
      view === "audit" ? ["ID", "Description", "Validation"] : ["ID", "Description"],
      task.acceptance.map((item) => view === "audit"
        ? [item.id, item.description, item.validation_id ?? ""]
        : [item.id, item.description]),
    ), "",
  );
  if (view === "audit") {
    sections.push(
      "## Risk Assessment", "",
      markdownTable(["Category", "Value"], Object.entries(task.risk)), "",
    );
    const handoffSections = [];
    for (const key of HANDOFF_KEYS) {
      if (task.handoff[key]?.length) {
        handoffSections.push(
          `**${key.replaceAll("_", " ")}:**\n${markdownList(task.handoff[key])}`,
        );
      }
    }
    sections.push("## Handoff Contract", "", handoffSections.join("\n\n") || "_(none)_", "");
  }
  sections.push(
    view === "audit" ? "## Validation" : "## Validation Contract", "",
    renderValidation(task.validation), "", "## Stop Conditions", "",
    markdownList(task.stop_conditions), "",
  );
  if (view === "audit" && Object.keys(task.extensions).length > 0) {
    sections.push(
      "## Extensions", "", `\`\`\`json\n${JSON.stringify(task.extensions, null, 2)}\n\`\`\``, "",
    );
  }
  return sections.join("\n");
}

export function taskAllowsNoChanges(taskInput) {
  const task = validateTaskCard(taskInput);
  return task.extensions.agent_control_plane?.allow_no_changes === true;
}

export function taskValidationCommands(taskInput) {
  return validateTaskCard(taskInput).validation
    .filter((item) => item.local_allowed !== false)
    .map((item) => [...item.command]);
}

export function createNextCycleTemplate(currentTaskInput) {
  const currentTask = validateTaskCard(currentTaskInput);
  return {
    rationale: "Explain why this remains aligned with the original improvement purpose.",
    expected_gain: "Define one measurable improvement.",
    rollback_boundary: "Describe what this cycle alone may change and revert.",
    added_paths: [],
    task: structuredClone({
      ...currentTask,
      id: `${currentTask.id.slice(0, 154)}-next`,
    }),
  };
}
