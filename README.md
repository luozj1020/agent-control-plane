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
templates that it projects into coding agents. Balanced additionally uses an
on-demand local Runner invoked by the active main agent. It is not a daemon:
the Runner exists only for one bounded downstream round and owns that child
process, its timers, budget ledger, evidence, and termination.

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
- a versioned Balanced timing policy and configurable call/Token budget;
- an on-demand Balanced Runner with pluggable downstream adapters;
- hash-bound round evidence, Revision Delta continuation, and budget receipts.

The selected main agent, following the activated instructions, owns:

- task planning and intent freeze;
- native or external subagent coordination;
- starting the Balanced Runner when the active Skill requires it;
- completion and revision decisions.

For Balanced, the Runner owns downstream invocation, execution windows,
process-group termination, session continuation, scope enforcement, validation
evidence, and call/Token budget enforcement. The main agent retains semantic
acceptance and never gains merge authority from a successful child exit.

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
daemon is required; Balanced starts its foreground Runner only when a task is
delegated.

## Status

Early product development. The first milestone defines the workflow Skill
catalog, product-owned modes, effective Skill bundles, and deterministic
target-file projections.

## Run the local preview

Node.js 24 and a global TypeScript compiler are currently required. Link the
local CLI once so an activated Skill can invoke it from any repository:

```bash
npm run build
npm link
npm run dev
```

Open `http://127.0.0.1:4173`. The current UI resolves modes and agent bindings
through the real contracts package, previews the minimal generated `SKILL.md`,
compares the generated token footprint of all three mode Skills, and exports the
selected one. A separate Usage page presents actual local-agent token usage and
model-call counts in an API-console style dashboard with 1 hour, 24 hour,
7 day, and 30 day ranges. Filesystem activation is disabled by default.

## Balanced Runner

Balanced uses the versioned `balanced-default@1.0.0` policy. Its defaults are a
600-second context window, 600-second active window, 300-second progress and
growth extensions, and an absolute 1500-second hard cap. Product-content
changes refresh the active window; assistant text, Token use, and control-file
activity do not. The UI exposes call and Token budgets but does not allow an
ad-hoc replacement for the tuned timing policy.

The activated Skill freezes a Task JSON and invokes:

```bash
agent-control-plane balanced run \
  --task TASK.json \
  --worktree /absolute/repository/path \
  --adapter claude-code \
  --policy balanced-default@1.0.0
```

Task JSON is deliberately small and shell-free:

```json
{
  "id": "task-id",
  "objective": "Implement the requested bounded change",
  "acceptance": ["Exact externally observable result"],
  "allowedPaths": ["src/**", "test/**"],
  "forbiddenPaths": [".env", "secrets/**"],
  "validationCommands": [["npm", "test"]],
  "allowNoChanges": false
}
```

Every round is persisted under
`~/.agent-control-plane/balanced-runs/<run-id>/`. The Runner records the frozen
contract hash, full product-content baseline/final digests, changed paths,
validation exit codes, normalized downstream usage, an append-only call budget
ledger, and `balanced-review.json`. Review is explicit and hash-bound:

```bash
agent-control-plane balanced review --run RUN_DIR --decision accept
agent-control-plane balanced review --run RUN_DIR --decision stop
agent-control-plane balanced review --run RUN_DIR --decision revise --revision REVISION.json
```

Revision consumes a main-review call and a new downstream round while
preserving the protected final-review slot. It reuses the prior downstream
session when the adapter supports it and refuses a stale worktree or exhausted
budget. Failed validation or scope cannot be accepted. Token exhaustion permits
only the reserved final stop decision.

Runtime location and the Claude executable remain external configuration; no
credentials are copied:

```bash
AGENT_CONTROL_BALANCED_RUNS_DIR=/absolute/runtime/root agent-control-plane balanced list
AGENT_CONTROL_CLAUDE_COMMAND=/absolute/path/to/claude agent-control-plane balanced run ...
```

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

Claude downstream usage is read directly and incrementally from
`~/.claude/projects` first. A read-only CC Switch adapter imports deduplicated
Claude Code `session_log` rows from `~/.cc-switch/cc-switch.db` only when the
local Claude session directory is unavailable. It never writes the CC Switch
database. A hot SQLite rollback journal is handled by querying a temporary
snapshot, leaving the source database untouched. Override or disable either
source explicitly:

```bash
AGENT_WORKFLOW_CLAUDE_PROJECTS_DIR=/absolute/path/to/projects npm run dev
AGENT_WORKFLOW_CLAUDE_USAGE=off npm run dev
AGENT_WORKFLOW_CC_SWITCH_DB=/absolute/path/to/cc-switch.db npm run dev
AGENT_WORKFLOW_CC_SWITCH_USAGE=off npm run dev
```

Token volume and model-call count use separate charts because they have
different units. Upstream and downstream calls share one grouped call chart so
delegation timing can be compared directly. Codex local session events are the
authoritative upstream source. Deduplicated Claude Code assistant usage events
are the downstream source, with CC Switch session rows as a fallback. If both
sources are absent or incompatible, the downstream lane is explicitly marked
unavailable; the application never infers calls from model names or message
content.

The Token summary exposes `upstreamTokens` and `downstreamTokens` independently
in both totals and time buckets. The Token chart can switch between token-type
composition (uncached input, cached input, output) and agent-lane composition
(upstream, downstream) without mixing Token values with call counts.

The Usage page also supports server-side `lane` and exact `model` filters. The
upstream/downstream and model selectors update summary cards, both time-series
charts, call counts, and the per-model cost table as one consistent scope. The
model table reports total, input, cached input, output, call count, and share of
the currently selected Token total. The local API accepts, for example,
`/api/usage?range=30d&lane=downstream&model=claude-sonnet-4-5`; omit `model` and
use `lane=all` for the unfiltered view.

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
