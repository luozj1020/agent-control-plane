export const SCHEMA_VERSION = 1 as const;

export type AgentKind = "codex" | "claude-code" | "custom";

export type AgentCapability =
  | "bounded-execution"
  | "durable-resume"
  | "external-delegation"
  | "native-subagents"
  | "semantic-review";

export interface AgentTarget {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly id: string;
  readonly kind: AgentKind;
  readonly displayName: string;
  readonly capabilities: readonly AgentCapability[];
}

export type WorkflowRole =
  | "builder"
  | "planner"
  | "reviewer"
  | "subagent"
  | "tester";

export type RoleTarget =
  | { readonly kind: "agent"; readonly agentId: string }
  | { readonly kind: "main" }
  | { readonly kind: "main-native" };

export interface RoleBinding {
  readonly role: WorkflowRole;
  readonly target: RoleTarget;
}

export interface VersionedRef {
  readonly id: string;
  readonly version: string;
}

export interface WorkflowProfile {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly id: string;
  readonly displayName: string;
  readonly mainAgentId: string;
  readonly mode: VersionedRef;
  readonly targetAdapterId: string;
  readonly roleBindings: readonly RoleBinding[];
}

export interface TunedWindowPolicy {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly id: string;
  readonly version: string;
  readonly contextAcquisitionSeconds: number;
  readonly activeWindowSeconds: number;
  readonly progressExtensionSeconds: number;
  readonly hardCapSeconds: number;
}

interface ModeSkillTemplateBase {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly description: string;
  readonly requiredMainCapabilities: readonly AgentCapability[];
}

export interface OvernightSkillTemplate extends ModeSkillTemplateBase {
  readonly kind: "overnight";
  readonly builderCapabilities: readonly AgentCapability[];
  readonly delegationPolicy: "durable-to-terminal";
  readonly reviewPolicy: "terminal-review-with-bounded-revisions";
}

export interface BalancedSkillTemplate extends ModeSkillTemplateBase {
  readonly kind: "balanced";
  readonly builderCapabilities: readonly AgentCapability[];
  readonly tunedWindowPolicy: VersionedRef;
  readonly reviewPolicy: "review-after-each-round";
}

export interface InteractiveSkillTemplate extends ModeSkillTemplateBase {
  readonly kind: "interactive";
  readonly subagentTopology: "main-native";
  readonly reviewPolicy: "continuous-main-agent-synthesis";
}

export type ModeSkillTemplate =
  | OvernightSkillTemplate
  | BalancedSkillTemplate
  | InteractiveSkillTemplate;

export interface ModeSkillCatalog {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly modes: readonly ModeSkillTemplate[];
  readonly tunedWindowPolicies: readonly TunedWindowPolicy[];
}

export interface SecretReference {
  readonly secretRef: string;
}

export interface SkillResolutionInput {
  readonly profile: WorkflowProfile;
  readonly agents: readonly AgentTarget[];
  readonly catalog?: ModeSkillCatalog;
}

export interface EffectiveSkillVariant {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly id: string;
  readonly mode: VersionedRef;
  readonly profileId: string;
  readonly mainAgentId: string;
  readonly targetAdapterId: string;
  readonly includedModeIds: readonly [string];
  readonly includedAgentIds: readonly string[];
  readonly relativeSkillPath: string;
  readonly content: string;
  readonly contentFingerprint: string;
  readonly estimatedTokens: number;
}

export interface ManagedSkillState {
  readonly variantId: string;
  readonly relativeSkillPath: string;
  readonly contentFingerprint: string;
  readonly active: boolean;
}

export type ActivationOperation =
  | { readonly kind: "deactivate"; readonly variantId: string }
  | { readonly kind: "backup"; readonly relativeSkillPath: string }
  | {
      readonly kind: "write";
      readonly relativeSkillPath: string;
      readonly contentFingerprint: string;
    }
  | { readonly kind: "activate"; readonly variantId: string };

export interface SkillActivationPlan {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly activeVariantId: string;
  readonly operations: readonly ActivationOperation[];
  readonly deactivatedVariantIds: readonly string[];
  readonly restartRequired: boolean;
}

export type ValidationIssueCode =
  | "agent.capability_missing"
  | "agent.duplicate_id"
  | "agent.invalid"
  | "agent.unknown"
  | "activation.duplicate_variant"
  | "activation.path_unsafe"
  | "mode.incompatible_role"
  | "mode.policy_unknown"
  | "mode.unknown"
  | "profile.duplicate_role"
  | "profile.invalid"
  | "profile.unknown_field"
  | "schema.unsupported"
  | "security.raw_secret";

export interface ValidationIssue {
  readonly code: ValidationIssueCode;
  readonly path: string;
  readonly message: string;
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };
