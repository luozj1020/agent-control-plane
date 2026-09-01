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
- a versioned Balanced timing policy with configurable wait/extension overrides and call budgets;
- two versioned Overnight loop policies with independent minimal Skill output;
- versioned external-monitor policies shared by Overnight and Balanced;
- an on-demand Balanced Runner with pluggable downstream adapters;
- hash-bound round evidence, Revision Delta continuation, and budget receipts.

The selected main agent, following the activated instructions, owns:

- task planning and intent freeze;
- native or external subagent coordination;
- starting the Balanced Runner when the active Skill requires it;
- submitting an Overnight durable task when the active Skill requires it;
- completion and revision decisions.

For Balanced, the Runner owns downstream invocation, execution windows,
process-group termination, session continuation, scope enforcement, validation
evidence, and call-budget enforcement. Token usage remains observable but never
terminates a round. The main agent retains semantic
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

## Sleep and external monitoring

Overnight and Balanced now use a common versioned monitoring contract with five
ordered layers: `process -> activity -> state -> evidence -> wake`. The external
control plane observes the downstream runtime and durable run state. It does
not monitor the upstream agent process, keep that process alive, or infer
semantic progress from elapsed time.

"Sleep" describes the upstream model lifecycle rather than an OS-level sleep.
Overnight has two independently activated policies:

- **Convergent / 收缩式修改:** freeze and durably submit the task, retain the
  returned Bookend state path, then end the current inference episode without
  polling. Every rejected review produces a narrower Revision Delta:
  `next.scope.write_paths` must be a subset of `previous.scope.write_paths`, while
  forbidden and authority boundaries cannot be relaxed. Accepted
  `review_ready` is globally terminal and schedules no duplicate wake.
- **Continuous improvement / 持续扩张改进:** treat the user's metrics as the
  minimum completion floor. Each successful cycle is a checkpoint rather than
  global completion. Before the next cycle, the upstream freezes one improvement
  hypothesis with rationale, expected measurable gain, added paths, validation,
  and rollback scope. Only that reviewed contract may expand allowed paths;
  destructive, permission, migration, deployment, billing, production-data,
  forbidden-path, and human-authority boundaries stay fixed. The same logical
  improvement run continues until the user interrupts it. Semantic, authority,
  and runtime blockers pause rather than silently broaden the task.
- Balanced starts one on-demand tuned Runner round, then yields while that
  invocation owns context acquisition, active execution, progress extensions,
  completion/idle checks, and the hard deadline. It wakes at `review_pending`
  or a machine-reported blocker, reads hash-bound `balanced-review.json`, and
  decides accept, stop, or a bounded continuation.
- Interactive remains foreground ownership with native subagents and has no
  external sleep/monitor policy.

The current contract exposes durable wake states to target adapters. It does
not add an always-running daemon or claim a universal remote-wake API for every
main-agent harness.

The Overnight strategy selector is shown only while Overnight is selected. Its
choice is included in the effective Skill identity, activation manifest,
history, backup, and rollback data. Only the selected strategy is rendered into
`SKILL.md`, keeping the inactive policy out of the loaded context.

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
7 day, and 30 day ranges. The local entrypoint automatically discovers the
current user's `~/.codex` directory and keeps filesystem activation restricted
to the loopback server and explicit UI activation actions. Set
`AGENT_WORKFLOW_PREVIEW_ONLY=1` to run without filesystem writes.

The overwrite-only Skill is always installed as
`agent-workflow-active/SKILL.md` with frontmatter name
`agent-workflow-active`. Mode, policy version, and upstream/downstream display
declarations remain in the manifest and activation history instead of entering
model context. The Skill body contains only an enforceable operating contract,
ordered procedure, and short product commands. Task and next-cycle schemas are
owned by the CLI rather than copied into model context. Interactive omits all
external Runner and Task Card material. Tests cap generated size and reject
cross-mode instruction leakage.

## Task Cards

JSON is the canonical Task Card format because scope, forbidden boundaries,
argv validation commands, revisions, and evidence hashes must be machine
validated. Create a non-overwriting scaffold, edit it, and validate it before
submission:

```bash
agent-control-plane task init --output TASK.json
agent-control-plane task validate --task TASK.json
agent-control-plane task migrate --task LEGACY.json --output TASK.json
agent-control-plane task render --task TASK.json --view execution --output TASK.md
```

Continuous improvement creates its next-cycle Card from the current frozen
run, preserving the acceptance and forbidden floors by default:

```bash
agent-control-plane overnight next-init --run RUN_DIR --output NEXT.json
```

