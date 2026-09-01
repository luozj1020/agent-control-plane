import { BUILTIN_MODE_CATALOG } from "./catalog.js";
import { BALANCED_BUDGET_LIMITS, BALANCED_TIMING_LIMITS } from "./budget.js";
import type {
  AgentCapability,
  AgentTarget,
  ExternalMonitorPolicy,
  ModeSkillCatalog,
  ModeSkillTemplate,
  OvernightLoopPolicy,
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
  "overnightLoopPolicy",
  "balancedBudget",
  "balancedTiming",
]);

const BALANCED_BUDGET_KEYS = new Set([
  "mainReviewCalls",
  "downstreamCalls",
  "advisorCalls",
  "reservedFinalReviewCalls",
]);

const BALANCED_TIMING_KEYS = new Set([
  "contextAcquisitionSeconds",
  "firstProgressSeconds",
  "activeWindowSeconds",
  "progressExtensionSeconds",
  "growingProgressExtensionSeconds",
  "hardCapSeconds",
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
const EXTERNAL_MONITOR_LAYERS = ["process", "activity", "state", "evidence", "wake"] as const;

function sameStringSet(actual: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(actual) &&
    actual.every((value) => typeof value === "string") &&
    actual.length === expected.length &&
    expected.every((value) => actual.includes(value))
  );
}

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

function validateBalancedBudget(value: unknown, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push(issue("profile.invalid", "/profile/balancedBudget", "Balanced budget must be an object."));
    return;
  }
  for (const key of Object.keys(value)) {
    if (!BALANCED_BUDGET_KEYS.has(key)) {
      issues.push(
        issue(
          "profile.unknown_field",
          `/profile/balancedBudget/${key}`,
          `Unknown Balanced budget field '${key}'.`,
        ),
      );
    }
  }
  const integer = (key: keyof typeof BALANCED_BUDGET_LIMITS) => {
    const range = BALANCED_BUDGET_LIMITS[key];
    return (
      Number.isSafeInteger(value[key]) &&
      Number(value[key]) >= range.min &&
      Number(value[key]) <= range.max
    );
  };
  for (const key of Object.keys(BALANCED_BUDGET_LIMITS) as Array<keyof typeof BALANCED_BUDGET_LIMITS>) {
    if (!integer(key)) {
      const range = BALANCED_BUDGET_LIMITS[key];
      issues.push(
        issue(
          "profile.invalid",
          `/profile/balancedBudget/${key}`,
          `${key} must be an integer from ${range.min} to ${range.max}.`,
        ),
      );
    }
  }
  if (
    integer("reservedFinalReviewCalls") &&
    integer("mainReviewCalls") &&
    Number(value.reservedFinalReviewCalls) > Number(value.mainReviewCalls)
  ) {
    issues.push(
      issue(
        "profile.invalid",
        "/profile/balancedBudget/reservedFinalReviewCalls",
        "Reserved final-review calls cannot exceed the main-review budget.",
      ),
    );
  }
}

function validateBalancedTiming(value: unknown, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push(issue("profile.invalid", "/profile/balancedTiming", "Balanced timing must be an object."));
    return;
  }
  for (const key of Object.keys(value)) {
    if (!BALANCED_TIMING_KEYS.has(key)) {
      issues.push(
        issue(
          "profile.unknown_field",
          `/profile/balancedTiming/${key}`,
          `Unknown Balanced timing field '${key}'.`,
        ),
      );
    }
  }
  const integer = (key: keyof typeof BALANCED_TIMING_LIMITS) => {
    const range = BALANCED_TIMING_LIMITS[key];
    return (
      Number.isSafeInteger(value[key]) &&
      Number(value[key]) >= range.min &&
      Number(value[key]) <= range.max
    );
  };
  for (const key of Object.keys(BALANCED_TIMING_LIMITS) as Array<keyof typeof BALANCED_TIMING_LIMITS>) {
    if (!integer(key)) {
      const range = BALANCED_TIMING_LIMITS[key];
      issues.push(
        issue(
          "profile.invalid",
          `/profile/balancedTiming/${key}`,
          `${key} must be an integer from ${range.min} to ${range.max}.`,
        ),
      );
    }
  }
  if (Object.keys(BALANCED_TIMING_LIMITS).every((key) => integer(key as keyof typeof BALANCED_TIMING_LIMITS))) {
    const hardCap = Number(value.hardCapSeconds);
    const longestWindow = Math.max(
      Number(value.contextAcquisitionSeconds),
      Number(value.firstProgressSeconds),
      Number(value.activeWindowSeconds),
      Number(value.progressExtensionSeconds),
      Number(value.growingProgressExtensionSeconds),
    );
    if (hardCap < longestWindow) {
      issues.push(
        issue(
          "profile.invalid",
          "/profile/balancedTiming/hardCapSeconds",
          "hardCapSeconds cannot be shorter than any configured wait or extension window.",
        ),
      );
    }
  }
}

