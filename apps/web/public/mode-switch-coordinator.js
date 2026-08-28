export function createLatestSwitchCoordinator(options) {
  if (typeof options?.apply !== "function") {
    throw new TypeError("A mode switch apply function is required.");
  }
  const onState = options.onState ?? (() => {});
  let active = null;
  let pending = null;
  let drainPromise = null;

  function publish() {
    onState({ active, pending, running: drainPromise !== null });
  }

  async function drain() {
    try {
      while (pending !== null) {
        active = pending;
        pending = null;
        publish();
        await options.apply(active);
      }
    } finally {
      active = null;
      drainPromise = null;
      publish();
    }
  }

  function request(value) {
    pending = value;
    if (drainPromise === null) {
      drainPromise = drain();
    }
    publish();
    return drainPromise;
  }

  function state() {
    return Object.freeze({ active, pending, running: drainPromise !== null });
  }

  return Object.freeze({ request, state });
}
