export const BALANCED_BUDGET_LIMITS = Object.freeze({
  mainReviewCalls: Object.freeze({ min: 1, max: 99 }),
  downstreamCalls: Object.freeze({ min: 1, max: 99 }),
  advisorCalls: Object.freeze({ min: 0, max: 99 }),
  reservedFinalReviewCalls: Object.freeze({ min: 0, max: 99 }),
  maxTotalTokens: Object.freeze({ min: 0, max: 1_000_000_000 }),
});
