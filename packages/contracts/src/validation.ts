import { BUILTIN_MODE_CATALOG } from "./catalog.js";
import type {
  AgentCapability,
  AgentTarget,
  ModeSkillCatalog,
  ModeSkillTemplate,
  RoleBinding,
  SkillResolutionInput,
  ValidationIssue,
  ValidationIssueCode,
  WorkflowProfile,
} from "./types.js";

const PROFILE_KEYS = new Set([
  "schemaVersion",
  "id",
  "displayName",
  "mainAgentId",
  "mode",
  "targetAdapterId",
  "roleBindings",
]);

const AGENT_KINDS = new Set(["codex", "claude-code", "custom"]);
const AGENT_CAPABILITIES = new Set([
  "bounded-execution",
  "durable-resume",
  "external-delegation",
  "native-subagents",
  "semantic-review",
]);
const WORKFLOW_ROLES = new Set(["builder", "planner", "reviewer", "subagent", "tester"]);
const TARGET_KINDS = new Set(["agent", "main", "main-native"]);

function issue(
  code: ValidationIssueCode,
  path: string,
  message: string,
): ValidationIssue {
  return { code, path, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function findRawSecrets(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => findRawSecrets(child, `${path}/${index}`, issues));
    return;
  }
  if (!isRecord(value)) return;

  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}/${key}`;
    const normalized = key.toLowerCase().replaceAll("_", "").replaceAll("-", "");
    const credentialLike =
      normalized === "apikey" ||
      normalized === "token" ||
      normalized === "password" ||
      normalized === "clientsecret";
    if (credentialLike && typeof child === "string") {
      issues.push(
        issue(
          "security.raw_secret",
          childPath,
          "Persist opaque secretRef identifiers instead of raw credentials.",
        ),
      );
    }
    findRawSecrets(child, childPath, issues);
  }
}

function findBinding(
  bindings: readonly RoleBinding[],
  role: RoleBinding["role"],
): RoleBinding | undefined {
  return bindings.find((binding) => binding.role === role);
}

function requireCapabilities(
  agent: AgentTarget,
  capabilities: readonly AgentCapability[],
  path: string,
  issues: ValidationIssue[],
): void {
  for (const capability of capabilities) {
    if (!agent.capabilities.includes(capability)) {
      issues.push(
        issue(
          "agent.capability_missing",
          path,
          `Agent '${agent.id}' does not declare '${capability}'.`,
        ),
      );
    }
  }
}

function validateModeRoles(
  mode: ModeSkillTemplate,
  profile: WorkflowProfile,
  agentsById: ReadonlyMap<string, AgentTarget>,
  issues: ValidationIssue[],
): void {
  const main = agentsById.get(profile.mainAgentId);
  if (!main) return;
  requireCapabilities(main, mode.requiredMainCapabilities, "/profile/mainAgentId", issues);

  if (mode.kind === "interactive") {
    const externalBinding = profile.roleBindings.find(
      (binding) => binding.target.kind === "agent",
    );
    if (externalBinding) {
      issues.push(
        issue(
          "mode.incompatible_role",
          `/profile/roleBindings/${profile.roleBindings.indexOf(externalBinding)}`,
          "Interactive accepts only main-native subagents and optional main review.",
        ),
      );
    }
    const subagent = findBinding(profile.roleBindings, "subagent");
    if (!subagent || subagent.target.kind !== "main-native") {
      issues.push(
        issue(
          "mode.incompatible_role",
          "/profile/roleBindings",
          "Interactive requires a subagent binding targeting main-native.",
        ),
      );
    }
    return;
  }

  const builder = findBinding(profile.roleBindings, "builder");
  if (!builder || builder.target.kind !== "agent") {
    issues.push(
      issue(
        "mode.incompatible_role",
        "/profile/roleBindings",
        `${mode.displayName} requires an external builder agent binding.`,
      ),
    );
  } else {
    const builderAgent = agentsById.get(builder.target.agentId);
    if (builderAgent) {
      requireCapabilities(
        builderAgent,
        mode.builderCapabilities,
        `/profile/roleBindings/${profile.roleBindings.indexOf(builder)}/target/agentId`,
        issues,
      );
    }
  }

  const reviewer = findBinding(profile.roleBindings, "reviewer");
  if (!reviewer || reviewer.target.kind !== "main") {
    issues.push(
      issue(
        "mode.incompatible_role",
        "/profile/roleBindings",
        `${mode.displayName} requires reviewer to target the main agent.`,
      ),
    );
  }
}

export function validateSkillResolutionInput(input: unknown): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  findRawSecrets(input, "", issues);

  if (!isRecord(input)) {
    issues.push(issue("profile.invalid", "", "Resolution input must be an object."));
    return issues;
  }
  if (!isRecord(input.profile)) {
    issues.push(issue("profile.invalid", "/profile", "Profile must be an object."));
    return issues;
  }
  for (const key of Object.keys(input.profile)) {
    if (!PROFILE_KEYS.has(key)) {
      issues.push(
        issue("profile.unknown_field", `/profile/${key}`, `Unknown profile field '${key}'.`),
      );
    }
  }

  const rawProfile = input.profile;
  if (
    typeof rawProfile.id !== "string" ||
    rawProfile.id.length === 0 ||
    typeof rawProfile.displayName !== "string" ||
    typeof rawProfile.mainAgentId !== "string" ||
    rawProfile.mainAgentId.length === 0 ||
    typeof rawProfile.targetAdapterId !== "string" ||
    rawProfile.targetAdapterId.length === 0 ||
    !isRecord(rawProfile.mode) ||
    typeof rawProfile.mode.id !== "string" ||
    typeof rawProfile.mode.version !== "string" ||
    !Array.isArray(rawProfile.roleBindings)
  ) {
    issues.push(issue("profile.invalid", "/profile", "Profile fields are incomplete."));
    return issues;
  }
  const profile = rawProfile as unknown as WorkflowProfile;
  if (profile.schemaVersion !== 1) {
    issues.push(
      issue("schema.unsupported", "/profile/schemaVersion", "Only schema version 1 is supported."),
    );
  }
  if (!Array.isArray(input.agents)) {
    issues.push(issue("agent.invalid", "/agents", "Agents must be an array."));
    return issues;
  }

  const agentsById = new Map<string, AgentTarget>();
  input.agents.forEach((rawAgent, index) => {
    if (
      !isRecord(rawAgent) ||
      typeof rawAgent.id !== "string" ||
      rawAgent.id.length === 0 ||
      typeof rawAgent.displayName !== "string" ||
      typeof rawAgent.kind !== "string" ||
      !AGENT_KINDS.has(rawAgent.kind) ||
      !Array.isArray(rawAgent.capabilities) ||
      !rawAgent.capabilities.every(
        (capability) => typeof capability === "string" && AGENT_CAPABILITIES.has(capability),
      )
    ) {
      issues.push(
        issue("agent.invalid", `/agents/${index}`, "Agent fields or capabilities are invalid."),
      );
      return;
    }
    const agent = rawAgent as unknown as AgentTarget;
    if (agent.schemaVersion !== 1) {
      issues.push(
        issue(
          "schema.unsupported",
          `/agents/${index}/schemaVersion`,
          "Only schema version 1 is supported.",
        ),
      );
    }
    if (agentsById.has(agent.id)) {
      issues.push(
        issue("agent.duplicate_id", `/agents/${index}/id`, `Duplicate agent id '${agent.id}'.`),
      );
    }
    agentsById.set(agent.id, agent);
  });

  if (!agentsById.has(profile.mainAgentId)) {
    issues.push(
      issue(
        "agent.unknown",
        "/profile/mainAgentId",
        `Unknown main agent '${profile.mainAgentId}'.`,
      ),
    );
  }

  const seenRoles = new Set<string>();
  profile.roleBindings.forEach((rawBinding, index) => {
    if (
      !isRecord(rawBinding) ||
      typeof rawBinding.role !== "string" ||
      !WORKFLOW_ROLES.has(rawBinding.role) ||
      !isRecord(rawBinding.target) ||
      typeof rawBinding.target.kind !== "string" ||
      !TARGET_KINDS.has(rawBinding.target.kind) ||
      (rawBinding.target.kind === "agent" &&
        (typeof rawBinding.target.agentId !== "string" ||
          rawBinding.target.agentId.length === 0))
    ) {
      issues.push(
        issue(
          "profile.invalid",
          `/profile/roleBindings/${index}`,
          "Role binding is invalid.",
        ),
      );
      return;
    }
    const binding = rawBinding as unknown as RoleBinding;
    if (seenRoles.has(binding.role)) {
      issues.push(
        issue(
          "profile.duplicate_role",
          `/profile/roleBindings/${index}/role`,
          `Role '${binding.role}' is bound more than once.`,
        ),
      );
    }
    seenRoles.add(binding.role);
    if (binding.target.kind === "agent" && !agentsById.has(binding.target.agentId)) {
      issues.push(
        issue(
          "agent.unknown",
          `/profile/roleBindings/${index}/target/agentId`,
          `Unknown agent '${binding.target.agentId}'.`,
        ),
      );
    }
  });

  const rawCatalog = input.catalog ?? BUILTIN_MODE_CATALOG;
  if (
    !isRecord(rawCatalog) ||
    !Array.isArray(rawCatalog.modes) ||
    !Array.isArray(rawCatalog.tunedWindowPolicies)
  ) {
    issues.push(issue("profile.invalid", "/catalog", "Mode catalog is invalid."));
    return issues;
  }
  const catalog = rawCatalog as unknown as ModeSkillCatalog;
  if (catalog.schemaVersion !== 1) {
    issues.push(
      issue("schema.unsupported", "/catalog/schemaVersion", "Only schema version 1 is supported."),
    );
    return issues;
  }
  const mode = catalog.modes.find(
    (candidate) =>
      candidate.id === profile.mode.id && candidate.version === profile.mode.version,
  );
  if (!mode) {
    issues.push(
      issue(
        "mode.unknown",
        "/profile/mode",
        `Unknown mode version '${profile.mode.id}@${profile.mode.version}'.`,
      ),
    );
    return issues;
  }
  if (mode.kind === "balanced") {
    const policyExists = catalog.tunedWindowPolicies.some(
      (policy) =>
        policy.id === mode.tunedWindowPolicy.id &&
        policy.version === mode.tunedWindowPolicy.version,
    );
    if (!policyExists) {
      issues.push(
        issue(
          "mode.policy_unknown",
          "/catalog/tunedWindowPolicies",
          `Balanced policy '${mode.tunedWindowPolicy.id}@${mode.tunedWindowPolicy.version}' is missing.`,
        ),
      );
    }
  }

  validateModeRoles(mode, profile, agentsById, issues);
  return issues;
}
