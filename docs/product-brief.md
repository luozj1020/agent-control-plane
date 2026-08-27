# Product brief

## Outcome

Provide a CC-Switch-style visual workflow Skill manager. Users select a mode,
main agent, and downstream role bindings; the product resolves them into an
effective Skill bundle, activates that bundle for the main agent, and lets the
user launch the main agent normally.

## Canonical flow

```text
select profile
  -> preview generated configuration
  -> resolve mode + agent bindings + target adapter
  -> render an effective Skill bundle
  -> atomically activate the Skill and managed config
  -> start the selected main agent
  -> main agent loads the generated instructions
  -> main agent coordinates downstream agents according to the selected mode
```

Example: `main=codex`, `mode=overnight`, `builder=claude-code`. Starting Codex
causes Codex to freeze intent, delegate implementation to Claude Code, and
review the result because activation projected the product-owned Overnight
template into Codex.

## Product invariants

1. The product is a configuration switcher, not an agent runtime or workflow
   daemon.
2. Overnight, Balanced, and Interactive are versioned product-owned mode
   templates. The product compiles them into agent-specific Skills,
   instructions, and configuration.
3. The managed unit is an effective Skill bundle whose identity binds the mode,
   agent bindings, adapter versions, source hashes, and generated artifacts.
4. Main agents and downstream roles are configurable independently. Runtime
   names never imply model providers.
5. Activation produces deterministic target-file projections and a receipt with
   source profile version, Skill version, target paths, hashes, and backups.
6. Every managed write uses preview, atomic replacement, and recoverable backup.
   User-owned text outside managed markers is preserved.
7. Active agent sessions are not silently mutated. A newly activated profile
   applies when the relevant agent or session is restarted/reloaded.
8. Credentials remain in the agent/provider's existing credential store. The
   product may reference a provider profile but does not copy raw secrets.
9. Removing the application must not leave Codex, Claude Code, or another agent
   unusable; the last known-good configuration remains recoverable.

## Configuration model

- **Agent target:** Codex, Claude Code, OpenCode, or another configurable host.
- **Workflow profile:** main agent, selected mode, downstream role bindings,
  repository scope, and optional provider-profile references.
- **Role binding:** builder, reviewer, tester, planner, or subagent mapped to an
  installed agent command/profile.
- **Mode template:** product-owned, versioned orchestration contract with role
  requirements, capabilities, continuation/review policy, and render inputs.
- **Target adapter:** renders a product mode for Codex, Claude Code, or another
  compatible main-agent Skill/config format.
- **Effective Skill bundle:** immutable resolved mode, agent bindings, adapter
  versions, source hashes, and generated Skill/instruction/config artifacts.
- **Skill catalog entry:** installed, available, active, incompatible, stale, or
  recoverable Skill bundle plus its compatibility and health information.
- **Projection:** deterministic files and managed blocks generated for each
  target agent.
- **Activation receipt:** before/after hashes, backups, compatibility result,
  warnings, and reload instructions.

## Product-owned modes

- **Overnight:** the main agent freezes intent, delegates durable downstream
  work to the configured roles, returns only for semantic review, and issues
  bounded revisions until accepted or genuinely blocked.
- **Balanced:** the product selects a versioned, previously tuned window policy;
  downstream work runs for the policy's current window and returns to the main
  agent for review after every round. It is not one user-entered fixed window.
- **Interactive:** the main agent remains foreground owner and collaborates with
  its native subagents. It requires native-subagent capability and does not
  imply external Claude delegation.

Mode templates are agent-neutral. Target adapters render the same template for
Codex, Claude Code, or future main agents. Adding new modes later uses the same
versioned mode registry rather than changing the profile schema.

The catalog treats rendered combinations as logical Skill variants. Only the
selected variant must be materialized, so adding agents and modes does not
require maintaining a Cartesian product of copied Skill directories.

## First vertical slices

1. Versioned profile, role-binding, product-mode, effective-Skill-bundle,
   catalog-entry, projection, and activation-receipt contracts.
2. Resolve and render one Codex Skill variant from mode plus agent bindings.
3. Read-only preview plus atomic activation/rollback for Codex project config.
4. Local UI for Skills, modes, agents, downstream roles, active-Skill diff, and
   activation health.
5. Additional target adapters for Claude Code and other agent hosts.
6. Import/export and compatibility migration across Skill versions.

## Explicit non-goals

- Running or supervising Codex, Claude Code, or model processes.
- Owning task histories, worktrees, agent messages, or execution leases.
- Acting as a model gateway or storing API credentials.
- Keeping a second always-running orchestrator after profile activation.
