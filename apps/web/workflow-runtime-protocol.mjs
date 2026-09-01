const FALLBACK_PROTOCOLS = Object.freeze({
  overnight: Object.freeze({
    states: Object.freeze([
      "submitted", "running", "revision_pending", "improvement_cycle_ready",
      "runtime_blocked", "scope_violation", "validation_failed", "accepted",
      "stopped", "interrupted", "interrupt_requested",
    ]),
    initial_state: "submitted",
    active_state: "running",
    wake_states: Object.freeze([
      "revision_pending", "improvement_cycle_ready", "runtime_blocked",
      "scope_violation", "validation_failed",
    ]),
    terminal_states: Object.freeze(["accepted", "stopped", "interrupted"]),
    review_decisions: Object.freeze({
      revision_pending: Object.freeze(["accept", "revise", "stop"]),
      improvement_cycle_ready: Object.freeze(["continue", "revise", "stop"]),
      runtime_blocked: Object.freeze(["stop"]),
      scope_violation: Object.freeze(["stop"]),
      validation_failed: Object.freeze(["stop"]),
    }),
    outcome_states: Object.freeze({
      interrupted: "interrupted",
      runtime_failure: "runtime_blocked",
      scope_failure: "scope_violation",
      validation_failure: "validation_failed",
      no_change: "revision_pending",
      convergent_ready: "revision_pending",
      improvement_ready: "improvement_cycle_ready",
    }),
    decision_states: Object.freeze({
      accept: "accepted",
      stop: "stopped",
      revise: "submitted",
      continue: "submitted",
      interrupt: "interrupted",
      interrupt_requested: "interrupt_requested",
    }),
  }),
  balanced: Object.freeze({
    states: Object.freeze([
      "created", "running", "review_pending", "revision_pending", "accepted", "stopped",
    ]),
    initial_state: "created",
    active_state: "running",
    review_state: "review_pending",
    terminal_states: Object.freeze(["accepted", "stopped"]),
    evidence_statuses: Object.freeze([
      "review_pending", "runtime_blocked", "budget_exhausted",
      "scope_violation", "validation_failed",
    ]),
    review_decisions: Object.freeze(["accept", "revise", "stop"]),
    outcome_states: Object.freeze({
      ready: "review_pending",
      runtime_failure: "runtime_blocked",
      budget_failure: "budget_exhausted",
      scope_failure: "scope_violation",
      validation_failure: "validation_failed",
    }),
    decision_states: Object.freeze({
      accept: "accepted",
      revise: "revision_pending",
      stop: "stopped",
    }),
  }),
});
const FALLBACK_STRATEGIES = Object.freeze(["convergent", "continuous-improvement"]);

function stringArray(value, label, { allowEmpty = false } = {}) {
  if (
    !Array.isArray(value) || (!allowEmpty && value.length === 0) ||
    value.some((entry) => typeof entry !== "string" || !entry) ||
    new Set(value).size !== value.length
  ) {
    throw new TypeError(`${label} must be a unique string array.`);
  }
  return [...value];
}

function validateOvernight(value) {
  const states = stringArray(value?.states, "overnight.states");
  const wakeStates = stringArray(value?.wake_states, "overnight.wake_states");
  const terminalStates = stringArray(value?.terminal_states, "overnight.terminal_states");
  const stateSet = new Set(states);
  for (const state of [value?.initial_state, value?.active_state, ...wakeStates, ...terminalStates]) {
    if (!stateSet.has(state)) throw new TypeError(`Overnight projection references unknown state '${state}'.`);
  }
  if (!value?.review_decisions || typeof value.review_decisions !== "object") {
    throw new TypeError("overnight.review_decisions must be an object.");
  }
  const reviewDecisions = {};
  for (const [state, decisions] of Object.entries(value.review_decisions)) {
    if (!wakeStates.includes(state)) throw new TypeError(`Overnight review state '${state}' is not a wake state.`);
    reviewDecisions[state] = stringArray(decisions, `overnight.review_decisions.${state}`);
  }
  const outcomeStates = validateStateMap(value.outcome_states, stateSet, "overnight.outcome_states");
  const decisionStates = validateStateMap(value.decision_states, stateSet, "overnight.decision_states");
  return {
    states,
    initialState: value.initial_state,
    activeState: value.active_state,
    wakeStates: new Set(wakeStates),
    terminalStates: new Set(terminalStates),
    reviewDecisions: Object.freeze(reviewDecisions),
    outcomeStates,
    decisionStates,
  };
}

function validateStateMap(value, states, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0) {
    throw new TypeError(`${label} must be a non-empty object.`);
  }
  const result = {};
  for (const [key, state] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9_]*$/.test(key) || !states.has(state)) {
      throw new TypeError(`${label}.${key} references unknown state '${state}'.`);
    }
    result[key] = state;
  }
  return Object.freeze(result);
}

function validateBalanced(value) {
  const states = stringArray(value?.states, "balanced.states");
  const terminalStates = stringArray(value?.terminal_states, "balanced.terminal_states");
  const evidenceStatuses = stringArray(value.evidence_statuses, "balanced.evidence_statuses");
  const stateSet = new Set(states);
  for (const state of [value?.initial_state, value?.active_state, value?.review_state, ...terminalStates]) {
    if (!stateSet.has(state)) throw new TypeError(`Balanced projection references unknown state '${state}'.`);
  }
  return {
    states,
    initialState: value.initial_state,
    activeState: value.active_state,
    reviewState: value.review_state,
    terminalStates: new Set(terminalStates),
    evidenceStatuses: new Set(evidenceStatuses),
    reviewDecisions: new Set(stringArray(value.review_decisions, "balanced.review_decisions")),
    outcomeStates: validateStateMap(
      value.outcome_states,
      new Set(evidenceStatuses),
      "balanced.outcome_states",
    ),
    decisionStates: validateStateMap(value.decision_states, stateSet, "balanced.decision_states"),
  };
}

export async function resolveRuntimeProtocol(mode, provider) {
  if (!Object.hasOwn(FALLBACK_PROTOCOLS, mode)) throw new TypeError(`Unknown runtime protocol '${mode}'.`);
  const envelope = provider ? await provider(mode) : null;
  const raw = envelope?.protocol ?? envelope ?? FALLBACK_PROTOCOLS[mode];
  const protocol = mode === "overnight" ? validateOvernight(raw) : validateBalanced(raw);
  return Object.freeze({
    mode,
    source: envelope?.sourceId ?? "embedded-compatibility",
    contractVersion: envelope?.contractVersion ?? null,
    contractSha256: envelope?.contractSha256 ?? null,
    allowedStrategies: mode === "overnight"
      ? new Set(stringArray(envelope?.strategies ?? FALLBACK_STRATEGIES, "overnight.strategies"))
      : new Set(),
    ...protocol,
  });
}

export const EMBEDDED_RUNTIME_PROTOCOLS = FALLBACK_PROTOCOLS;
