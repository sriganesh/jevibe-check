// Plain script shared by content scripts, and imported for tests/settings.
globalThis.DarterFilters = {
  normalizeRule(rule) {return {...rule, action:rule.action === 'spoiler' ? 'hide' : rule.action};},
  validate(rules, catalog) {
    if (!Array.isArray(rules) || rules.length > 20) throw new Error('Use up to 20 filter rules.');
    return rules.map(saved => {
      const rule = this.normalizeRule(saved);
      if (!rule || !Object.hasOwn(catalog, rule.classifier) || !Object.hasOwn(catalog[rule.classifier].options, rule.label)) throw new Error('A filter uses a missing classifier or label. Update or remove that rule.');
      if (!['blur','hide'].includes(rule.action) || !Number.isFinite(rule.confidence) || rule.confidence < .55 || rule.confidence > 1) throw new Error('Choose a filter action and confidence between 55% and 100%.');
      return {classifier:rule.classifier,label:rule.label,action:rule.action,confidence:rule.confidence};
    });
  },
  match(labels, rules) {
    return rules.find(rule => labels.some(label => label.id === rule.classifier && label.label === rule.label && label.confidence >= Math.max(.55,rule.confidence)));
  },
  apply(target, rule, name) {
    rule = this.normalizeRule(rule);
    const host = document.createElement('div'); host.dataset.darterFilter = '';
    host.style.cssText = 'display:block;margin:8px 0;width:100%;box-sizing:border-box;';
    host.style.colorScheme = getComputedStyle(target).colorScheme;
    const shadow = host.attachShadow({mode:'open'});
    shadow.innerHTML = `<style>.row{display:flex;align-items:center;gap:12px;justify-content:space-between;font:12px/1.5 system-ui,sans-serif;color:light-dark(#526273,#a8b7c8);border:1px solid light-dark(#d5dde5,#344151);border-radius:6px;padding:8px 10px}button{font:inherit;color:light-dark(#1767b1,#83beff);border:0;background:none;cursor:pointer;padding:3px 6px;white-space:nowrap}button:focus-visible{outline:2px solid #168bff}</style><div class="row"><span></span><button type="button">Reveal</button></div>`;
    const properties = ['filter','pointer-events','user-select','visibility','display'];
    const original = properties.map(property => [property,target.style.getPropertyValue(property),target.style.getPropertyPriority(property)]);
    const inert = target.inert, ariaHidden = target.getAttribute('aria-hidden');
    let concealed = false;
    function restore() {
      for (const [property,value,priority] of original) {if (value) target.style.setProperty(property,value,priority); else target.style.removeProperty(property);}
      target.inert = inert;
      if (ariaHidden === null) target.removeAttribute('aria-hidden'); else target.setAttribute('aria-hidden',ariaHidden);
    }
    function update() {
      concealed = !concealed;
      restore();
      if (concealed) {
        target.inert = true; target.setAttribute('aria-hidden','true');
        if (rule.action === 'hide') target.style.setProperty('display','none','important');
        else {target.style.setProperty('filter','blur(7px)','important'); target.style.setProperty('pointer-events','none','important'); target.style.setProperty('user-select','none','important');}
      }
      shadow.querySelector('span').textContent = `${concealed ? ({blur:'Blurred',hide:'Collapsed'}[rule.action]) : 'Revealed'} · ${name}: ${rule.label}`;
      shadow.querySelector('button').textContent = concealed ? 'Reveal' : 'Conceal again';
      shadow.querySelector('button').setAttribute('aria-expanded',String(!concealed));
    }
    host.addEventListener('click',event => event.stopPropagation());
    shadow.querySelector('button').onclick = update;
    target.insertAdjacentElement('beforebegin',host); update();
    return () => {restore(); host.remove();};
  }
};
