# Agent Workflow Switch

Agent Workflow Switch is a local-first workflow Skill manager for coding-agent
collaboration. It follows the CC-Switch product model: choose a mode and agent
bindings, activate the resolved Skill, then start your preferred coding agent
normally.

For example, a profile can select Codex as the main agent, Overnight as the
workflow mode, and Claude Code as the downstream implementation agent.
Activation renders the product-owned Overnight template into a managed Skill
and agent configuration. When the user starts Codex, Codex loads that generated
Skill bundle and performs planning, delegation, review, and continuation.

## What is switched

The user-facing controls are workflow mode, main agent, and downstream role
bindings. The actual activated artifact is an effective Skill bundle:

```text
product mode template + agent bindings + target adapter
                         -> effective Skill bundle
                         -> activate for Codex or another main agent
```

Each mode is a separate Skill family rather than one Skill containing all mode
instructions. The product may reuse source fragments internally, but it
materializes only the selected mode and selected agent bindings, exposes only
that workflow Skill to the target agent, and records exactly which variant is
active.

This keeps inactive modes and unused agent adapters out of Codex's loaded Skill
context. Switching mode means atomically switching the active minimal Skill,
not asking a large Skill to route among three embedded modes.

## Product boundary

The application manages external configuration and owns the versioned workflow
templates that it projects into coding agents. It does not become an agent
runtime or supervise model processes.

It owns:

- a workflow Skill catalog with separate mode Skill families;
- reusable workflow profiles;
- built-in Overnight, Balanced, and Interactive mode templates;
- main-agent, mode, and downstream role selections;
- rendering and synchronization of mode-specific Skills/instructions;
- active-Skill preview, enable, switch, rollback, update, and removal;
- managed AGENTS.md/CLAUDE.md/config projections;
- compatibility checks, activation previews, atomic writes, and backups;
- import, export, health status, and one-click switching.

The selected main agent, following the activated instructions, owns:

- task planning and intent freeze;
- native or external subagent coordination;
- downstream agent invocation;
- execution state, recovery, evidence, and review;
- completion and revision decisions.

## Example

```text
Profile: Codex Overnight / Claude Builder

Main agent       Codex
Mode             Overnight
Builder          Claude Code
Reviewer         Main agent
Active Skill     generated/codex-overnight-claude-builder
Target           selected repository
```

After activation, the user starts `codex` as usual. No separate orchestration
daemon is required.

## Status

Early product development. The first milestone defines the workflow Skill
catalog, product-owned modes, effective Skill bundles, and deterministic
target-file projections.

## Run the local preview

Node.js 24 and a global TypeScript compiler are currently required. No package
installation is needed for this dependency-free milestone.

```bash
npm run build
npm run dev
```

Open `http://127.0.0.1:4173`. The current UI resolves modes and agent bindings
through the real contracts package, previews the minimal generated `SKILL.md`,
and exports it. It deliberately does not write into Codex configuration yet.
