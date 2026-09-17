import {test, expect} from '@playwright/test';
async function setup(page, beforeScript) {
  await page.route('https://bsky.app/**', r=>r.fulfill({contentType:'text/html',body:`<body><div data-testid="feedItem-by-a"><div data-testid="postText">First post</div></div><div data-testid="postThreadItem-by-b"><div data-word-wrap="1">Reply text <a data-word-wrap="1">link</a></div></div><div style="height:1600px"></div><div data-testid="feedItem-by-c"><div data-testid="postText">Offscreen post</div></div></body>`}));
  await page.goto('https://bsky.app');
  await page.evaluate(()=>{
    window.calls=[]; window.enabled=true;
    window.chrome={runtime:{onMessage:{addListener:fn=>window.changed=fn},sendMessage:async m=>{
      if(m.type==='preferences')return {viewedPosts:window.enabled,ready:true};
      if(m.type!=='classify')return {};
      window.calls.push(m);
      return {labels:[{name:'Warmth',label:'Warm',confidence:.9,probability:.95}]};
    }}};
  });
  if (beforeScript) await beforeScript(page);
  await page.addScriptTag({path:'extension/posts.js'});
}
test('labels feed and thread text only when visible, then handles scrolling',async({page})=>{
  await setup(page);
  await expect(page.locator('[data-darter-post]')).toHaveCount(2);
  expect(await page.evaluate(()=>window.calls.map(c=>c.text))).toEqual(['First post','Reply text link']);
  await page.getByText('Offscreen post',{exact:true}).scrollIntoViewIfNeeded();
  await expect(page.locator('[data-darter-post]')).toHaveCount(3);
  expect(await page.evaluate(()=>window.calls.length)).toBe(3);
});
test('caches duplicates, updates recycled posts and removes labels when disabled',async({page})=>{
  await setup(page);
  await expect(page.locator('[data-darter-post]')).toHaveCount(2);
  await page.evaluate(()=>{
    const copy=document.createElement('div');copy.dataset.testid='feedItem-by-copy';copy.innerHTML='<div data-testid="postText">First post</div>';document.body.prepend(copy);
  });
  await expect(page.locator('[data-darter-post]')).toHaveCount(3);
  expect(await page.evaluate(()=>window.calls.length)).toBe(2);
  await page.evaluate(()=>document.querySelector('[data-testid="postText"]').textContent='Changed post');
  await expect.poll(()=>page.evaluate(()=>window.calls.length)).toBe(3);
  await expect(page.locator('[data-darter-post]')).toHaveCount(3);
  await page.evaluate(()=>{window.enabled=false;window.changed({type:'darter-settings-changed'});});
  await expect(page.locator('[data-darter-post]')).toHaveCount(0);
});

test('labels search results that have postText but no feed wrapper',async({page})=>{
  await setup(page);
  await page.evaluate(()=>document.body.insertAdjacentHTML('afterbegin','<div class="search-result"><div data-testid="postText">Search result text</div></div>'));
  await expect.poll(()=>page.evaluate(()=>window.calls.some(call=>call.text==='Search result text'))).toBe(true);
  await expect(page.locator('.search-result [data-darter-post]')).toHaveCount(1);
});
test('uses custom site post selectors without collecting other page text',async({page})=>{
  await setup(page);
  await page.evaluate(()=>{
    const original=chrome.runtime.sendMessage;
    chrome.runtime.sendMessage=async m=>m.type==='preferences'?{viewedPosts:true,ready:true,site:{postSelector:'article .body-text'}}:original(m);
    document.body.insertAdjacentHTML('afterbegin','<article><h2>Not post text</h2><div class="body-text">Custom site post</div></article>');
    window.changed({type:'darter-settings-changed'});
  });
  await expect(page.locator('article [data-darter-post]')).toHaveCount(1);
  expect(await page.evaluate(()=>window.calls.at(-1).text)).toBe('Custom site post');
});

