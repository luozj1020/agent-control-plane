import type {
  ModeSkillCatalog,
  ModeSkillTemplate,
  BalancedBudgetPolicy,
  ExternalMonitorPolicy,
  OvernightLoopPolicy,
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

const OVERNIGHT_CONVERGENT_MONITOR_POLICY: ExternalMonitorPolicy = {
  schemaVersion: 1,
  id: "overnight-convergent-monitor",
  version: "1.0.0",
  owner: "external-control-plane",
  monitorLayers: ["process", "activity", "state", "evidence", "wake"],
  monitorsUpstreamProcess: false,
  upstreamSleepPolicy: "end-episode-after-submit",
  wakeEvents: [
    "revision_pending",
    "semantic_blocked",
    "runtime_blocked",
    "scope_violation",
    "validation_failed",
  ],
  terminalWithoutWake: ["accepted", "stopped", "interrupted"],
};

const OVERNIGHT_CONTINUOUS_MONITOR_POLICY: ExternalMonitorPolicy = {
  schemaVersion: 1,
  id: "overnight-continuous-monitor",
  version: "1.0.0",
  owner: "external-control-plane",
  monitorLayers: ["process", "activity", "state", "evidence", "wake"],
  monitorsUpstreamProcess: false,
  upstreamSleepPolicy: "end-episode-after-submit",
  wakeEvents: [
    "improvement_cycle_ready",
    "revision_pending",
    "semantic_blocked",
    "authority_blocked",
    "runtime_blocked",
  ],
  terminalWithoutWake: ["stopped", "interrupted"],
};

const BALANCED_MONITOR_POLICY: ExternalMonitorPolicy = {
  schemaVersion: 1,
  id: "balanced-round-monitor",
  version: "1.0.0",
  owner: "external-control-plane",
  monitorLayers: ["process", "activity", "state", "evidence", "wake"],
  monitorsUpstreamProcess: false,
  upstreamSleepPolicy: "yield-during-runner-round",
  wakeEvents: [
    "review_pending",
    "runtime_blocked",
    "budget_exhausted",
    "scope_violation",
    "validation_failed",
  ],
  terminalWithoutWake: [],
};

const OVERNIGHT_CONVERGENT_POLICY: OvernightLoopPolicy = {
  schemaVersion: 1,
  id: "overnight-convergent",
  version: "1.0.0",
  displayName: "收缩式修改",
  description: "每轮 Revision Delta 不得超过前一轮边界，验收通过后结束。",
  strategy: "convergent",
  scopePolicy: "monotonic-non-expanding",
  completionPolicy: "terminal-on-acceptance",
  externalMonitorPolicy: {
    id: OVERNIGHT_CONVERGENT_MONITOR_POLICY.id,
    version: OVERNIGHT_CONVERGENT_MONITOR_POLICY.version,
  },
};

const OVERNIGHT_CONTINUOUS_POLICY: OvernightLoopPolicy = {
  schemaVersion: 1,
  id: "overnight-continuous-improvement",
  version: "1.0.0",
  displayName: "持续扩张改进",
  description: "达到用户指标后继续规划有证据、有边界的改进循环，直到用户中断。",
  strategy: "continuous-improvement",
  scopePolicy: "bounded-expansion-with-rationale",
  completionPolicy: "continue-until-interrupted",
  externalMonitorPolicy: {
    id: OVERNIGHT_CONTINUOUS_MONITOR_POLICY.id,
    version: OVERNIGHT_CONTINUOUS_MONITOR_POLICY.version,
  },
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
    loopPolicies: [
      { id: OVERNIGHT_CONVERGENT_POLICY.id, version: OVERNIGHT_CONVERGENT_POLICY.version },
      { id: OVERNIGHT_CONTINUOUS_POLICY.id, version: OVERNIGHT_CONTINUOUS_POLICY.version },
    ],
    defaultLoopPolicy: {
      id: OVERNIGHT_CONVERGENT_POLICY.id,
      version: OVERNIGHT_CONVERGENT_POLICY.version,
    },
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
    externalMonitorPolicy: {
      id: BALANCED_MONITOR_POLICY.id,
      version: BALANCED_MONITOR_POLICY.version,
    },
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
  externalMonitorPolicies: [
    OVERNIGHT_CONVERGENT_MONITOR_POLICY,
    OVERNIGHT_CONTINUOUS_MONITOR_POLICY,
    BALANCED_MONITOR_POLICY,
  ],
  overnightLoopPolicies: [OVERNIGHT_CONVERGENT_POLICY, OVERNIGHT_CONTINUOUS_POLICY],
});
