# Product brief

## Outcome

Provide one visual control plane where users can select agent runtimes, model
connections, team roles, and execution modes without coupling orchestration to
one vendor or model.

## Product invariants

1. An agent runtime is not a model provider. A Claude Code runtime may use an
   official Anthropic model, a gateway profile, or another compatible backend.
2. Modes describe intervention and lifecycle policy, never vendor identity.
3. Running tasks use an immutable execution snapshot. Later profile changes do
   not silently mutate active work.
4. The daemon is the single writer for task state. UI, CLI, Skills, and MCP are
   clients of the same control API.
5. Native subagents and externally orchestrated subagents are distinct,
   capability-declared execution paths.
6. Secrets are referenced by identifier and must not be persisted in ordinary
   task or profile records.

## Initial modes

- **Overnight:** freeze, run the selected main agent until a terminal state,
  review, and submit bounded revisions when needed.
- **Balanced:** run one round under a versioned tuned window policy, return for
  review, and start another reviewed round when required.
- **Interactive:** keep the main agent in the foreground while it coordinates
  native, external, or hybrid subagents and synthesizes their results.

## First vertical slices

1. Versioned core contracts and built-in mode templates.
2. SQLite-backed daemon and event API.
3. Agent/provider/team/mode catalog UI.
4. ACP runtime adapter and Codex App Server adapter.
5. Run timeline, review center, and durable continuation.

