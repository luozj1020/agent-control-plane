import assert from "node:assert/strict";
import test from "node:test";

import {
  BALANCED_BUDGET_LIMITS,
  BALANCED_TIMING_LIMITS,
  BUILTIN_MODE_CATALOG,
  CODEX_OVERNIGHT_CLAUDE_PROFILE,
  EXAMPLE_AGENTS,
  customizeEffectiveSkill,
  planSkillActivation,
  resolveEffectiveSkill,
} from "../dist/index.js";

function resolve(profile, agents = EXAMPLE_AGENTS, catalog = BUILTIN_MODE_CATALOG) {
  return resolveEffectiveSkill({ profile, agents, catalog });
}

test("catalog exposes three distinct immutable mode Skill families", () => {
  assert.deepEqual(
    BUILTIN_MODE_CATALOG.modes.map((mode) => mode.id),
    ["overnight", "balanced", "interactive"],
  );
  assert.equal(new Set(BUILTIN_MODE_CATALOG.modes.map((mode) => mode.id)).size, 3);
  assert.equal(Object.isFrozen(BUILTIN_MODE_CATALOG), true);
  assert.deepEqual(BALANCED_BUDGET_LIMITS.mainReviewCalls, { min: 1, max: 99 });
  assert.deepEqual(BALANCED_TIMING_LIMITS.hardCapSeconds, { min: 60, max: 7_200 });
  assert.equal(Object.isFrozen(BUILTIN_MODE_CATALOG.modes[0]), true);
  assert.deepEqual(
    BUILTIN_MODE_CATALOG.externalMonitorPolicies.map((policy) => policy.id),
    ["overnight-convergent-monitor", "overnight-continuous-monitor", "balanced-round-monitor"],
  );
  for (const policy of BUILTIN_MODE_CATALOG.externalMonitorPolicies) {
    assert.equal(policy.owner, "external-control-plane");
    assert.equal(policy.monitorsUpstreamProcess, false);
    assert.deepEqual(policy.monitorLayers, ["process", "activity", "state", "evidence", "wake"]);
  }
  assert.deepEqual(
    BUILTIN_MODE_CATALOG.overnightLoopPolicies.map((policy) => policy.strategy),
    ["convergent", "continuous-improvement"],
  );
  assert.equal("externalMonitorPolicy" in BUILTIN_MODE_CATALOG.modes[2], false);
});

