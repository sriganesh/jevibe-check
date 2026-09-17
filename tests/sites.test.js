import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installScheduling} from './browser-scheduling.js';
import {normalizeOrigin, sitePattern, siteScriptId, syncSites, defaultSite} from '../extension/sites.js';
test('normalizes domain scope and rejects paths and non-HTTPS URLs',()=>{
  assert.equal(normalizeOrigin('mu.social'), 'https://mu.social');
  assert.equal(sitePattern(normalizeOrigin('https://witchsky.app/')), 'https://witchsky.app/*');
  for(const value of ['http://mu.social','https://mu.social/feed','https://user:pass@mu.social','https://mu.social:8443']) assert.throws(()=>normalizeOrigin(value));
  assert.notEqual(siteScriptId('https://a-b.com'),siteScriptId('https://a.b.com'));
  assert.match(defaultSite('https://reddwarf.app').composerSelector,/textarea/);
});
test('registers only saved, granted domains and unregisters removed sites',async()=>{
  let scripts=[{id:siteScriptId('https://removed.example')}];
  globalThis.chrome={storage:{local:{get:async()=>({sites:[{origin:'https://mu.social'},{origin:'https://denied.example'}]})}},permissions:{contains:async({origins})=>origins[0]==='https://mu.social/*'},scripting:{updateContentScripts:async()=>{},getRegisteredContentScripts:async()=>scripts,unregisterContentScripts:async({ids})=>{scripts=scripts.filter(s=>!ids.includes(s.id));},registerContentScripts:async additions=>{scripts.push(...additions);}}};
  installScheduling(chrome);
  await syncSites();
  assert.equal(scripts.length,1);
  assert.deepEqual(scripts[0].matches,['https://mu.social/*']);
  assert.deepEqual(scripts[0].js,['filters.js','content.js','posts.js']);
  await syncSites();assert.equal(scripts.length,1);
  delete globalThis.chrome;
});

test('invalid saved sites do not block valid registration or obsolete cleanup',async()=>{
  let scripts=[{id:siteScriptId('https://removed.example')}];
  globalThis.chrome={storage:{local:{get:async()=>({sites:[null,{}, {origin:'bad/path'},{origin:'https://mu.social'},{origin:'https://mu.social'}]})}},permissions:{contains:async()=>true},scripting:{updateContentScripts:async()=>{},getRegisteredContentScripts:async()=>scripts,unregisterContentScripts:async({ids})=>{scripts=scripts.filter(s=>!ids.includes(s.id));},registerContentScripts:async additions=>scripts.push(...additions)}};
  installScheduling(chrome);
  await syncSites();assert.equal(scripts.length,1);assert.deepEqual(scripts[0].matches,['https://mu.social/*']);
});

async function accessFixture({granted=false,failStore=false,failRegister=false,denyRemoval=false,sites=[]}={}) {
  let scripts=[];
  globalThis.chrome={storage:{local:{get:async()=>({sites:structuredClone(sites)}),set:async value=>{if(failStore){failStore=false;throw new Error('Storage failed');}sites=value.sites;}}},permissions:{contains:async()=>granted,request:async()=>{granted=true;return true;},remove:async()=>{if(denyRemoval)return false;granted=false;return true;}},scripting:{getRegisteredContentScripts:async()=>scripts,updateContentScripts:async()=>{},registerContentScripts:async added=>{if(failRegister)throw new Error('Register failed');scripts.push(...added);},unregisterContentScripts:async({ids})=>{scripts=scripts.filter(s=>!ids.includes(s.id));}}};
  const scheduling=installScheduling(chrome);
  return {state:()=>({granted,sites,scripts}),...scheduling};
}
test('failed add rolls back new grants and records, but preserves pre-existing permissions',async()=>{
  const {addSite}=await import('../extension/sites.js');
  for(const granted of [false,true]) {
    for(const failure of ['failStore','failRegister']) {
      const f=await accessFixture({granted,[failure]:true});
      await assert.rejects(addSite('https://mu.social'),/rolled back/);
      assert.equal(f.state().granted,granted);assert.deepEqual(f.state().sites,[]);assert.deepEqual(f.state().scripts,[]);
    }
  }
});
test('failed permission removal keeps the saved site visible',async()=>{
  const {removeSite}=await import('../extension/sites.js');
  const sites=[defaultSite('https://mu.social')];
  const f=await accessFixture({granted:true,denyRemoval:true,sites});
  await assert.rejects(removeSite('https://mu.social'),/kept in settings/);
  assert.equal(f.state().granted,true);assert.deepEqual(f.state().sites,sites);
});
test('successful add and removal keep grants, records and scripts aligned',async()=>{
  const {addSite,removeSite}=await import('../extension/sites.js');
  const f=await accessFixture();
  await addSite('https://mu.social');assert.equal(f.state().granted,true);assert.equal(f.state().sites.length,1);assert.equal(f.state().scripts.length,1);
  await removeSite('https://mu.social');assert.equal(f.state().granted,false);assert.equal(f.state().sites.length,0);assert.equal(f.state().scripts.length,0);
});

test('removal retries transient storage failure and still removes scripts',async()=>{
  const {addSite,removeSite}=await import('../extension/sites.js');
  const f=await accessFixture();await addSite('https://mu.social');
  const save=chrome.storage.local.set;let attempts=0;
  chrome.storage.local.set=async value=>{if(++attempts===1)throw new Error('Storage busy');return save(value);};
  await removeSite('https://mu.social');
  assert.equal(attempts,2);assert.deepEqual(f.state(),{granted:false,sites:[],scripts:[]});
});
test('persistent storage failure reports incomplete removal but does not skip script cleanup',async()=>{
  const {addSite,removeSite}=await import('../extension/sites.js');
  const f=await accessFixture();await addSite('https://mu.social');
  const save=chrome.storage.local.set;let attempts=0;
  chrome.storage.local.set=async()=>{attempts++;throw new Error('Storage unavailable');};
  await assert.rejects(removeSite('https://mu.social'),/access was revoked, but cleanup is incomplete/);
  assert.equal(attempts,2);assert.equal(f.state().granted,false);
  assert.equal(f.state().sites.length,1);assert.deepEqual(f.state().scripts,[]);
  chrome.storage.local.set=save;await removeSite('https://mu.social');
  assert.deepEqual(f.state(),{granted:false,sites:[],scripts:[]});
});
test('removal retries unregister failures and retains a retry alarm if cleanup stays incomplete',async()=>{
  const {addSite,removeSite,SITE_SYNC_ALARM}=await import('../extension/sites.js');
  for(const persistent of [false,true]) {
    const f=await accessFixture();await addSite('https://mu.social');
    const unregister=chrome.scripting.unregisterContentScripts;let attempts=0;
    chrome.scripting.unregisterContentScripts=async value=>{if(++attempts===1 || persistent)throw new Error('Unregister failed');return unregister(value);};
    if(persistent) {
      await assert.rejects(removeSite('https://mu.social'),/cleanup is incomplete/);
      assert.equal(f.state().scripts.length,1);assert.equal(f.alarms.has(SITE_SYNC_ALARM),true);
    } else {
      await removeSite('https://mu.social');assert.deepEqual(f.state().scripts,[]);
      assert.equal(f.alarms.has(SITE_SYNC_ALARM),false);
    }
    assert.equal(attempts,2);assert.equal(f.state().granted,false);assert.deepEqual(f.state().sites,[]);
    chrome.scripting.unregisterContentScripts=unregister;await syncSites();
    assert.deepEqual(f.state().scripts,[]);assert.equal(f.alarms.has(SITE_SYNC_ALARM),false);
  }
});
