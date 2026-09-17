import {DEFAULT_PRICING, recordStats, usageDelta, clearStats, currentStatsEpoch} from './stats.js';
import './filters.js';
import {BUILTIN_ORIGIN, SITE_SYNC_ALARM, syncSites, readSites, validSites} from './sites.js';
import {CLASSIFIERS, DEFAULTS, classifierCatalog, validateCustom, buildRequest, parseAnswers} from './classifiers.js';
// Content scripts never receive storage access or the key.
const ready = (async () => {
  await chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
  const {filterRules = []} = await chrome.storage.local.get({filterRules:[]});
  if (filterRules.some(rule => rule.action === 'spoiler')) await chrome.storage.local.set({filterRules:filterRules.map(rule => DarterFilters.normalizeRule(rule))});
})();
const active = new Map();
const cache = new Map();
let cooldownUntil = 0;
async function settings(signal) {
  signal?.throwIfAborted();
  await abortable(ready, signal);
  signal?.throwIfAborted();
  const s = await chrome.storage.local.get({...DEFAULTS, apiKey: '', sites: [], usagePricing: DEFAULT_PRICING});
  s.sites = validSites(s.sites);
  s.filterRules = s.filterRules.map(rule => DarterFilters.normalizeRule(rule));
  s.classifiers = [...new Set(s.classifiers)].filter(id => Object.hasOwn(CLASSIFIERS, id));
  const custom = validateCustom(s.customClassifiers);
  s.catalog = classifierCatalog(custom);
  s.classifiers.push(...custom.filter(item => item.enabled).map(item => item.id));
  return s;
}
function invalidateSettings() {
  for (const controller of active.values()) controller.abort();
  active.clear(); cache.clear();
  void chrome.tabs.query({}).then(tabs => Promise.all(tabs.map(tab =>
    chrome.tabs.sendMessage(tab.id, {type:'darter-settings-changed'}).catch(() => {})
  ))).catch(() => {});
}
function reconcileSites() {
  return syncSites().catch(() => {
    console.warn('Site script cleanup failed; it will be retried on the next cleanup alarm or worker start.');
  });
}
chrome.runtime.onInstalled.addListener(reconcileSites);
chrome.runtime.onStartup.addListener(reconcileSites);
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === SITE_SYNC_ALARM) return reconcileSites();
});
// Alarms can disappear across browser restarts. Reconcile on every worker start too.
// A failed settings migration must not prevent registration cleanup.
void ready.then(reconcileSites, reconcileSites);
chrome.permissions.onRemoved.addListener(() => {
  invalidateSettings();
  return reconcileSites();
});
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.keys(changes).some(key => !['usageStats','usagePricing'].includes(key))) invalidateSettings();
});
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !msg || typeof msg.type !== 'string') return;
  if (msg.type === 'clear-stats' && sender.url === chrome.runtime.getURL('options.html')) {
    clearStats().then(() => respond({ok:true})).catch(() => respond({ok:false}));
    return true;
  }
  if (!sender.tab || !sender.url) return;
  let origin;
  try {origin = new URL(sender.url).origin;} catch {return;}
  const key = `${sender.tab.id}:${sender.frameId}:${String(msg.editor).slice(0, 80)}`;
  // Register/cancel synchronously, before authorization and storage can yield.
  if (msg.type === 'cancel') {
    active.get(key)?.abort(); active.delete(key); respond({ok:true}); return;
  }
  let controller, timer;
  const statsEpoch = currentStatsEpoch();
  if (msg.type === 'classify') {
    active.get(key)?.abort();
    controller = new AbortController(); active.set(key, controller);
    timer = setTimeout(() => controller.abort(), 12000);
  }
  (async () => {
    const allowed = await authorize(origin, controller?.signal);
    controller?.signal.throwIfAborted();
    if (!allowed) return {viewedPosts:false, ready:false, allowed:false};
    if (msg.type === 'preferences') {
      const s = await settings();
      return {allowed:true, site:s.sites.find(site => site.origin === origin) || {}, enabled:s.enabled, viewedPosts:s.viewedPosts, ready:!!s.apiKey && s.classifiers.length > 0, filtersEnabled:s.filtersEnabled, filterRules:s.filterRules};
    }
    if (msg.type === 'cache-hit') {await recordStats({cacheHits:1}); return {ok:true};}
    if (msg.type === 'settings') {await chrome.runtime.openOptionsPage(); return {ok:true};}
    if (msg.type === 'classify') return classify(msg, controller.signal, statsEpoch);
    return {};
  })().then(respond).catch(error => respond({status:error.name === 'AbortError' ? 'Request canceled or timed out. Keep typing to retry.' : 'Could not classify. Check your connection and settings.'})).finally(() => {
    clearTimeout(timer);
    if (controller && active.get(key) === controller) active.delete(key);
  });
  return true;
});
async function abortable(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, {once:true});
  });
  try {return await Promise.race([promise, aborted]);}
  finally {signal.removeEventListener('abort', onAbort);}
}
async function authorize(origin, signal) {
  signal?.throwIfAborted();
  if (origin === BUILTIN_ORIGIN) return true;
  await abortable(ready, signal);
  signal?.throwIfAborted();
  const sites = await abortable(readSites(), signal);
  signal?.throwIfAborted();
  return sites.some(site => site.origin === origin) && await abortable(chrome.permissions.contains({origins:[`${origin}/*`]}), signal);
}
async function classify(msg, signal, statsEpoch) {
  const s = await settings(signal);
  signal.throwIfAborted();
  const viewedPost = msg.source === 'post';
  if (viewedPost && !s.viewedPosts) return {status:'Post labels paused'};
  if (!viewedPost && !s.enabled) return {status:'Paused in settings'};
  if (!s.apiKey) return {status:'Add your TypeSafe API key in settings'};
  if (!s.classifiers.length) return {status:'Choose classifiers in settings'};
  if (typeof msg.text !== 'string' || !msg.text.trim() || msg.text.length > 10000) return {status:'Draft is empty or too long'};
  const cacheKey = JSON.stringify([s.classifiers, s.catalog, msg.text]);
  if (viewedPost && cache.has(cacheKey)) {
    const result = cache.get(cacheKey);
    await recordStats({cacheHits:1}, statsEpoch); signal.throwIfAborted(); return result;
  }
  if (Date.now() < cooldownUntil) return {status:'TypeSafe is busy. Pause and try again shortly.'};
  let outcome = 'errors';
  try {
    await recordStats({requests:1, [viewedPost ? 'posts' : 'drafts']:1}, statsEpoch);
    signal.throwIfAborted();
    const response = await fetch('https://api.typesafe.ai/v1/systemone', {method:'POST', headers:{Authorization:`Bearer ${s.apiKey}`, 'Content-Type':'application/json'}, body:JSON.stringify(buildRequest(msg.text, s.classifiers, viewedPost, s.catalog)), signal});
    if ([429, 529].includes(response.status)) {cooldownUntil = Date.now() + 30000; return {status:'TypeSafe is busy. Try again in 30 seconds.'};}
    if ([401, 403].includes(response.status)) return {status:'Check your API key and TypeSafe access in settings'};
    if (!response.ok) return {status:`TypeSafe request failed (${response.status})`};
    const data = await response.json();
    await recordStats(usageDelta(data.usage, s.usagePricing), statsEpoch);
    signal.throwIfAborted();
    const result = {labels:parseAnswers(data, s.classifiers, s.catalog)};
    await recordStats({decisions:result.labels.length}, statsEpoch);
    signal.throwIfAborted();
    outcome = 'successful';
    if (viewedPost) {cache.set(cacheKey, result); if (cache.size > 300) cache.delete(cache.keys().next().value);}
    return result;
  } catch (error) {if (error.name === 'AbortError') outcome = 'canceled'; throw error;}
  finally {await recordStats({[outcome]:1}, statsEpoch);}
}