test("Overnight resolves one minimal Skill with only selected agents", () => {
  const result = resolve(CODEX_OVERNIGHT_CLAUDE_PROFILE);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.deepEqual(result.value.includedModeIds, ["overnight"]);
  assert.deepEqual(result.value.includedAgentIds, ["codex", "claude-code"]);
  assert.match(result.value.content, /# Workflow/);
  assert.doesNotMatch(result.value.content, /Balanced|Interactive/);
  assert.doesNotMatch(result.value.content, /- mode:|- main:|- builder:|- reviewer:/);
  assert.deepEqual(result.value.externalMonitorPolicy, {
    id: "overnight-convergent-monitor",
    version: "1.0.0",
  });
  assert.deepEqual(result.value.overnightLoopPolicy, {
    id: "overnight-convergent",
    version: "1.0.0",
  });
  assert.match(result.value.id, /overnight-convergent/);
  assert.match(result.value.content, /agent-control-plane overnight submit/);
  assert.match(result.value.content, /--adapter claude-code --strategy convergent/);
  assert.match(result.value.content, /end the current upstream inference episode/);
  assert.match(result.value.content, /Do not call status or poll downstream/);
  assert.match(result.value.content, /process -> activity -> state -> evidence -> wake/);
  assert.match(result.value.content, /revision_pending, semantic_blocked, runtime_blocked/);
  assert.match(result.value.content, /Terminal-without-wake states: accepted, stopped, interrupted/);
  assert.match(result.value.content, /scope\.write_paths.*may only narrow/);
  assert.match(result.value.content, /accept.*globally terminal/);
  assert.match(result.value.relativeSkillPath, /SKILL\.md$/);
});

test("Overnight continuous improvement treats user metrics as a floor and expands only by reviewed cycles", () => {
  const profile = {
    ...CODEX_OVERNIGHT_CLAUDE_PROFILE,
    id: "codex-overnight-continuous",
    overnightLoopPolicy: { id: "overnight-continuous-improvement", version: "1.0.0" },
  };
  const result = resolve(profile);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.match(result.value.id, /overnight-continuous-improvement/);
  assert.deepEqual(result.value.overnightLoopPolicy, profile.overnightLoopPolicy);
  assert.deepEqual(result.value.externalMonitorPolicy, {
    id: "overnight-continuous-monitor",
    version: "1.0.0",
  });
  assert.match(result.value.content, /permanent minimum floor/);
  assert.match(result.value.content, /success as a checkpoint, not global completion/);
  assert.match(result.value.content, /overnight next-init/);
  assert.match(result.value.content, /hypothesis and Task Card/);
  assert.match(result.value.content, /`added_paths`/);
  assert.match(result.value.content, /Continue until the user interrupts/);
  assert.match(result.value.content, /--decision continue --next NEXT\.json/);
  assert.doesNotMatch(result.value.content, /globally terminal/);
});

test("edited Skill content retains generated identity and receives derived metadata", () => {
  const resolved = resolve(CODEX_OVERNIGHT_CLAUDE_PROFILE);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  const content = resolved.value.content.replace("# Workflow", "# Customized workflow");
  const customized = customizeEffectiveSkill(resolved.value, content);
  assert.equal(customized.ok, true);
  if (!customized.ok) return;
  assert.equal(customized.value.content, content);
  assert.notEqual(customized.value.contentFingerprint, resolved.value.contentFingerprint);
  assert.equal(customized.value.estimatedTokens, Math.ceil(content.length / 4));
  assert.equal(customized.value.id, resolved.value.id);
});

test("edited Skill content rejects missing or mismatched generated frontmatter", () => {
  const resolved = resolve(CODEX_OVERNIGHT_CLAUDE_PROFILE);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  const mismatched = customizeEffectiveSkill(
    resolved.value,
    resolved.value.content.replace("name: agent-workflow-active", "name: another-skill"),
  );
  assert.equal(mismatched.ok, false);
  if (mismatched.ok) return;
  assert(mismatched.issues.some((issue) => issue.code === "skill.frontmatter_invalid"));
});

test("edited Skill content rejects duplicate identity fields and oversized UTF-8 content", () => {
  const resolved = resolve(CODEX_OVERNIGHT_CLAUDE_PROFILE);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  const duplicate = customizeEffectiveSkill(
    resolved.value,
    resolved.value.content.replace(
      "name: agent-workflow-active",
      "name: agent-workflow-active\nname: agent-workflow-active",
    ),
  );
  assert.equal(duplicate.ok, false);
  const oversized = customizeEffectiveSkill(
    resolved.value,
    `${resolved.value.content}${"界".repeat(44_000)}`,
  );
  assert.equal(oversized.ok, false);
  if (oversized.ok) return;
  assert(oversized.issues.some((issue) => issue.code === "skill.content_too_large"));
});

test("Balanced resolves its tuned policy and excludes other modes", () => {
  const profile = {
    ...CODEX_OVERNIGHT_CLAUDE_PROFILE,
    id: "codex-balanced-claude",
    mode: { id: "balanced", version: "1.0.0" },
  };
  const result = resolve(profile);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.doesNotMatch(result.value.content, /balanced-default@1\.0\.0|--policy/);
  assert.match(result.value.content, /agent-control-plane balanced run/);
  assert.match(result.value.content, /context=600, first-progress=600, active=600/);
  assert.match(result.value.content, /main-review=3, downstream=3, advisor=2/);
  assert.deepEqual(result.value.externalMonitorPolicy, {
    id: "balanced-round-monitor",
    version: "1.0.0",
  });
  assert.match(result.value.content, /Yield the upstream until the command returns/);
  assert.match(result.value.content, /Do not poll status/);
  assert.match(result.value.content, /machine-observed product changes refresh execution windows/);
  assert.match(result.value.content, /At `review_pending`/);
  assert.match(result.value.content, /runtime_blocked, budget_exhausted, scope_violation, validation_failed/);
  assert.doesNotMatch(result.value.content, /Overnight|Interactive/);
});

test("Overnight Skills invoke the product-owned detached runner", () => {
  const convergent = resolve(CODEX_OVERNIGHT_CLAUDE_PROFILE);
  assert.equal(convergent.ok, true);
  if (!convergent.ok) return;
  assert.match(convergent.value.content, /agent-control-plane overnight submit/);
  assert.match(convergent.value.content, /--strategy convergent/);
  assert.match(convergent.value.content, /agent-control-plane overnight review/);
  assert.doesNotMatch(convergent.value.content, /aiwf\.py/);

  const continuous = resolve({
    ...CODEX_OVERNIGHT_CLAUDE_PROFILE,
    overnightLoopPolicy: { id: "overnight-continuous-improvement", version: "1.0.0" },
  });
  assert.equal(continuous.ok, true);
  if (!continuous.ok) return;
  assert.match(continuous.value.content, /--strategy continuous-improvement/);
  assert.match(continuous.value.content, /--decision continue --next NEXT\.json/);
  assert.match(continuous.value.content, /overnight interrupt/);
});

test("mode resolution rejects missing or malformed external monitor policies", () => {
  const unknownProfile = {
    ...CODEX_OVERNIGHT_CLAUDE_PROFILE,
    overnightLoopPolicy: { id: "missing-policy", version: "1.0.0" },
  };
  const unknown = resolve(unknownProfile);
  assert.equal(unknown.ok, false);
  if (!unknown.ok) {
    assert(unknown.issues.some((entry) => entry.code === "mode.policy_unknown"));
  }

  const invalidCatalog = {
    ...BUILTIN_MODE_CATALOG,
    externalMonitorPolicies: BUILTIN_MODE_CATALOG.externalMonitorPolicies.map((policy) =>
      policy.id === "overnight-convergent-monitor"
        ? { ...policy, monitorLayers: ["activity", "process", "state", "evidence", "wake"] }
        : policy,
    ),
  };
  const invalid = resolve(CODEX_OVERNIGHT_CLAUDE_PROFILE, EXAMPLE_AGENTS, invalidCatalog);
  assert.equal(invalid.ok, false);
  if (!invalid.ok) {
    assert(invalid.issues.some((entry) => entry.code === "mode.policy_invalid"));
  }

  const malformedCatalog = {
    ...BUILTIN_MODE_CATALOG,
    externalMonitorPolicies: BUILTIN_MODE_CATALOG.externalMonitorPolicies.map((policy) =>
      policy.id === "overnight-convergent-monitor"
        ? { ...policy, wakeEvents: null, terminalWithoutWake: "review_ready" }
        : policy,
    ),
  };
  assert.doesNotThrow(() =>
    resolve(CODEX_OVERNIGHT_CLAUDE_PROFILE, EXAMPLE_AGENTS, malformedCatalog),
  );
  const malformed = resolve(CODEX_OVERNIGHT_CLAUDE_PROFILE, EXAMPLE_AGENTS, malformedCatalog);
  assert.equal(malformed.ok, false);
  if (!malformed.ok) {
    assert(malformed.issues.some((entry) => entry.code === "mode.policy_invalid"));
  }
});

test("Overnight loop selection is rejected outside Overnight mode", () => {
  const profile = {
    ...CODEX_OVERNIGHT_CLAUDE_PROFILE,
    id: "balanced-with-overnight-policy",
    mode: { id: "balanced", version: "1.0.0" },
    overnightLoopPolicy: { id: "overnight-convergent", version: "1.0.0" },
  };
  const result = resolve(profile);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert(result.issues.some((entry) => entry.path === "/profile/overnightLoopPolicy"));
  }
});

