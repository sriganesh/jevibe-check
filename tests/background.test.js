import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installScheduling} from './browser-scheduling.js';
import {SITE_SYNC_ALARM} from '../extension/sites.js';
const deferred = () => {let resolve; const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const tick = () => new Promise(resolve=>setImmediate(resolve));
async function setup({accessReady=Promise.resolve(),initialGetHook}={}) {
  const listeners={}, sent=[], fetched=[], removed=[];
  const data={apiKey:'test-only-fake-key',sites:[{origin:'https://example.com',postSelector:'',composerSelector:''}]};
  let getHook=initialGetHook, setHook, unregisterHook, permission=true;
  let scripts=[{id:'darter_68747470733a2f2f6578616d706c652e636f6d'}];
  const event=name=>({addListener:fn=>listeners[name]=fn});
  globalThis.chrome={
    runtime:{id:'test',getURL:path=>`chrome-extension://test/${path}`,onInstalled:event('installed'),onStartup:event('startup'),onMessage:event('message'),openOptionsPage:async()=>{}},
    storage:{onChanged:event('storage'),local:{setAccessLevel:()=>accessReady,get:async keys=>{
      await getHook?.(keys);
      if(typeof keys==='string')return {[keys]:data[keys]};
      return {...structuredClone(keys),...Object.fromEntries(Object.keys(keys).filter(key=>key in data).map(key=>[key,structuredClone(data[key])]))};
    },set:async value=>{await setHook?.(value);Object.assign(data,structuredClone(value));}}},
    permissions:{onRemoved:event('permissions'),contains:async()=>permission},
    tabs:{query:async()=>[{id:1}],sendMessage:async(id,msg)=>sent.push({id,msg})},
    action:{onClicked:event('action')},
    scripting:{getRegisteredContentScripts:async()=>scripts,unregisterContentScripts:async value=>{await unregisterHook?.();removed.push(value);scripts=scripts.filter(script=>!value.ids.includes(script.id));},updateContentScripts:async()=>{},registerContentScripts:async()=>{}}
  };
  const scheduling=installScheduling(chrome);
  globalThis.fetch=async(_url,options)=>{
    fetched.push(options);
    const request=JSON.parse(options.body),answers={};
    for(const [id,q] of Object.entries(request.questions)){const choice=Object.keys(q.criteria)[0];answers[id]={type:'choice',choice,confidence:.9,probabilities:{[choice]:.95}};}
    return new Response(JSON.stringify({answers,usage:{input_tokens:10,output_tokens:1}}));
  };
  const reload=async()=>{await import(`../extension/background.js?test=${crypto.randomUUID()}`);await tick();};
  await reload();
  const send=(msg,url='https://bsky.app/')=>new Promise(resolve=>listeners.message(msg,{id:'test',tab:{id:1},frameId:0,url},resolve));
  return {...scheduling,reload,listeners,data,sent,fetched,removed,send,setUnregisterHook:fn=>unregisterHook=fn,setGetHook:fn=>getHook=fn,setSetHook:fn=>setHook=fn,revoke:()=>{permission=false;return listeners.permissions({origins:['https://example.com/*']});}};
}
test('cancel during settings read prevents unpublished draft transmission',async()=>{
  const h=await setup(),entered=deferred(),release=deferred();
  h.setGetHook(async keys=>{if(keys.apiKey===''){entered.resolve();await release.promise;}});
  const response=h.send({type:'classify',editor:'a',text:'private draft'});
  await entered.promise;await h.send({type:'cancel',editor:'a'});release.resolve();
  assert.match((await response).status,/canceled/);assert.equal(h.fetched.length,0);
});
test('cancel during authorization prevents added-site transmission',async()=>{
  const h=await setup(),entered=deferred(),release=deferred();
  h.setGetHook(async keys=>{if(keys.sites && !('apiKey' in keys)){entered.resolve();await release.promise;}});
  const response=h.send({type:'classify',editor:'a',text:'private draft'},'https://example.com/');
  await entered.promise;await h.send({type:'cancel',editor:'a'},'https://example.com/');release.resolve();
  assert.match((await response).status,/canceled/);assert.equal(h.fetched.length,0);
});
test('cancel while recording an attempt still prevents network transmission',async()=>{
  const h=await setup(),entered=deferred(),release=deferred();
  h.setSetHook(async value=>{if(value.usageStats?.requests===1 && !value.usageStats.canceled){entered.resolve();await release.promise;}});
  const response=h.send({type:'classify',editor:'a',text:'private draft'});
  await entered.promise;await h.send({type:'cancel',editor:'a'});release.resolve();
  assert.match((await response).status,/canceled/);assert.equal(h.fetched.length,0);assert.equal(h.data.usageStats.canceled,1);
});
test('permission revocation aborts pending work and notifies injected tabs',async()=>{
  const h=await setup(),entered=deferred(),release=deferred();
  h.setGetHook(async keys=>{if(keys.apiKey===''){entered.resolve();await release.promise;}});
  const response=h.send({type:'classify',editor:'a',text:'private draft'},'https://example.com/');
  await entered.promise;h.revoke();await tick();release.resolve();
  assert.match((await response).status,/canceled/);assert.equal(h.fetched.length,0);
  assert.deepEqual(h.sent,[{id:1,msg:{type:'darter-settings-changed'}}]);
  assert.equal(h.removed.length,1);
  assert.equal((await h.send({type:'preferences'},'https://example.com/')).allowed,false);
});

test('cancellation interrupts readiness before authorization or settings reads',async()=>{
  for (const url of ['https://example.com/','https://bsky.app/']) {
    const release=deferred(),h=await setup({accessReady:release.promise});
    let siteReads=0,settingsReads=0,responded=false;
    h.setGetHook(keys=>{if(keys.sites)siteReads++;if('apiKey' in keys)settingsReads++;});
    const response=h.send({type:'classify',editor:'a',text:'private draft'},url).then(value=>{responded=true;return value;});
    await tick();
    await h.send({type:'cancel',editor:'a'},url);
    await tick();
    try {
      assert.equal(responded,true,'Cancellation must respond while readiness is still blocked');
      assert.match((await response).status,/canceled/);
      assert.equal(siteReads,0);assert.equal(settingsReads,0);assert.equal(h.fetched.length,0);
    } finally {release.resolve();await tick();}
    assert.equal(siteReads,1,'Only worker-start reconciliation may read sites after readiness');
    assert.equal(settingsReads,0);assert.equal(h.fetched.length,0);
  }
});
test('superseding a classification during readiness cancels only the old request',async()=>{
  const release=deferred(),h=await setup({accessReady:release.promise});
  const old=h.send({type:'classify',editor:'a',text:'old draft'},'https://example.com/');
  const latest=h.send({type:'classify',editor:'a',text:'new draft'},'https://example.com/');
  await tick();
  release.resolve();
  assert.match((await old).status,/canceled/);
  assert.ok((await latest).labels.length);assert.equal(h.fetched.length,1);
  assert.match(h.fetched[0].body,/new draft/);
});
test('failed permission cleanup retries on an alarm and keeps authorization denied',async()=>{
  const h=await setup();
  h.setUnregisterHook(()=>{throw new Error('Temporary unregister failure');});
  await h.revoke();
  assert.equal(h.removed.length,0);assert.equal(h.alarms.has(SITE_SYNC_ALARM),true);
  assert.equal((await h.send({type:'preferences'},'https://example.com/')).allowed,false);
  h.setUnregisterHook(undefined);
  await h.fire(SITE_SYNC_ALARM);
  assert.equal(h.removed.length,1);assert.equal(h.alarms.has(SITE_SYNC_ALARM),false);
  assert.equal(h.data.sites.length,1,'Chrome revocation must preserve saved settings');
});
test('worker restart resumes failed cleanup even when Chrome loses the alarm',async()=>{
  const h=await setup();
  h.setUnregisterHook(()=>{throw new Error('Persistent unregister failure');});
  await h.revoke();
  h.alarms.clear();
  await h.reload();
  assert.equal(h.alarms.has(SITE_SYNC_ALARM),true);assert.equal(h.removed.length,0);
  h.setUnregisterHook(undefined);
  h.alarms.clear();
  await h.reload();
  assert.equal(h.removed.length,1);assert.equal(h.alarms.has(SITE_SYNC_ALARM),false);
});
test('failed settings migration does not block permission cleanup or alarm retries',async()=>{
  let fail=true;
  const h=await setup({initialGetHook:keys=>{
    if(fail && Object.keys(keys).length===1 && 'filterRules' in keys){fail=false;throw new Error('Transient migration read failure');}
  }});
  h.setUnregisterHook(()=>{throw new Error('Temporary unregister failure');});
  await h.revoke();
  assert.equal(h.alarms.has(SITE_SYNC_ALARM),true);assert.equal(h.removed.length,0);
  h.setUnregisterHook(undefined);
  await h.fire(SITE_SYNC_ALARM);
  assert.equal(h.removed.length,1);assert.equal(h.alarms.has(SITE_SYNC_ALARM),false);
  const response=await h.send({type:'classify',editor:'a',text:'draft'});
  assert.match(response.status,/Could not classify/);assert.equal(h.fetched.length,0);
});
