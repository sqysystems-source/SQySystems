import {test} from 'node:test';
import assert from 'node:assert/strict';
import {environment,EMAIL,SESSION_KEY,tick} from './fixtures.mjs';
const initCalls=p=>p.featureCalls.filter(c=>c.name.startsWith('init'));
const loginCalls=p=>p.state.calls.filter(c=>c.type==='login');

test('one portal login authenticates tenant only and initializes all six modules',async()=>{
 const p=await environment();assert.equal(p.session.auth,null);assert.equal(initCalls(p).length,0);
 await p.login('  KOSTAS6603@GMAIL.COM  ');
 assert.deepEqual(loginCalls(p).map(c=>c.project),['test-db-f6315']);assert.equal(initCalls(p).length,6);
 assert.ok(p.state.calls.every(c=>c.project==='test-db-f6315'));assert.equal(p.byId('dashboard-view').classList.contains('flex'),true);
 assert.equal(await p.utils.getCurrentUser().getIdToken(),'TENANT-TOKEN');assert.equal(p.byId('portal-identity').textContent,EMAIL);
 assert.equal(p.session.buildStoreApiUrl('/api/send-email'),'https://www.sqysystemsdev.org/api/send-email');
 assert.equal(p.byId('admin-password').value,'');
});
test('landing modal logs in once; following page resumes the very same tenant session',async()=>{
 const p=await environment({landing:true});await p.login();assert.equal(p.destination,'https://sqysystems.com/public/admin.html');
 assert.deepEqual(loginCalls(p).map(c=>c.project),['test-db-f6315']);
 assert.ok(!p.state.calls.some(c=>c.project==='sqysystems-faa0e'&&['login','read','write'].includes(c.type)));
 const q=await environment({storage:p.entries});assert.equal(loginCalls(q).length,0);assert.equal(initCalls(q).length,6);assert.equal(q.byId('dashboard-view').classList.contains('flex'),true);
});
test('no passwords, credentials or ID tokens are saved in session locator',async()=>{
 const p=await environment();await p.login();const hint=JSON.parse(p.entries.get(SESSION_KEY));
 assert.deepEqual(Object.keys(hint).sort(),['email','slug','uid','version']);assert.equal(hint.email,EMAIL);
 assert.ok(![...p.entries.values()].some(v=>v.includes('correct-password')||v.includes('TENANT-TOKEN')));
});
test('unknown portal email cannot initialize any Firebase app or call Auth',async()=>{
 const p=await environment();await p.login('unknown@example.com');assert.equal(p.state.calls.length,0);assert.equal(initCalls(p).length,0);assert.equal(p.byId('login-error').classList.contains('hidden'),false);
});
test('unconfigured AURA fails closed; no second login or Master fallback',async()=>{
 const p=await environment({unconfigured:true});await p.login();assert.equal(p.state.calls.length,0);assert.equal(initCalls(p).length,0);assert.match(p.byId('login-error').textContent,/SQySystems/);
 const q=await environment({landing:true,unconfigured:true});await q.login();assert.equal(loginCalls(q).length,0);assert.equal(q.destination,undefined);assert.match(q.byId('loginMsg').textContent,/SQySystems/);
});
test('wrong password stays on single form and permits a successful retry',async()=>{
 const p=await environment();await p.login(EMAIL,'wrong');assert.equal(initCalls(p).length,0);assert.equal(p.byId('admin-login-form').hidden,false);assert.equal(p.byId('login-submit-btn').disabled,false);assert.equal(p.entries.has(SESSION_KEY),false);
 await p.login();assert.equal(initCalls(p).length,6);assert.equal(loginCalls(p).length,2);
});
test('tenant customer is denied before all features and cleared from Auth',async()=>{
 const p=await environment({nonAdmin:true});await p.login();assert.equal(initCalls(p).length,0);assert.equal(p.session.auth.currentUser,null);assert.equal(p.entries.has(SESSION_KEY),false);assert.equal(p.byId('dashboard-view').classList.contains('hidden'),true);assert.equal(p.utils.getCurrentUser(),null);
 assert.ok(p.state.calls.filter(c=>c.type==='read').every(c=>c.path==='users/tenant-uid'));
});
test('mapped email cannot resume or login as a different tenant email',async()=>{
 const p=await environment({wrongAuthEmail:'someone-else@example.com'});await p.login();assert.equal(initCalls(p).length,0);assert.equal(p.entries.has(SESSION_KEY),false);assert.equal(p.session.auth.currentUser,null);
});
test('reload re-verifies admin role rather than trusting locator',async()=>{
 const p=await environment();await p.login();const q=await environment({storage:p.entries,nonAdmin:true});assert.equal(initCalls(q).length,0);assert.equal(q.entries.has(SESSION_KEY),false);assert.equal(q.session.auth.currentUser,null);
});
test('tampered tenant uid or store slug cannot restore session',async()=>{
 for(const field of ['uid','slug']) {
  const p=await environment();await p.login();const hint=JSON.parse(p.entries.get(SESSION_KEY));hint[field]='wrong';p.entries.set(SESSION_KEY,JSON.stringify(hint));
  const q=await environment({storage:p.entries});assert.equal(initCalls(q).length,0);assert.equal(q.entries.has(SESSION_KEY),false);
 }
});
test('tenant role revocation locks UI, purges identity and reloads cleanly',async()=>{
 const p=await environment();await p.login();p.byId('orders-table-body').innerHTML='customer-data';p.state.role='customer';p.state.emitProfile();await tick();
 assert.equal(p.utils.getCurrentUser(),null);assert.equal(p.byId('orders-table-body').innerHTML,'');assert.equal(p.byId('dashboard-view').classList.contains('hidden'),true);assert.equal(p.entries.has(SESSION_KEY),false);assert.equal(p.destination,'https://sqysystems.com/public/admin.html?notice=session-ended');assert.throws(()=>p.session.buildStoreApiUrl('/api/r2'));
});
test('logout clears tenant Auth/locator and returns to agency homepage',async()=>{
 const p=await environment();await p.login();await p.byId('logout-btn').emit('click');await tick();assert.equal(p.session.auth.currentUser,null);assert.equal(p.entries.has(SESSION_KEY),false);assert.equal(p.destination,'https://sqysystems.com/index.html');assert.equal(p.utils.getCurrentUser(),null);
});
test('tenant Auth account change invalidates the existing module graph',async()=>{
 const p=await environment();await p.login();p.session.auth.currentUser={uid:'other-uid',email:EMAIL};
 for(const e of p.state.authListeners)await e.callback(p.session.auth.currentUser);await tick();assert.equal(p.utils.getCurrentUser(),null);assert.equal(p.entries.has(SESSION_KEY),false);assert.equal(initCalls(p).length,6);assert.ok(p.destination);
});
test('profile network error fails closed and permits retry',async()=>{
 const p=await environment({failRead:true});await p.login();assert.equal(initCalls(p).length,0);assert.equal(p.entries.has(SESSION_KEY),false);p.state.failRead=false;await p.login();assert.equal(initCalls(p).length,6);
});
test('storage persistence failure permits retry with a partially initialized app',async()=>{
 const p=await environment({failPersistence:true});await p.login();assert.equal(loginCalls(p).length,0);p.state.failPersistence=false;await p.login();assert.equal(initCalls(p).length,6);
});
test('failed handoff storage never redirects a successful-looking landing login',async()=>{
 const p=await environment({landing:true,failHintWrite:true});await p.login();assert.equal(p.destination,undefined);assert.equal(p.session.auth.currentUser,null);assert.equal(p.entries.has(SESSION_KEY),false);assert.match(p.byId('loginMsg').textContent,/browser/);
});
test('merchant password reset uses tenant Auth without Master sign-in',async()=>{
 const p=await environment({landing:true});p.byId('loginEmail').value=EMAIL;await p.byId('forgotBtn').emit('click');
 assert.deepEqual(p.state.calls.filter(c=>c.type==='reset').map(c=>c.project),['test-db-f6315']);assert.equal(loginCalls(p).length,0);
});
test('general agency client login is preserved independently in Master',async()=>{
 const p=await environment({landing:true});await p.login('agency-client@example.com');assert.deepEqual(loginCalls(p).map(c=>c.project),['sqysystems-faa0e']);assert.equal(p.session.auth,null);assert.equal(p.destination,undefined);
});
test('managed merchants cannot self-register in Master via agency signup',async()=>{
 const p=await environment({landing:true});p.entry.namespace.initSignupForm();p.byId('signupName').value='Merchant';p.byId('signupEmail').value=EMAIL;p.byId('signupPassword').value='correct-password';await p.byId('signupForm').emit('submit');assert.equal(p.state.calls.filter(c=>c.type==='signup').length,0);assert.match(p.byId('signupMsg').textContent,/existing store credentials/);
});
test('legacy double-login hint cannot grant an automatic managed session',async()=>{
 const storage=new Map([['sqysystems:tenant-session',JSON.stringify({masterUid:'old',tenantUid:'tenant-uid',projectId:'test-db-f6315'})]]);const p=await environment({storage});assert.equal(initCalls(p).length,0);assert.equal(p.session.auth,null);assert.equal(storage.has('sqysystems:tenant-session'),false);
});

test('failed AURA attempt can retry another managed store without leaking old db/app',async()=>{
 const p=await environment({extraStore:true});await p.login(EMAIL,'wrong');await p.login('beta@example.com');
 assert.deepEqual(loginCalls(p).map(c=>c.project),['test-db-f6315','beta-store']);assert.ok(p.state.calls.some(c=>c.type==='deleteApp'&&c.project==='test-db-f6315'));
 assert.equal(p.utils.db.app.options.projectId,'beta-store');assert.equal(p.session.buildStoreApiUrl('/api/r2?action=upload-url'),'https://beta.example.com/api/r2?action=upload-url');assert.equal(initCalls(p).length,6);
});
