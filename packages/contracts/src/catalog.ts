import type {
  ModeSkillCatalog,
  ModeSkillTemplate,
  BalancedBudgetPolicy,
  TunedWindowPolicy,
} from "./types.js";

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

const BALANCED_POLICY: TunedWindowPolicy = {
  schemaVersion: 1,
  id: "balanced-default",
  version: "1.0.0",
  contextAcquisitionSeconds: 600,
  activeWindowSeconds: 600,
  firstProgressSeconds: 600,
  progressExtensionSeconds: 300,
  growingProgressExtensionSeconds: 300,
  hardCapSeconds: 1500,
  noOutputSeconds: 0,
  productIdleSeconds: 600,
  productIdleConfirmations: 2,
  completionGraceSeconds: 20,
  tailSeconds: 90,
  advisorLeadSeconds: 60,
  advisorCallTimeoutSeconds: 90,
  pollSeconds: 5,
};

const BALANCED_BUDGET: BalancedBudgetPolicy = {
  schemaVersion: 1,
  id: "balanced-standard",
  version: "1.0.0",
  mainReviewCalls: 3,
  downstreamCalls: 3,
  advisorCalls: 2,
  reservedFinalReviewCalls: 1,
};

const MODES: readonly ModeSkillTemplate[] = [
  {
    schemaVersion: 1,
    id: "overnight",
    version: "1.0.0",
    kind: "overnight",
    displayName: "Overnight",
    description: "Durable downstream implementation followed by bounded semantic review.",
    requiredMainCapabilities: ["external-delegation", "semantic-review"],
    builderCapabilities: ["durable-resume"],
    delegationPolicy: "durable-to-terminal",
    reviewPolicy: "terminal-review-with-bounded-revisions",
  },
  {
    schemaVersion: 1,
    id: "balanced",
    version: "1.0.0",
    kind: "balanced",
    displayName: "Balanced",
    description: "Tuned downstream rounds with main-agent review after every round.",
    requiredMainCapabilities: ["external-delegation", "semantic-review"],
    builderCapabilities: ["bounded-execution"],
    tunedWindowPolicy: { id: BALANCED_POLICY.id, version: BALANCED_POLICY.version },
    budgetPolicy: { id: BALANCED_BUDGET.id, version: BALANCED_BUDGET.version },
    reviewPolicy: "review-after-each-round",
  },
  {
    schemaVersion: 1,
    id: "interactive",
    version: "1.0.0",
    kind: "interactive",
    displayName: "Interactive",
    description: "Foreground collaboration between the main agent and its native subagents.",
    requiredMainCapabilities: ["native-subagents"],
    subagentTopology: "main-native",
    reviewPolicy: "continuous-main-agent-synthesis",
  },
];

export const BUILTIN_MODE_CATALOG: ModeSkillCatalog = deepFreeze({
  schemaVersion: 1,
  modes: MODES,
  tunedWindowPolicies: [BALANCED_POLICY],
  balancedBudgetPolicies: [BALANCED_BUDGET],
});
