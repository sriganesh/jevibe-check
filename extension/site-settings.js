import {BUILTIN_ORIGIN, SUGGESTED_SITES, normalizeOrigin, readSites, addSite, removeSite} from './sites.js';
const list = document.querySelector('#sites-list');
const status = document.querySelector('#site-status');
const domain = document.querySelector('#site-domain');
function validSelector(value) {
  if (value.length > 500) throw new Error('Keep each selector under 500 characters.');
  if (value) document.querySelector(value);
  return value.trim();
}
async function render() {
  list.replaceChildren();
  const sites = await readSites();
  const suggestions = document.querySelector('#site-suggestions');
  suggestions.replaceChildren();
  for (const host of SUGGESTED_SITES.filter(host => !sites.some(site => site.origin === `https://${host}`))) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = host;
    button.onclick = () => {domain.value = host; domain.focus();};
    suggestions.append(button);
  }
  for (const site of sites) {
    const row = document.createElement('div'); row.className = 'site-row';
    const top = document.createElement('div'); top.className = 'custom-top';
    const name = document.createElement('strong'); name.textContent = new URL(site.origin).hostname;
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove'; remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove ${name.textContent}`);
    remove.onclick = async () => {
      try {
        await removeSite(site.origin);
        await render(); status.textContent = 'Site removed.';
      } catch (error) {status.textContent = error.message || 'Could not remove this site. Try again.';}
    };
    top.append(name,remove); row.append(top);
    const details = document.createElement('details');
    details.innerHTML = '<summary>Site detection</summary><p class="small">Leave blank for Bluesky-compatible apps. For other apps, use CSS selectors that match only post text and editable composers.</p><label>Post text selector<input class="post-selector" type="text" placeholder="article .post-text"></label><label>Composer selector<input class="composer-selector" type="text" placeholder=".post-composer [contenteditable=true]"></label><button class="save-detection" type="button">Save detection</button>';
    details.querySelector('.post-selector').value = site.postSelector || '';
    details.querySelector('.composer-selector').value = site.composerSelector || '';
    details.querySelector('.save-detection').onclick = async () => {
      let postSelector, composerSelector;
      try {postSelector = validSelector(details.querySelector('.post-selector').value); composerSelector = validSelector(details.querySelector('.composer-selector').value);}
      catch {status.textContent = 'Enter valid CSS selectors, up to 500 characters each.'; return;}
      try {
        const sites = await readSites();
        await chrome.storage.local.set({sites:sites.map(item => item.origin === site.origin ? {...item,postSelector,composerSelector} : item)});
        status.textContent = 'Detection saved.';
      } catch {status.textContent = 'Could not save site detection.';}
    };
    row.append(details); list.append(row);
  }
}
document.querySelector('#add-site').onclick = async () => {
  let origin;
  try {origin = normalizeOrigin(domain.value.trim());}
  catch {status.textContent = 'Enter a domain, for example mu.social.'; return;}
  if (origin === BUILTIN_ORIGIN) {status.textContent = 'Bluesky is already enabled.'; return;}
  const button = document.querySelector('#add-site');
  button.disabled = true;
  try {
    await addSite(origin);
    domain.value = '';
    try {await render();} catch {status.textContent = 'Site added. Reopen settings to refresh the list.'; return;}
    status.textContent = 'Site added. Refresh its tab to start. Other apps may need custom detection.';
  } catch (error) {status.textContent = error.message || 'Could not add this site. Try again.';}
  finally {button.disabled = false;}
};
render().catch(() => {status.textContent = 'Open settings from the installed extension.';});
