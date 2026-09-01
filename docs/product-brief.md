# Product brief

## Outcome

Provide a CC-Switch-style visual workflow Skill manager. Users select a mode,
main agent, and downstream role bindings; the product resolves them into an
effective Skill bundle, activates that bundle for the main agent, and lets the
user launch the main agent normally.

## Canonical flow

```text
select profile
  -> preview generated configuration
  -> resolve mode + agent bindings + target adapter
  -> render an effective Skill bundle
  -> atomically activate the Skill and managed config
  -> start the selected main agent
  -> main agent loads the generated instructions
  -> main agent coordinates downstream agents according to the selected mode
```

Example: `main=codex`, `mode=overnight`, `builder=claude-code`. Starting Codex
causes Codex to freeze intent, delegate implementation to Claude Code, and
review the result because activation projected the product-owned Overnight
template into Codex.

## Product invariants

1. The product is primarily a configuration switcher. Overnight may launch one
   detached, run-scoped supervisor and Balanced may invoke one foreground,
   bounded local Runner; neither requires an always-running workflow daemon.
2. Overnight, Balanced, and Interactive are versioned product-owned mode
   templates. The product compiles them into agent-specific Skills,
   instructions, and configuration.
3. The managed unit is an effective Skill bundle whose identity binds the mode,
   agent bindings, adapter versions, source hashes, and generated artifacts.
4. One effective Skill contains exactly one mode. Inactive modes and unused
   agent adapters are not projected into the target agent's visible Skill set.
5. Main agents and downstream roles are configurable independently. Runtime
   names never imply model providers.
6. Activation produces deterministic target-file projections and a receipt with
   source profile version, Skill version, target paths, hashes, and backups.
7. Every managed write uses preview, atomic replacement, and recoverable backup.
   User-owned text outside managed markers is preserved.
8. Active agent sessions are not silently mutated. A newly activated profile
   applies when the relevant agent or session is restarted/reloaded.
9. Credentials remain in the agent/provider's existing credential store. The
   product may reference a provider profile but does not copy raw secrets.
10. Removing the application must not leave Codex, Claude Code, or another agent
   unusable; the last known-good configuration remains recoverable.
11. Balanced timing and budgets are enforced by tools, not natural-language
    claims. Product-content hashes are the only window-refresh authority.
12. A downstream exit never authorizes semantic acceptance or merge.
13. Overnight and Balanced reference versioned external-monitor policies with
    the same ordered layers: process, activity, state, evidence, and wake. The
    monitor owns downstream runtime facts and durable state; it never monitors
    or keeps alive the upstream agent process.
14. "Sleep" is an upstream lifecycle boundary, not an operating-system sleep:
    Overnight ends the current inference episode after durable submission,
    while Balanced yields during one foreground Runner round. Interactive has
    no external sleep/monitor policy.
15. Overnight loop policies are separate versioned Skill variants. The active
    Skill contains either convergent or continuous-improvement instructions,
    never both strategy bodies.
16. An Overnight submission is durable before the upstream episode ends. Its
    supervisor records process, activity, state, hash-bound evidence, and one
    current wake request; a wake transport adapter may open the next upstream
    review episode without making the upstream process the monitored subject.
17. Convergent revisions are mechanically non-expanding. Continuous next-cycle
    contracts retain the initial metric floor and forbidden boundaries, while
    declaring rationale, measurable gain, added paths, and rollback boundary.

## Configuration model

- **Agent target:** Codex, Claude Code, OpenCode, or another configurable host.
- **Workflow profile:** main agent, selected mode, downstream role bindings,
  repository scope, and optional provider-profile references.
- **Role binding:** builder, reviewer, tester, planner, or subagent mapped to an
  installed agent command/profile.
- **Mode Skill template:** one product-owned, versioned orchestration contract
  for exactly one mode, with role requirements, capabilities,
  continuation/review policy, and render inputs.
- **External monitor policy:** a versioned, agent-neutral contract defining the
  downstream monitoring hierarchy, upstream sleep boundary, wake states, and
  terminal states that must not generate duplicate wakes.
