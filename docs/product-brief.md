# Product brief

## Outcome

Provide a CC-Switch-style visual application that configures how an existing
coding agent collaborates with other agents. The product owns three versioned
workflow modes, renders the selected mode into the target agent's instructions,
and lets the user launch the selected main agent normally.

## Canonical flow

```text
select profile
  -> preview generated configuration
  -> compile the selected product mode for the target agents
  -> atomically activate generated Skill/instructions and managed config
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
3. Main agents and downstream roles are configurable independently. Runtime
   names never imply model providers.
4. Activation produces deterministic target-file projections and a receipt with
   source profile version, Skill version, target paths, hashes, and backups.
5. Every managed write uses preview, atomic replacement, and recoverable backup.
   User-owned text outside managed markers is preserved.
6. Active agent sessions are not silently mutated. A newly activated profile
   applies when the relevant agent or session is restarted/reloaded.
7. Credentials remain in the agent/provider's existing credential store. The
   product may reference a provider profile but does not copy raw secrets.
8. Removing the application must not leave Codex, Claude Code, or another agent
   unusable; the last known-good configuration remains recoverable.

## Configuration model

- **Agent target:** Codex, Claude Code, OpenCode, or another configurable host.
- **Workflow profile:** main agent, selected mode, downstream role bindings,
  repository scope, and optional provider-profile references.
- **Role binding:** builder, reviewer, tester, planner, or subagent mapped to an
  installed agent command/profile.
- **Mode template:** product-owned, versioned orchestration contract with role
  requirements, capabilities, continuation/review policy, and render inputs.
- **Instruction bundle:** generated Skill/instruction/config artifacts for the
  selected main and downstream agent adapters.
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

## First vertical slices

1. Versioned profile, role-binding, product-mode, instruction-bundle,
   projection, and activation-receipt contracts.
2. Read-only preview plus atomic activation/rollback for Codex project config.
3. Local UI for profiles, agents, modes, downstream roles, diff preview, and
   activation health.
4. Additional target adapters for Claude Code and other agent hosts.
5. Import/export and compatibility migration across Skill versions.

## Explicit non-goals

- Running or supervising Codex, Claude Code, or model processes.
- Owning task histories, worktrees, agent messages, or execution leases.
- Acting as a model gateway or storing API credentials.
- Keeping a second always-running orchestrator after profile activation.
