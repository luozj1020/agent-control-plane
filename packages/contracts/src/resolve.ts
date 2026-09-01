import { BUILTIN_MODE_CATALOG } from "./catalog.js";
import type {
  BalancedBudgetOverride,
  BalancedTimingOverride,
  EffectiveSkillVariant,
  ExternalMonitorPolicy,
  ModeSkillTemplate,
  OvernightLoopPolicy,
  Result,
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

const MAX_SKILL_CONTENT_BYTES = 128 * 1024;
const ACTIVE_SKILL_NAME = "agent-workflow-active";

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
  if (!frontmatter || name !== ACTIVE_SKILL_NAME || !description) {
    return {
      ok: false,
      issues: [
        {
          code: "skill.frontmatter_invalid",
          path: "/content/frontmatter",
          message: `Skill frontmatter must retain name: ${ACTIVE_SKILL_NAME} and a non-empty description.`,
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

function renderTaskContract(): string[] {
  return [
    "## Task Card",
    "",
    "Create the JSON Task Card with the product, edit its placeholders, then validate it before delegation:",
    "",
    "```bash",
    "agent-control-plane task init --output TASK.json",
    "agent-control-plane task validate --task TASK.json",
    "```",
    "",
    "Do not hand-write schema variants. Validation commands are argv arrays, never shell strings.",
  ];
}

function effectiveDescription(
  mode: ModeSkillTemplate,
  overnight?: { readonly policy: OvernightLoopPolicy },
): string {
  if (mode.kind === "overnight" && overnight?.policy.strategy === "convergent") {
    return "Use when a bounded task should be delegated durably, followed by evidence review and non-expanding revisions until accepted.";
  }
  if (mode.kind === "overnight") {
    return "Use when reviewed improvement cycles should continue through an external worker until the user interrupts.";
  }
  if (mode.kind === "balanced") {
    return "Use when work should run in tuned foreground rounds with evidence review after every round.";
  }
  return "Use when the main thread should keep continuous ownership while coordinating native subagents.";
}

function renderModeInstructions(
  mode: ModeSkillTemplate,
  externalMonitor?: ExternalMonitorPolicy,
  overnight?: { readonly policy: OvernightLoopPolicy; readonly builderId: string },
  balanced?: {
    readonly policy: TunedWindowPolicy;
    readonly budget: BalancedBudgetOverride;
    readonly timing: BalancedTimingOverride;
    readonly builderId: string;
  },
): string {
  switch (mode.kind) {
    case "overnight": {
      if (!externalMonitor || !overnight) {
        throw new Error("Overnight loop or external monitor configuration is missing.");
      }
      const shared = [
        "## Operating contract",
        "",
        `- The main agent owns task meaning and review decisions. The external control plane owns downstream ${externalMonitor.monitorLayers.join(" -> ")} facts.`,
        "- Never monitor, poll, or keep alive the upstream process after a durable submission.",
        "- Tool evidence can prove process, scope, and validation facts; it cannot grant destructive, permission, migration, deployment, billing, secrets, or production-data authority.",
        "",
        ...renderTaskContract(),
        "",
        "## Procedure",
        "",
      ];
      if (overnight.policy.strategy === "convergent") {
        return [
          ...shared,
          "1. Freeze `TASK.json`; do not delegate while acceptance, scope, or validation is ambiguous.",
          "2. Submit once and retain `runDirectory`:",
          "",
          "```bash",
          `agent-control-plane overnight submit --task TASK.json --worktree ABSOLUTE_WORKTREE --adapter ${overnight.builderId} --strategy convergent --wake-adapter durable-file`,
          "```",
          "",
          "3. After successful submission, end the current upstream inference episode. Do not call status or poll downstream.",
          "4. On a new wake episode, verify `wake-request.json`, its SHA-256-bound evidence, the frozen task, Review Projection, validation results, process result, and `allowedDecisions`.",
          "5. Decide exactly one:",
          "   - `accept`: only when every acceptance criterion is satisfied; this is globally terminal.",
          "   - `revise`: keep `goal`, `mode`, and `profiles` unchanged; acceptance, `scope.write_paths`, and validation may only narrow; forbidden, stop, and authority boundaries may only grow.",
          "   - `stop`: terminate without acceptance.",
          "6. Submit the decision:",
          "",
          "```bash",
          "agent-control-plane overnight review --run RUN_DIR --decision accept",
          "agent-control-plane overnight review --run RUN_DIR --decision revise --revision REVISION.json",
          "agent-control-plane overnight review --run RUN_DIR --decision stop",
          "```",
          "",
          `Wake states: ${externalMonitor.wakeEvents.join(", ")}. Terminal-without-wake states: ${externalMonitor.terminalWithoutWake.join(", ")}. Never manufacture a duplicate wake.`,
        ].join("\n");
      }
      return [
        ...shared,
        "1. Freeze the improvement purpose and initial `TASK.json`. Its acceptance criteria are the permanent minimum floor; its forbidden paths and human-authority boundaries are immutable.",
        "2. Submit the first cycle and retain `runDirectory`:",
        "",
        "```bash",
        `agent-control-plane overnight submit --task TASK.json --worktree ABSOLUTE_WORKTREE --adapter ${overnight.builderId} --strategy continuous-improvement --wake-adapter durable-file`,
        "```",
        "",
        "3. End the upstream episode after submission. Do not poll.",
        "4. On wake, verify the hash-bound evidence and act by state:",
        "   - `revision_pending`: repair only the current cycle with a non-expanding Revision Delta.",
        "   - `improvement_cycle_ready`: treat success as a checkpoint, not global completion; design one measurable next hypothesis.",
        "   - blocker state: pause rather than inventing authority, scope, or product direction.",
        "5. Scaffold `NEXT.json`, then edit its hypothesis and Task Card. `added_paths` must exactly equal the new `scope.write_paths`, and the original acceptance and authority floors must remain:",
        "",
        "```bash",
        "agent-control-plane overnight next-init --run RUN_DIR --output NEXT.json",
        "```",
        "",
        "6. Continue or interrupt:",
        "",
        "```bash",
        "agent-control-plane overnight review --run RUN_DIR --decision revise --revision REVISION.json",
        "agent-control-plane overnight review --run RUN_DIR --decision continue --next NEXT.json",
        "agent-control-plane overnight interrupt --run RUN_DIR",
        "```",
        "",
        `Wake states: ${externalMonitor.wakeEvents.join(", ")}. Terminal-without-wake states: ${externalMonitor.terminalWithoutWake.join(", ")}. Continue until the user interrupts.`,
      ].join("\n");
    }
    case "balanced": {
      if (!balanced || !externalMonitor) {
        throw new Error("Balanced runtime or external monitor configuration is missing.");
      }
      return [
        "## Operating contract",
        "",
        "- The Runner—not prose—enforces timing and call budgets.",
        `- Windows (seconds): context=${balanced.policy.contextAcquisitionSeconds}, first-progress=${balanced.policy.firstProgressSeconds}, active=${balanced.policy.activeWindowSeconds}, extension=${balanced.policy.progressExtensionSeconds}, growing-extension=${balanced.policy.growingProgressExtensionSeconds}, hard-cap=${balanced.policy.hardCapSeconds}.`,
        `- Calls: main-review=${balanced.budget.mainReviewCalls}, downstream=${balanced.budget.downstreamCalls}, advisor=${balanced.budget.advisorCalls}, reserved-final-review=${balanced.budget.reservedFinalReviewCalls}. Token use is evidence, never a termination budget.`,
        `- The external control plane owns downstream ${externalMonitor.monitorLayers.join(" -> ")} facts. A process exit is never semantic acceptance.`,
        "- Do not bypass a blocker with an unmanaged downstream call.",
        "",
        ...renderTaskContract(),
        "",
        "## Procedure",
        "",
        "1. Freeze `TASK.json`, then run exactly one tuned foreground round:",
        "",
        "```bash",
        `agent-control-plane balanced run --task TASK.json --worktree ABSOLUTE_WORKTREE --adapter ${balanced.builderId} --context-seconds ${balanced.timing.contextAcquisitionSeconds} --first-progress-seconds ${balanced.timing.firstProgressSeconds} --active-seconds ${balanced.timing.activeWindowSeconds} --extension-seconds ${balanced.timing.progressExtensionSeconds} --growing-extension-seconds ${balanced.timing.growingProgressExtensionSeconds} --hard-cap-seconds ${balanced.timing.hardCapSeconds} --main-review-calls ${balanced.budget.mainReviewCalls} --downstream-calls ${balanced.budget.downstreamCalls} --advisor-calls ${balanced.budget.advisorCalls} --reserved-final-review-calls ${balanced.budget.reservedFinalReviewCalls}`,
        "```",
        "",
        "2. Yield the upstream until the command returns. Do not poll status or infer progress from elapsed time. Only machine-observed product changes refresh execution windows.",
        "3. Verify the returned, hash-bound `balanced-review.json` and its Review Projection.",
        "4. At `review_pending`, decide exactly one; a revision starts another tuned round, so yield again:",
        "",
        "```bash",
        "agent-control-plane balanced review --run RUN_DIR --decision accept",
        "agent-control-plane balanced review --run RUN_DIR --decision stop",
        "agent-control-plane balanced review --run RUN_DIR --decision revise --revision REVISION.json",
        "```",
        "",
        `5. At ${externalMonitor.wakeEvents.filter((state) => state !== "review_pending").join(", ")}, inspect machine evidence and stop or repair the stated blocker; never declare acceptance from an exit code.`,
      ].join("\n");
    }
    case "interactive":
      return [
        "## Operating contract",
        "",
        "- The main thread continuously owns intent, decomposition, architecture, synthesis, validation, and the final answer.",
        "- Use only native subagents available to the selected main-agent harness. Never route Interactive work through the external Builder binding.",
        "- Treat every subagent report as a claim until the main thread inspects the shared diff and exact check results.",
        "- Keep one active writer unless write paths or worktrees are provably disjoint and one integration owner is explicit.",
        "",
        "## Procedure",
        "",
        "1. Decompose only when parallel work or specialization materially reduces latency or risk; handle trivial sequential work in the main thread.",
        "2. Select roles by installed name, description, permissions, and developer instructions. Do not assume a fixed role list or model.",
        "3. Give each subagent a bounded objective, read/write scope, forbidden boundaries, expected evidence, and return condition.",
        "4. Fan out read-only exploration and independent validation. Use one writer by default; parallel writers require disjoint ownership and an explicit integration owner.",
        "5. Wait for every result needed by the decision. Inspect actual changed files, reconcile conflicting claims, and run the authoritative checks in the main thread.",
        "6. Use an independent reviewer after implementation when a suitable role exists. The reviewer does not replace main-thread acceptance.",
        "7. Finish only after the main thread confirms acceptance, scope, validation, and remaining risks.",
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
  let overnightRuntime: { policy: OvernightLoopPolicy; builderId: string } | undefined;
  let externalMonitor: ExternalMonitorPolicy | undefined;
  if (mode.kind === "overnight") {
    const loopReference = input.profile.overnightLoopPolicy ?? mode.defaultLoopPolicy;
    const policy = catalog.overnightLoopPolicies.find(
      (candidate) =>
        candidate.id === loopReference.id && candidate.version === loopReference.version,
    );
    const builder = input.profile.roleBindings.find((binding) => binding.role === "builder");
    if (policy && builder?.target.kind === "agent") {
      overnightRuntime = { policy, builderId: builder.target.agentId };
      externalMonitor = catalog.externalMonitorPolicies.find(
        (candidate) =>
          candidate.id === policy.externalMonitorPolicy.id &&
          candidate.version === policy.externalMonitorPolicy.version,
      );
    }
  } else if (mode.kind === "balanced") {
    externalMonitor = catalog.externalMonitorPolicies.find(
      (candidate) =>
        candidate.id === mode.externalMonitorPolicy.id &&
        candidate.version === mode.externalMonitorPolicy.version,
    );
  }
  if (mode.kind !== "interactive" && !externalMonitor) {
    throw new Error("Validated resolution input lost its external monitor policy.");
  }
  if (mode.kind === "overnight" && !overnightRuntime) {
    throw new Error("Validated resolution input lost its Overnight loop policy.");
  }

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
  const variantId = [
    "workflow",
    slug(main.id),
    slug(mode.id),
    ...(overnightRuntime ? [slug(overnightRuntime.policy.strategy)] : []),
    ...externalAgentIds.map(slug),
  ].join("-");
  const description = effectiveDescription(mode, overnightRuntime);
  const content = [
    "---",
    `name: ${ACTIVE_SKILL_NAME}`,
    `description: ${description}`,
    "---",
    "",
    "# Workflow",
    "",
    renderModeInstructions(mode, externalMonitor, overnightRuntime, balancedRuntime),
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
      relativeSkillPath: `${ACTIVE_SKILL_NAME}/SKILL.md`,
      content,
      contentFingerprint: fingerprint(content),
      estimatedTokens: Math.ceil(content.length / 4),
      ...(externalMonitor
        ? { externalMonitorPolicy: { id: externalMonitor.id, version: externalMonitor.version } }
        : {}),
      ...(overnightRuntime
        ? {
            overnightLoopPolicy: {
              id: overnightRuntime.policy.id,
              version: overnightRuntime.policy.version,
            },
          }
        : {}),
      ...(balancedRuntime ? { balancedBudget: balancedRuntime.budget } : {}),
      ...(balancedRuntime ? { balancedTiming: balancedRuntime.timing } : {}),
    },
  };
}
