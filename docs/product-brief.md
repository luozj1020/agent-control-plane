# Product brief

## Outcome

Provide a CC-Switch-style visual application that configures how an existing
coding agent collaborates with other agents. Users activate a profile and then
launch the selected main agent normally; the installed Skill performs the work.

## Canonical flow

```text
select profile
  -> preview generated configuration
  -> atomically activate Skill and managed config
  -> start the selected main agent
  -> main agent loads the Skill
  -> Skill coordinates downstream agents according to the selected mode
```

Example: `main=codex`, `mode=overnight`, `builder=claude-code`. Starting Codex
causes Codex to freeze intent, delegate implementation to Claude Code, and review
the result because those semantics are supplied by the installed Skill.

## Product invariants

1. The product is a configuration switcher, not an agent runtime or workflow
   daemon.
2. Execution semantics remain in the selected, versioned Skill. The UI selects
   and validates a mode; it does not implement that mode.
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
  Skill binding, repository scope, and optional provider-profile references.
- **Role binding:** builder, reviewer, tester, planner, or subagent mapped to an
  installed agent command/profile.
- **Skill binding:** Skill identifier, source, version/hash, compatibility range,
  and synchronization strategy.
- **Projection:** deterministic files and managed blocks generated for each
  target agent.
- **Activation receipt:** before/after hashes, backups, compatibility result,
  warnings, and reload instructions.

## Initial modes

The product exposes modes declared by the selected Skill. The built-in
`ai-coding-workflow` integration initially advertises:

- **Overnight:** main agent freezes intent, delegates durable downstream work,
  and returns for final or revision review.
- **Balanced:** downstream work runs in tuned rounds and returns to the main
  agent for review after every round.
- **Interactive:** the main agent remains active and coordinates its configured
  native subagents. Downstream Claude delegation is not implied.

## First vertical slices

1. Versioned profile, role-binding, Skill-binding, projection, and activation
   receipt contracts.
2. Read-only preview plus atomic activation/rollback for Codex project config.
3. Local UI for profiles, agents, modes, downstream roles, diff preview, and
   activation health.
4. Additional target adapters for Claude Code and other agent hosts.
5. Import/export and compatibility migration across Skill versions.

## Explicit non-goals

- Running or supervising Codex, Claude Code, or model processes.
- Reimplementing Overnight, Balanced, Interactive, evidence, or review loops.
- Owning task histories, worktrees, agent messages, or execution leases.
- Acting as a model gateway or storing API credentials.

