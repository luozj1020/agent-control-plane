import { BUILTIN_MODE_CATALOG } from "./catalog.js";
import type {
  AgentTarget,
  EffectiveSkillVariant,
  ModeSkillTemplate,
  Result,
  RoleBinding,
  SkillResolutionInput,
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

function fingerprint(content: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function targetLabel(binding: RoleBinding, agents: ReadonlyMap<string, AgentTarget>): string {
  if (binding.target.kind === "main") return "main agent";
  if (binding.target.kind === "main-native") return "main agent native subagents";
  return lineSafe(agents.get(binding.target.agentId)?.displayName ?? binding.target.agentId);
}

function renderModeInstructions(mode: ModeSkillTemplate): string {
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
      return [
        "## Workflow",
        "",
        `Use tuned window policy ${mode.tunedWindowPolicy.id}@${mode.tunedWindowPolicy.version}.`,
        "After each bounded downstream round, review the result in the main-agent context.",
        "Accept, stop, or dispatch a narrowed continuation using the same policy version.",
        "Do not replace the tuned policy with an arbitrary user-entered duration.",
      ].join("\n");
    case "interactive":
      return [
        "## Workflow",
        "",
        "Keep the main agent in the foreground as the synthesis owner.",
        "Use only the main agent's native subagents for parallel bounded work.",
        "Continuously integrate subagent results and make final decisions in the main context.",
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
    renderModeInstructions(mode),
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
    },
  };
}
