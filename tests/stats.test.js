import {test} from 'node:test';
import assert from 'node:assert/strict';
import {usageDelta, recordStats, validatePricing, clearStats, currentStatsEpoch, normalizePricing, DEFAULT_PRICING} from '../extension/stats.js';
test('estimates from reported tokens and keeps missing usage unknown',()=>{
  assert.equal(usageDelta({input_tokens:1000000,output_tokens:5000}).estimatedUsd,.042);
  assert.deepEqual(usageDelta(undefined),{});
  assert.deepEqual(usageDelta({input_tokens:-1,output_tokens:0}),{});
  assert.equal(usageDelta({input_tokens:1000000,output_tokens:1000000},{inputPerMillion:1,outputPerMillion:2}).estimatedUsd,3);
  assert.throws(()=>validatePricing({inputPerMillion:-1,outputPerMillion:0}));
});
test('serializes concurrent stats increments without storing text',async()=>{
  let saved;
  globalThis.chrome={storage:{local:{get:async()=>({usageStats:saved}),set:async value=>{saved=structuredClone(value.usageStats);}}}};
  await Promise.all(Array.from({length:15},()=>recordStats({requests:1,posts:1})));
  await recordStats({successful:1,...usageDelta({input_tokens:100,output_tokens:10})});
  assert.equal(saved.requests,15);assert.equal(saved.posts,15);assert.equal(saved.successful,1);assert.equal(saved.inputTokens,100);
  assert.equal(Object.hasOwn(saved,'text'),false);
  delete globalThis.chrome;
});

test('reset serializes with writes and excludes old in-flight request results',async()=>{
  let saved;
  globalThis.chrome={storage:{local:{get:async()=>({usageStats:saved}),set:async value=>{saved=structuredClone(value.usageStats);}}}};
  const oldEpoch=currentStatsEpoch();
  await recordStats({requests:5,successful:4,inputTokens:100,estimatedUsd:1},oldEpoch);
  await Promise.all([recordStats({requests:1},oldEpoch),clearStats(),recordStats({requests:1,drafts:1})]);
  await recordStats({successful:1,inputTokens:200,estimatedUsd:5},oldEpoch);
  assert.equal(saved.requests,1);assert.equal(saved.drafts,1);assert.equal(saved.successful,0);
  assert.equal(saved.inputTokens,0);assert.equal(saved.estimatedUsd,0);
  await recordStats({successful:1});assert.equal(saved.successful,1);
  delete globalThis.chrome;
});

test('malformed stored pricing uses defaults in fields and usage accounting',()=>{
  for(const value of [null,undefined,{}, {inputPerMillion:-1,outputPerMillion:0}]) {
    assert.deepEqual(normalizePricing(value),DEFAULT_PRICING);
    assert.equal(usageDelta({input_tokens:1000000,output_tokens:100},value).estimatedUsd,.042);
  }
});
