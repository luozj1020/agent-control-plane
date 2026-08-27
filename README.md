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

The product does not need a hand-maintained Skill for every combination. It
keeps versioned mode templates and adapter renderers, materializes the selected
Skill variant deterministically, and records exactly which variant is active.

## Product boundary

The application manages external configuration and owns the versioned workflow
templates that it projects into coding agents. It does not become an agent
runtime or supervise model processes.

It owns:

- a workflow Skill catalog and activation lifecycle;
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
