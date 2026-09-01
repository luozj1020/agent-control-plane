import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  TaskCardError,
  createNextCycleTemplate,
  createTaskCardTemplate,
  normalizeTaskCard,
  renderTaskCardMarkdown,
  taskAllowsNoChanges,
  taskValidationCommands,
  validateTaskCard,
} from "../task-card.mjs";

function runCli(args, cwd) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [new URL("../balanced-cli.mjs", import.meta.url).pathname, ...args],
      { cwd, encoding: "utf8" },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }),
    );
  });
}

test("Task Card v1 scaffold contains the complete frozen contract", () => {
  const validated = validateTaskCard(createTaskCardTemplate());
  assert.equal(validated.schema_version, 1);
  assert.equal(validated.mode, "builder");
  assert.deepEqual(validated.profiles, ["base"]);
  assert.deepEqual(validated.scope.write_paths, ["src/**"]);
  assert.equal(validated.acceptance[0].id, "acceptance-1");
  assert.deepEqual(validated.validation, []);
  assert.deepEqual(validated.stop_conditions, [
    "scope_boundary_crossed",
    "acceptance_unreachable",
    "external_blocker",
  ]);
});

test("legacy-v0 cards migrate deterministically and retain no-change intent as an extension", () => {
  const legacy = {
    id: "legacy-task",
    objective: "Implement one bounded behavior.",
    acceptance: ["The behavior is observable."],
    allowedPaths: ["src/**"],
    forbiddenPaths: ["secrets/**"],
    validationCommands: [["npm", "test"]],
    allowNoChanges: true,
  };
  const normalized = normalizeTaskCard(legacy);
  assert.equal(normalized.migrated, true);
  assert.equal(normalized.sourceFormat, "legacy-v0");
  assert.equal(normalized.task.goal, legacy.objective);
  assert.deepEqual(normalized.task.scope.write_paths, legacy.allowedPaths);
  assert.deepEqual(normalized.task.acceptance, [{
    id: "acceptance-1",
    description: legacy.acceptance[0],
  }]);
  assert.deepEqual(taskValidationCommands(normalized.task), [["npm", "test"]]);
  assert.equal(taskAllowsNoChanges(normalized.task), true);
  assert.throws(
    () => normalizeTaskCard(legacy, { allowLegacy: false }),
    (error) => error instanceof TaskCardError && error.code === "task.legacy_not_allowed",
  );
});