test('stops cleanly if the extension runtime disappears',async({page})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await setup(page);
  await expect(page.locator('[data-darter-post]')).toHaveCount(2);
  await page.evaluate(()=>{chrome.runtime=undefined;document.body.insertAdjacentHTML('afterbegin','<div data-testid="postText">A new post</div>');});
  await expect(page.locator('[data-darter-post]')).toHaveCount(0);
  expect(errors).toEqual([]);
});
test('filter changes restore posts and clear applied rules',async({page})=>{
  await setup(page);
  await page.addScriptTag({path:'extension/filters.js'});
  await page.evaluate(()=>{
    const original=chrome.runtime.sendMessage;
    chrome.runtime.sendMessage=async m=>m.type==='preferences'?{viewedPosts:true,ready:true,filtersEnabled:true,filterRules:[{classifier:'warmth',label:'Warm',action:'hide',confidence:.85}]}:m.type==='classify'?{labels:[{id:'warmth',name:'Warmth',label:'Warm',confidence:.9,probability:.95}]}:original(m);
    window.changed({type:'darter-settings-changed'});
  });
  await expect(page.locator('[data-darter-filter]')).toHaveCount(2);
  await expect(page.locator('[data-testid="feedItem-by-a"]')).toBeHidden();
  await page.evaluate(()=>{
    chrome.runtime.sendMessage=async()=>({viewedPosts:false,ready:true});window.changed({type:'darter-settings-changed'});
  });
  await expect(page.locator('[data-darter-filter]')).toHaveCount(0);
  await expect(page.locator('[data-testid="feedItem-by-a"]')).toBeVisible();
});

test('a changed or removed post during a pending response never starves the event loop',async({page})=>{
  await setup(page);
  await page.evaluate(()=>{
    window.pending=[];
    const original=chrome.runtime.sendMessage;
    chrome.runtime.sendMessage=async message=>message.type==='classify'?new Promise(resolve=>window.pending.push({message,resolve})):original(message);
  });
  await expect.poll(()=>page.evaluate(()=>window.pending.length)).toBe(2);
  await page.evaluate(()=>{
    document.querySelector('[data-testid="feedItem-by-a"] [data-testid="postText"]').textContent='Recycled post';
    document.querySelector('[data-testid="postThreadItem-by-b"]').remove();
    chrome.runtime.sendMessage=async message=>message.type==='preferences'?{viewedPosts:true,ready:true}:{labels:[{id:'warmth',name:'Warmth',label:'Warm',confidence:.9,probability:.95}]};
    for(const item of window.pending)item.resolve({labels:[{id:'warmth',name:'Warmth',label:'Warm',confidence:.9,probability:.95}]});
    setTimeout(()=>window.heartbeat=true,0);
  });
  await expect.poll(()=>page.evaluate(()=>window.heartbeat)).toBe(true);
  await expect(page.locator('[data-testid="feedItem-by-a"] [data-darter-post]')).toHaveCount(1);
  await expect(page.locator('[data-darter-post]')).toHaveCount(1);
});

test('frequent page mutations are batched and annotations do not trigger scan loops',async({page})=>{
  await setup(page);
  await expect(page.locator('[data-darter-post]')).toHaveCount(2);
  await page.evaluate(()=>{
    window.scanQueries=0;
    const original=document.querySelectorAll.bind(document);
    document.querySelectorAll=selector=>{if(selector.includes('feedItem-by-'))window.scanQueries++;return original(selector);};
    const ticker=document.createElement('p');document.body.append(ticker);
    let ticks=0;
    const timer=setInterval(()=>{ticker.textContent=String(++ticks);if(ticks===100){clearInterval(timer);window.floodDone=true;}},5);
  });
  await expect.poll(()=>page.evaluate(()=>window.floodDone)).toBe(true);
  await page.waitForTimeout(400);
  expect(await page.evaluate(()=>window.scanQueries)).toBeLessThanOrEqual(5);
  expect(await page.evaluate(()=>window.calls.length)).toBe(2);
});

test('invalid stored selectors clear labels without repeated errors and recover when corrected',async({page})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await setup(page);
  await expect(page.locator('[data-darter-post]')).toHaveCount(2);
  await page.evaluate(()=>{
    const original=chrome.runtime.sendMessage;
    window.savedSelector='[';
    chrome.runtime.sendMessage=async m=>m.type==='preferences'?{viewedPosts:true,ready:true,site:{postSelector:window.savedSelector}}:original(m);
    window.changed({type:'darter-settings-changed'});
  });
  await expect(page.locator('[data-darter-post]')).toHaveCount(0);
  await page.evaluate(()=>document.body.insertAdjacentHTML('afterbegin','<p>Unrelated mutation</p>'));
  await page.waitForTimeout(400);
  expect(errors).toEqual([]);
  await page.evaluate(()=>{window.savedSelector='';window.changed({type:'darter-settings-changed'});});
  await expect(page.locator('[data-darter-post]')).toHaveCount(2);
  expect(errors).toEqual([]);
});

test('custom feed navigation discovers new posts without reinjecting scripts',async({page})=>{
  await setup(page);await expect(page.locator('[data-darter-post]')).toHaveCount(2);
  await page.evaluate(()=>{
    history.pushState({},'', '/profile/example.test/feed/test');
    document.body.innerHTML='<main data-testid="customFeedScreen"><div data-testid="feedItem-by-example.com"><div data-testid="contentHider-post"><div data-testid="postText" data-word-wrap="1">A custom feed post</div></div></div></main>';
  });
  await expect(page.locator('[data-testid="customFeedScreen"] .labels')).toHaveText('Warm');
  expect(await page.evaluate(()=>window.calls.at(-1).text)).toBe('A custom feed post');
});

