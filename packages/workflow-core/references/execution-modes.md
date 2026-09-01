# Execution Modes

Load this reference when choosing or operating Overnight, Balanced, or
Interactive. The modes are one intervention continuum, not three unrelated
backends. Explicit user choice always wins.

## Selection

| Need | Select | Why |
|---|---|---|
| Lowest Codex usage; latency is flexible | Overnight | Codex appears only at task bookends and delta reviews |
| Claude leverage with periodic Codex correction | Balanced | Tuned Claude rounds return deterministic evidence to the active Codex thread |
| Lowest wall-clock latency; Codex-native parallelism | Interactive | Codex continuously owns the task and coordinates native subagents |

Questions, read-only investigations, tiny/urgent edits, and Skill maintenance
remain bypass/direct work unless the user explicitly selects a mode.

## Overnight Contract

```text
Codex FREEZE -> aiwf submit -> Codex episode ends
                              -> Claude CONVERGE across epochs
                              -> revision_pending -> Codex REVIEW
                                   revise -> same owner/worktree
                                   accept -> review_ready terminal
```

- Codex freezes goal, acceptance, invariants, forbidden boundaries, validation
  authority, write scope, and concrete risk facts. Unknown implementation files
  do not block freeze.
- The detached supervisor owns runtime recovery and the single-writer lease.
- Compile/test failures, transport recovery, timeouts, and context exhaustion
  never wake Codex. Strict `semantic_blocked` may wake it for a contract delta.
- Review produces `accept` or a bounded Revision Delta. Acceptance releases the
  owner and must not schedule a duplicate Codex episode.

## Balanced Contract

```text
Codex FREEZE -> tuned Claude round -> evidence + balanced-review.json
       ^                                      |
       |------ bounded Revision Delta --------|
                          or accept/stop
```

- One `aiwf balanced TASK.json` invocation is one Claude execution round; a
  task may use multiple rounds.
- The dispatcher, not ad-hoc task prose, applies the tuned timing plan. The plan
  includes context acquisition, active execution, progress-based extensions,
  no-output/first-progress policy, and a hard deadline. Explicit supported
  operator overrides remain valid and must be visible in dispatch evidence.
- The Codex thread stays active. After every returned round it reads the
  hash-bound task, diff/evidence, validation and `balanced-review.json`, then
  decides `accept`, `revise`, or `stop`.
- `revise` freezes only the delta from the prior contract and evidence. The
  next invocation is a new tuned round; it is not an unbounded continuation.
  Prepare the existing one-use, state-hash-bound continuation approval, then
  run `aiwf balanced NEXT_TASK.json --reviewed-continuation APPROVAL`. This
  preserves the reviewed worktree and same Claude session when available.
- A successful process exit is never acceptance by itself. Missing evidence,
  incomplete diff coverage, or failed validation remains `review_pending`.

The retained `submit --mode balanced` checkpoint experiment is compatibility
only. Its fixed `--window-minutes` and `checkpoint_ready` protocol do not define
the top-level Balanced mode.

## Interactive Contract

```text
                     -> explorer (read-only) ---|
Codex PLAN/ROUTE ----> worker (bounded writer) --|-> Codex SYNTHESIZE/VERIFY
                     -> tester/reviewer --------|
```

- The main Codex thread owns intent, decomposition, architectural decisions,
  write coordination, synthesis, validation, and final review.
- Use native explorer, worker, tester, debugger, build-fixer, benchmarker, and
  reviewer roles when their bounded work can proceed independently.
- Read-only work may fan out. Permit one active writer by default. Multiple
  writers require non-overlapping paths or isolated worktrees and an explicit
  integration owner.
- Subagent reports are claims. The main thread verifies the shared diff and
  exact validation results before acceptance.
- Interactive invokes neither Claude nor Spark merely to justify routing.
  Optional `aiwf_*` agent files only specialize native roles.

## Cross-Mode Invariants

- Mode changes are semantic routing decisions. Do not silently fall from one
  mode to another after execution starts.
- Every write has one owner, bounded scope, and review classification.
- Tools establish hashes, paths, commands, exit codes, and validation facts.
- Models never merge. Humans retain destructive, deployment, authentication,
  billing, secrets, production-data, public-API, and merge authority.
