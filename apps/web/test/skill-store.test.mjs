import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

function resolveMode(modeId, balancedBudget, balancedTiming) {
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
    ...(balancedBudget ? { balancedBudget } : {}),
    ...(balancedTiming ? { balancedTiming } : {}),
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

test("store rejects a resolved variant with out-of-range Balanced timing", async () => {
  await withTempDirectory(async (skillsDir) => {
    const store = testStore(skillsDir);
    const balanced = resolveMode("balanced");
    await assert.rejects(
      store.activate({
        ...balanced,
        balancedTiming: {
          ...balanced.balancedTiming,
          activeWindowSeconds: 3_601,
        },
      }),
      (error) => error instanceof SkillStoreError && error.code === "variant.invalid",
    );
  });
});

test("activation writes an owned minimal Skill atomically", async () => {
  await withTempDirectory(async (skillsDir) => {
    const store = testStore(skillsDir);
    const variant = resolveMode("overnight");
    const result = await store.activate(variant);

    assert.equal(result.changed, true);
    assert.equal(result.activationKind, "activate");
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

test("activating the identical mode is unchanged and creates no duplicate history", async () => {
  await withTempDirectory(async (skillsDir) => {
    const store = testStore(skillsDir);
    const overnight = resolveMode("overnight");
    await store.activate(overnight);
    const repeated = await store.activate(overnight);

    assert.equal(repeated.changed, false);
    assert.equal(repeated.activationKind, "unchanged");
    assert.equal(repeated.backupId, null);
    assert.equal((await store.history()).entries.length, 1);
  });
});

test("switching creates a recoverable backup and rollback preserves both versions", async () => {
  await withTempDirectory(async (skillsDir) => {
    const store = testStore(skillsDir);
    const overnight = resolveMode("overnight");
    const balanced = resolveMode("balanced");
    await store.activate(overnight);
    const switched = await store.activate(balanced);

    assert.equal(switched.activationKind, "overwrite");
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

test("Balanced budget and timing survive status, backup, and rollback", async () => {
  await withTempDirectory(async (skillsDir) => {
    const store = testStore(skillsDir);
    const budget = {
      mainReviewCalls: 4,
      downstreamCalls: 5,
      advisorCalls: 2,
      reservedFinalReviewCalls: 1,
    };
    const timing = {
      contextAcquisitionSeconds: 480,
      firstProgressSeconds: 420,
      activeWindowSeconds: 540,
      progressExtensionSeconds: 240,
      growingProgressExtensionSeconds: 300,
      hardCapSeconds: 1800,
    };
    const balanced = resolveMode("balanced", budget, timing);
    const activated = await store.activate(balanced);
    assert.deepEqual(activated.status.active.balancedBudget, budget);
    assert.deepEqual(activated.status.active.balancedTiming, timing);

    const switched = await store.activate(resolveMode("overnight"));
    const balancedBackup = switched.status.backups.find(
      (entry) => entry.variantId === balanced.id,
    );
    assert(balancedBackup);
    const restored = await store.rollback(balancedBackup.backupId);
    assert.deepEqual(restored.status.active.balancedBudget, budget);
    assert.deepEqual(restored.status.active.balancedTiming, timing);
  });
});

test("activation history persists immutable snapshots and restores any entry", async () => {
  await withTempDirectory(async (skillsDir) => {
    const store = testStore(skillsDir);
    const overnight = resolveMode("overnight");
    const balanced = resolveMode("balanced");
    await store.activate(overnight);
    await store.activate(balanced);

    const history = await store.history();
    assert.equal(history.available, true);
    assert.equal(history.entries.length, 2);
    assert.equal(history.entries.filter((entry) => entry.isActive).length, 1);
    const overnightEntry = history.entries.find((entry) => entry.variantId === overnight.id);
    assert(overnightEntry);

    const detail = await store.historyDetail(overnightEntry.historyId);
    assert.equal(detail.entry.variantId, overnight.id);
    assert.equal(detail.diff.available, true);
    assert(detail.diff.summary.added > 0);
    assert(detail.diff.summary.removed > 0);
    assert(detail.fieldChanges.some((change) => change.field === "mode"));

    const restored = await store.restoreHistory(overnightEntry.historyId);
    assert.equal(restored.changed, true);
    assert.equal(restored.status.active.variantId, overnight.id);
    assert.equal(
      await readFile(join(skillsDir, "agent-workflow-active", "SKILL.md"), "utf8"),
      overnight.content,
    );

    const reopened = testStore(skillsDir);
    const persisted = await reopened.history();
    assert.equal(persisted.entries.length, 3);
    assert.equal(persisted.entries.filter((entry) => entry.isActive).length, 1);
    const restoreEvent = persisted.entries.find(
      (entry) => entry.action === "restore-history",
    );
    assert(restoreEvent);
    assert.equal(restoreEvent.sourceHistoryId, overnightEntry.historyId);
  });
});

test("history lookup refuses a replaced symlink root", async () => {
  await withTempDirectory(async (skillsDir) => {
    const store = testStore(skillsDir);
    await store.activate(resolveMode("overnight"));
    const historyRoot = join(skillsDir, ".agent-workflow-switch", "history");
    await rm(historyRoot, { recursive: true });
    await symlink(skillsDir, historyRoot, "dir");

    await assert.rejects(
      store.history(),
      (error) => error instanceof SkillStoreError && error.code === "history.corrupt_root",
    );
  });
});

test("activation refuses an unsafe history root without changing the active Skill", async () => {
  await withTempDirectory(async (skillsDir) => {
    const store = testStore(skillsDir);
    const overnight = resolveMode("overnight");
    await store.activate(overnight);
    const historyRoot = join(skillsDir, ".agent-workflow-switch", "history");
    await rm(historyRoot, { recursive: true });
    await writeFile(historyRoot, "unsafe", "utf8");

    await assert.rejects(
      store.activate(resolveMode("balanced")),
      (error) => error instanceof SkillStoreError && error.code === "store.unsafe_directory",
    );
    assert.equal(
      await readFile(join(skillsDir, "agent-workflow-active", "SKILL.md"), "utf8"),
      overnight.content,
    );
  });
});

test("history integrity failures are reported without exposing corrupt content", async () => {
  await withTempDirectory(async (skillsDir) => {
    const store = testStore(skillsDir);
    await store.activate(resolveMode("overnight"));
    const history = await store.history();
    const historyId = history.entries[0].historyId;
    await writeFile(
      join(skillsDir, ".agent-workflow-switch", "history", historyId, "SKILL.md"),
      "tampered",
      "utf8",
    );

    const afterTamper = await store.history();
    assert.equal(afterTamper.entries.length, 0);
    assert.equal(afterTamper.corruptEntries, 1);
    await assert.rejects(
      store.historyDetail(historyId),
      (error) =>
        error instanceof SkillStoreError && error.code === "history.content_mismatch",
    );
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

test("history restore rejects path-like identifiers", async () => {
  await withTempDirectory(async (skillsDir) => {
    const store = testStore(skillsDir);
    await assert.rejects(
      store.restoreHistory("../outside"),
      (error) => error instanceof SkillStoreError && error.code === "history.invalid_id",
    );
  });
});
