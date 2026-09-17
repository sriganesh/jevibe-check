export const BUILTIN_ORIGIN = 'https://bsky.app';
export const SUGGESTED_SITES = ['blacksky.community', 'mu.social', 'reddwarf.app', 'witchsky.app'];
export function normalizeOrigin(value) {
  const url = new URL(value.includes('://') ? value : `https://${value}`);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash || !url.hostname.includes('.')) throw new Error('Enter an HTTPS domain, without a path or port.');
  return url.origin;
}
export function validSites(value) {
  const seen = new Set();
  return (Array.isArray(value) ? value : []).filter(site => {
    try {
      if (normalizeOrigin(site?.origin) !== site.origin || seen.has(site.origin)) return false;
      seen.add(site.origin); return true;
    } catch {return false;}
  });
}
export async function readSites() {return validSites((await chrome.storage.local.get({sites:[]})).sites);}
export const sitePattern = origin => `${origin}/*`;
export const siteScriptId = origin => `darter_${Array.from(origin, c => c.charCodeAt(0).toString(16)).join('')}`;
export const SITE_SYNC_ALARM = 'darter-site-sync';
export function syncSites() {
  // Options and worker reconciliation share this lock, including alarm lifecycle.
  return navigator.locks.request(SITE_SYNC_ALARM, async () => {
    // Arm before touching registrations so worker termination cannot lose a retry.
    await chrome.alarms.create(SITE_SYNC_ALARM, {delayInMinutes:1, periodInMinutes:1});
    await reconcileSiteScripts();
    await chrome.alarms.clear(SITE_SYNC_ALARM);
  });
}
async function reconcileSiteScripts() {
  const sites = await readSites();
  const existing = await chrome.scripting.getRegisteredContentScripts();
  const wanted = [];
  for (const site of sites) {
    if (site.origin === BUILTIN_ORIGIN || normalizeOrigin(site.origin) !== site.origin) continue;
    if (await chrome.permissions.contains({origins: [sitePattern(site.origin)]})) wanted.push(site);
  }
  const ids = new Set(wanted.map(site => siteScriptId(site.origin)));
  const obsolete = existing.filter(script => script.id.startsWith('darter_') && !ids.has(script.id)).map(script => script.id);
  if (obsolete.length) await chrome.scripting.unregisterContentScripts({ids: obsolete});
  const retained = wanted.filter(site => existing.some(script => script.id === siteScriptId(site.origin)));
  if (retained.length) await chrome.scripting.updateContentScripts(retained.map(site => ({id:siteScriptId(site.origin),js:['filters.js','content.js','posts.js']})));
  const added = wanted.filter(site => !existing.some(script => script.id === siteScriptId(site.origin)));
  if (added.length) await chrome.scripting.registerContentScripts(added.map(site => ({id: siteScriptId(site.origin), matches:[sitePattern(site.origin)], js:['filters.js','content.js','posts.js'], runAt:'document_idle', persistAcrossSessions:true})));
}
export function defaultSite(origin) {
  if (origin === 'https://reddwarf.app') return {origin,
    postSelector: 'main div[style*="white-space: pre-wrap"][style*="overflow-wrap: anywhere"]:not(.animate-pulse)',
    composerSelector: 'textarea[placeholder="What\'s happening?!"], textarea[placeholder="Post your reply"], textarea[placeholder="Add a comment..."]'};
  return {origin, postSelector:'', composerSelector:''};
}

export async function addSite(origin) {
  const scope = {origins:[sitePattern(origin)]};
  // Both API calls begin in the button's user gesture, before the first await.
  const previousPermission = chrome.permissions.contains(scope);
  const requestedPermission = chrome.permissions.request(scope);
  const [hadPermission, granted] = await Promise.all([previousPermission, requestedPermission]);
  if (!granted) throw new Error('Site access was not granted.');
  let added = false;
  try {
    const sites = await readSites();
    if (!sites.some(site => site.origin === origin)) {
      await chrome.storage.local.set({sites:[...sites,defaultSite(origin)]});
      added = true;
    }
    await syncSites();
  } catch (error) {
    const failures = [];
    if (added) {
      try {await chrome.storage.local.set({sites:(await readSites()).filter(site => site.origin !== origin)});} catch (failure) {failures.push(failure);}
      try {await chrome.scripting.unregisterContentScripts({ids:[siteScriptId(origin)]});} catch {
        // Registering may have failed before the script existed.
        try {if ((await chrome.scripting.getRegisteredContentScripts()).some(script => script.id === siteScriptId(origin))) failures.push(new Error('Script still registered'));} catch (failure) {failures.push(failure);}
      }
    }
    if (!hadPermission) {
      try {
        await chrome.permissions.remove(scope);
        if (await chrome.permissions.contains(scope)) failures.push(new Error('Permission still granted'));
      } catch (failure) {failures.push(failure);}
    }
    if (failures.length) throw new Error('Site setup failed and cleanup was incomplete. Check site access in Chrome extension settings, then retry.');
    throw new Error('Could not add this site. Changes from this attempt were rolled back.', {cause:error});
  }
}
export async function removeSite(origin) {
  const scope = {origins:[sitePattern(origin)]};
  await chrome.permissions.remove(scope);
  if (await chrome.permissions.contains(scope)) throw new Error('Chrome did not remove site access. The site was kept in settings; try again.');
  const failures = [];
  // Always attempt script cleanup, even if deleting the saved record fails.
  for (const operation of [
    async () => chrome.storage.local.set({sites:(await readSites()).filter(site => site.origin !== origin)}),
    syncSites
  ]) {
    try {await operation();}
    catch {
      try {await operation();} catch (error) {failures.push(error);}
    }
  }
  if (failures.length) throw new Error('Site access was revoked, but cleanup is incomplete. Script cleanup will retry automatically; retry Remove to finish updating settings.', {cause:failures[0]});
}
