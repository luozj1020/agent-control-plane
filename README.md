# Agent Workflow Switch

Agent Workflow Switch is a local-first configuration manager for coding-agent
collaboration profiles. It follows the CC-Switch product model: choose a profile,
activate it, then start your preferred coding agent normally.

For example, a profile can select Codex as the main agent, Overnight as the
workflow mode, and Claude Code as the downstream implementation agent. Activation
syncs the required Skill and managed configuration into Codex. When the user
starts Codex, Codex loads the Skill and performs planning, delegation, review,
and continuation according to that profile.

## Product boundary

The application manages external configuration. It does not become an agent
runtime and does not reimplement the workflow engine.

It owns:

- reusable workflow profiles;
- main-agent, mode, and downstream role selections;
- Skill installation or synchronization;
- managed AGENTS.md/CLAUDE.md/config projections;
- compatibility checks, activation previews, atomic writes, and backups;
- import, export, health status, and one-click switching.

The selected main agent and its installed Skill own:

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
Skill            ai-coding-workflow
Target           selected repository
```

After activation, the user starts `codex` as usual. No separate orchestration
daemon is required.

## Status

Early product development. The first milestone defines versioned configuration
profiles and deterministic target-file projections.