test("Balanced embeds validated budget and timing overrides in the external Runner command", () => {
  const profile = {
    ...CODEX_OVERNIGHT_CLAUDE_PROFILE,
    id: "codex-balanced-budgeted",
    mode: { id: "balanced", version: "1.0.0" },
    balancedBudget: {
      mainReviewCalls: 4,
      downstreamCalls: 5,
      advisorCalls: 2,
      reservedFinalReviewCalls: 1,
    },
    balancedTiming: {
      contextAcquisitionSeconds: 480,
      firstProgressSeconds: 420,
      activeWindowSeconds: 540,
      progressExtensionSeconds: 240,
      growingProgressExtensionSeconds: 300,
      hardCapSeconds: 1800,
    },
  };
  const result = resolve(profile);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.value.content, /--main-review-calls 4/);
  assert.match(result.value.content, /--downstream-calls 5/);
  assert.match(result.value.content, /--context-seconds 480/);
  assert.match(result.value.content, /--growing-extension-seconds 300/);
  assert.doesNotMatch(result.value.content, /max-total-tokens/);
});

test("Balanced rejects a budget that consumes the protected final review slot", () => {
  const profile = {
    ...CODEX_OVERNIGHT_CLAUDE_PROFILE,
    id: "codex-balanced-invalid-budget",
    mode: { id: "balanced", version: "1.0.0" },
    balancedBudget: {
      mainReviewCalls: 1,
      downstreamCalls: 1,
      advisorCalls: 0,
      reservedFinalReviewCalls: 2,
    },
  };
  const result = resolve(profile);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert(result.issues.some((entry) => entry.path.endsWith("reservedFinalReviewCalls")));
});

