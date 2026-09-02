import type {
  EffectiveSkillVariant,
  ManagedSkillState,
  Result,
  SkillActivationPlan,
  ValidationIssue,
} from "./types.js";

function safeRelativePath(value: string): boolean {
  if (value.length === 0 || value.startsWith("/") || /^[a-zA-Z]:/.test(value)) return false;
  const segments = value.replaceAll("\\", "/").split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function sameProjectBinding(
  left: EffectiveSkillVariant["projectBinding"],
  right: ManagedSkillState["projectBinding"],
): boolean {
  if (left == null || right == null) return left == null && right == null;
  return (left.projectId ?? null) === (right.projectId ?? null) &&
    left.workspaceId === right.workspaceId &&
    left.projectRevision === right.projectRevision &&
    left.projectConfigSha256 === right.projectConfigSha256;
}

export function planSkillActivation(
  desired: EffectiveSkillVariant,
  installed: readonly ManagedSkillState[],
): Result<SkillActivationPlan> {
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  installed.forEach((entry, index) => {
    if (seen.has(entry.variantId)) {
      issues.push({
        code: "activation.duplicate_variant",
        path: `/installed/${index}/variantId`,
        message: `Variant '${entry.variantId}' appears more than once.`,
      });
    }
    seen.add(entry.variantId);
    if (!safeRelativePath(entry.relativeSkillPath)) {
      issues.push({
        code: "activation.path_unsafe",
        path: `/installed/${index}/relativeSkillPath`,
        message: "Managed Skill paths must be normalized relative paths.",
      });
    }
  });
  if (!safeRelativePath(desired.relativeSkillPath)) {
    issues.push({
      code: "activation.path_unsafe",
      path: "/desired/relativeSkillPath",
      message: "Desired Skill path must be a normalized relative path.",
    });
  }
  if (issues.length > 0) return { ok: false, issues };

  const activeOthers = installed.filter(
    (entry) => entry.active && entry.variantId !== desired.id,
  );
  const current = installed.find((entry) => entry.variantId === desired.id);
  const unchanged =
    current?.active === true &&
    current.contentFingerprint === desired.contentFingerprint &&
    sameProjectBinding(desired.projectBinding, current.projectBinding) &&
    activeOthers.length === 0;
  if (unchanged) {
    return {
      ok: true,
      value: {
        schemaVersion: 1,
        activeVariantId: desired.id,
        operations: [],
        deactivatedVariantIds: [],
        restartRequired: false,
      },
    };
  }

  const operations: SkillActivationPlan["operations"][number][] = [];
  for (const entry of activeOthers) {
    operations.push({ kind: "deactivate", variantId: entry.variantId });
  }
  if (current) {
    operations.push({ kind: "backup", relativeSkillPath: current.relativeSkillPath });
  }
  operations.push({
    kind: "write",
    relativeSkillPath: desired.relativeSkillPath,
    contentFingerprint: desired.contentFingerprint,
  });
  operations.push({ kind: "activate", variantId: desired.id });

  return {
    ok: true,
    value: {
      schemaVersion: 1,
      activeVariantId: desired.id,
      operations,
      deactivatedVariantIds: activeOthers.map((entry) => entry.variantId),
      restartRequired: true,
    },
  };
}
