(async () => {
  const mounted = new Map();
  const defaultSelector = '[data-testid="composePostView"] [contenteditable="true"], [data-testid="composePostView"] textarea, [role="dialog"] .tiptap[contenteditable="true"], [aria-modal="true"] .tiptap[contenteditable="true"]';
  let selector = defaultSelector;
  let stopped = false, domObserver, scanTimer, preferenceVersion = 0;
  function stop() {
    if (stopped) return;
    stopped = true; domObserver?.disconnect(); clearTimeout(scanTimer);
    for (const cleanup of mounted.values()) cleanup();
    mounted.clear();
  }
  const send = async message => {
    try {
      if (stopped) return null;
      if (!globalThis.chrome?.runtime?.sendMessage) {stop();return null;}
      return await chrome.runtime.sendMessage(message);
    } catch {stop();return null;}
  };
  async function preferences() {
    const version = ++preferenceVersion;
    // Clear stale feedback immediately, even while preferences are loading.
    for (const cleanup of mounted.values()) cleanup();
    mounted.clear(); selector = ':not(*)';
    const prefs = await send({type:'preferences'});
    if (stopped || version !== preferenceVersion || !prefs || prefs.allowed === false || prefs.enabled === false) return;
    const next = prefs.site?.composerSelector || defaultSelector;
    try {document.querySelector(next);} catch {return;}
    selector = next; scan();
  }
  function attach(editor) {
    const id = crypto.randomUUID();
    const host = document.createElement('div'); host.dataset.darter = '';
    host.style.cssText = 'display:block;width:100%;flex-shrink:0;box-sizing:border-box;margin:6px 0;';
    const foreground = getComputedStyle(editor).color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
    if (foreground?.length === 3) host.style.colorScheme = (foreground[0] * .299 + foreground[1] * .587 + foreground[2] * .114) > 145 ? 'dark' : 'light';
    const shadow = host.attachShadow({mode: 'open'});
    shadow.innerHTML = `<style>
      :host{color-scheme:light dark}*{box-sizing:border-box}
      .panel{display:flex;align-items:center;gap:8px;font:11px/1.4 system-ui,sans-serif;color:light-dark(#526273,#a8b7c8)}
      .labels{display:flex;align-items:center;flex-wrap:wrap;gap:5px;flex:1;min-width:0}
      .chip{padding:2px 6px;border-radius:4px;background:light-dark(#edf1f5,#232e3c);white-space:nowrap;cursor:default}
      .chip[data-tone=good]{color:light-dark(#356b54,#9ac6b2)}
      .chip[data-tone=alert]{color:light-dark(#8e552c,#dbb28d)}
      button{border:0;background:none;color:inherit;cursor:pointer;padding:4px;border-radius:4px;flex-shrink:0;opacity:.65}
      button:hover{opacity:1}button:focus-visible,.chip:focus-visible{outline:2px solid #168bff;outline-offset:2px}
      svg{width:14px;height:14px;display:block}.status{font-size:11px}
    </style><section class="panel" aria-label="Jevibe Check tone feedback"><div class="labels" role="status" aria-live="polite"></div><button title="Jevibe Check settings" aria-label="Jevibe Check settings"><!-- @license lucide-static v1.46.0 - ISC -->
<svg aria-hidden="true"
  class="lucide lucide-settings"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
  <circle cx="12" cy="12" r="3" />
</svg></button></section>`;
    // Dock below the scrollable composer body, outside the avatar's text column.
    const boundary = editor.closest('[aria-modal="true"], [role="dialog"], [data-testid="composePostView"]');
    let anchor = editor.closest('.tiptap')?.parentElement || editor;
    let docked = false;
    if (boundary && boundary.querySelectorAll(selector).length === 1) {
      for (let parent = editor.parentElement; parent && parent !== boundary; parent = parent.parentElement) {
        if (['auto','scroll'].includes(getComputedStyle(parent).overflowY)) {anchor = parent; docked = true; break;}
      }
    }
    if (!docked) {
      for (let parent = editor.parentElement; parent && parent !== boundary && parent !== document.body; parent = parent.parentElement) {
        if (getComputedStyle(parent).flexDirection === 'row' && parent.querySelector('img, [role="img"]') && parent.querySelectorAll(selector).length === 1) {anchor = parent; break;}
      }
    }
    if (docked) host.style.cssText = 'display:none;width:100%;flex-shrink:0;box-sizing:border-box;padding:6px 16px;';
    anchor.insertAdjacentElement('afterend', host);
    shadow.querySelector('button').onclick = () => send({type: 'settings'});
    const labels = shadow.querySelector('.labels');
    let timer, version = 0, composing = false, lastText = null;
    const readText = () => (editor.value ?? editor.innerText ?? '').replace(/[\u200b\ufeff]/g, '').trim();
    const status = text => {host.style.display = 'block'; labels.replaceChildren(); const el = document.createElement('span'); el.className = 'status'; el.textContent = text; labels.append(el);};
    const cancel = () => {clearTimeout(timer); version++; void send({type: 'cancel', editor: id});};
    function changed() {
      cancel();
      const text = readText(); lastText = text;
      if (!text) {labels.replaceChildren(); host.style.display = 'none'; return;}
      status(composing ? 'Waiting for typing…' : 'Reading your draft…');
      if (composing) return;
      const current = version;
      timer = setTimeout(async () => {
        const result = await send({type: 'classify', editor: id, text});
        if (current !== version || !editor.isConnected || readText() !== text) return;
        if (!result?.labels) {status(result?.status || 'Unable to classify'); return;}
        labels.replaceChildren();
        for (const label of result.labels.filter(label => label.confidence >= .55)) {
          const chip = document.createElement('span'); chip.className = 'chip';
          chip.dataset.tone = ['Warm','Constructive','Calm','Clear','Supporting'].includes(label.label) ? 'good' : ['Cold','Heated','Hostile','Unconstructive','Sarcastic','Ambiguous'].includes(label.label) ? 'alert' : '';
          chip.title = `${label.name}: ${label.label}. Selected-label probability: ${Math.round(label.probability * 100)}%. Model confidence: ${Math.round(label.confidence * 100)}%. An estimate, not a verdict.`;
          chip.textContent = label.label;
          chip.setAttribute('aria-label', chip.title);
          chip.tabIndex = 0;
          labels.append(chip);
        }
        host.style.display = labels.childElementCount ? 'block' : 'none';
      }, 650);
    }
    const start = () => {composing = true; changed();};
    const end = () => {composing = false; changed();};
    editor.addEventListener('input', changed); editor.addEventListener('compositionstart', start); editor.addEventListener('compositionend', end);
    const detectChange = () => {if (!stopped && editor.isConnected && readText() !== lastText) changed();};
    const textObserver = new MutationObserver(detectChange);
    textObserver.observe(editor, {childList:true,subtree:true,characterData:true});
    const valuePoll = setInterval(detectChange,250);
    mounted.set(editor, () => {textObserver.disconnect(); clearInterval(valuePoll); cancel(); host.remove(); editor.removeEventListener('input', changed); editor.removeEventListener('compositionstart', start); editor.removeEventListener('compositionend', end);});
    changed();
  }
  function scan() {
    if (stopped) return;
    for (const [editor, cleanup] of mounted) if (!editor.isConnected || !editor.matches(selector)) {cleanup(); mounted.delete(editor);}
    for (const editor of document.querySelectorAll(selector)) if (!mounted.has(editor)) attach(editor);
  }
  domObserver = new MutationObserver(records => {
    const own = node => node.nodeType === 1 && node.matches('[data-darter], [data-darter-post], [data-darter-filter]');
    if (!stopped && !scanTimer && records.some(record => [...record.addedNodes,...record.removedNodes].some(node => !own(node)))) {
      scanTimer = setTimeout(() => {scanTimer = null; scan();}, 300);
    }
  });
  domObserver.observe(document.body, {childList: true, subtree: true});
  globalThis.chrome?.runtime?.onMessage?.addListener(message => {
    if (message.type === 'darter-settings-changed') void preferences();
  });
  await preferences();
})();