test("Balanced rejects every budget field outside its product range", () => {
  const profile = {
    ...CODEX_OVERNIGHT_CLAUDE_PROFILE,
    id: "codex-balanced-out-of-range",
    mode: { id: "balanced", version: "1.0.0" },
    balancedBudget: {
      mainReviewCalls: 100,
      downstreamCalls: 100,
      advisorCalls: 100,
      reservedFinalReviewCalls: 100,
    },
  };
  const result = resolve(profile);
  assert.equal(result.ok, false);
  if (result.ok) return;
  const paths = new Set(result.issues.map((entry) => entry.path));
  for (const key of Object.keys(profile.balancedBudget)) {
    assert(paths.has(`/profile/balancedBudget/${key}`));
  }
});

test("Balanced rejects timing overrides outside ranges or beyond the hard cap", () => {
  const profile = {
    ...CODEX_OVERNIGHT_CLAUDE_PROFILE,
    id: "codex-balanced-invalid-timing",
    mode: { id: "balanced", version: "1.0.0" },
    balancedTiming: {
      contextAcquisitionSeconds: 600,
      firstProgressSeconds: 600,
      activeWindowSeconds: 800,
      progressExtensionSeconds: 300,
      growingProgressExtensionSeconds: 300,
      hardCapSeconds: 700,
    },
  };
  const result = resolve(profile);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert(result.issues.some((entry) => entry.path.endsWith("hardCapSeconds")));
});

test("Balanced rejects arbitrary window configuration on the profile", () => {
  const profile = {
    ...CODEX_OVERNIGHT_CLAUDE_PROFILE,
    mode: { id: "balanced", version: "1.0.0" },
    windowMinutes: 5,
  };
  const result = resolve(profile);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert(result.issues.some((entry) => entry.code === "profile.unknown_field"));
});

