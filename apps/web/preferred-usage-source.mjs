export function createPreferredUsageSource(options) {
  const id = options?.id ?? "preferred";
  const lane = options?.lane ?? "downstream";
  const sources = Object.freeze([...(options?.sources ?? [])]);

  async function collect(window) {
    let fallback = null;
    for (const source of sources) {
      let result;
      try {
        result = await source.collect(window);
      } catch {
        result = {
          id: source.id ?? "unknown",
          lane: source.lane ?? lane,
          status: "unavailable",
          source: source.id ?? null,
          reason: "collector-failed",
          events: [],
          diagnostics: { eventsRead: 0 },
        };
      }
      if (result.status === "active") return result;
      if (!fallback || fallback.status === "not-connected") fallback = result;
    }
    return (
      fallback ?? {
        id,
        lane,
        status: "not-connected",
        source: null,
        reason: "no-sources-configured",
        events: [],
        diagnostics: { eventsRead: 0 },
      }
    );
  }

  return Object.freeze({ id, lane, collect });
}
