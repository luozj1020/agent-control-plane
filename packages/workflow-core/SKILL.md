---
name: ai-coding-workflow
description: Three-mode coding orchestration. Choose Overnight for Claude-owned autonomous convergence, Balanced for tuned Claude execution rounds with Codex review between rounds, or Interactive for Codex-owned work with native subagents. Skip questions, read-only work, tiny edits, and direct Skill maintenance.
---

# AI Coding Workflow

## Applicability Gate

Classify first: **bypass** for questions/read-only/tiny/urgent work (record
`workflow bypassed: <reason>`); **direct** for bounded single-owner edits and
Skill maintenance (`aiwf direct --reason ... --path ...`); **setup/update** for
installation work; otherwise select exactly one execution mode below. An
explicit user-selected mode wins. Semantic auto-load never expands bypass or
direct work into model delegation.

## Execution Modes

The modes differ by how often Codex intervenes:

| Mode | Execution owner | Codex synchronization | Entry |
|---|---|---|---|
| **Overnight** | durable Claude owner | intent freeze, final/delta review | `aiwf submit TASK.json` |
| **Balanced** | Claude for one tuned round | review after every returned round | `aiwf balanced TASK.json` |
| **Interactive** | Codex main thread + native subagents | continuous | native orchestration |

Load `references/execution-modes.md` when selecting or operating a mode.

### Overnight

Codex freezes the executable Task JSON, submits it, returns the durable
`bookend-state.json` path, and ends the episode. Claude owns exploration,
implementation, tests, diagnosis, recovery, and revisions across epochs.
`revision_pending` wakes Codex for a bounded accept/revise decision;
`semantic_blocked` wakes it only for a new semantic choice. A Revision Delta
returns to the same Claude owner and worktree. Accepted `review_ready` is
terminal and does not schedule another Codex review.

### Balanced

Codex stays in the foreground. Each `aiwf balanced` call runs one Claude round
under the dispatcher's established tuned time plan: context acquisition,
active execution, progress-based extension, and hard deadline. This is not a
single fixed-duration checkpoint. When the round returns, deterministic tools
produce `balanced-review.json`; Codex accepts, stops, or freezes a bounded
Revision Delta and starts another tuned round. Repeat until accepted or
explicitly stopped.

### Interactive

Codex continuously owns planning, decomposition, synthesis, validation, and
final review while collaborating with Codex-native subagents. Parallelize
read-only exploration and independent validation freely. Keep one active writer
unless write scopes or worktrees are provably disjoint. Claude, Task JSON, and
project bootstrap are not required. Optional `aiwf_*` agent configurations may
specialize native roles but are never a prerequisite.

## Shared Evidence Contract

Tools establish facts; models make claims. Hashes, changed paths, commands,
exit codes, validation, scope, and diff coverage must be machine generated.
Every changed byte needs exactly one Review Projection classification before
acceptance. Models never merge; humans retain high-impact authority.

## Compatibility Paths

`aiwf run` is the full foreground compatibility lifecycle. `aiwf loop` is the
legacy per-iteration loop. `aiwf submit --mode balanced` is the legacy
single-checkpoint Bookend pilot, not the top-level Balanced mode.

## Reference Router

Load only the reference for the current operation; do not load multiple
references speculatively.

| Operation | Reference |
|---|---|
| mode selection and synchronization | `references/execution-modes.md` |
| Bookend roles, states, evidence | `references/operating-model.md` |
| Contract and Task JSON | `references/task-card-policy.md` |
| Claude epochs, recovery, single writer | `references/claude-runtime.md` |
| Review Projection and Codex decisions | `references/review-policy.md` |
| Worktrees and continuation | `references/worktree-and-parallel.md` |
| Setup/update/doctor | `references/setup-policy.md` |

For command syntax, prefer this Skill package's `README.md`; in a bootstrapped
repo use `ai/README.md`. Overnight and Balanced require bootstrap. Interactive
and direct do not.
