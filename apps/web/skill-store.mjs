import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, parse, resolve } from "node:path";

const OWNER = "agent-workflow-switch";
const ACTIVE_DIRECTORY = "agent-workflow-active";
const CONTROL_DIRECTORY = ".agent-workflow-switch";
const CONTROL_OWNER_FILE = "owner.json";
const MANIFEST_FILE = "manifest.json";
const SKILL_FILE = "SKILL.md";

export class SkillStoreError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "SkillStoreError";
    this.code = code;
    this.status = status;
  }
}

async function pathType(path) {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) return "symlink";
    if (metadata.isDirectory()) return "directory";
    if (metadata.isFile()) return "file";
    return "other";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

function safeIdentifier(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,159}$/.test(value);
}

function sha256(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function assertVariant(variant) {
  if (
    !variant ||
    !safeIdentifier(variant.id) ||
    typeof variant.content !== "string" ||
    variant.content.length === 0 ||
    variant.content.length > 128 * 1024 ||
    typeof variant.contentFingerprint !== "string" ||
    !Array.isArray(variant.includedModeIds) ||
    variant.includedModeIds.length !== 1
  ) {
    throw new SkillStoreError("variant.invalid", "Resolved Skill variant is invalid.");
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      throw new SkillStoreError("store.corrupt_json", `Invalid JSON at ${path}.`, 409);
    }
    throw error;
  }
}

