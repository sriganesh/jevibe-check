export const DEFAULT_PRICING = {inputPerMillion: 0.042, outputPerMillion: 0};
export function emptyStats() {
  return {since: new Date().toISOString(), requests:0, posts:0, drafts:0, successful:0, errors:0, canceled:0, decisions:0, cacheHits:0, inputTokens:0, outputTokens:0, usageResponses:0, estimatedUsd:0};
}
export function usageDelta(usage, pricing = DEFAULT_PRICING) {
  if (!Number.isSafeInteger(usage?.input_tokens) || usage.input_tokens < 0 || !Number.isSafeInteger(usage?.output_tokens) || usage.output_tokens < 0) return {};
  pricing = normalizePricing(pricing);
  return {inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, usageResponses:1, estimatedUsd:(usage.input_tokens * pricing.inputPerMillion + usage.output_tokens * pricing.outputPerMillion) / 1e6};
}
export function validatePricing(value) {
  for (const rate of [value?.inputPerMillion, value?.outputPerMillion]) if (!Number.isFinite(rate) || rate < 0 || rate > 10000) throw new Error('Token prices must be between $0 and $10,000 per million.');
  return value;
}
export function normalizePricing(value) {
  try {return validatePricing(value);} catch {return DEFAULT_PRICING;}
}
let pending = Promise.resolve();
let generation = 0;
export const currentStatsEpoch = () => generation;
export function clearStats() {
  generation++;
  const write = pending.then(() => chrome.storage.local.set({usageStats:emptyStats()}));
  pending = write.catch(() => {});
  return write;
}
export function recordStats(delta, epoch = generation) {
  // The worker is the sole writer. Serialize read/modify/write across parallel requests.
  const write = pending.then(async () => {
    if (epoch !== generation) return;
    const {usageStats = emptyStats()} = await chrome.storage.local.get('usageStats');
    const next = {...emptyStats(), ...usageStats};
    for (const [key,value] of Object.entries(delta)) if (typeof next[key] === 'number' && Number.isFinite(value) && value >= 0) next[key] += value;
    await chrome.storage.local.set({usageStats:next});
  });
  pending = write.catch(() => {});
  return pending;
}
