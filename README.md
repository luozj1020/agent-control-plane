# AI Coding Workflow Control Plane

AI Coding Workflow Control Plane is a local-first control plane for selecting,
binding, activating, and observing coding-agent workflows. It follows the
CC-Switch interaction model: choose a workflow mode and agent bindings,
activate the resolved projection, then start your preferred coding agent
normally.

For example, a profile can select Codex as the main agent, Overnight as the
workflow mode, and Claude Code as the downstream implementation agent.
The workflow semantics, Task Card protocol, runtime tools, schemas, and
installation assets are embedded in `packages/workflow-core`. Activation
projects the selected internal contract into a managed Skill and agent
configuration. When the user starts Codex, Codex loads that generated bundle
and performs planning, delegation, review, and continuation.

## What is switched

The user-facing controls are workflow mode, main agent, and downstream role
bindings. The actual activated artifact is an effective Skill bundle:

```text
workflow contract + mode selection + agent bindings + target adapter
                         -> effective Skill bundle
                         -> activate for Codex or another main agent
```

Each mode is projected as a separate Skill family rather than one Skill
containing every mode. The product materializes only the selected mode and
agent bindings, exposes only that workflow projection to the target agent, and
records exactly which variant is active.

This keeps inactive modes and unused agent adapters out of Codex's loaded Skill
context. Switching mode means atomically switching the active minimal Skill,
not asking a large Skill to route among three embedded modes.

## Product boundary

The embedded `packages/workflow-core` package owns mode semantics, Task Card
protocol, runtime states, review decisions, wake conditions, and evidence
invariants. The ACP application layer owns selection, profiles, agent/Harness
bindings, activation, rollback, usage monitoring, compatibility diagnosis, and
UI/CLI projection. Balanced also has an on-demand local Runner invoked by the
active main agent. It is not a daemon:
the Runner exists only for one bounded downstream round and owns that child
process, its timers, budget ledger, evidence, and termination.

The control plane owns:

- a workflow Skill catalog with separate mode Skill families;
- reusable workflow profiles;
- projections of the Overnight, Balanced, and Interactive workflow contract;
- main-agent, mode, and downstream role selections;
- rendering and synchronization of mode-specific Skills/instructions;
- active-Skill preview, enable, switch, rollback, update, and removal;
- managed AGENTS.md/CLAUDE.md/config projections;
- compatibility checks, activation previews, atomic writes, and backups;
- import, export, health status, and one-click switching.
- configurable Balanced timing overrides and call budgets constrained by the workflow contract;
- selection of the two upstream Overnight strategies with independent minimal Skill output;
- external-monitor adapters for the upstream wake/evidence contract;
- an on-demand Balanced Runner with pluggable downstream adapters;
- hash-bound round evidence, Revision Delta continuation, and budget receipts.
- content-free coordination telemetry for Runner calls, artifacts, states,
  validation, wake delivery, review decisions, and interrupts.

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
Balanced and Overnight resolve lifecycle states, evidence outcomes, strategies,
terminal states, and review decisions from the hash-bound Workflow Contract
projection. Each run records the embedded Contract version and SHA-256. Runtime
fallback constants are synchronization-checked safety defaults for isolated
module tests; they are not an independent semantic authority.

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

## Coordination observability

Workflow Contract 1.6 includes `Coordination Event v1`, `Coordination Run
Summary v1`, and the bounded `Coordination Run Detail v1` projection. Every new
Balanced and Overnight run appends comparable control-plane boundary events to
`coordination-events.jsonl`; the mode-specific
`events.jsonl` and `monitor-events.jsonl` remain available for deeper runtime
diagnosis.

The Activity page combines immutable activation snapshots with their Balanced
and Overnight runs. `GET /api/activity` links a run by an explicit activation
id first, then by the effective Skill SHA-256. Legacy runs without either field
are visibly marked as an inferred time/mode association; stale explicit links
and incompatible runs remain in the unlinked section. Activation rollback never
deletes runtime history.

The product CLI automatically reads the active, same-mode managed Skill and
stores its activation id and SHA-256 in each new run. External launchers can
override that context with `--activation-id` and `--skill-sha256`. Both fields
remain optional so older launchers stay compatible; missing history never
blocks execution and produces a visibly inferred or unlinked run instead.

The same page and `GET /api/coordination` aggregate only recorded
facts: downstream invocation boundaries and reported token totals, explicit
artifact reads, artifact writes, lifecycle transitions, validation, wake
delivery, review decisions, and interrupts. Event details are metadata-only
and never contain prompt, response, or source-file contents. Unsupported
dimensions are reported as `unsupported`, not zero. Older runs are not
backfilled with inferred events.