async function writeJsonAtomic(path, value, nonce) {
  const temporary = `${path}.tmp-${nonce}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function manifestFor(variant, now, restoredFrom) {
  const manifest = {
    schemaVersion: 1,
    owner: OWNER,
    variantId: variant.id,
    mode: variant.mode,
    profileId: variant.profileId,
    mainAgentId: variant.mainAgentId,
    contentFingerprint: variant.contentFingerprint,
    contentSha256: sha256(variant.content),
    activatedAt: now,
  };
  if (restoredFrom) manifest.restoredFrom = restoredFrom;
  return manifest;
}

async function readOwnedDirectory(directory) {
  const type = await pathType(directory);
  if (type === "missing") return null;
  if (type !== "directory") {
    throw new SkillStoreError(
      "store.ownership_conflict",
      `Managed path is a ${type}, not an owned directory.`,
      409,
    );
  }
  const manifest = await readJson(join(directory, MANIFEST_FILE));
  if (!manifest || manifest.owner !== OWNER || manifest.schemaVersion !== 1) {
    throw new SkillStoreError(
      "store.ownership_conflict",
      "Existing active Skill is not owned by Agent Workflow Switch.",
      409,
    );
  }
  const skillPath = join(directory, SKILL_FILE);
  const skillType = await pathType(skillPath);
  if (skillType !== "file") {
    throw new SkillStoreError(
      "store.corrupt_active",
      "Owned active Skill is missing SKILL.md.",
      409,
    );
  }
  const content = await readFile(skillPath, "utf8");
  if (
    typeof manifest.contentSha256 !== "string" ||
    manifest.contentSha256 !== sha256(content)
  ) {
    throw new SkillStoreError(
      "store.content_mismatch",
      "Managed SKILL.md does not match its ownership manifest.",
      409,
    );
  }
  return manifest;
}

export function createSkillStore(options = {}) {
  const configured = options.skillsDir;
  if (configured !== undefined && (!isAbsolute(configured) || configured.trim() === "")) {
    throw new SkillStoreError(
      "store.invalid_root",
      "AGENT_WORKFLOW_SKILLS_DIR must be an absolute path.",
    );
  }
  const skillsDir = configured === undefined ? null : resolve(configured);
  if (skillsDir && skillsDir === parse(skillsDir).root) {
    throw new SkillStoreError(
      "store.invalid_root",
      "The filesystem root cannot be used as a managed Skill directory.",
    );
  }
  const clock = options.clock ?? (() => new Date());
  const nonceFactory = options.nonceFactory ?? randomUUID;

  const paths = skillsDir
    ? {
        active: join(skillsDir, ACTIVE_DIRECTORY),
        backups: join(skillsDir, CONTROL_DIRECTORY, "backups"),
        control: join(skillsDir, CONTROL_DIRECTORY),
        lock: join(skillsDir, CONTROL_DIRECTORY, "activation.lock"),
        state: join(skillsDir, CONTROL_DIRECTORY, "state.json"),
      }
    : null;

  function requireEnabled() {
    if (!paths || !skillsDir) {
      throw new SkillStoreError(
        "store.preview_only",
        "Filesystem activation is disabled. Set AGENT_WORKFLOW_SKILLS_DIR explicitly.",
        409,
      );
    }
    return { paths, skillsDir };
  }

  async function ensureControlDirectories() {
    const enabled = requireEnabled();
    const rootType = await pathType(enabled.skillsDir);
    if (rootType === "missing") {
      await mkdir(enabled.skillsDir, { recursive: true, mode: 0o700 });
    } else if (rootType !== "directory") {
      throw new SkillStoreError(
        "store.unsafe_directory",
        `Refusing ${rootType} at managed directory ${enabled.skillsDir}.`,
        409,
      );
    }

    const controlType = await pathType(enabled.paths.control);
    if (controlType === "missing") {
      await mkdir(enabled.paths.control, { mode: 0o700 });
      await writeFile(
        join(enabled.paths.control, CONTROL_OWNER_FILE),
        `${JSON.stringify({ schemaVersion: 1, owner: OWNER }, null, 2)}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
    } else if (controlType !== "directory") {
      throw new SkillStoreError(
        "store.unsafe_directory",
        `Refusing ${controlType} at managed control directory.`,
        409,
      );
    } else {
      const ownership = await readJson(join(enabled.paths.control, CONTROL_OWNER_FILE));
      if (!ownership || ownership.owner !== OWNER || ownership.schemaVersion !== 1) {
        throw new SkillStoreError(
          "store.ownership_conflict",
          "Existing control directory is not owned by Agent Workflow Switch.",
          409,
        );
      }
    }

    const backupsType = await pathType(enabled.paths.backups);
    if (backupsType === "missing") {
      await mkdir(enabled.paths.backups, { mode: 0o700 });
    } else if (backupsType !== "directory") {
      throw new SkillStoreError(
        "store.unsafe_directory",
        `Refusing ${backupsType} at managed backup directory.`,
        409,
      );
    }
    return enabled;
  }

  async function validateExistingControl() {
    if (!paths) return;
    const type = await pathType(paths.control);
    if (type === "missing") return;
    if (type !== "directory") {
      throw new SkillStoreError(
        "store.unsafe_directory",
        `Refusing ${type} at managed control directory.`,
        409,
      );
    }
    const ownership = await readJson(join(paths.control, CONTROL_OWNER_FILE));
    if (!ownership || ownership.owner !== OWNER || ownership.schemaVersion !== 1) {
      throw new SkillStoreError(
        "store.ownership_conflict",
        "Existing control directory is not owned by Agent Workflow Switch.",
        409,
      );
    }
  }

  async function withLock(operation) {
    const enabled = await ensureControlDirectories();
    let handle;
    try {
      handle = await open(enabled.paths.lock, "wx", 0o600);
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, acquiredAt: clock().toISOString() })}\n`,
        "utf8",
      );
    } catch (error) {
      await handle?.close();
      if (handle) await rm(enabled.paths.lock, { force: true });
      if (error?.code === "EEXIST") {
        throw new SkillStoreError(
          "store.locked",
          "Another activation owns the Skill store lock. Remove it only after proving no writer is active.",
          409,
        );
      }
      throw error;
    }

    try {
      return await operation(enabled);
    } finally {
      await handle?.close();
      await unlink(enabled.paths.lock).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
  }

  async function createPreparedDirectory(parent, variant, restoredFrom) {
    const nonce = nonceFactory();
    const temporary = join(parent, `.agent-workflow-active.tmp-${nonce}`);
    await mkdir(temporary, { mode: 0o700 });
    const now = clock().toISOString();
    const manifest = manifestFor(variant, now, restoredFrom);
    try {
      await writeFile(join(temporary, SKILL_FILE), variant.content, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await writeFile(join(temporary, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      return { manifest, temporary };
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }

  async function moveActiveToBackup(enabled, label) {
    const active = await readOwnedDirectory(enabled.paths.active);
    if (!active) return null;
    const backupId = `${clock().toISOString().replace(/[:.]/g, "-")}-${label}-${nonceFactory()}`.toLowerCase();
    const backupPath = join(enabled.paths.backups, backupId);
    await rename(enabled.paths.active, backupPath);
    try {
      await writeFile(
        join(backupPath, "backup.json"),
        `${JSON.stringify({ schemaVersion: 1, backupId, backedUpAt: clock().toISOString() }, null, 2)}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
    } catch (error) {
      await rename(backupPath, enabled.paths.active);
      throw error;
    }
    return { backupId, backupPath, manifest: active };
  }

  async function listBackups() {
    if (!paths) return [];
    const directoryType = await pathType(paths.backups);
    if (directoryType === "missing") return [];
    if (directoryType !== "directory") {
      throw new SkillStoreError("store.corrupt_backups", "Backup root is not a directory.", 409);
    }
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(paths.backups, { withFileTypes: true });
    const backups = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !safeIdentifier(entry.name)) continue;
      const directory = join(paths.backups, entry.name);
      try {
        const manifest = await readOwnedDirectory(directory);
        if (!manifest) continue;
        const metadata = await readJson(join(directory, "backup.json"));
        backups.push({
          backupId: entry.name,
          variantId: manifest.variantId,
          contentFingerprint: manifest.contentFingerprint,
          backedUpAt: metadata?.backedUpAt ?? manifest.activatedAt,
        });
      } catch (error) {
        if (!(error instanceof SkillStoreError)) throw error;
      }
    }
    return backups.sort((left, right) => right.backedUpAt.localeCompare(left.backedUpAt));
  }

  async function status() {
    if (!paths || !skillsDir) {
      return {
        writeEnabled: false,
        skillsDir: null,
        health: "preview-only",
        active: null,
        backups: [],
      };
    }
    try {
      await validateExistingControl();
      const manifest = await readOwnedDirectory(paths.active);
      return {
        writeEnabled: true,
        skillsDir,
        health: manifest ? "active" : "ready",
        active: manifest
          ? {
              variantId: manifest.variantId,
              relativeSkillPath: `${ACTIVE_DIRECTORY}/${SKILL_FILE}`,
              contentFingerprint: manifest.contentFingerprint,
              activatedAt: manifest.activatedAt,
            }
          : null,
        backups: await listBackups(),
      };
    } catch (error) {
      if (error instanceof SkillStoreError) {
        return {
          writeEnabled: true,
          skillsDir,
          health: error.code,
          active: null,
          backups: [],
          error: error.message,
        };
      }
      throw error;
    }
  }

  async function activate(variant) {
    assertVariant(variant);
    return withLock(async (enabled) => {
      const current = await readOwnedDirectory(enabled.paths.active);
      if (
        current?.variantId === variant.id &&
        current.contentFingerprint === variant.contentFingerprint
      ) {
        return { changed: false, backupId: null, status: await status() };
      }

      const prepared = await createPreparedDirectory(enabled.skillsDir, variant);
      let backup = null;
      let installedNew = false;
      try {
        backup = await moveActiveToBackup(enabled, "activate");
        await rename(prepared.temporary, enabled.paths.active);
        installedNew = true;
        await writeJsonAtomic(
          enabled.paths.state,
          {
            schemaVersion: 1,
            owner: OWNER,
            activeVariantId: variant.id,
            contentFingerprint: variant.contentFingerprint,
            updatedAt: clock().toISOString(),
          },
          nonceFactory(),
        );
      } catch (error) {
        if (installedNew) {
          await rm(enabled.paths.active, { recursive: true, force: true });
        }
        await rm(prepared.temporary, { recursive: true, force: true });
        if (backup) {
          await rename(backup.backupPath, enabled.paths.active);
        }
        throw error;
      }
      return { changed: true, backupId: backup?.backupId ?? null, status: await status() };
    });
  }

  async function rollback(backupId) {
    if (!safeIdentifier(backupId)) {
      throw new SkillStoreError("rollback.invalid_id", "Backup id is invalid.");
    }
    return withLock(async (enabled) => {
      const source = join(enabled.paths.backups, backupId);
      const backupManifest = await readOwnedDirectory(source);
      if (!backupManifest) {
        throw new SkillStoreError("rollback.not_found", "Backup does not exist.", 404);
      }
      const content = await readFile(join(source, SKILL_FILE), "utf8");
      const variant = {
        id: backupManifest.variantId,
        mode: backupManifest.mode,
        profileId: backupManifest.profileId,
        mainAgentId: backupManifest.mainAgentId,
        contentFingerprint: backupManifest.contentFingerprint,
        includedModeIds: [backupManifest.mode.id],
        content,
      };
      assertVariant(variant);

      const prepared = await createPreparedDirectory(enabled.skillsDir, variant, backupId);
      let currentBackup = null;
      let installedNew = false;
      try {
        currentBackup = await moveActiveToBackup(enabled, "rollback");
        await rename(prepared.temporary, enabled.paths.active);
        installedNew = true;
        await writeJsonAtomic(
          enabled.paths.state,
          {
            schemaVersion: 1,
            owner: OWNER,
            activeVariantId: variant.id,
            contentFingerprint: variant.contentFingerprint,
            restoredFrom: backupId,
            updatedAt: clock().toISOString(),
          },
          nonceFactory(),
        );
      } catch (error) {
        if (installedNew) {
          await rm(enabled.paths.active, { recursive: true, force: true });
        }
        await rm(prepared.temporary, { recursive: true, force: true });
        if (currentBackup) {
          await rename(currentBackup.backupPath, enabled.paths.active);
        }
        throw error;
      }
      return {
        changed: true,
        restoredFrom: backupId,
        backupId: currentBackup?.backupId ?? null,
        status: await status(),
      };
    });
  }

  return Object.freeze({ activate, listBackups, rollback, status });
}
