const RUN_MODES = new Set(["balanced", "overnight"]);

function timestamp(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

function activationMode(entry) {
  return typeof entry?.mode?.id === "string" ? entry.mode.id : null;
}

function projectBindingMatches(run, activation) {
  const left = run?.projectBinding ?? null;
  const right = activation?.projectBinding ?? null;
  if (left === null || right === null) return left === right;
  return (
    left.projectId === right.projectId &&
    left.projectRevision === right.projectRevision &&
    left.projectConfigSha256 === right.projectConfigSha256
  );
}

function normalizedRun(run, mode) {
  return {
    ...run,
    mode,
    association: null,
  };
}

function linked(run, activation, source, confidence) {
  return {
    ...run,
    association: {
      status: "linked",
      activationId: activation.historyId,
      source,
      confidence,
    },
  };
}

function unlinked(run, reason) {
  return {
    ...run,
    association: {
      status: "unlinked",
      activationId: null,
      source: "none",
      confidence: "unknown",
      reason,
    },
  };
}

function latestEligible(activations, run, predicate) {
  const runTime = timestamp(run.createdAt);
  if (runTime === null) return null;
  return activations
    .filter((entry) => {
      const activationTime = timestamp(entry.recordedAt);
      return activationTime !== null && activationTime <= runTime && predicate(entry);
    })
    .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))[0] ?? null;
}

function associateRun(run, activations) {
  if (!RUN_MODES.has(run.mode)) return unlinked(run, "unsupported-mode");

  if (typeof run.activationId === "string" && run.activationId.length > 0) {
    const explicit = activations.find((entry) => entry.historyId === run.activationId);
    if (!explicit) return unlinked(run, "activation-not-found");
    if (activationMode(explicit) !== run.mode) return unlinked(run, "activation-mode-mismatch");
    if (!projectBindingMatches(run, explicit)) return unlinked(run, "activation-project-mismatch");
    return linked(run, explicit, "explicit", "exact");
  }

  if (typeof run.effectiveSkillSha256 === "string" && run.effectiveSkillSha256.length > 0) {
    const byHash = latestEligible(
      activations,
      run,
      (entry) =>
        activationMode(entry) === run.mode &&
        entry.contentSha256 === run.effectiveSkillSha256 &&
        projectBindingMatches(run, entry),
    );
    return byHash
      ? linked(run, byHash, "skill-hash", "exact")
      : unlinked(run, "skill-hash-not-found");
  }

  const inferred = latestEligible(
    activations,
    run,
    (entry) =>
      activationMode(entry) === run.mode &&
      projectBindingMatches(run, entry) &&
      (!entry.targetAdapterId || !run.adapterId || entry.targetAdapterId === run.adapterId),
  );
  return inferred
    ? linked(run, inferred, "temporal-mode", "inferred")
    : unlinked(run, "no-prior-compatible-activation");
}

export function buildActivityLog(history, balancedRuns = [], overnightRuns = []) {
  const activations = Array.isArray(history?.entries) ? history.entries : [];
  const runs = [
    ...(Array.isArray(balancedRuns) ? balancedRuns : []).map((run) => normalizedRun(run, "balanced")),
    ...(Array.isArray(overnightRuns) ? overnightRuns : []).map((run) => normalizedRun(run, "overnight")),
  ]
    .map((run) => associateRun(run, activations))
    .sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""));

  const byActivation = new Map(activations.map((entry) => [entry.historyId, []]));
  const unlinkedRuns = [];
  for (const run of runs) {
    const target = run.association.activationId
      ? byActivation.get(run.association.activationId)
      : null;
    if (target) target.push(run);
    else unlinkedRuns.push(run);
  }

  const entries = activations.map((entry) => ({
    ...entry,
    runs: byActivation.get(entry.historyId) ?? [],
  }));
  return {
    ...history,
    entries,
    unlinkedRuns,
    activitySummary: {
      activations: entries.length,
      runs: runs.length,
      linkedRuns: runs.length - unlinkedRuns.length,
      unlinkedRuns: unlinkedRuns.length,
      events: runs.reduce((sum, run) => sum + (run.coordination?.eventCount ?? 0), 0),
      projects: new Set([
        ...activations.map((entry) => entry.projectBinding?.projectId).filter(Boolean),
        ...runs.map((run) => run.projectBinding?.projectId).filter(Boolean),
      ]).size,
    },
  };
}

export function activityDetail(historyDetail, activity) {
  const entry = activity.entries.find(
    (candidate) => candidate.historyId === historyDetail.entry.historyId,
  );
  return {
    ...historyDetail,
    entry: entry ?? { ...historyDetail.entry, runs: [] },
    runs: entry?.runs ?? [],
    activitySummary: activity.activitySummary,
  };
}
