import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BUILTIN_MODE_CATALOG,
  CODEX_OVERNIGHT_CLAUDE_PROFILE,
  EXAMPLE_AGENTS,
  resolveEffectiveSkill,
} from "../../../packages/contracts/dist/index.js";
import { createSkillStore, SkillStoreError } from "../skill-store.mjs";

async function withTempDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "agent-workflow-store-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function testStore(skillsDir) {
  let nonce = 0;
  return createSkillStore({
    skillsDir,
    clock: () => new Date("2026-08-28T01:02:03.000Z"),
    nonceFactory: () => `nonce-${++nonce}`,
  });
}

function resolveMode(modeId) {
  const mode = BUILTIN_MODE_CATALOG.modes.find((entry) => entry.id === modeId);
  assert(mode);
  const interactive = modeId === "interactive";
  const profile = {
    ...CODEX_OVERNIGHT_CLAUDE_PROFILE,
    id: `codex-${modeId}`,
    mode: { id: mode.id, version: mode.version },
    roleBindings: interactive
      ? [{ role: "subagent", target: { kind: "main-native" } }]
      : CODEX_OVERNIGHT_CLAUDE_PROFILE.roleBindings,
  };
  const result = resolveEffectiveSkill({
    profile,
    agents: EXAMPLE_AGENTS,
    catalog: BUILTIN_MODE_CATALOG,
  });
  assert.equal(result.ok, true);
  return result.value;
}

test("preview-only store rejects writes", async () => {
  const store = createSkillStore();
  assert.deepEqual(await store.status(), {
    writeEnabled: false,
    skillsDir: null,
    health: "preview-only",
    active: null,
    backups: [],
  });
  await assert.rejects(
    store.activate(resolveMode("overnight")),
    (error) => error instanceof SkillStoreError && error.code === "store.preview_only",
  );
});

test("activation writes an owned minimal Skill atomically", async () => {
  await withTempDirectory(async (skillsDir) => {
    const store = testStore(skillsDir);
    const variant = resolveMode("overnight");
    const result = await store.activate(variant);

    assert.equal(result.changed, true);
    assert.equal(result.backupId, null);
    assert.equal(
      await readFile(join(skillsDir, "agent-workflow-active", "SKILL.md"), "utf8"),
      variant.content,
    );
    const manifest = JSON.parse(
      await readFile(join(skillsDir, "agent-workflow-active", "manifest.json"), "utf8"),
    );
    assert.equal(manifest.owner, "agent-workflow-switch");
    assert.equal(manifest.variantId, variant.id);
    assert.equal(result.status.active.variantId, variant.id);
    assert.deepEqual(result.status.backups, []);
  });
});

test("switching creates a recoverable backup and rollback preserves both versions", async () => {
  await withTempDirectory(async (skillsDir) => {
    const store = testStore(skillsDir);
    const overnight = resolveMode("overnight");
    const balanced = resolveMode("balanced");
    await store.activate(overnight);
    const switched = await store.activate(balanced);

    assert.equal(switched.status.active.variantId, balanced.id);
    assert.equal(switched.status.backups.length, 1);
    assert.equal(switched.status.backups[0].variantId, overnight.id);

    const restored = await store.rollback(switched.status.backups[0].backupId);
    assert.equal(restored.status.active.variantId, overnight.id);
    assert.equal(
      await readFile(join(skillsDir, "agent-workflow-active", "SKILL.md"), "utf8"),
      overnight.content,
    );
    assert(restored.status.backups.some((entry) => entry.variantId === balanced.id));
  });
});

test("activation refuses to overwrite an unowned Skill directory", async () => {
  await withTempDirectory(async (skillsDir) => {
    const active = join(skillsDir, "agent-workflow-active");
    await mkdir(active);
    await writeFile(join(active, "SKILL.md"), "user-owned", "utf8");
    const store = testStore(skillsDir);

    await assert.rejects(
      store.activate(resolveMode("overnight")),
      (error) =>
        error instanceof SkillStoreError && error.code === "store.ownership_conflict",
    );
    assert.equal(await readFile(join(active, "SKILL.md"), "utf8"), "user-owned");
  });
});

test("activation refuses an existing unowned control directory", async () => {
  await withTempDirectory(async (skillsDir) => {
    const control = join(skillsDir, ".agent-workflow-switch");
    await mkdir(control);
    await writeFile(join(control, "user-data.txt"), "preserve", "utf8");
    const store = testStore(skillsDir);

    await assert.rejects(
      store.activate(resolveMode("overnight")),
      (error) =>
        error instanceof SkillStoreError && error.code === "store.ownership_conflict",
    );
    assert.equal(await readFile(join(control, "user-data.txt"), "utf8"), "preserve");
  });
});

test("filesystem root is never accepted as a Skill directory", () => {
  assert.throws(
    () => createSkillStore({ skillsDir: "/" }),
    (error) => error instanceof SkillStoreError && error.code === "store.invalid_root",
  );
});

test("tampered managed Skill fails integrity checks before replacement", async () => {
  await withTempDirectory(async (skillsDir) => {
    const store = testStore(skillsDir);
    await store.activate(resolveMode("overnight"));
    const skillPath = join(skillsDir, "agent-workflow-active", "SKILL.md");
    await writeFile(skillPath, "tampered", "utf8");

    await assert.rejects(
      store.activate(resolveMode("balanced")),
      (error) => error instanceof SkillStoreError && error.code === "store.content_mismatch",
    );
    assert.equal(await readFile(skillPath, "utf8"), "tampered");
  });
});

test("existing lock fails closed without changing the active Skill", async () => {
  await withTempDirectory(async (skillsDir) => {
    const store = testStore(skillsDir);
    const overnight = resolveMode("overnight");
    await store.activate(overnight);
    const lockDirectory = join(skillsDir, ".agent-workflow-switch");
    await writeFile(join(lockDirectory, "activation.lock"), "occupied", "utf8");

    await assert.rejects(
      store.activate(resolveMode("balanced")),
      (error) => error instanceof SkillStoreError && error.code === "store.locked",
    );
    assert.equal(
      await readFile(join(skillsDir, "agent-workflow-active", "SKILL.md"), "utf8"),
      overnight.content,
    );
  });
});

test("rollback rejects path-like backup identifiers", async () => {
  await withTempDirectory(async (skillsDir) => {
    const store = testStore(skillsDir);
    await assert.rejects(
      store.rollback("../outside"),
      (error) => error instanceof SkillStoreError && error.code === "rollback.invalid_id",
    );
  });
});
