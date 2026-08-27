import type { AgentTarget, WorkflowProfile } from "./types.js";

export const EXAMPLE_AGENTS: readonly AgentTarget[] = Object.freeze([
  Object.freeze({
    schemaVersion: 1,
    id: "codex",
    kind: "codex",
    displayName: "Codex",
    capabilities: Object.freeze([
      "external-delegation",
      "native-subagents",
      "semantic-review",
    ]),
  } satisfies AgentTarget),
  Object.freeze({
    schemaVersion: 1,
    id: "claude-code",
    kind: "claude-code",
    displayName: "Claude Code",
    capabilities: Object.freeze(["bounded-execution", "durable-resume"]),
  } satisfies AgentTarget),
]);

export const CODEX_OVERNIGHT_CLAUDE_PROFILE: WorkflowProfile = Object.freeze({
  schemaVersion: 1,
  id: "codex-overnight-claude",
  displayName: "Codex Overnight / Claude Builder",
  mainAgentId: "codex",
  mode: Object.freeze({ id: "overnight", version: "1.0.0" }),
  targetAdapterId: "codex-skill-v1",
  roleBindings: Object.freeze([
    Object.freeze({
      role: "builder",
      target: Object.freeze({ kind: "agent", agentId: "claude-code" }),
    }),
    Object.freeze({ role: "reviewer", target: Object.freeze({ kind: "main" }) }),
  ]),
});