for (const failure of ['rejection', 'error response']) {
  test(`recovers from a temporary preferences ${failure} without a refresh`,async({page})=>{
    await setup(page,async()=>page.evaluate(failure=>{
      const original=chrome.runtime.sendMessage;window.preferenceCalls=0;
      chrome.runtime.sendMessage=async message=>{
        if(message.type==='preferences' && ++window.preferenceCalls===1) {
          if(failure==='rejection')throw new Error('Could not establish connection. Receiving end does not exist.');
          return {status:'Could not load settings'};
        }
        return original(message);
      };
    },failure));
    await expect(page.locator('[data-darter-post]')).toHaveCount(2);
    expect(await page.evaluate(()=>window.preferenceCalls)).toBe(2);
  });
}
test('restores labels removed by a page redraw without another API request',async({page})=>{
  await setup(page);await expect(page.locator('[data-darter-post]')).toHaveCount(2);
  await page.evaluate(()=>document.querySelector('[data-darter-post]').remove());
  await expect(page.locator('[data-darter-post]')).toHaveCount(2);
  expect(await page.evaluate(()=>window.calls.length)).toBe(2);
});
test('temporary classification messaging failure retries without stopping the feed',async({page})=>{
  await setup(page,async()=>page.evaluate(()=>{
    const original=chrome.runtime.sendMessage;let failed=false;
    chrome.runtime.sendMessage=async message=>{
      if(message.type==='classify' && !failed){failed=true;throw new Error('The message port closed before a response was received.');}
      return original(message);
    };
  }));
  await expect(page.locator('[data-darter-post]')).toHaveCount(2);
  expect(await page.evaluate(()=>window.calls.length)).toBe(2);
});
test('a disabled setting cancels a scheduled preferences retry',async({page})=>{
  await setup(page,async()=>page.evaluate(()=>{
    const original=chrome.runtime.sendMessage;window.preferenceCalls=0;
    chrome.runtime.sendMessage=async message=>{
      if(message.type==='preferences' && ++window.preferenceCalls===1)return {status:'Unavailable'};
      return original(message);
    };
  }));
  await page.evaluate(()=>{window.enabled=false;window.changed({type:'darter-settings-changed'});});
  await page.waitForTimeout(1200);
  expect(await page.evaluate(()=>window.preferenceCalls)).toBe(2);
  await expect(page.locator('[data-darter-post]')).toHaveCount(0);
});
test('failed preferences recover when a background tab becomes visible',async({page})=>{
  await setup(page,async()=>page.evaluate(()=>{
    window.testVisibility='hidden';Object.defineProperty(document,'visibilityState',{get:()=>window.testVisibility});
    const original=chrome.runtime.sendMessage;window.preferenceCalls=0;
    chrome.runtime.sendMessage=async message=>{
      if(message.type==='preferences' && ++window.preferenceCalls===1)return {status:'Unavailable'};
      return original(message);
    };
  }));
  await expect(page.locator('[data-darter-post]')).toHaveCount(0);
  await page.evaluate(()=>{window.testVisibility='visible';document.dispatchEvent(new Event('visibilitychange'));});
  await expect(page.locator('[data-darter-post]')).toHaveCount(2);
  expect(await page.evaluate(()=>window.preferenceCalls)).toBe(2);
});
test('API error responses keep their cooldown instead of rapid transport retries',async({page})=>{
  await setup(page,async()=>page.evaluate(()=>{
    const original=chrome.runtime.sendMessage;window.attempts=0;
    chrome.runtime.sendMessage=async message=>{
      if(message.type==='classify'){window.attempts++;return {status:'TypeSafe is busy. Try again in 30 seconds.'};}
      return original(message);
    };
  }));
  await expect.poll(()=>page.evaluate(()=>window.attempts)).toBe(2);
  await page.waitForTimeout(1200);
  expect(await page.evaluate(()=>window.attempts)).toBe(2);
  await expect(page.locator('[data-darter-post]')).toHaveCount(0);
});
test('an invalidated extension context still stops all retries',async({page})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await setup(page,async()=>page.evaluate(()=>{
    window.attempts=0;
    chrome.runtime.sendMessage=async()=>{window.attempts++;throw new Error('Extension context invalidated.');};
  }));
  await page.waitForTimeout(1200);
  expect(await page.evaluate(()=>window.attempts)).toBe(1);
  expect(errors).toEqual([]);
});
