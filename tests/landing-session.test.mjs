import {test} from 'node:test';
import assert from 'node:assert/strict';
import {harness,MASTER,TENANT,EMAIL,storeRecord,tick} from './harness.mjs';
const hintKey='sqysystems:managed-merchant:v1';
const records=()=>new Map([[MASTER+'/merchant_stores/'+EMAIL,storeRecord()]]);
const landing=options=>harness({entry:'app.js',landingAuth:true,...options});
const storeButton=p=>p.nodes.find(n=>n.attrs.href==='public/admin.html'&&'data-user-only'in n.attrs);
const noAgencyPrivileges=p=>assert.ok(p.nodes.filter(n=>'data-sqy-admin'in n.attrs).every(n=>n.hidden));
async function signedPortal(){const p=await harness({records:records()});await p.login();return p;}

test('round trip: landing login -> admin -> return -> refresh -> admin, password only once',async()=>{
 const p=await landing({records:records()});await p.login();assert.equal(p.destination,'https://sqysystems.com/public/admin.html');
 const q=await harness({records:p.records,storage:p.entries});assert.equal(q.byId('dashboard-view').classList.contains('flex'),true);
 const r=await landing({records:q.records,storage:q.entries});assert.equal(r.destination,undefined);assert.equal(r.byId('dashboard').hidden,false);assert.equal(r.byId('dashEmail').textContent,EMAIL);assert.equal(storeButton(r).hidden,false);assert.match(r.byId('dashStoreName').textContent,/Managed AURA/);noAgencyPrivileges(r);
 const refreshed=await landing({records:r.records,storage:r.entries});assert.equal(refreshed.byId('dashboard').hidden,false);
 const reopened=await harness({records:r.records,storage:r.entries});assert.equal(reopened.byId('dashboard-view').classList.contains('flex'),true);
 assert.deepEqual([p,q,r,refreshed,reopened].flatMap(x=>x.state.calls).filter(c=>c.type==='login').map(c=>c.project),[TENANT]);
});
test('direct admin login appears signed in on landing without Master login or profile reads',async()=>{
 const p=await signedPortal();const q=await landing({records:p.records,storage:p.entries});
 assert.equal(q.byId('dashboard').hidden,false);assert.equal(q.state.auths[MASTER].currentUser,null);
 assert.ok(q.state.calls.filter(c=>c.project===MASTER).every(c=>c.type==='init'||c.path?.startsWith('merchant_stores/')));
});
test('locator without a real Firebase session cannot render signed-in landing',async()=>{
 const p=await signedPortal();p.entries.delete('mock-auth:'+TENANT);const q=await landing({records:p.records,storage:p.entries});
 assert.equal(q.byId('dashboard').hidden,true);assert.equal(q.entries.has(hintKey),false);noAgencyPrivileges(q);
});
test('tenant context cannot inherit Master superadmin access or write an agency profile',async()=>{
 const p=await signedPortal();p.records.set(TENANT+'/users/tenant-uid',{role:'admin',displayName:'Store owner',company:'Store Ltd'});
 const q=await landing({records:p.records,storage:p.entries,masterSigned:true,masterRole:'superadmin'});
 assert.equal(q.byId('dashName').textContent,'Store owner');assert.equal(q.byId('dashCompany').textContent,'Store Ltd');noAgencyPrivileges(q);
 assert.equal(q.byId('agencyProfilePanel').hidden,true);assert.equal(q.byId('profileSave').disabled,true);
 q.byId('companyInput').value='Unauthorized';await q.byId('profileForm').emit('submit');assert.equal(q.state.calls.filter(c=>c.type==='write').length,0);
});
test('ordinary Master session and company editing work independently',async()=>{
 const p=await landing({masterSigned:true,masterRole:'client'});assert.equal(p.byId('dashboard').hidden,false);assert.equal(p.byId('agencyProfilePanel').hidden,false);noAgencyPrivileges(p);
 p.byId('companyInput').value='Client Ltd';await p.byId('profileForm').emit('submit');assert.equal(p.records.get(MASTER+'/users/master-uid').company,'Client Ltd');
});
test('Master superadmin access follows live role removal',async()=>{
 const p=await landing({masterSigned:true});assert.ok(p.nodes.filter(n=>'data-sqy-admin'in n.attrs).every(n=>!n.hidden));
 await p.put(MASTER,'users/master-uid',{uid:'master-uid',role:'client',email:'owner@sqysystems.com'});noAgencyPrivileges(p);
});
test('landing logout clears identity, both sessions, locator, and profile subscriptions',async()=>{
 const p=await signedPortal();const q=await landing({records:p.records,storage:p.entries,masterSigned:true});
 await q.entry.namespace.handleLogout();await tick();assert.equal(q.byId('dashboard').hidden,true);assert.equal(q.byId('dashEmail').textContent,'—');assert.equal(storeButton(q).hidden,true);assert.equal(q.entries.has(hintKey),false);assert.equal(q.state.auths[TENANT].currentUser,null);assert.equal(q.state.auths[MASTER].currentUser,null);assert.equal(q.state.listeners.length,0);noAgencyPrivileges(q);
 const r=await landing({records:q.records,storage:q.entries});assert.equal(r.byId('dashboard').hidden,true);
});
test('disabled/deleted/missing directory records revoke landing access and tenant session',async()=>{
 for(const status of ['disabled','deleted','missing']){
  const p=await signedPortal();const q=await landing({records:p.records,storage:p.entries});
  if(status==='missing'){q.records.delete(MASTER+'/merchant_stores/'+EMAIL);q.state.emit(MASTER,'merchant_stores/'+EMAIL);await tick();}
  else await q.put(MASTER,'merchant_stores/'+EMAIL,storeRecord(EMAIL,{status}));
  assert.equal(q.byId('dashboard').hidden,true);assert.equal(q.entries.has(hintKey),false);assert.equal(q.state.auths[TENANT].currentUser,null);assert.equal(q.state.listeners.length,0);
 }
});
test('tenant role removal and live store URL changes revoke landing access',async()=>{
 for(const change of ['role','url']){
  const p=await signedPortal();const q=await landing({records:p.records,storage:p.entries});
  if(change==='role')await q.put(TENANT,'users/tenant-uid',{role:'customer'});
  else await q.put(MASTER,'merchant_stores/'+EMAIL,storeRecord(EMAIL,{storeApiBaseUrl:'https://changed.example.com'}));
  assert.equal(q.byId('dashboard').hidden,true);assert.equal(q.entries.has(hintKey),false);noAgencyPrivileges(q);
 }
});
test('directory network failure during return fails closed',async()=>{
 const p=await signedPortal();const q=await landing({records:p.records,storage:p.entries,directoryFailure:'unavailable'});assert.equal(q.byId('dashboard').hidden,true);assert.equal(q.entries.has(hintKey),false);assert.ok(q.byId('loginMsg').textContent);noAgencyPrivileges(q);
});
test('pagehide cleans listeners but preserves session; bfcache Back triggers revalidation',async()=>{
 const p=await signedPortal();const q=await landing({records:p.records,storage:p.entries});await q.emitWindow('pagehide');assert.equal(q.byId('dashboard').hidden,true);assert.equal(q.state.listeners.length,0);assert.equal(q.entries.has(hintKey),true);assert.ok(q.state.auths[TENANT].currentUser);
 await q.emitWindow('pageshow',{persisted:true});assert.equal(q.destination,'https://sqysystems.com/index.html');
 const r=await harness({records:p.records,storage:p.entries});await r.emitWindow('pagehide');assert.equal(r.byId('dashboard-view').classList.contains('hidden'),true);assert.equal(r.entries.has(hintKey),true);await r.emitWindow('pageshow',{persisted:true});assert.equal(r.destination,'https://sqysystems.com/public/admin.html');
});
test('late Master profile response cannot overwrite a verified merchant identity',async()=>{
 const p=await landing();let release;const gate=new Promise(r=>{release=r;});
 p.state.readHook=ref=>ref.db.app.options.projectId===MASTER&&ref.path==='users/master-uid'?gate:undefined;
 const firebase=await p.importModule('firebase-config.js');const sdk=await p.importModule('https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js');
 await sdk.signInWithEmailAndPassword(firebase.auth,'owner@sqysystems.com','correct-password');await tick();
 p.records.set(MASTER+'/merchant_stores/'+EMAIL,storeRecord());await p.login();release();await tick();assert.equal(p.byId('dashEmail').textContent,EMAIL);noAgencyPrivileges(p);
});
