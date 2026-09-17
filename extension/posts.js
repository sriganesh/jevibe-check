(() => {
  const roots = '[data-testid^="feedItem-by-"], [data-testid^="postThreadItem-by-"]';
  const entries = new Map(), cache = new Map(), nodeEntries = new WeakMap();
  let filterRules = [], filtersEnabled = false;
  let customSelector = '', enabled = false, generation = 0, running = 0;
  let stopped = false, domObserver, retryTimer, scanTimer, pumpTimer, pumpAt = 0;
  let preferenceTimer, preferenceDelay = 1000, preferencesFailed = false;
  function stop() {
    if (stopped) return;
    stopped = true; enabled = false; generation++;
    domObserver?.disconnect(); observer.disconnect(); clearInterval(retryTimer); clearTimeout(scanTimer); clearTimeout(pumpTimer);
    clearTimeout(preferenceTimer);
    document.removeEventListener('visibilitychange',onVisibility);
    for (const entry of entries.values()) {entry.removeFilter?.(); entry.host?.remove();}
    entries.clear(); cache.clear();
  }
  const send = async message => {
    try {
      if (stopped) return null;
      if (!globalThis.chrome?.runtime?.sendMessage) {stop();return null;}
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      if (!globalThis.chrome?.runtime?.sendMessage || /extension context invalidated/i.test(error?.message || '')) stop();
      return null;
    }
  };
  function textNode(root) {
    if (customSelector || root.matches('[data-testid="postText"]')) return root;
    // RichText's word-wrap marker covers thread anchors and replies without postText IDs.
    return [...root.querySelectorAll('[data-testid="postText"], [data-word-wrap="1"]')].find(el =>
      el.closest(roots) === root && !el.closest('[data-testid="quotePost"], [data-testid="contentHider-embed"], [contenteditable="true"]') &&
      !el.parentElement.closest('[data-word-wrap="1"]'));
  }
  function scheduleScan() {
    if (stopped || !enabled || scanTimer || document.visibilityState !== 'visible') return;
    scanTimer = setTimeout(() => {scanTimer = null; scan();}, 300);
  }
  function schedulePump(delay = 25) {
    if (stopped || !enabled || document.visibilityState !== 'visible') return;
    const at = Date.now() + delay;
    if (pumpTimer && pumpAt <= at) return;
    clearTimeout(pumpTimer); pumpAt = at;
    // Always yield to rendering, input, and mutation callbacks, including on cache hits.
    pumpTimer = setTimeout(() => {pumpTimer = null; pump();}, delay);
  }
  function discard(entry) {
    observer.unobserve(entry.node); nodeEntries.delete(entry.node);
    entry.removeFilter?.(); entry.removeFilter = null; entry.host?.remove();
    if (entries.get(entry.root) === entry) entries.delete(entry.root);
    entry.done = true;
  }
  function mount(entry, result) {
    entry.removeFilter?.(); entry.removeFilter = null;
    entry.host?.remove();
    const confidentLabels = result?.labels?.filter(label => label.confidence >= .55);
    if (!confidentLabels?.length) return;
    const host = document.createElement('div'); host.dataset.darterPost = '';
    host.style.cssText = 'margin:6px 0;display:block;';
    const c = getComputedStyle(entry.node).color.match(/[\d.]+/g)?.slice(0,3).map(Number);
    host.style.colorScheme = c && (c[0]*.299+c[1]*.587+c[2]*.114)>145 ? 'dark' : 'light';
    const shadow = host.attachShadow({mode:'open'});
    shadow.innerHTML = `<style>:host{color-scheme:light dark}.labels{display:flex;flex-wrap:wrap;gap:5px;font:11px/1.4 system-ui,sans-serif;color:light-dark(#526273,#a8b7c8)}span{padding:2px 6px;border-radius:4px;background:light-dark(#edf1f5,#232e3c);cursor:default;white-space:nowrap}span[data-tone=good]{color:light-dark(#356b54,#9ac6b2)}span[data-tone=alert]{color:light-dark(#8e552c,#dbb28d)}span:focus-visible{outline:2px solid #168bff}</style><div class="labels" aria-label="Jevibe Check post labels"></div>`;
    for (const label of confidentLabels) {
      const el = document.createElement('span');
      el.textContent = label.label;
      el.title = `Jevibe Check · ${label.name}: ${label.label}. Probability ${Math.round(label.probability*100)}%. Confidence ${Math.round(label.confidence*100)}%. Text only; conversation context may be missing.`;
      el.setAttribute('aria-label', el.title); el.tabIndex = 0;
      el.dataset.tone = ['Warm','Constructive','Calm','Clear','Supporting'].includes(label.label) ? 'good' : ['Cold','Heated','Hostile','Unconstructive','Sarcastic','Ambiguous'].includes(label.label) ? 'alert' : '';
      shadow.querySelector('.labels').append(el);
    }
    host.addEventListener('click', event => event.stopPropagation());
    entry.node.insertAdjacentElement('afterend',host); entry.host = host;
    if (filtersEnabled && globalThis.DarterFilters) {
      const rule = DarterFilters.match(result.labels,filterRules);
      if (rule) {
        const target = entry.node.closest(roots) || entry.node.closest('article') || entry.node;
        entry.removeFilter = DarterFilters.apply(target,rule,result.labels.find(label => label.id === rule.classifier)?.name || rule.classifier);
      }
    }
  }
  async function classify(entry) {
    running++; entry.busy = true;
    const revision = generation, text = entry.text;
    try {
      let request = cache.get(text);
      if (!request) {
        request = send({type:'classify', source:'post', editor:entry.id, text}); cache.set(text,request);
        if (cache.size > 300) cache.delete(cache.keys().next().value);
      } else {void send({type:'cache-hit'});}
      const result = await request;
      if (stopped || revision !== generation || !enabled || entries.get(entry.root) !== entry) return;
      if (!entry.node.isConnected || entry.node.textContent !== entry.fingerprint) {
        discard(entry); scheduleScan(); return;
      }
      if (result?.labels) {entry.done = true; mount(entry,result);}
      else {
        if (cache.get(text) === request) cache.delete(text);
        // Retry a lost message promptly; keep the API error/rate-limit cooldown.
        entry.retryAt = Date.now() + (result ? 30000 : Math.min(30000, 1000 * 2 ** (entry.failures || 0)));
        entry.failures = Math.min(5, (entry.failures || 0) + 1);
      }
    } catch {entry.done = true;}
    finally {entry.busy = false; running--; schedulePump();}
  }
  function pump() {
    if (stopped || !enabled || document.visibilityState !== 'visible') return;
    let retryIn = Infinity;
    for (const entry of entries.values()) {
      if (running >= 2) break;
      if (!entry.done && !entry.busy && entry.inView && entry.node.isConnected && entry.node.checkVisibility({checkVisibilityCSS:true})) {
        const remaining = (entry.retryAt || 0) - Date.now();
        if (remaining > 0) retryIn = Math.min(retryIn, remaining);
        else void classify(entry);
      }
    }
    if (Number.isFinite(retryIn)) schedulePump(Math.max(25, retryIn));
  }
  const observer = new IntersectionObserver(records => {
    for (const record of records) {const entry = nodeEntries.get(record.target); if (entry) entry.inView = record.isIntersecting;}
    schedulePump();
  }, {threshold:0});
  function scan() {
    if (stopped || !enabled || document.visibilityState !== 'visible') return;
    for (const [root,entry] of entries) {
      const node = root.isConnected ? textNode(root) : null;
      if (!node || node !== entry.node || node.textContent !== entry.fingerprint) {
        discard(entry);
        void send({type:'cancel',editor:entry.id});
      } else if (entry.host && !entry.host.isConnected) {
        // A page redraw can remove our sibling without changing the post text.
        entry.node.insertAdjacentElement('afterend',entry.host);
      }
    }
    const candidates = customSelector ? [...document.querySelectorAll(customSelector)] : [
      ...document.querySelectorAll(roots),
      ...[...document.querySelectorAll('[data-testid="postText"]')].filter(node => !node.closest(roots))
    ];
    for (const root of candidates) {
      if (entries.has(root) || root.closest('[data-testid="composePostView"], [aria-modal="true"]')) continue;
      const node = textNode(root), text = node?.textContent.trim();
      if (!text || text.length > 10000) continue;
      const entry = {root,node,text,fingerprint:node.textContent,id:crypto.randomUUID(),done:false,inView:false}; entries.set(root,entry); nodeEntries.set(node,entry); observer.observe(node);
    }
    schedulePump();
  }
  async function preferences() {
    clearTimeout(preferenceTimer); preferenceTimer = null; preferencesFailed = false;
    const revision = ++generation;
    enabled = false; cache.clear();
    for (const entry of entries.values()) {entry.removeFilter?.(); entry.host?.remove(); void send({type:'cancel',editor:entry.id});}
    entries.clear(); observer.disconnect();
    const prefs = await send({type:'preferences'});
    if (stopped || revision !== generation) return;
    if (typeof prefs?.ready !== 'boolean' || typeof prefs?.viewedPosts !== 'boolean') {
      preferencesFailed = true;
      if (document.visibilityState === 'visible') {
        preferenceTimer = setTimeout(() => {preferenceTimer = null; if (document.visibilityState === 'visible') void preferences();}, preferenceDelay);
        preferenceDelay = Math.min(30000, preferenceDelay * 2);
      }
      return;
    }
    preferenceDelay = 1000;
    filtersEnabled = !!prefs?.filtersEnabled; filterRules = prefs?.filterRules || [];
    customSelector = prefs?.site?.postSelector || '';
    // Corrupt or outdated saved selectors must not throw on every DOM mutation.
    try { if (customSelector) document.querySelector(customSelector); } catch { return; }
    enabled = prefs?.allowed !== false && !!(prefs?.viewedPosts && prefs.ready); scan();
  }
  const owned = node => {
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return !!el?.closest('[data-darter], [data-darter-post], [data-darter-filter]');
  };
  domObserver = new MutationObserver(records => {
    if (records.some(record => !owned(record.target) &&
      (record.type === 'characterData' || [...record.addedNodes,...record.removedNodes].some(node => !owned(node)) ||
      [...record.removedNodes].some(node => node.nodeType === Node.ELEMENT_NODE && node.matches('[data-darter-post]'))))) scheduleScan();
  });
  domObserver.observe(document.body,{childList:true,subtree:true,characterData:true});
  function onVisibility() {
    if (document.visibilityState === 'visible') {
      if (preferencesFailed) void preferences();
      else {scheduleScan(); schedulePump();}
    }
  }
  document.addEventListener('visibilitychange',onVisibility);
  globalThis.chrome?.runtime?.onMessage?.addListener(message => {if (message.type === 'darter-settings-changed') void preferences();});
  retryTimer = setInterval(schedulePump, 30000);
  void preferences();
})();
