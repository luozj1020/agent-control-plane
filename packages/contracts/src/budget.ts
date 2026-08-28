export const BALANCED_BUDGET_LIMITS = Object.freeze({
  mainReviewCalls: Object.freeze({ min: 1, max: 99 }),
  downstreamCalls: Object.freeze({ min: 1, max: 99 }),
  advisorCalls: Object.freeze({ min: 0, max: 99 }),
  reservedFinalReviewCalls: Object.freeze({ min: 0, max: 99 }),
});

export const BALANCED_TIMING_LIMITS = Object.freeze({
  contextAcquisitionSeconds: Object.freeze({ min: 30, max: 3_600 }),
  firstProgressSeconds: Object.freeze({ min: 30, max: 3_600 }),
  activeWindowSeconds: Object.freeze({ min: 30, max: 3_600 }),
  progressExtensionSeconds: Object.freeze({ min: 10, max: 1_800 }),
  growingProgressExtensionSeconds: Object.freeze({ min: 10, max: 1_800 }),
  hardCapSeconds: Object.freeze({ min: 60, max: 7_200 }),
});
