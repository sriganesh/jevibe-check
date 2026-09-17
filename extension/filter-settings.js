import './filters.js';
let getCatalog;
const list = document.querySelector('#filter-rules');
const status = document.querySelector('#status');
function addRule(rule = {classifier:'tension',label:'Hostile',action:'blur',confidence:.85}) {
  rule = DarterFilters.normalizeRule(rule);
  let catalog;
  try {catalog = getCatalog();} catch(error) {status.textContent=error.message;return;}
  if (list.children.length >= 20) {status.textContent='Use up to 20 filter rules.';return;}
  const row = document.createElement('div'); row.className='filter-rule';
  row.innerHTML = '<div class="rule-fields"><label>Classifier<select class="rule-classifier"></select></label><label>Label<select class="rule-label"></select></label><label>Action<select class="rule-action"><option value="blur">Blur</option><option value="hide">Collapse</option></select></label><label>Min. confidence<select class="rule-confidence"><option value="0.55">55%</option><option value="0.7">70%</option><option value="0.85">85%</option><option value="0.95">95%</option><option value="0.99">99%</option></select></label></div><button type="button" class="remove">Remove rule</button>';
  const classifier = row.querySelector('.rule-classifier'), label = row.querySelector('.rule-label');
  for (const [id,item] of Object.entries(catalog)) classifier.add(new Option(item.name,id));
  if (!Object.hasOwn(catalog,rule.classifier)) classifier.add(new Option('Missing classifier',rule.classifier));
  classifier.value=rule.classifier;
  const labels = () => {label.replaceChildren();for(const value of Object.keys(catalog[classifier.value]?.options || {})) label.add(new Option(value,value));};
  labels();
  if (![...label.options].some(option=>option.value===rule.label)) label.add(new Option(`${rule.label} (missing)`,rule.label));
  label.value=rule.label;
  classifier.onchange=labels;
  row.querySelector('.rule-action').value=rule.action;
  const confidence=row.querySelector('.rule-confidence');
  if (![...confidence.options].some(option=>Number(option.value)===rule.confidence)) confidence.add(new Option(`${Math.round(rule.confidence*100)}%`,String(rule.confidence)));
  confidence.value=String(rule.confidence);
  row.querySelector('.remove').onclick=()=>row.remove();list.append(row);
}
export function initFilters(settings, catalog) {
  getCatalog=catalog;
  document.querySelector('#filters-enabled').checked=settings.filtersEnabled;
  for(const rule of settings.filterRules) addRule(rule);
  document.querySelector('#add-filter').onclick=()=>addRule();
}
export function readFilters() {
  return {filtersEnabled:document.querySelector('#filters-enabled').checked,filterRules:DarterFilters.validate([...list.children].map(row=>({classifier:row.querySelector('.rule-classifier').value,label:row.querySelector('.rule-label').value,action:row.querySelector('.rule-action').value,confidence:Number(row.querySelector('.rule-confidence').value)})),getCatalog())};
}