The CLI refuses to overwrite an existing scaffold or migration/render target.
The Task Card page can import, edit, validate, autosave, and export the same
JSON. Its default structured editor uses collapsible sections for identity,
scope, acceptance, risk, handoff, argv validation, stop conditions, and
extensions; JSON expert mode edits the identical draft. Both views share
undo/redo and a session-baseline revert action. Legacy seven-field drafts are
converted in place after validation. The Markdown pane switches between
complete Audit and compact Execution projections; both are regenerated by the
server-side validator and are never accepted as runtime input, so there is
still only one authoritative contract.

The page also has a read-only Preflight. It verifies the canonical Task Card,
absolute accessible worktree, workflow mode, downstream adapter, Overnight
strategy, and Balanced timing/call-budget constraints, then shows the frozen
task SHA-256 and runtime-envelope preview. Preflight never launches an Agent;
the actual submit/run action remains a separate, explicit operation.

Preflight also freezes the downstream runtime environment. The default is
`executionEnvironment=auto`, `proxyMode=direct`,
`isolationMode=provider-scoped`, and metadata-only network diagnostics.
`direct` removes common upper/lowercase proxy variables from the child while
`inherit` passes them through without persisting their values. Provider-scoped
isolation passes the basic process environment plus adapter-declared provider
prefixes (for Claude Code: `ANTHROPIC_`, `CLAUDE_`, and `CC_SWITCH_`) instead of
blindly copying every parent secret.

When `CODEX_SANDBOX_NETWORK_DISABLED` is visible, a network-dependent adapter
does not start and the result is classified as
`sandbox-network-host-handoff`. This is an inconclusive environment failure,
not model no-progress or provider unavailability: restart the control plane in
an authorized host terminal and rerun the identical Preflight. Process evidence
records only proxy variable names, isolation mode, stream initialization,
stdout/stderr byte counts, and failure category; it never records proxy URLs,
tokens, prompts, or credentials. Exact write-path filesystem sandboxing is
reported separately as an adapter capability. Until an adapter declares
`exact-write-paths`, the UI shows a warning because post-run scope evidence is
not equivalent to OS-enforced isolation.

The adjacent **主动连接诊断 · 1 次调用** button is intentionally separate from
Preflight. After explicit confirmation it sends one fixed minimal prompt through
only the currently selected `direct` or `inherit` route; it never performs an
automatic two-route comparison or retry. The receipt contains elapsed time,
stream initialization, terminal-result presence, byte counts, usage visibility,
Token totals when available, and a failure category. It does not return the
model response, prompt, Task Card, proxy values, or credentials. A successful
probe establishes current connectivity only and is not task acceptance evidence;
switching routes and probing again consumes another explicitly confirmed call.

The checked-in normative schema is `apps/web/task-card-v1.schema.json` and the
local server exposes it at `GET /api/task-card/schema` for editors and adapters.

## Interactive subagent installation

Interactive activation can also install a product-owned global Codex subagent
preset. It enables `[agents]`, sets six concurrent subagent threads, uses
`gpt-5.3-codex-spark` with medium reasoning for the default and the
`worker`, `explorer`, `tester`, `debugger`, `benchmarker`, and `build_fixer`
roles, and uses `gpt-5.6-terra` with high reasoning for the read-only
`reviewer`. The generated Interactive Skill tells the main Codex thread how to
route these roles while retaining planning, architecture, synthesis, and final
validation.

By default, `npm run dev` uses `~/.codex` and `~/.codex/skills`. Set the paths
explicitly when managing another Codex installation:

```bash
AGENT_WORKFLOW_SKILLS_DIR=/absolute/path/to/.codex/skills \
AGENT_WORKFLOW_CODEX_HOME=/absolute/path/to/.codex \
npm run dev
```

