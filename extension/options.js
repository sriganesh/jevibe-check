import {initFilters, readFilters} from './filter-settings.js';
import {CLASSIFIERS, DEFAULTS, validateCustom, classifierCatalog} from './classifiers.js';
const form = document.querySelector('form');
const status = document.querySelector('#status');
const key = document.querySelector('#apiKey');
for (const [id, item] of Object.entries(CLASSIFIERS)) {
  const label = document.createElement('label'); label.className = 'card';
  const input = document.createElement('input'); input.type = 'checkbox'; input.name = 'classifier'; input.value = id;
  const text = document.createElement('span'); const name = document.createElement('strong'); name.textContent = item.name;
  const description = document.createElement('small'); description.textContent = item.description;
  text.append(name, description); label.append(input, text); document.querySelector('#classifiers').append(label);
}
function addCustom(item = {id: `custom_${crypto.randomUUID()}`, name: '', question: '', labels: [], enabled: true}) {
  const fieldset = document.createElement('fieldset'); fieldset.className = 'custom'; fieldset.dataset.id = item.id;
  fieldset.innerHTML = `<div class="custom-top"><label><input type="checkbox" class="custom-enabled"> Enabled</label><button type="button" class="remove">Remove</button></div><label>Name<input type="text" class="custom-name" maxlength="40" placeholder="Humor"></label><label>Question<textarea class="custom-question" maxlength="600" rows="2" placeholder="What kind of humor does this post use?"></textarea></label><label>Possible labels<textarea class="custom-labels" rows="4" placeholder="Dry humor&#10;Wordplay&#10;Absurdist&#10;Not humorous"></textarea></label><p class="small">One label per line. Include an option for posts that don't fit.</p>`;
  fieldset.querySelector('.custom-enabled').checked = item.enabled;
  fieldset.querySelector('.custom-name').value = item.name;
  fieldset.querySelector('.custom-question').value = item.question;
  fieldset.querySelector('.custom-labels').value = item.labels.join('\n');
  fieldset.querySelector('.remove').onclick = () => {fieldset.remove(); status.textContent = 'Save to apply changes.';};
  document.querySelector('#custom-classifiers').append(fieldset);
  return fieldset;
}
document.querySelector('#add-custom').onclick = () => {
  if (document.querySelectorAll('.custom').length >= 12) {status.textContent = 'Use up to 12 custom classifiers.'; return;}
  addCustom().querySelector('.custom-name').focus();
};
function customFromForm() {return validateCustom([...document.querySelectorAll('.custom')].map(row => ({id:row.dataset.id, name:row.querySelector('.custom-name').value, question:row.querySelector('.custom-question').value, labels:row.querySelector('.custom-labels').value.split('\n').map(label => label.trim()).filter(Boolean), enabled:row.querySelector('.custom-enabled').checked})));}
try {
  await chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
  const settings = await chrome.storage.local.get({...DEFAULTS, apiKey: ''});
  for (const item of settings.customClassifiers) addCustom(item);
  initFilters(settings, () => classifierCatalog(customFromForm()));
  key.value = settings.apiKey;
  document.querySelector('#viewedPosts').checked = settings.viewedPosts;
  document.querySelector('#enabled').checked = settings.enabled;
  for (const input of document.querySelectorAll('[name=classifier]')) input.checked = settings.classifiers.includes(input.value);
} catch {status.textContent = 'Open this page from the installed Chrome extension.';}
document.querySelector('#show').onclick = event => {key.type = key.type === 'password' ? 'text' : 'password'; event.target.textContent = key.type === 'password' ? 'Show' : 'Hide';};
form.onsubmit = async event => {
  event.preventDefault();
  const classifiers = [...document.querySelectorAll('[name=classifier]:checked')].map(input => input.value);
  let customClassifiers, filters;
  try {
    customClassifiers = customFromForm(); filters = readFilters();
  } catch (error) {status.textContent = error.message; return;}
  try {
    await chrome.storage.local.set({...filters, customClassifiers, viewedPosts: document.querySelector('#viewedPosts').checked, apiKey: key.value.trim(), enabled: document.querySelector('#enabled').checked, classifiers});
    status.textContent = 'Saved.';
  } catch {status.textContent = 'Could not save settings. Please try again.';}
};
