import {test, expect} from '@playwright/test';
const fixture = '<div data-testid="composePostView"><div aria-modal="true"><p>Parent post goes here</p><div><div class="tiptap" contenteditable="true" role="textbox"></div></div><button>Reply</button></div></div>';
async function setup(page) {
  await page.route('https://bsky.app/**', route => route.fulfill({body: fixture, contentType: 'text/html'}));
  await page.goto('https://bsky.app/');
  await page.evaluate(() => {
    window.calls = [];
    window.preferences = {};
    window.chrome = {runtime: {onMessage:{addListener:fn=>window.settingsChanged=fn}, getURL: () => '', sendMessage: async msg => {
      if (msg.type === 'preferences') return window.preferences;
      if (msg.type !== 'classify') return {};
      window.calls.push(msg.text);
      await new Promise(r => setTimeout(r, msg.text === 'old text' ? 1100 : 10));
      return {labels: [{id:'warmth', name:'Warmth', label: msg.text === 'old text' ? 'Cold' : 'Warm', confidence:.8, probability:.9}]};
    }}};
  });
  await page.addScriptTag({path: 'extension/content.js'});
}
test('debounces input, adds one strip and never includes parent text', async ({page}) => {
  await setup(page);
  await page.getByRole('textbox').fill('hello');
  await page.getByRole('textbox').fill('thank you');
  await expect(page.locator('.chip')).toHaveText('Warm');
  expect(await page.evaluate(() => window.calls)).toEqual(['thank you']);
  await expect(page.locator('[data-darter]')).toHaveCount(1);
  await page.getByRole('textbox').fill('');
  await expect(page.locator('.labels')).toBeEmpty();
  await expect(page.locator('[data-darter]')).toBeHidden();
});
test('discards stale results and cleans up closed composers', async ({page}) => {
  await setup(page);
  await page.getByRole('textbox').fill('old text');
  await expect.poll(() => page.evaluate(() => window.calls.length)).toBe(1);
  await page.getByRole('textbox').fill('new text');
  await expect(page.locator('.chip')).toHaveText('Warm');
  await page.waitForTimeout(1200);
  await expect(page.locator('.chip')).toHaveText('Warm');
  await page.evaluate(() => document.querySelector('[data-testid]').remove());
  await expect(page.locator('[data-darter]')).toHaveCount(0);
});
test('ignores non-composer editors and supports new composers', async ({page}) => {
  await setup(page);
  await page.evaluate(() => {document.body.insertAdjacentHTML('beforeend', '<div contenteditable="true" id="other"></div>');});
  await expect(page.locator('[data-darter]')).toHaveCount(1);
  await page.evaluate(html => {document.querySelector('[data-testid]').remove(); document.body.insertAdjacentHTML('beforeend', html);}, fixture);
  await page.getByRole('textbox').fill('new reply');
  await expect(page.locator('.chip')).toHaveText('Warm');
  await expect(page.locator('[data-darter]')).toHaveCount(1);
});

test('clears labels when the app resets content without an input event', async ({page}) => {
  await setup(page);
  await page.getByRole('textbox').fill('a draft');
  await expect(page.locator('.chip')).toHaveText('Warm');
  await page.getByRole('textbox').evaluate(editor => editor.replaceChildren(document.createElement('p')));
  await expect(page.locator('.labels')).toBeEmpty();
  await expect(page.locator('[data-darter]')).toBeHidden();
});
test('docks labels outside the scroll body and avatar column', async ({page}) => {
  await page.route('https://bsky.app/**', r => r.fulfill({contentType:'text/html',body:'<div data-testid="composePostView"><div aria-modal="true"><div id="scroll" style="overflow-y:auto;height:220px"><div style="display:flex;flex-direction:row"><img alt="Avatar"><div style="flex:1"><div style="min-height:140px" class="tiptap" role="textbox" contenteditable="true"></div></div></div></div><div id="footer">Toolbar</div></div></div>'}));
  await page.goto('https://bsky.app');
  await page.evaluate(() => {window.chrome={runtime:{getURL:()=>'',sendMessage:async()=>({labels:[{name:'Warmth',label:'Warm',confidence:.9,probability:.95}]})}};});
  await page.addScriptTag({path:'extension/content.js'});
  await page.getByRole('textbox').fill('hello');
  await expect(page.locator('#scroll + [data-darter] + #footer')).toHaveCount(1);
  await expect(page.locator('.chip')).toHaveText('Warm');
});

test('composer disconnects without uncaught errors when runtime is invalidated',async({page})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await setup(page);await page.getByRole('textbox').fill('hello');await expect(page.locator('.chip')).toHaveText('Warm');
  await page.evaluate(()=>chrome.runtime.sendMessage=()=>{throw new Error('Extension context invalidated');});
  await page.getByRole('textbox').fill('new text');
  await expect(page.locator('[data-darter]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('composer settings clear feedback, resume and apply changed selectors immediately',async({page})=>{
  await setup(page);await page.getByRole('textbox').fill('Draft');await expect(page.locator('.chip')).toHaveText('Warm');
  for(const setting of ['enabled','allowed']) {
    await page.evaluate(setting=>{window.preferences={[setting]:false};window.settingsChanged({type:'darter-settings-changed'});},setting);
    await expect(page.locator('[data-darter]')).toHaveCount(0);
    await page.evaluate(()=>{window.preferences={enabled:true,allowed:true};window.settingsChanged({type:'darter-settings-changed'});});
    await expect(page.locator('.chip')).toHaveText('Warm');
  }
  await page.evaluate(()=>{
    document.body.insertAdjacentHTML('beforeend','<div id="alternate" contenteditable="true">Another draft</div>');
    window.preferences={site:{composerSelector:'#alternate'}};window.settingsChanged({type:'darter-settings-changed'});
  });
  await expect(page.locator('#alternate + [data-darter] .chip')).toHaveText('Warm');
  await expect(page.locator('[data-testid="composePostView"] [data-darter]')).toHaveCount(0);
  await page.evaluate(()=>{window.preferences={site:{composerSelector:'['}};window.settingsChanged({type:'darter-settings-changed'});});
  await expect(page.locator('[data-darter]')).toHaveCount(0);
  await page.evaluate(()=>{window.preferences={};window.settingsChanged({type:'darter-settings-changed'});});
  await expect(page.locator('[data-testid="composePostView"] .chip')).toHaveText('Warm');
});
