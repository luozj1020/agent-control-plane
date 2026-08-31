import { BUILTIN_MODE_CATALOG } from "./catalog.js";
import type {
  AgentTarget,
  BalancedBudgetOverride,
  BalancedTimingOverride,
  EffectiveSkillVariant,
  ModeSkillTemplate,
  Result,
  RoleBinding,
  SkillResolutionInput,
  TunedWindowPolicy,
} from "./types.js";
import { validateSkillResolutionInput } from "./validation.js";

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "agent";
}

function lineSafe(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

const MAX_SKILL_CONTENT_BYTES = 128 * 1024;

function fingerprint(content: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function skillContentBytes(content: string): number {
  return new TextEncoder().encode(content).length;
}

export function customizeEffectiveSkill(
  variant: EffectiveSkillVariant,
  content: unknown,
): Result<EffectiveSkillVariant> {
  if (typeof content !== "string" || content.trim().length === 0 || content.includes("\0")) {
    return {
      ok: false,
      issues: [
        {
          code: "skill.content_invalid",
          path: "/content",
          message: "Skill content must be a non-empty text document without NUL characters.",
        },
      ],
    };
  }
  if (skillContentBytes(content) > MAX_SKILL_CONTENT_BYTES) {
    return {
      ok: false,
      issues: [
        {
          code: "skill.content_too_large",
          path: "/content",
          message: "Skill content cannot exceed 128 KiB in UTF-8.",
        },
      ],
    };
  }
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const frontmatterBody = frontmatter?.[1];
  const nameLines = frontmatterBody
    ? [...frontmatterBody.matchAll(/^name:[\t ]*([^\r\n]*)$/gm)]
    : [];
  const descriptionLines = frontmatterBody
    ? [...frontmatterBody.matchAll(/^description:[\t ]*([^\r\n]*)$/gm)]
    : [];
  const name = nameLines[0]?.[1]?.trim();
  const description = descriptionLines[0]?.[1]?.trim();
  if (!frontmatter || name !== variant.id || !description) {
    return {
      ok: false,
      issues: [
        {
          code: "skill.frontmatter_invalid",
          path: "/content/frontmatter",
          message: `Skill frontmatter must retain name: ${variant.id} and a non-empty description.`,
        },
      ],
    };
  }
  if (nameLines.length !== 1 || descriptionLines.length !== 1) {
    return {
      ok: false,
      issues: [
        {
          code: "skill.frontmatter_invalid",
          path: "/content/frontmatter",
          message: "Skill frontmatter must contain exactly one name and one description.",
        },
      ],
    };
  }
  return {
    ok: true,
    value: {
      ...variant,
      content,
      contentFingerprint: fingerprint(content),
      estimatedTokens: Math.ceil(content.length / 4),
    },
  };
}

function targetLabel(binding: RoleBinding, agents: ReadonlyMap<string, AgentTarget>): string {
  if (binding.target.kind === "main") return "main agent";
  if (binding.target.kind === "main-native") return "main agent native subagents";
  return lineSafe(agents.get(binding.target.agentId)?.displayName ?? binding.target.agentId);
}

function renderModeInstructions(
  mode: ModeSkillTemplate,
  balanced?: {
    readonly policy: TunedWindowPolicy;
    readonly budget: BalancedBudgetOverride;
    readonly timing: BalancedTimingOverride;
    readonly builderId: string;
  },
): string {
  switch (mode.kind) {
    case "overnight":
      return [
        "## Workflow",
        "",
        "1. Freeze intent, acceptance criteria, write scope, and validation before delegation.",
        "2. Delegate implementation to the bound builder as one durable task.",
        "3. Let the builder converge to a terminal result without foreground polling.",
        "4. Review the bounded result semantically; issue only bounded revision deltas.",
        "5. Stop when accepted or when a genuine semantic choice requires the user.",
      ].join("\n");
    case "balanced":
      if (!balanced) throw new Error("Balanced runtime configuration is missing.");
      return [
        "## Workflow",
        "",
        `Use the external Balanced Runner with policy ${mode.tunedWindowPolicy.id}@${mode.tunedWindowPolicy.version}; do not simulate its timers or budgets in prose.`,
        `Policy seconds: context=${balanced.policy.contextAcquisitionSeconds}, active=${balanced.policy.activeWindowSeconds}, extension=${balanced.policy.progressExtensionSeconds}, growing-extension=${balanced.policy.growingProgressExtensionSeconds}, hard-cap=${balanced.policy.hardCapSeconds}.`,
        `Budget: main-review=${balanced.budget.mainReviewCalls}, downstream=${balanced.budget.downstreamCalls}, advisor=${balanced.budget.advisorCalls}, reserved-final-review=${balanced.budget.reservedFinalReviewCalls}.`,
        "Freeze a Task JSON with objective, acceptance, allowedPaths, forbiddenPaths, and validationCommands before the first round.",
        `Run: agent-control-plane balanced run --task TASK.json --worktree ABSOLUTE_WORKTREE --adapter ${balanced.builderId} --policy ${mode.tunedWindowPolicy.id}@${mode.tunedWindowPolicy.version} --context-seconds ${balanced.timing.contextAcquisitionSeconds} --first-progress-seconds ${balanced.timing.firstProgressSeconds} --active-seconds ${balanced.timing.activeWindowSeconds} --extension-seconds ${balanced.timing.progressExtensionSeconds} --growing-extension-seconds ${balanced.timing.growingProgressExtensionSeconds} --hard-cap-seconds ${balanced.timing.hardCapSeconds} --main-review-calls ${balanced.budget.mainReviewCalls} --downstream-calls ${balanced.budget.downstreamCalls} --advisor-calls ${balanced.budget.advisorCalls} --reserved-final-review-calls ${balanced.budget.reservedFinalReviewCalls}`,
        "Read the returned hash-bound balanced-review.json. Decide accept, stop, or revise; a process exit is never acceptance.",
        "Record accept/stop with `agent-control-plane balanced review --run RUN_DIR --decision DECISION`.",
        "For revise, freeze a bounded Revision Delta and run `agent-control-plane balanced review --run RUN_DIR --decision revise --revision REVISION.json`.",
        "If the Runner is unavailable or reports runtime_blocked, budget_exhausted, scope_violation, or validation_failed, do not bypass it with an unmanaged downstream call.",
      ].join("\n");
    case "interactive":
      return [
        "## Workflow",
        "",
        "Keep the main Codex thread in continuous ownership of intent, decomposition, synthesis, validation, and final decisions.",
        "Use native subagents aggressively when independent work can materially improve speed or quality, then wait for the relevant results before deciding.",
        "Delegate exploration to explorer, implementation to worker, tests to tester, debugging to debugger, benchmarks to benchmarker, and build failures to build_fixer.",
        "Use reviewer after implementation when correctness, regression, concurrency, performance, or test risk warrants an independent read-only review.",
        "Keep architectural and product decisions in the main thread. Keep one active writer unless paths or worktrees are provably disjoint.",
        "Treat subagent reports as claims until the main thread verifies the shared diff and exact checks.",
        "Use only the main agent's native subagents; do not route Interactive work through an external builder.",
      ].join("\n");
  }
}

export function resolveEffectiveSkill(
  input: SkillResolutionInput,
): Result<EffectiveSkillVariant> {
  const issues = validateSkillResolutionInput(input);
  if (issues.length > 0) return { ok: false, issues };

  const catalog = input.catalog ?? BUILTIN_MODE_CATALOG;
  const mode = catalog.modes.find(
    (candidate) =>
      candidate.id === input.profile.mode.id &&
      candidate.version === input.profile.mode.version,
  );
  const main = input.agents.find((agent) => agent.id === input.profile.mainAgentId);
  if (!mode || !main) {
    throw new Error("Validated resolution input lost a referenced mode or main agent.");
  }

  const agents = new Map(input.agents.map((agent) => [agent.id, agent]));
  const externalAgentIds = input.profile.roleBindings.flatMap((binding) =>
    binding.target.kind === "agent" ? [binding.target.agentId] : [],
  );
  const includedAgentIds = [...new Set([main.id, ...externalAgentIds])];
  let balancedRuntime:
    | {
        policy: TunedWindowPolicy;
        budget: BalancedBudgetOverride;
        timing: BalancedTimingOverride;
        builderId: string;
      }
    | undefined;
  if (mode.kind === "balanced") {
    const policy = catalog.tunedWindowPolicies.find(
      (candidate) =>
        candidate.id === mode.tunedWindowPolicy.id &&
        candidate.version === mode.tunedWindowPolicy.version,
    );
    const defaultBudget = catalog.balancedBudgetPolicies.find(
      (candidate) =>
        candidate.id === mode.budgetPolicy.id && candidate.version === mode.budgetPolicy.version,
    );
    const builder = input.profile.roleBindings.find((binding) => binding.role === "builder");
    if (!policy || !defaultBudget || builder?.target.kind !== "agent") {
      throw new Error("Validated Balanced input lost its runtime policy or builder.");
    }
    const timing = input.profile.balancedTiming ?? {
      contextAcquisitionSeconds: policy.contextAcquisitionSeconds,
      firstProgressSeconds: policy.firstProgressSeconds,
      activeWindowSeconds: policy.activeWindowSeconds,
      progressExtensionSeconds: policy.progressExtensionSeconds,
      growingProgressExtensionSeconds: policy.growingProgressExtensionSeconds,
      hardCapSeconds: policy.hardCapSeconds,
    };
    balancedRuntime = {
      policy: { ...policy, ...timing },
      timing,
      budget: input.profile.balancedBudget ?? {
        mainReviewCalls: defaultBudget.mainReviewCalls,
        downstreamCalls: defaultBudget.downstreamCalls,
        advisorCalls: defaultBudget.advisorCalls,
        reservedFinalReviewCalls: defaultBudget.reservedFinalReviewCalls,
      },
      builderId: builder.target.agentId,
    };
  }
  const bindingLines = input.profile.roleBindings.map(
    (binding) => `- ${binding.role}: ${targetLabel(binding, agents)}`,
  );
  const variantId = [
    "workflow",
    slug(main.id),
    slug(mode.id),
    ...externalAgentIds.map(slug),
  ].join("-");
  const description = lineSafe(`${mode.displayName} workflow for ${main.displayName}.`);
  const content = [
    "---",
    `name: ${variantId}`,
    `description: ${description}`,
    "---",
    "",
    `# ${mode.displayName}`,
    "",
    mode.description,
    "",
    renderModeInstructions(mode, balancedRuntime),
    "",
    "## Active bindings",
    "",
    `- main: ${lineSafe(main.displayName)}`,
    ...bindingLines,
    "",
  ].join("\n");

  return {
    ok: true,
    value: {
      schemaVersion: 1,
      id: variantId,
      mode: { id: mode.id, version: mode.version },
      profileId: input.profile.id,
      mainAgentId: main.id,
      targetAdapterId: input.profile.targetAdapterId,
      includedModeIds: [mode.id],
      includedAgentIds,
      relativeSkillPath: `${variantId}/SKILL.md`,
      content,
      contentFingerprint: fingerprint(content),
      estimatedTokens: Math.ceil(content.length / 4),
      ...(balancedRuntime ? { balancedBudget: balancedRuntime.budget } : {}),
      ...(balancedRuntime ? { balancedTiming: balancedRuntime.timing } : {}),
    },
  };
}
