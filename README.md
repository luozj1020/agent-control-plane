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
compares the generated token footprint of all three mode Skills, and exports the
selected one. A separate Usage page presents actual local-agent token usage and
model-call counts in an API-console style dashboard with 1 hour, 24 hour,
7 day, and 30 day ranges. Filesystem activation is disabled by default.

Runtime usage is read locally from Codex session `token_count` events. The
collector incrementally reads only appended JSONL bytes and retains only event
time, model, and token counters in memory; prompt and response content is never
returned by the API or shown in the UI. Input totals include cached input, so the
dashboard displays cached and uncached portions separately without double
counting. The default source is `~/.codex/sessions`. To use another absolute
session directory:

```bash
AGENT_WORKFLOW_CODEX_SESSIONS_DIR=/absolute/path/to/sessions npm run dev
```

When available, a read-only CC Switch adapter imports deduplicated Claude Code
`session_log` rows from `~/.cc-switch/cc-switch.db` as downstream usage. It
never writes the CC Switch database. A hot SQLite rollback journal is handled
by querying a temporary snapshot, leaving the source database untouched. Use a
different absolute database path or disable the adapter explicitly:

```bash
AGENT_WORKFLOW_CC_SWITCH_DB=/absolute/path/to/cc-switch.db npm run dev
AGENT_WORKFLOW_CC_SWITCH_USAGE=off npm run dev
```

Token volume and model-call count use separate charts because they have
different units. Upstream and downstream calls share one grouped call chart so
delegation timing can be compared directly. Codex local session events are the
authoritative upstream source. Deduplicated Claude Code session rows imported
by CC Switch are the downstream source. If that database is absent or
incompatible, the downstream lane is explicitly marked unavailable; the
application never infers calls from model names or message content.

CC Switch rows currently provide agent-level attribution: they establish that
Claude Code made a call, but do not prove which activated workflow or task
caused it. Task-level attribution remains unavailable until dispatch and child
sessions share a stable run identifier.

To enable atomic activation, explicitly provide the absolute Codex Skill
directory you want this application to manage:

```bash
AGENT_WORKFLOW_SKILLS_DIR=/absolute/path/to/.codex/skills npm run dev
```

The application owns only `agent-workflow-active/` and its hidden
`.agent-workflow-switch/` control directory inside that root. It refuses to
overwrite an unowned active directory. Every switch backs up the prior managed
Skill, uses a single-writer lock and atomic directory rename, and exposes
rollback in the UI. A restarted Codex session is required after switching.

When filesystem activation is enabled, selecting a mode card is itself a switch
operation. The first selection activates the generated Skill; later selections
back up and atomically overwrite the current managed Skill. Selecting identical
content is a no-op. Rapid selections are serialized and only the latest waiting
mode is retained, so concurrent clicks cannot create competing file writers.
When activation is disabled, mode cards change only the browser preview.

## Activation history

Every successful filesystem activation now records an immutable snapshot under
the product-owned `.agent-workflow-switch/history/` directory. The Activation
History page provides:

- a chronological audit log of real Skill writes and restores;
- active mode, profile, main agent, adapter, fingerprint, and timestamp metadata;
- a field-level configuration comparison;
- a line-by-line `SKILL.md` restore preview from the current version to the
  selected snapshot;
- restoration of any recorded snapshot, with the current Skill backed up first;
- SHA-256 validation before snapshots are listed, compared, or restored.

Browser-only preview selections do not create audit records. History writes and
restores use the same ownership checks, local single-writer lock, atomic rename,
and cross-origin mutation protection as normal activation.
