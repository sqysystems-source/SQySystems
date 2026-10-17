import {test} from 'node:test';
import assert from 'node:assert/strict';
import {harness,MASTER,TENANT,EMAIL,storeRecord,fakeConfig,tick} from './harness.mjs';
const inits=p=>p.featureCalls.filter(c=>c.name.startsWith('init'));
const logins=p=>p.state.calls.filter(c=>c.type==='login');

test('Firestore mapping sends credentials only to its configured tenant',async()=>{
 const records=new Map([[MASTER+'/merchant_stores/'+EMAIL,storeRecord()]]);const p=await harness({records});await p.login();assert.equal(inits(p).length,6);assert.deepEqual(logins(p).map(c=>c.project),[TENANT]);assert.equal(p.session.buildStoreApiUrl('/api/r2?action=upload-url'),'https://dynamic.example.com/api/r2?action=upload-url');assert.ok(p.state.calls.filter(c=>c.project===MASTER).every(c=>c.type==='init'||c.path?.startsWith('merchant_stores/')));
});
test('new dynamic-only merchant works from landing modal and resumes without another login',async()=>{
 const email='new-store@example.com';const records=new Map([[MASTER+'/merchant_stores/'+email,storeRecord(email)]]);const p=await harness({entry:'app.js',records});await p.login(email);assert.equal(p.destination,'https://sqysystems.com/public/admin.html');assert.deepEqual(logins(p).map(c=>c.project),[TENANT]);const q=await harness({records,storage:p.entries});assert.equal(inits(q).length,6);assert.equal(logins(q).length,0);
});
test('missing AURA record has no local fallback and denies portal login',async()=>{
 const p=await harness();await p.login();assert.equal(inits(p).length,0);assert.equal(logins(p).length,0);
 assert.ok(p.state.calls.some(c=>c.project===MASTER&&c.path==='merchant_stores/'+EMAIL&&c.type==='read'));
});
test('disabled and deleted mappings never fall back to AURA or Master login',async()=>{
 for(const status of ['disabled','deleted'])for(const entry of ['public/js/admin.js','app.js']){
  const records=new Map([[MASTER+'/merchant_stores/'+EMAIL,storeRecord(EMAIL,{status})]]);const p=await harness({records,entry});await p.login();assert.equal(logins(p).length,0);assert.equal(inits(p).length,0);assert.equal(p.destination,undefined);
 }
});
test('malformed mapping and directory network/permission failures fail closed',async()=>{
 const records=new Map([[MASTER+'/merchant_stores/'+EMAIL,storeRecord(EMAIL,{firebaseConfig:{private_key:'secret'}})]]);const p=await harness({records});await p.login();assert.equal(logins(p).length,0);
 for(const code of ['unavailable','permission-denied']){const q=await harness({entry:'app.js',directoryFailure:code});await q.login();assert.equal(logins(q).length,0);assert.equal(q.destination,undefined);}
});
test('ordinary agency account uses Master only after confirmed directory absence',async()=>{
 const p=await harness({entry:'app.js'});await p.login('normal-client@example.com');assert.deepEqual(logins(p).map(c=>c.project),[MASTER]);
});
test('unknown portal merchant is denied and slash email cannot create a path lookup',async()=>{
 const p=await harness();await p.login('unknown@example.com');assert.equal(logins(p).length,0);assert.equal(inits(p).length,0);
 const q=await harness();await q.login('bad/path@example.com');assert.ok(!q.state.calls.some(c=>c.type==='read'));
});
test('wrong password retry and tenant non-admin rejection retain one form',async()=>{
 const p=await harness({records:new Map([[MASTER+'/merchant_stores/'+EMAIL,storeRecord()]])});await p.login(EMAIL,'wrong');assert.equal(p.byId('admin-login-form').hidden,false);await p.login();assert.equal(inits(p).length,6);
 const records=new Map([[MASTER+'/merchant_stores/'+EMAIL,storeRecord()],[TENANT+'/users/tenant-uid',{role:'customer'}]]);const q=await harness({records});await q.login();assert.equal(inits(q).length,0);assert.equal(q.session.auth.currentUser,null);
});
test('dynamic disabling, deleting, domain changes and tenant role revocation lock a live portal',async()=>{
 for(const change of [{status:'disabled'},{status:'deleted'},{storeApiBaseUrl:'https://changed.example.com'}]){
  const records=new Map([[MASTER+'/merchant_stores/'+EMAIL,storeRecord()]]);const p=await harness({records});await p.login();await p.put(MASTER,'merchant_stores/'+EMAIL,storeRecord(EMAIL,change));assert.ok(p.destination?.includes('notice=session-ended'));assert.equal(p.entries.has('sqysystems:managed-merchant:v1'),false);assert.throws(()=>p.session.buildStoreApiUrl('/api/r2'));
 }
 const q=await harness({records:new Map([[MASTER+'/merchant_stores/'+EMAIL,storeRecord()]])});await q.login();await q.put(TENANT,'users/tenant-uid',{role:'customer'});assert.ok(q.destination);
});
test('connection disabled during sign-in fails its post-auth directory check',async()=>{
 const records=new Map([[MASTER+'/merchant_stores/'+EMAIL,storeRecord()]]);const p=await harness({records});let reads=0;
 p.state.directoryReadHook=()=>{if(++reads===2)records.set(MASTER+'/merchant_stores/'+EMAIL,storeRecord(EMAIL,{status:'disabled'}))};
 await p.login();assert.equal(inits(p).length,0);assert.equal(p.session.auth.currentUser,null);assert.equal(p.entries.has('sqysystems:managed-merchant:v1'),false);
});
test('session locator stores no password/token and is rechecked against current tenant project',async()=>{
 const p=await harness({records:new Map([[MASTER+'/merchant_stores/'+EMAIL,storeRecord()]])});await p.login();const hint=JSON.parse(p.entries.get('sqysystems:managed-merchant:v1'));assert.equal(hint.version,2);assert.equal(hint.projectId,TENANT);assert.ok(!JSON.stringify(hint).includes('correct-password'));assert.ok(!JSON.stringify(hint).includes('TOKEN'));
 hint.projectId='other-project';p.entries.set('sqysystems:managed-merchant:v1',JSON.stringify(hint));const q=await harness({records:p.records,storage:p.entries});assert.equal(inits(q).length,0);
});
test('dynamic password reset targets tenant and disabled record blocks Master reset',async()=>{
 const email='dynamic@example.com';const records=new Map([[MASTER+'/merchant_stores/'+email,storeRecord(email)]]);const p=await harness({entry:'app.js',records});p.byId('loginEmail').value=email;await p.byId('forgotBtn').emit('click');assert.deepEqual(p.state.calls.filter(c=>c.type==='reset').map(c=>c.project),[TENANT]);
 await p.put(MASTER,'merchant_stores/'+email,storeRecord(email,{status:'disabled'}));await p.byId('forgotBtn').emit('click');assert.equal(p.state.calls.filter(c=>c.type==='reset').length,1);
});
test('registered dynamic merchant cannot self-register in Master',async()=>{
 const email='dynamic@example.com';const records=new Map([[MASTER+'/merchant_stores/'+email,storeRecord(email)]]);const p=await harness({entry:'app.js',records});p.entry.namespace.initSignupForm();p.byId('signupName').value='Store owner';p.byId('signupEmail').value=email;p.byId('signupPassword').value='correct-password';await p.byId('signupForm').emit('submit');assert.equal(p.state.calls.filter(c=>c.type==='signup').length,0);
});
test('landing nav visibility follows verified Master role, including role removal',async()=>{
 const p=await harness({entry:'app.js'});const view=p.entry.namespace.View;view.renderGuest();const storeButton=p.nodes.find(n=>n.attrs.href==='public/admin.html'&&'data-user-only'in n.attrs);assert.equal(storeButton.hidden,true);assert.ok(p.nodes.filter(n=>'data-sqy-admin'in n.attrs).every(n=>n.hidden));
 const user={uid:'master-uid',email:'owner@example.com',metadata:{creationTime:'2026-01-01'}};view.renderUser(user,{role:'client',displayName:'Client'});assert.equal(storeButton.hidden,false);assert.ok(p.nodes.filter(n=>'data-sqy-admin'in n.attrs).every(n=>n.hidden));view.renderUser(user,{role:'superadmin',displayName:'Owner'});assert.ok(p.nodes.filter(n=>'data-sqy-admin'in n.attrs).every(n=>!n.hidden));view.renderUser(user,{role:'client',displayName:'Client'});assert.ok(p.nodes.filter(n=>'data-sqy-admin'in n.attrs).every(n=>n.hidden));
});