Filesystem containment is an Adapter capability, not a model claim. Read and
write guarantees are independent: reads are `exact-paths`,
`partial-event-audit`, or `unsupported`; writes are `exact-paths`,
`post-run-audit`, or `unsupported`. The built-in Claude Code Adapter records
only explicit `Read` tool-use entries in stream JSON. Bash, MCP, LSP, and other
unobserved channels therefore keep the run at partial coverage. Observed reads
are classified against Task Card `read_paths`, `write_paths`, and
`forbidden_paths`; outside-worktree paths are redacted and retained as
violations rather than silently discarded.

Run summaries also derive read classifications, repeated-read counts, observed
node/relationship counts, artifact-reader links, and maximum artifact reader
fan-out. These values are computed only from recorded events. They do not infer
hidden Bash/MCP/LSP reads, Agent messages, or a coordination-token ratio.

Selecting a run returns at most 500 allowlisted metadata events and renders their
append sequence as a temporal node/edge graph plus an event timeline. Invalid
JSON, mismatched run identity, unsafe endpoint identifiers, and unapproved
detail fields are rejected or stripped before the API response. The graph scope
is explicitly `returned-events`; it is not presented as a complete interaction
graph when instrumentation is partial.
The backing JSONL must be a regular file and is capped at 16 MiB for local API
reads; symlinks and oversized telemetry fail closed.

The Overnight strategy selector is shown only while Overnight is selected. Its
choice is included in the effective Skill identity, activation manifest,
history, backup, and rollback data. Only the selected strategy is rendered into
`SKILL.md`, keeping the inactive policy out of the loaded context.

## Status

Early product development. The current milestone embeds the complete workflow
core in this repository and reports internal Contract compatibility, Schema
bindings, and protocol drift alongside activation and runtime features.

## Embedded Workflow Core

The former standalone workflow implementation is part of this monorepo at
`packages/workflow-core`. No sibling checkout or source-path environment
variable is required. Useful maintenance commands are:

```bash
npm run workflow:contract
npm run workflow:test
npm run workflow:test:full
npm run workflow -- contract export
```

The default root `npm test` includes the core Contract, extension interfaces,
Bookend/Runner behavior, and both installer suites. `workflow:test:full` keeps
the much slower exhaustive timing and recovery suite available on demand.

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

Multi-participant work can declare durable ownership for decomposition seams
under `extensions.task_shape`:

```json
{
  "participants": [
    {"id": "parser", "owner": "worker", "responsibilities": ["Produce normalized AST"]},
    {"id": "renderer", "owner": "worker", "responsibilities": ["Consume AST"]}
  ],
  "interfaces": [
    {
      "id": "ast-boundary",
      "producer": "parser",
      "consumer": "renderer",
      "owner": "renderer",
      "contract": "Normalized AST preserves source ranges",
      "validation_id": "interface-test"
    }
  ]
}
```

Participant and interface IDs are stable task semantics; `owner` on a
participant binds it to an Agent/role, while `owner` on an interface names the
participant accountable for the boundary. Unknown references, self-edges, and
unknown validation IDs fail closed. Preflight warns when multiple participants
declare no interfaces or when an interface has no deterministic validation.

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

`GET /api/task-card/schema` serves the hash-bound schema from
`packages/workflow-core`. There is no second Web-owned schema copy: an absent
core, incompatible Contract, or hash mismatch fails closed.

## Personal project scopes

The configuration page is a personal project hub. Opening a project restores
that checkout's mode, Agent bindings, runtime controls, and Skill appendix. It
also shows whether the resolved Skill is active or stale, the latest bound run,
current integration health, and up to eight recent projects. Activity defaults
to the current workspace and can be expanded to all local projects explicitly.

Each initialized project may contain a minimal repository-owned
`.agent-control-plane/` directory. These files are declarative; personal use
does not require committing or sharing them:

```text
repo/.agent-control-plane/
├── project.json       # logical project identity
└── workflow.json      # shared delta over the global Profile
```

Mutable state is deliberately kept outside the repository:

```text
~/.agent-control-plane/workspaces/<workspaceId>/
├── binding.json       # this physical checkout
├── state.json         # local revision and local overrides
├── recent.json        # validated personal project summary
├── history/           # immutable local snapshots
└── project.lock       # local single-writer lock
```