test("Interactive uses native subagents and includes no external agent", () => {
  const profile = {
    ...CODEX_OVERNIGHT_CLAUDE_PROFILE,
    id: "codex-interactive-native",
    mode: { id: "interactive", version: "1.0.0" },
    roleBindings: [{ role: "subagent", target: { kind: "main-native" } }],
  };
  const result = resolve(profile);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.deepEqual(result.value.includedModeIds, ["interactive"]);
  assert.deepEqual(result.value.includedAgentIds, ["codex"]);
  assert.match(result.value.content, /# Workflow/);
  assert.match(result.value.content, /Do not assume a fixed role list or model/);
  assert.match(result.value.content, /bounded objective, read\/write scope/);
  assert.match(result.value.content, /one active writer/);
  assert.match(result.value.content, /explicit integration owner/);
  assert.equal(result.value.externalMonitorPolicy, undefined);
  assert.equal(result.value.overnightLoopPolicy, undefined);
  assert.doesNotMatch(result.value.content, /external-control-plane|yield\/sleep|revision_pending/);
  assert.doesNotMatch(result.value.content, /Overnight|Balanced|Claude Code/);
});

test("generated Skills are self-contained, mode-isolated, and bounded in size", () => {
  const profiles = [
    CODEX_OVERNIGHT_CLAUDE_PROFILE,
    {
      ...CODEX_OVERNIGHT_CLAUDE_PROFILE,
      id: "continuous-size-check",
      overnightLoopPolicy: { id: "overnight-continuous-improvement", version: "1.0.0" },
    },
    {
      ...CODEX_OVERNIGHT_CLAUDE_PROFILE,
      id: "balanced-size-check",
      mode: { id: "balanced", version: "1.0.0" },
    },
    {
      ...CODEX_OVERNIGHT_CLAUDE_PROFILE,
      id: "interactive-size-check",
      mode: { id: "interactive", version: "1.0.0" },
      roleBindings: [{ role: "subagent", target: { kind: "main-native" } }],
    },
  ];
  for (const profile of profiles) {
    const result = resolve(profile);
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    assert.match(result.value.content, /^---\nname: agent-workflow-active\n/);
    assert.match(result.value.content, /description: Use when /);
    assert.doesNotMatch(result.value.content, /## Active configuration|- mode:|- main:|- builder:|- reviewer:|@1\.0\.0/);
    assert.match(result.value.content, /## Operating contract/);
    assert.match(result.value.content, /## Procedure/);
    assert(result.value.estimatedTokens <= (profile.mode.id === "interactive" ? 500 : 900));
    if (profile.mode.id === "interactive") {
      assert.doesNotMatch(result.value.content, /## Task Card|agent-control-plane .* run/);
    } else {
      assert.match(result.value.content, /## Task Card/);
      assert.match(result.value.content, /agent-control-plane task init --output TASK\.json/);
      assert.match(result.value.content, /agent-control-plane task validate --task TASK\.json/);
      assert.doesNotMatch(result.value.content, /```json/);
    }
  }
});

test("Interactive rejects external-only subagent topology", () => {
  const profile = {
    ...CODEX_OVERNIGHT_CLAUDE_PROFILE,
    mode: { id: "interactive", version: "1.0.0" },
    roleBindings: [
      { role: "subagent", target: { kind: "agent", agentId: "claude-code" } },
    ],
  };
  const result = resolve(profile);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert(result.issues.some((entry) => entry.code === "mode.incompatible_role"));
});

test("unknown mode versions and duplicate roles fail closed", () => {
  const profile = {
    ...CODEX_OVERNIGHT_CLAUDE_PROFILE,
    mode: { id: "overnight", version: "99.0.0" },
    roleBindings: [
      ...CODEX_OVERNIGHT_CLAUDE_PROFILE.roleBindings,
      { role: "builder", target: { kind: "agent", agentId: "claude-code" } },
    ],
  };
  const result = resolve(profile);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert(result.issues.some((entry) => entry.code === "mode.unknown"));
  assert(result.issues.some((entry) => entry.code === "profile.duplicate_role"));
});

test("raw credentials are rejected", () => {
  const profile = { ...CODEX_OVERNIGHT_CLAUDE_PROFILE, apiKey: "not-allowed" };
  const result = resolve(profile);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert(result.issues.some((entry) => entry.code === "security.raw_secret"));
});

test("malformed JSON-shaped input fails closed instead of throwing", () => {
  const result = resolveEffectiveSkill({ profile: null, agents: "invalid" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert(result.issues.some((entry) => entry.code === "profile.invalid"));
});

test("activation switches off every other managed workflow Skill", () => {
  const resolved = resolve(CODEX_OVERNIGHT_CLAUDE_PROFILE);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;

  const plan = planSkillActivation(resolved.value, [
    {
      variantId: "workflow-codex-interactive",
      relativeSkillPath: "workflow-codex-interactive/SKILL.md",
      contentFingerprint: "fnv1a32:00000000",
      active: true,
    },
  ]);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.deepEqual(plan.value.deactivatedVariantIds, ["workflow-codex-interactive"]);
  assert.deepEqual(
    plan.value.operations.map((operation) => operation.kind),
    ["deactivate", "write", "activate"],
  );
  assert.equal(plan.value.restartRequired, true);
});

test("activation is a no-op for the identical sole active Skill", () => {
  const resolved = resolve(CODEX_OVERNIGHT_CLAUDE_PROFILE);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;

  const plan = planSkillActivation(resolved.value, [
    {
      variantId: resolved.value.id,
      relativeSkillPath: resolved.value.relativeSkillPath,
      contentFingerprint: resolved.value.contentFingerprint,
      projectBinding: null,
      active: true,
    },
  ]);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.deepEqual(plan.value.operations, []);
  assert.equal(plan.value.restartRequired, false);
});

test("activation treats a different project revision as a distinct target", () => {
  const resolved = resolve(CODEX_OVERNIGHT_CLAUDE_PROFILE);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  const desired = {
    ...resolved.value,
    projectBinding: {
      projectId: null,
      workspaceId: "workspace-1",
      projectRevision: 2,
      projectConfigSha256: "b".repeat(64),
    },
  };
  const plan = planSkillActivation(desired, [{
    variantId: desired.id,
    relativeSkillPath: desired.relativeSkillPath,
    contentFingerprint: desired.contentFingerprint,
    projectBinding: {
      projectId: "project-1",
      workspaceId: "workspace-1",
      projectRevision: 1,
      projectConfigSha256: "a".repeat(64),
    },
    active: true,
  }]);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.deepEqual(plan.value.operations.map((entry) => entry.kind), ["backup", "write", "activate"]);
  assert.equal(plan.value.restartRequired, true);
});

test("activation rejects traversal paths", () => {
  const resolved = resolve(CODEX_OVERNIGHT_CLAUDE_PROFILE);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;

  const unsafe = { ...resolved.value, relativeSkillPath: "../SKILL.md" };
  const plan = planSkillActivation(unsafe, []);
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert(plan.issues.some((entry) => entry.code === "activation.path_unsafe"));
});