- **Overnight loop policy:** a versioned strategy defining whether review
  boundaries monotonically contract toward acceptance or permit a reviewed,
  measurable expansion after each successful improvement checkpoint.
- **Target adapter:** renders a product mode for Codex, Claude Code, or another
  compatible main-agent Skill/config format.
- **Effective Skill bundle:** immutable resolved mode, agent bindings, adapter
  versions, source hashes, and generated Skill/instruction/config artifacts.
- **Skill catalog entry:** installed, available, active, incompatible, stale, or
  recoverable Skill bundle plus its compatibility and health information.
- **Projection:** deterministic files and managed blocks generated for each
  target agent.
- **Activation receipt:** before/after hashes, backups, compatibility result,
  warnings, and reload instructions.

## Product-owned modes

- **Overnight / convergent:** the main agent freezes intent, delegates durable
  downstream work, and ends its current inference episode. Every rejected
  result becomes a Revision Delta whose `goal`, stable acceptance items, and
  `scope.write_paths` cannot exceed the previous round. Forbidden paths,
  stop conditions, risk, and authority boundaries cannot be relaxed. Accepted
  `review_ready` is terminal.
- **Overnight / continuous improvement:** the user metrics are the minimum
  completion floor. A successful cycle becomes an evidence checkpoint; the
  main agent may freeze one next hypothesis with measurable gain, added paths,
  validation, and rollback boundaries. Forbidden and human-authority boundaries
  remain immutable. The logical run continues until user interruption, while
  semantic, authority, or runtime blockers pause it without inventing scope.
- **Balanced:** the product selects a versioned, previously tuned window policy;
  the main agent yields while downstream work runs for the policy's current
  round and wakes at the round-review or blocker boundary. An on-demand Runner
  monitors and enforces context, active, extension, idle, tail, and hard-cap
  boundaries plus call budgets.
  Token usage is monitored but never used as a termination budget.
  It is not one user-entered fixed window.
- **Interactive:** the main agent remains foreground owner and collaborates with
  its native subagents. It requires native-subagent capability and does not
  imply external Claude delegation.

Mode templates are agent-neutral. Target adapters render the same template for
Codex, Claude Code, or future main agents. Adding new modes later uses the same
versioned mode registry rather than changing the profile schema.

The catalog treats rendered combinations as logical Skill variants. Only the
selected variant must be materialized, so adding agents and modes does not
require maintaining a Cartesian product of copied Skill directories.

## Context and token policy

- Overnight, Balanced, and Interactive are separate Skill families.
- The target agent sees only the currently activated workflow Skill.
- A rendered Skill includes only the selected downstream agent adapters and
  role bindings.
- An Overnight Skill includes only its selected loop policy, so the inactive
  strategy does not consume the main agent's context.
- Shared source fragments are resolved at render time; they are not bundled as
  unused runtime instructions.
- Switching modes replaces the managed active Skill atomically and preserves a
  rollback copy of the previous variant.

This makes token cost proportional to the selected workflow instead of the
total number of modes and supported agents in the product catalog.

## First vertical slices

1. Versioned profile, role-binding, single-mode-Skill-template,
   effective-Skill-variant, catalog-entry, projection, and activation-receipt
   contracts.
2. Resolve and render one Codex Skill variant from mode plus agent bindings.
3. Read-only preview plus atomic activation/rollback for Codex project config.
4. Local UI for Skills, modes, agents, downstream roles, active-Skill diff, and
   activation health.
5. Additional target adapters for Claude Code and other agent hosts.
6. Import/export and compatibility migration across Skill versions.

## Explicit non-goals

- Running or supervising the main Codex process or Interactive native
  subagents. External monitors own only the downstream child and durable run
  state they explicitly launch or receive.
- Owning general chat histories or arbitrary worktrees outside a Balanced run.
- Acting as a model gateway or storing API credentials.
- Keeping a second always-running orchestrator after profile activation.
- Providing a remote wake transport for every supported upstream harness. Wake
  states are durable adapter boundaries; harness-specific delivery remains an
  adapter capability.