`AGENT_CONTROL_PROJECT_STATE_DIR` may select another absolute local state root.
`projectId` identifies the logical project configuration; `workspaceId`
identifies one physical checkout on one control-plane installation. Two clones
therefore keep independent personal overrides, locks, revision history, and
runtime identity.

The primary **保存项目配置** action writes only local state and masks matching
repository fields. Writing the current effective delta to `workflow.json` is an
advanced experimental action hidden behind **高级 · 仓库配置**; it is not part
of the normal personal workflow and never commits or pushes Git. The delta may
select the mode and Agent bindings, retain the relevant Overnight or Balanced
controls, and add a bounded project Skill appendix. It never copies the
complete mode Skill, embeds secrets, or rewrites an existing `AGENTS.md`.

Project paths can be typed or selected through an explicit host directory
dialog. WSL/Windows uses the Windows folder browser and maps the result back to
the WSL path; macOS uses Finder, while Linux tries Zenity and then KDialog. The
browser never invents a filesystem path: the local server canonicalizes the
selected existing directory, cancellation preserves the current value, and an
unavailable desktop picker is reported without changing project state.

Recent-project metadata is stored as `recent.json` beside local workspace
state. Opening, initializing, migrating, saving, or restoring a project updates
its validated local summary. Older workspace state without this file is
projected from its binding and last update time, so upgrading does not hide
existing personal projects. Missing paths remain visible but cannot be opened.

Project writes use optimistic local-revision and shared-policy-hash checks, a
workspace-local single-writer lock, atomic replacement, immutable local
snapshots, and explicit restore. Unknown fields, unsafe control paths, stale
revisions, concurrent Git/shared-policy changes, malformed timing or call
budgets, and Skill appendices above 32 KiB fail closed. Initialization and
project-override saves do not activate a Harness. Every effective configuration
has a deterministic SHA-256 independent of its local revision number.

Projects created by the previous repository-local state format remain readable
but cannot be edited or activated until the user confirms **迁移本地状态**. The
migration preserves the logical `projectId`, moves legacy revision snapshots to
the workspace state root, rewrites only the declarative repository files, and
removes the old repository-local lock/history layout after successful copying.
There is no silent migration.

The explicit activation request sends the workspace id, local revision, and
effective hash back to the server. The server reloads both shared and local
configuration and rejects stale workspace context, profile mismatches, or a
missing Skill appendix before any managed Skill write.

The verified project/workspace binding is stored in the active manifest and
immutable activation history. Balanced and Overnight runtime discovery
propagates the same binding into run metadata. Activity association requires
project identity, workspace identity, revision, and configuration hash to
match; a run without that evidence remains global or unlinked instead of being
inferred into another checkout. Legacy activation history remains readable but
is not projected into new workspace-bound runtime lineage. This keeps
activation, rollback, runtime evidence, and coordination telemetry on one
auditable checkout identity chain. Native writes into Harness-specific project
configuration remain a separate adapter capability and are not implied by
initializing project overrides.

## Tools and integrations

The **工具与集成** page begins with the embedded Workflow Core panel. It reads
`packages/workflow-core`, accepts Contract 1.1+, verifies every Schema hash,
compares mode, strategy, review, and Runner-state projections, and reports drift
between the canonical embedded protocol and the runtime safety defaults.

A versioned
Integration Manifest keeps tool identity, capabilities, permissions, project
markers, and Harness compatibility separate from workflow Skills. The initial
catalog contains CodeGraph CLI, CodeGraph MCP, and a generic custom MCP Server
registration entry.

Discovery is read-only and reports two independent layers. **Global environment**
discovery resolves commands directly from `PATH` without a shell and runs a
five-second bounded version handshake with a minimal non-secret process
environment. **Current project** discovery validates an absolute project
directory, treats a symlinked or non-directory `.codegraph` marker as unsafe,
and uses a bounded status probe to verify initialization, project identity, and
pending index drift. Marker presence alone is not reported as a healthy project;
unobservable initialization or drift remains explicitly unknown.
Diagnostics return only checks, version metadata, and health categories; command
output, environment values, repository content, and credentials are not returned.

Installation planning is also non-mutating in this milestone. The server returns
argv arrays, expected write boundaries, network requirements, target Harness,
and global/project scope with `executable=false`. CodeGraph project initialization
and MCP configuration projection therefore remain previews. The later execution
layer must add explicit confirmation, target-file backup, post-write verification,
and rollback before these plans may run.

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
