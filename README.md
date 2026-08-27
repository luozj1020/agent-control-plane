# Agent Workflow Switch

Agent Workflow Switch is a local-first configuration manager for coding-agent
collaboration profiles. It follows the CC-Switch product model: choose a profile,
activate it, then start your preferred coding agent normally.

For example, a profile can select Codex as the main agent, Overnight as the
workflow mode, and Claude Code as the downstream implementation agent.
Activation renders the product-owned Overnight template into a managed Skill
and agent configuration. When the user starts Codex, Codex loads that generated
instruction bundle and performs planning, delegation, review, and continuation.

## Product boundary

The application manages external configuration and owns the versioned workflow
templates that it projects into coding agents. It does not become an agent
runtime or supervise model processes.

It owns:

- reusable workflow profiles;
- built-in Overnight, Balanced, and Interactive mode templates;
- main-agent, mode, and downstream role selections;
- rendering and synchronization of mode-specific Skills/instructions;
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
Mode pack        built-in/overnight
Target           selected repository
```

After activation, the user starts `codex` as usual. No separate orchestration
daemon is required.

## Status

Early product development. The first milestone defines product-owned modes,
versioned configuration profiles, and deterministic target-file projections.
