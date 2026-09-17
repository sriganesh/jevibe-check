import {DEFAULT_PRICING, emptyStats, validatePricing, normalizePricing} from './stats.js';
const number = value => new Intl.NumberFormat().format(value);
function render(stats) {
  const data = stats || emptyStats();
  for(const key of ['requests','successful','cacheHits','decisions','inputTokens','outputTokens']) document.querySelector(`[data-stat="${key}"]`).textContent=number(data[key] || 0);
  document.querySelector('[data-stat="cost"]').textContent=`$${(data.estimatedUsd || 0).toFixed(6)}`;
  document.querySelector('#usage-breakdown').textContent=`${number(data.posts || 0)} viewed-post requests · ${number(data.drafts || 0)} draft requests · ${number(data.errors || 0)} failed · ${number(data.canceled || 0)} canceled`;
  document.querySelector('#usage-since').textContent=stats ? `Tracked on this device since ${new Date(data.since).toLocaleDateString()}.` : 'Tracking starts with your next request. Earlier usage is not available.';
  const missing = Math.max(0,(data.requests || 0)-(data.usageResponses || 0));
  document.querySelector('#usage-missing').textContent=missing ? `${number(missing)} requests have no reported token usage, including pending, failed, or canceled calls. Their cost is unknown.` : '';
}
const saved = await chrome.storage.local.get({usageStats:null,usagePricing:DEFAULT_PRICING});
render(saved.usageStats);
const pricing=normalizePricing(saved.usagePricing);
document.querySelector('#input-rate').value=pricing.inputPerMillion;
document.querySelector('#output-rate').value=pricing.outputPerMillion;
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes.usageStats)render(changes.usageStats.newValue);});
document.querySelector('#save-rates').onclick=async()=>{
  const status=document.querySelector('#rate-status');
  try {
    const input=document.querySelector('#input-rate'),output=document.querySelector('#output-rate');
    if (!input.value || !output.value) throw new Error('Enter both token prices.');
    const usagePricing=validatePricing({inputPerMillion:Number(input.value),outputPerMillion:Number(output.value)});
    await chrome.storage.local.set({usagePricing});status.textContent='Rates saved for future requests.';
  } catch(error) {status.textContent=error.message;}
};

document.querySelector('#clear-stats').onclick=async event=>{
  const button=event.currentTarget, status=document.querySelector('#clear-stats-status');
  button.disabled=true;
  try {
    const result=await chrome.runtime.sendMessage({type:'clear-stats'});
    if (!result?.ok) throw new Error('Could not clear stats. Try again.');
    status.textContent='Stats cleared. Settings and API key kept.';
  } catch(error) {status.textContent=error.message;}
  finally {button.disabled=false;}
};