test("audit and execution Markdown are deterministic projections with different disclosure", () => {
  const task = createTaskCardTemplate();
  task.id = "bounded-change";
  task.goal = "Ship one observable behavior.";
  task.validation = [{
    id: "unit-tests",
    command: ["npm", "test"],
    description: "Run unit tests.",
    local_allowed: true,
  }];
  task.acceptance[0].validation_id = "unit-tests";
  const audit = renderTaskCardMarkdown(task, { view: "audit" });
  const execution = renderTaskCardMarkdown(task, { view: "execution" });
  assert.match(audit, /^# Task Card:/m);
  assert.match(audit, /## Risk Assessment/);
  assert.match(audit, /## Handoff Contract/);
  assert.match(audit, /unit-tests/);
  assert.match(execution, /agent-control-plane-execution-card-v1/);
  assert.match(execution, /# Task: bounded-change/);
  assert.doesNotMatch(execution, /Risk Assessment/);
  assert.doesNotMatch(execution, /Handoff Contract/);
});

test("v1 validation rejects unknown fields, unsafe paths, duplicate ids, and broken references", () => {
  const template = createTaskCardTemplate();
  assert.throws(
    () => validateTaskCard({ ...template, model: "hidden-routing" }),
    (error) => error instanceof TaskCardError && error.code === "task.unknown_field",
  );
  assert.throws(
    () => validateTaskCard({
      ...template,
      scope: { ...template.scope, write_paths: ["../outside"] },
    }),
    (error) => error instanceof TaskCardError && error.code === "task.unsafe_path",
  );
  assert.throws(
    () => validateTaskCard({
      ...template,
      acceptance: [...template.acceptance, { ...template.acceptance[0] }],
    }),
    (error) => error instanceof TaskCardError && error.code === "task.duplicate_id",
  );
  assert.throws(
    () => validateTaskCard({
      ...template,
      acceptance: [{ ...template.acceptance[0], validation_id: "missing" }],
    }),
    (error) => error instanceof TaskCardError && error.code === "task.invalid_reference",
  );
});

test("complex gate tasks require negative counterexamples and fail-closed conditions", () => {
  const template = createTaskCardTemplate();
  template.goal = "Implement an eligibility fallback gate.";
  assert.throws(
    () => validateTaskCard(template),
    (error) => error instanceof TaskCardError && error.code === "task.complex_gate_required",
  );
  template.extensions.complex_gate_contract = {
    enabled: true,
    counterexamples: ["Missing eligibility evidence", "A rejected member enters quorum"],
    fail_closed_conditions: ["Evidence is missing or contradictory"],
  };
  assert.equal(validateTaskCard(template).extensions.complex_gate_contract.enabled, true);
});

test("structured coordination interfaces bind every boundary to participants and validation", () => {
  const task = createTaskCardTemplate();
  task.validation = [{
    id: "interface-test",
    command: ["npm", "test", "--", "interface"],
    description: "Exercise the parser-renderer boundary.",
  }];
  task.extensions.task_shape = {
    responsibilities: ["Parse input", "Render output"],
    participants: [
      { id: "parser", owner: "worker", responsibilities: ["Produce normalized AST"] },
      { id: "renderer", owner: "worker", responsibilities: ["Consume AST and render output"] },
    ],
    interfaces: [{
      id: "ast-boundary",
      producer: "parser",
      consumer: "renderer",
      owner: "renderer",
      contract: "Normalized AST preserves source ranges.",
      validation_id: "interface-test",
    }],
  };
  const validated = validateTaskCard(task);
  assert.equal(validated.extensions.task_shape.interfaces[0].owner, "renderer");
  for (const view of ["audit", "execution"]) {
    const markdown = renderTaskCardMarkdown(task, { view });
    assert.match(markdown, /## Coordination Interfaces/);
    assert.match(markdown, /ast-boundary/);
    assert.match(markdown, /Normalized AST preserves source ranges/);
  }

  const unknownOwner = structuredClone(task);
  unknownOwner.extensions.task_shape.interfaces[0].owner = "coordinator";
  assert.throws(
    () => validateTaskCard(unknownOwner),
    (error) => error instanceof TaskCardError && error.code === "task.invalid_reference" &&
      error.path.endsWith(".owner"),
  );
  const sameEndpoint = structuredClone(task);
  sameEndpoint.extensions.task_shape.interfaces[0].consumer = "parser";
  assert.throws(
    () => validateTaskCard(sameEndpoint),
    (error) => error instanceof TaskCardError && error.code === "task.invalid_interface",
  );
  const missingValidation = structuredClone(task);
  missingValidation.extensions.task_shape.interfaces[0].validation_id = "missing";
  assert.throws(
    () => validateTaskCard(missingValidation),
    (error) => error instanceof TaskCardError && error.code === "task.invalid_reference" &&
      error.path.endsWith(".validation_id"),
  );
});

test("next-cycle scaffold preserves the complete acceptance and authority floor", () => {
  const current = createTaskCardTemplate();
  current.id = "current-cycle";
  current.scope.write_paths = ["src/**", "test/**"];
  const validated = validateTaskCard(current);
  const next = createNextCycleTemplate(validated);
  assert.equal(next.task.id, "current-cycle-next");
  assert.deepEqual(next.task.acceptance, validated.acceptance);
  assert.deepEqual(next.task.scope, validated.scope);
  assert.deepEqual(next.task.risk, validated.risk);
  assert.deepEqual(next.task.handoff, validated.handoff);
  assert.deepEqual(next.task.stop_conditions, validated.stop_conditions);
  assert.deepEqual(next.added_paths, []);
});

test("Task Card CLI creates, validates, renders, and explicitly migrates without overwriting", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-control-task-card-"));
  const output = join(root, "TASK.json");
  const legacyPath = join(root, "LEGACY.json");
  const migratedPath = join(root, "MIGRATED.json");
  const markdownPath = join(root, "TASK.md");
  try {
    const created = await runCli(["task", "init", "--output", output], root);
    assert.equal(created.error, null, created.stderr);
    const task = JSON.parse(await readFile(output, "utf8"));
    task.goal = "Implement one bounded behavior.";
    task.acceptance[0].description = "The behavior is observable.";
    await writeFile(output, `${JSON.stringify(task, null, 2)}\n`, "utf8");

    const validated = await runCli(["task", "validate", "--task", output], root);
    assert.equal(validated.error, null, validated.stderr);
    const rendered = await runCli([
      "task", "render", "--task", output, "--view", "execution", "--output", markdownPath,
    ], root);
    assert.equal(rendered.error, null, rendered.stderr);
    assert.match(await readFile(markdownPath, "utf8"), /# Task: task-id/);

    await writeFile(legacyPath, JSON.stringify({
      id: "legacy-cli",
      objective: "Migrate this contract.",
      acceptance: ["Migration is deterministic."],
      allowedPaths: ["src/**"],
      forbiddenPaths: [],
      validationCommands: [],
    }), "utf8");
    const migrated = await runCli([
      "task", "migrate", "--task", legacyPath, "--output", migratedPath,
    ], root);
    assert.equal(migrated.error, null, migrated.stderr);
    assert.equal(JSON.parse(await readFile(migratedPath, "utf8")).schema_version, 1);

    const duplicate = await runCli(["task", "init", "--output", output], root);
    assert.notEqual(duplicate.error, null);
    assert.equal(duplicate.error.code, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