The installer edits only four keys in the existing `[agents]` table and
preserves unrelated `config.toml` content. Existing same-name agent files are
never overwritten silently: the UI requires an explicit backup-and-overwrite
checkbox. Backups and ownership hashes are stored under
`<CODEX_HOME>/.agent-workflow-switch-agents/`. Restart Codex after activation
so the new global configuration and custom agents are loaded. The supported
configuration fields and personal agent directory follow the
[official Codex subagents documentation](https://developers.openai.com/codex/subagents).

## Overnight Runner

Overnight now has a product-owned, run-scoped supervisor. Submission persists
the frozen contract first, launches the supervisor as a detached child, prints
the durable run directory, and returns so the upstream agent can end its
inference episode:

```bash
agent-control-plane overnight submit \
  --task TASK.json \
  --worktree /absolute/repository/path \
  --adapter claude-code \
  --strategy convergent \
  --wake-adapter durable-file \
  --execution-env auto \
  --proxy-mode direct \
  --environment-isolation provider-scoped \
  --network-diagnostics metadata
```

The supervisor records process/activity/state/evidence/wake events under
`~/.agent-control-plane/overnight-runs/<run-id>/`. Each completed cycle writes
hash-bound `evidence.json` and `wake-request.json`; no foreground Codex polling
is required. The wake transport is intentionally adapter-neutral: a harness can
watch the durable wake file and start a new upstream review episode. Every
delivery attempt receives its own `wake-delivery.json` receipt; the default
`durable-file` adapter records `scheduled` without assuming that Codex, Claude
Code, OpenCode, Cursor, or another host supports the same resume mechanism.
Target integrations can register a wake adapter without changing the state
machine; a process-based adapter is available for harnesses that accept
`--wake-request` and `--wake-sha256` argv parameters.

Convergent review either accepts, stops, or supplies a non-expanding revision:

```bash
agent-control-plane overnight review --run RUN_DIR --decision accept
agent-control-plane overnight review --run RUN_DIR --decision stop
agent-control-plane overnight review --run RUN_DIR --decision revise --revision REVISION.json
```

Continuous improvement uses the same Task schema, but a successful cycle is a
checkpoint. `NEXT.json` must contain `rationale`, `expected_gain`,
`rollback_boundary`, an exact `added_paths` declaration, and the next `task`.
The initial acceptance floor and forbidden boundaries cannot be removed:

```bash
agent-control-plane overnight review --run RUN_DIR --decision continue --next NEXT.json
agent-control-plane overnight interrupt --run RUN_DIR
agent-control-plane overnight status --run RUN_DIR
agent-control-plane overnight list
```

`AGENT_CONTROL_OVERNIGHT_RUNS_DIR` overrides the external artifact root. The
runner reuses the downstream session when the selected adapter supports it.

## Balanced Runner

Balanced uses the versioned `balanced-default@1.0.0` policy. Its defaults are a
600-second context window, 600-second active window, 300-second progress and
growth extensions, and an absolute 1500-second hard cap. Product-content
changes refresh the active window; assistant text, Token use, and control-file
activity do not. The UI starts from the tuned policy and records explicit,
bounded wait/extension overrides with the activated profile.

Balanced call-budget ranges are enforced consistently by the UI, profile
resolver, Skill store, and Runner: main-review and downstream calls are `1–99`,
Advisor calls are `0–99`, and reserved final reviews are
`0–main-review calls`. Timing overrides cover context wait, first-progress
wait, active window, first extension, growing extension, and the per-round hard
cap. Downstream Token usage is recorded as evidence and shown in Usage, but it
is not an execution budget.

The activated Skill freezes a Task JSON and invokes:

```bash
agent-control-plane balanced run \
  --task TASK.json \
  --worktree /absolute/repository/path \
  --adapter claude-code \
  --context-seconds 600 \
  --first-progress-seconds 600 \
  --active-seconds 600 \
  --extension-seconds 300 \
  --growing-extension-seconds 300 \
  --hard-cap-seconds 1500 \
  --execution-env auto \
  --proxy-mode direct \
  --environment-isolation provider-scoped \
  --network-diagnostics metadata
```

Task JSON uses the versioned `task-card-v1` contract. Workflow mode, Agent
bindings, timing, budgets, and worktree remain in the separate runtime
envelope rather than entering this task contract:

```json
{
  "schema_version": 1,
  "id": "task-id",
  "mode": "builder",
  "goal": "Implement the requested bounded change",
  "profiles": ["base"],
  "scope": {
    "write_paths": ["src/**", "test/**"],
    "read_paths": [],
    "forbidden_paths": [".env", "secrets/**"]
  },
  "acceptance": [
    {
      "id": "behavior",
      "description": "Exact externally observable result",
      "validation_id": "tests"
    }
  ],
  "risk": {
    "public_api": "unknown",
    "data_model": "unknown",
    "security": "unknown",
    "migration": "unknown",
    "permission": "unknown",
    "concurrency": "unknown",
    "cross_module": "unknown",
    "production_impact": "unknown"
  },
  "handoff": {
    "must_do": ["Implement the frozen goal"],
    "must_not_do": ["Broaden scope"],
    "may_decide": ["Implementation details within the contract"],
    "must_report": ["Changed paths", "Validation", "Remaining risks"]
  },
  "validation": [
    {
      "id": "tests",
      "command": ["npm", "test"],
      "local_allowed": true
    }
  ],
  "stop_conditions": [
    "scope_boundary_crossed",
    "acceptance_unreachable",
    "external_blocker"
  ],
  "extensions": {}
}
```

Legacy seven-field cards are accepted at import, CLI validation, and runtime
boundaries, then deterministically normalized to v1. New scaffolds and exports
are always v1. `agent-control-plane task migrate` performs the conversion
explicitly; `agent-control-plane task render` creates immutable `audit` or
compact `execution` Markdown projections.

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
budget. Failed validation or scope cannot be accepted. Token volume never
removes an available review decision.

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
