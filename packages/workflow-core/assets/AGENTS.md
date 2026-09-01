# Agents

Project-specific text outside the managed block is preserved by the installer.

<!-- AI-CODING-WORKFLOW:BEGIN managed -->
## AI Coding Workflow Core

Select exactly one execution mode before model work. An explicit user choice
wins: Overnight uses Codex only at task bookends, Balanced returns each tuned
Claude round to the active Codex thread, and Interactive keeps Codex in
continuous ownership with native subagents.

Classify first: `bypass` for questions/read-only/tiny/urgent work; `direct` for
bounded single-owner Codex edits and workflow maintenance; `overnight` or
`balanced` for Claude delegation; `interactive` for Codex-native multi-agent
work. Direct work records `python ai/aiwf.py direct --reason ... --path ...`.
Setup/update loads setup policy only. Bypass records `workflow bypassed:
<reason>`.

For indexed code, use one healthy CodeGraph query first; use
`ai/locate-code.py` for behavior/files and lexical search for text, Shell, and
configuration. Ground only enough to freeze behavior, acceptance, invariants,
forbidden boundaries, validation authority, and concrete risk facts. Unknown
implementation files do not block freeze. Do not browse the web unless asked.

## Overnight Bookend Path

```text
GROUND -> Codex FREEZE -> aiwf submit -> Codex episode ends
                                      -> Claude CONVERGE
                                      -> tools PROJECT
                                      -> new Codex REVIEW episode
```

For JSON-backed delegation, Codex freezes Task JSON and runs:

```bash
python ai/aiwf.py submit TASK.json
```

Return the durable `bookend-state.json` path, then end the current Codex
episode. Do not block on `monitor-claude.sh`, poll Claude, perform Direction
Review, or dispatch Checker through Codex. `aiwf run` is foreground
compatibility and `aiwf loop` is the legacy per-iteration review loop.
The component composer is for explicit legacy Markdown cards only.
Within Overnight, runtime state changes are not Codex synchronization points.

## Balanced Foreground Rounds

Run `python ai/aiwf.py balanced TASK.json`. One invocation is one Claude round
under the dispatcher's established tuned timing policy: context acquisition,
active execution, progress-based extensions, and hard deadline. On return,
read `balanced-review.json` and its hash-bound evidence. Codex decides accept,
stop, or a bounded Revision Delta followed by another tuned round. The number
of rounds is task-dependent; do not replace this policy with a single fixed
checkpoint window.

## Interactive Codex Ownership

The main Codex thread owns intent, decomposition, synthesis, validation, and
final review while coordinating native subagents. Read-only exploration and
independent validation may fan out. Keep one active writer unless paths or
worktrees are provably disjoint and one integration owner is explicit.
Subagent reports are claims until the main thread verifies the shared diff and
exact checks. Interactive does not invoke Claude merely for routing.

## Claude-Owned Convergence

Claude owns exploration, implementation, assigned tests, diagnosis, revision,
validation, and evidence claims. Builder Claude, Checker/Test Claude, and revision are
internal duties and may use separate Claude sessions under one logical owner.
Compile/test failures, missing code knowledge, timeouts, transport recovery,
session loss, and context exhaustion stay inside Claude/runtime convergence.

Only `semantic_blocked` may wake Codex early. It requires proof that the frozen
contract cannot be completed without a new semantic choice, such as
contradictory acceptance, materially ambiguous external behavior, an
unavoidable forbidden boundary, or an invalid frozen assumption.

## Runtime and Single Writer

The logical Claude owner survives execution epochs; process and write grants do
not. Every next epoch requires identity-bound termination of the old process,
proof of no active writer, a stable state hash, the same contract/base/scope,
and a fresh epoch grant. Unknown visibility fails closed.

The hard timeout expires an execution epoch, not the logical task. A
deterministic `continuation_safe=true` may continue the same owner. Runtime,
authority, and budget failures become `runtime_blocked`, `authority_blocked`,
or `budget_exhausted`; they never request semantic Codex inference.

## Evidence and Review

Tools establish facts; models make claims. Hashes, changed paths, commands,
exit codes, validation, scope, and diff coverage must be machine generated.
Claude supplies semantic assumptions, acceptance implications, and unresolved
risks.

Every changed byte must have exactly one Review Projection classification.
Gaps, overlaps, stale bindings, or unknown classifications invalidate the
projection and expand semantic review. Read a scheduled wake request with:

```bash
python ai/aiwf.py bookend review-input BOOKEND_STATE_OR_DIR
```

At `revision_pending`, Codex reviews the frozen contract and remaining semantic
frontier once. A revision becomes a bounded Revision Delta submitted back to
the same Claude owner; an accepted `review_ready` is terminal and schedules no
duplicate review. Models never merge.

Humans retain destructive, deletion, migration, authentication/permission,
billing, deployment, public-API, secrets, production-data, and merge authority.
Spark remains advisory: it cannot satisfy acceptance or authorize merge;
`preflight-bundle` is diagnostic-only. External MCP/plugins are default-off and
do not widen Bash/Edit authority. The compatibility configuration name remains
`ownership_profile=claude-first`.

## References

Load only the reference for the current operation.

| Need | Reference |
|---|---|
| Mode selection/synchronization | `references/execution-modes.md` |
| Bookend roles/states/evidence | `references/operating-model.md` |
| Task contract | `references/task-card-policy.md` |
| Claude epochs/recovery | `references/claude-runtime.md` |
| Review Projection/decisions | `references/review-policy.md` |
| Worktrees/continuation | `references/worktree-and-parallel.md` |
| Retrieval/context | `references/mcp-policy.md` |
| Setup/update/doctor | `references/setup-policy.md` |
| Metrics/pilots | `references/benchmark-policy.md` |
| Skill feedback | `references/feedback-policy.md` |
| Legacy synchronous loop | `references/loop-model.md` |
<!-- AI-CODING-WORKFLOW:END managed -->
