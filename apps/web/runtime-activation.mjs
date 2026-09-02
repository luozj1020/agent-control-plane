const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export function normalizeRuntimeActivation(input, ErrorType) {
  const activationId = input?.activationId ?? null;
  const requestedHash = input?.effectiveSkillSha256 ?? null;
  const effectiveSkillSha256 = typeof requestedHash === "string" && requestedHash.startsWith("sha256:")
    ? requestedHash.slice("sha256:".length)
    : requestedHash;
  if (activationId !== null && !SAFE_ID.test(activationId)) {
    throw new ErrorType("runtime.invalid_activation", "Activation id is invalid.");
  }
  if (effectiveSkillSha256 !== null && !SHA256.test(effectiveSkillSha256)) {
    throw new ErrorType("runtime.invalid_activation", "Effective Skill SHA-256 is invalid.");
  }
  const requestedProject = input?.projectBinding ?? null;
  let projectBinding = null;
  if (requestedProject !== null) {
    const requestedProjectHash = requestedProject?.projectConfigSha256;
    const projectConfigSha256 =
      typeof requestedProjectHash === "string" && requestedProjectHash.startsWith("sha256:")
        ? requestedProjectHash.slice("sha256:".length)
        : requestedProjectHash;
    if (
      !requestedProject ||
      (requestedProject.projectId !== undefined && requestedProject.projectId !== null &&
        !SAFE_ID.test(requestedProject.projectId)) ||
      !SAFE_ID.test(requestedProject.workspaceId) ||
      !Number.isSafeInteger(requestedProject.projectRevision) || requestedProject.projectRevision < 0 ||
      typeof projectConfigSha256 !== "string" || !SHA256.test(projectConfigSha256)
    ) {
      throw new ErrorType("runtime.invalid_activation", "Project activation binding is invalid.");
    }
    projectBinding = {
      projectId: requestedProject.projectId ?? null,
      workspaceId: requestedProject.workspaceId,
      projectRevision: requestedProject.projectRevision,
      projectConfigSha256,
    };
  }
  return { activationId, effectiveSkillSha256, projectBinding };
}

export async function discoverRuntimeActivation(mode, options = {}) {
  const environment = options.environment ?? process.env;
  if (environment.AGENT_WORKFLOW_PREVIEW_ONLY === "1") {
    return { activationId: null, effectiveSkillSha256: null, projectBinding: null };
  }
  const userHome = options.userHome ?? homedir();
  const codexHome = resolve(
    environment.AGENT_WORKFLOW_CODEX_HOME?.trim() || join(userHome, ".codex"),
  );
  const skillsDir = resolve(
    environment.AGENT_WORKFLOW_SKILLS_DIR?.trim() || join(codexHome, "skills"),
  );
  const store = options.store ?? createSkillStore({ skillsDir });
  try {
    const history = await store.history();
    const active = history.entries?.find(
      (entry) => entry.isActive && entry.mode?.id === mode,
    );
    return active
      ? {
          activationId: active.historyId,
          effectiveSkillSha256: active.contentSha256,
          projectBinding: active.projectBinding?.workspaceId ? active.projectBinding : null,
        }
      : { activationId: null, effectiveSkillSha256: null, projectBinding: null };
  } catch {
    // Runtime execution remains available when activation history is absent or
    // unreadable. The Activity API will keep the run explicitly unlinked.
    return { activationId: null, effectiveSkillSha256: null, projectBinding: null };
  }
}
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { createSkillStore } from "./skill-store.mjs";