function validateExternalMonitorPolicy(
  reference: unknown,
  lifecycle: "overnight-convergent" | "overnight-continuous" | "balanced",
  catalog: ModeSkillCatalog,
  issues: ValidationIssue[],
): void {
  if (!isRecord(reference) || typeof reference.id !== "string" || typeof reference.version !== "string") {
    issues.push(
      issue(
        "mode.policy_invalid",
        "/catalog/modes",
        `${lifecycle} must reference a versioned external monitor policy.`,
      ),
    );
    return;
  }
  const candidate = catalog.externalMonitorPolicies.find(
    (policy) =>
      isRecord(policy) && policy.id === reference.id && policy.version === reference.version,
  );
  if (!candidate) {
    issues.push(
      issue(
        "mode.policy_unknown",
        "/catalog/externalMonitorPolicies",
        `External monitor policy '${reference.id}@${reference.version}' is missing.`,
      ),
    );
    return;
  }

  const policy = candidate as ExternalMonitorPolicy;
  const layersAreOrdered =
    Array.isArray(policy.monitorLayers) &&
    policy.monitorLayers.length === EXTERNAL_MONITOR_LAYERS.length &&
    EXTERNAL_MONITOR_LAYERS.every((layer, index) => policy.monitorLayers[index] === layer);
  const commonContractIsValid =
    policy.schemaVersion === 1 &&
    policy.owner === "external-control-plane" &&
    policy.monitorsUpstreamProcess === false &&
    layersAreOrdered &&
    Array.isArray(policy.wakeEvents) &&
    Array.isArray(policy.terminalWithoutWake);
  const lifecycleContractIsValid =
    lifecycle === "overnight-convergent"
      ? policy.upstreamSleepPolicy === "end-episode-after-submit" &&
        sameStringSet(policy.wakeEvents, [
          "revision_pending",
          "semantic_blocked",
          "runtime_blocked",
          "scope_violation",
          "validation_failed",
        ]) &&
        sameStringSet(policy.terminalWithoutWake, ["accepted", "stopped", "interrupted"])
      : lifecycle === "overnight-continuous"
        ? policy.upstreamSleepPolicy === "end-episode-after-submit" &&
          sameStringSet(policy.wakeEvents, [
            "improvement_cycle_ready",
            "revision_pending",
            "semantic_blocked",
            "authority_blocked",
            "runtime_blocked",
          ]) &&
          sameStringSet(policy.terminalWithoutWake, ["stopped", "interrupted"])
        : policy.upstreamSleepPolicy === "yield-during-runner-round" &&
        sameStringSet(policy.wakeEvents, [
          "review_pending",
          "runtime_blocked",
          "budget_exhausted",
          "scope_violation",
          "validation_failed",
        ]) &&
        Array.isArray(policy.terminalWithoutWake) &&
        policy.terminalWithoutWake.length === 0;
  if (!commonContractIsValid || !lifecycleContractIsValid) {
    issues.push(
      issue(
        "mode.policy_invalid",
        "/catalog/externalMonitorPolicies",
        `External monitor policy '${reference.id}@${reference.version}' violates the ${lifecycle} lifecycle contract.`,
      ),
    );
  }
}

