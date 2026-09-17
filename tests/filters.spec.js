import {test,expect} from '@playwright/test';
test('filters match exact classifier and confidence, and restore content',async({page})=>{
  await page.setContent('<article style="filter:contrast(1.1)"><p>Example post</p><a href="#">Link</a></article>');
  await page.addScriptTag({path:'extension/filters.js'});
  const match=await page.evaluate(()=>{
    const rule={classifier:'tension',label:'Hostile',action:'blur',confidence:.85};
    return [DarterFilters.match([{id:'tension',label:'Hostile',confidence:.7}],[rule]),DarterFilters.match([{id:'custom_rude',label:'Hostile',confidence:.99}],[rule]),DarterFilters.match([{id:'tension',label:'Hostile',confidence:.9}],[rule])];
  });
  expect(match[0]).toBeUndefined();expect(match[1]).toBeUndefined();expect(match[2].action).toBe('blur');
  for(const action of ['blur','hide','spoiler']) {
    await page.evaluate(action=>window.restoreFilter=DarterFilters.apply(document.querySelector('article'),{label:'Hostile',action},'Tension'),action);
    if (action === 'spoiler') {
      await expect(page.locator('article')).toBeHidden();
      await expect(page.locator('[data-darter-filter]')).toContainText('Collapsed');
    }
    await expect(page.locator('article')).toHaveAttribute('inert','');
    await expect(page.getByRole('button',{name:'Reveal',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Reveal',exact:true}).click();
    await expect(page.locator('article')).not.toHaveAttribute('inert','');
    await expect(page.getByText('Example post')).toBeVisible();
    await page.getByRole('button',{name:'Conceal again'}).click();
    await page.evaluate(()=>window.restoreFilter());
    await expect(page.locator('[data-darter-filter]')).toHaveCount(0);
    expect(await page.locator('article').evaluate(e=>e.style.filter)).toBe('contrast(1.1)');
  }
});