function validateOvernightLoopPolicy(
  mode: Extract<ModeSkillTemplate, { kind: "overnight" }>,
  profile: WorkflowProfile,
  catalog: ModeSkillCatalog,
  issues: ValidationIssue[],
): void {
  const reference = profile.overnightLoopPolicy ?? mode.defaultLoopPolicy;
  if (!isRecord(reference) || typeof reference.id !== "string" || typeof reference.version !== "string") {
    issues.push(
      issue(
        "mode.policy_invalid",
        profile.overnightLoopPolicy === undefined
          ? "/catalog/modes"
          : "/profile/overnightLoopPolicy",
        "Overnight must select a versioned loop policy.",
      ),
    );
    return;
  }
  const allowed =
    Array.isArray(mode.loopPolicies) &&
    mode.loopPolicies.some(
      (candidate) =>
        isRecord(candidate) &&
        candidate.id === reference.id &&
        candidate.version === reference.version,
    );
  const candidate = catalog.overnightLoopPolicies.find(
    (policy) =>
      isRecord(policy) && policy.id === reference.id && policy.version === reference.version,
  );
  if (!allowed || !candidate) {
    issues.push(
      issue(
        "mode.policy_unknown",
        profile.overnightLoopPolicy === undefined
          ? "/catalog/overnightLoopPolicies"
          : "/profile/overnightLoopPolicy",
        `Overnight loop policy '${reference.id}@${reference.version}' is missing or not allowed by this mode.`,
      ),
    );
    return;
  }

  const policy = candidate as OvernightLoopPolicy;
  const convergent =
    policy.strategy === "convergent" &&
    policy.scopePolicy === "monotonic-non-expanding" &&
    policy.completionPolicy === "terminal-on-acceptance";
  const continuous =
    policy.strategy === "continuous-improvement" &&
    policy.scopePolicy === "bounded-expansion-with-rationale" &&
    policy.completionPolicy === "continue-until-interrupted";
  if (
    policy.schemaVersion !== 1 ||
    typeof policy.displayName !== "string" ||
    policy.displayName.length === 0 ||
    typeof policy.description !== "string" ||
    policy.description.length === 0 ||
    (!convergent && !continuous)
  ) {
    issues.push(
      issue(
        "mode.policy_invalid",
        "/catalog/overnightLoopPolicies",
        `Overnight loop policy '${reference.id}@${reference.version}' is invalid.`,
      ),
    );
    return;
  }
  validateExternalMonitorPolicy(
    policy.externalMonitorPolicy,
    convergent ? "overnight-convergent" : "overnight-continuous",
    catalog,
    issues,
  );
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
    !Array.isArray(rawCatalog.tunedWindowPolicies) ||
    !Array.isArray(rawCatalog.balancedBudgetPolicies) ||
    !Array.isArray(rawCatalog.externalMonitorPolicies) ||
    !Array.isArray(rawCatalog.overnightLoopPolicies)
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
  if (mode.kind === "overnight") {
    validateOvernightLoopPolicy(mode, profile, catalog, issues);
  } else if (mode.kind === "balanced") {
    validateExternalMonitorPolicy(mode.externalMonitorPolicy, "balanced", catalog, issues);
  } else if (
    "externalMonitorPolicy" in mode ||
    "loopPolicies" in mode ||
    "defaultLoopPolicy" in mode
  ) {
    issues.push(
      issue(
        "mode.policy_invalid",
        "/catalog/modes",
        "Interactive must remain in foreground ownership and cannot reference external monitor or Overnight loop policies.",
      ),
    );
  }
  if (mode.kind === "balanced") {
    const policy = catalog.tunedWindowPolicies.find(
      (policy) =>
        policy.id === mode.tunedWindowPolicy.id &&
        policy.version === mode.tunedWindowPolicy.version,
    );
    if (!policy) {
      issues.push(
        issue(
          "mode.policy_unknown",
          "/catalog/tunedWindowPolicies",
          `Balanced policy '${mode.tunedWindowPolicy.id}@${mode.tunedWindowPolicy.version}' is missing.`,
        ),
      );
    } else {
      const positiveFields = [
        "contextAcquisitionSeconds",
        "activeWindowSeconds",
        "firstProgressSeconds",
        "progressExtensionSeconds",
        "growingProgressExtensionSeconds",
        "hardCapSeconds",
        "productIdleSeconds",
        "completionGraceSeconds",
        "tailSeconds",
        "advisorLeadSeconds",
        "advisorCallTimeoutSeconds",
        "pollSeconds",
      ] as const;
      if (
        positiveFields.some((key) => !Number.isFinite(policy[key]) || policy[key] <= 0) ||
        !Number.isFinite(policy.noOutputSeconds) ||
        policy.noOutputSeconds < 0 ||
        !Number.isSafeInteger(policy.productIdleConfirmations) ||
        policy.productIdleConfirmations < 1 ||
        policy.hardCapSeconds < policy.contextAcquisitionSeconds
      ) {
        issues.push(
          issue(
            "mode.policy_invalid",
            "/catalog/tunedWindowPolicies",
            `Balanced policy '${mode.tunedWindowPolicy.id}@${mode.tunedWindowPolicy.version}' is invalid.`,
          ),
        );
      }
    }
    const budgetPolicy = catalog.balancedBudgetPolicies.find(
      (policy) =>
        policy.id === mode.budgetPolicy.id && policy.version === mode.budgetPolicy.version,
    );
    if (!budgetPolicy) {
      issues.push(
        issue(
          "mode.policy_unknown",
          "/catalog/balancedBudgetPolicies",
          `Balanced budget policy '${mode.budgetPolicy.id}@${mode.budgetPolicy.version}' is missing.`,
        ),
      );
    } else if (
      !Number.isSafeInteger(budgetPolicy.mainReviewCalls) ||
      budgetPolicy.mainReviewCalls < BALANCED_BUDGET_LIMITS.mainReviewCalls.min ||
      budgetPolicy.mainReviewCalls > BALANCED_BUDGET_LIMITS.mainReviewCalls.max ||
      !Number.isSafeInteger(budgetPolicy.downstreamCalls) ||
      budgetPolicy.downstreamCalls < BALANCED_BUDGET_LIMITS.downstreamCalls.min ||
      budgetPolicy.downstreamCalls > BALANCED_BUDGET_LIMITS.downstreamCalls.max ||
      !Number.isSafeInteger(budgetPolicy.advisorCalls) ||
      budgetPolicy.advisorCalls < BALANCED_BUDGET_LIMITS.advisorCalls.min ||
      budgetPolicy.advisorCalls > BALANCED_BUDGET_LIMITS.advisorCalls.max ||
      !Number.isSafeInteger(budgetPolicy.reservedFinalReviewCalls) ||
      budgetPolicy.reservedFinalReviewCalls < BALANCED_BUDGET_LIMITS.reservedFinalReviewCalls.min ||
      budgetPolicy.reservedFinalReviewCalls > BALANCED_BUDGET_LIMITS.reservedFinalReviewCalls.max ||
      budgetPolicy.reservedFinalReviewCalls > budgetPolicy.mainReviewCalls
    ) {
      issues.push(
        issue(
          "mode.policy_invalid",
          "/catalog/balancedBudgetPolicies",
          `Balanced budget policy '${mode.budgetPolicy.id}@${mode.budgetPolicy.version}' is invalid.`,
        ),
      );
    }
    if (profile.balancedBudget !== undefined) {
      validateBalancedBudget(profile.balancedBudget, issues);
    }
    if (profile.balancedTiming !== undefined) {
      validateBalancedTiming(profile.balancedTiming, issues);
    }
  } else {
    if (profile.balancedBudget !== undefined) {
      issues.push(
        issue(
          "mode.incompatible_role",
          "/profile/balancedBudget",
          "Balanced budget configuration is valid only in Balanced mode.",
        ),
      );
    }
    if (profile.balancedTiming !== undefined) {
      issues.push(
        issue(
          "mode.incompatible_role",
          "/profile/balancedTiming",
          "Balanced timing configuration is valid only in Balanced mode.",
        ),
      );
    }
  }
  if (mode.kind !== "overnight" && profile.overnightLoopPolicy !== undefined) {
    issues.push(
      issue(
        "mode.incompatible_role",
        "/profile/overnightLoopPolicy",
        "Overnight loop policy configuration is valid only in Overnight mode.",
      ),
    );
  }

  validateModeRoles(mode, profile, agentsById, issues);
  return issues;
}
