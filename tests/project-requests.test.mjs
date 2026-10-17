import {test} from 'node:test';
import assert from 'node:assert/strict';
import {harness,MASTER,TENANT,EMAIL,storeRecord,tick} from './harness.mjs';
import {PROJECT_TRACKS,validateProjectRequest} from '../public/js/agency-model.js';
const brief=(category='websites',extra={})=>({uid:null,clientName:'Jane Example',clientEmail:'jane@example.com',clientPhone:'+30 690 123 4567',company:'Example Ltd',category,subType:PROJECT_TRACKS[category].types[0],profession:'Independent retail',productsOrServices:'A considered online customer experience.',estimatedScale:'20-100',selectedFeatures:[PROJECT_TRACKS[category].features[0]],projectName:'Example Studio',preferredColors:'Clean White & Editorial',aestheticStyle:'Minimalist',timeline:'1–3 Months',notes:'Reference: https://example.com',...extra});
const rows=p=>[...p.records].filter(([key])=>key.startsWith(MASTER+'/project_requests/'));
const wizard=options=>harness({entry:'app.js',wizard:true,...options});
async function choose(p,name,value){const inputs=p.allNodes().filter(n=>n.name===name);const input=inputs.find(n=>n.value===value);assert.ok(input,name+': '+value);if(name!=='pw-feature')inputs.forEach(n=>n.checked=false);input.checked=true;await p.byId('projectWizardForm').emit('change',{target:input});}
async function scope(p,category='websites'){
 await p.click({'data-start-project':''});await choose(p,'pw-category',category);await p.byId('projectWizardForm').emit('submit');
 await choose(p,'pw-subtype',PROJECT_TRACKS[category].types[0]);p.byId('pw-profession').value='Retail';p.byId('pw-purpose').value='Sell handcrafted goods with a clear customer journey.';p.byId('pw-scale').value='1-20';await choose(p,'pw-feature',PROJECT_TRACKS[category].features[0]);await p.byId('projectWizardForm').emit('submit');
 p.byId('pw-project-name').value='Example Studio';await choose(p,'pw-palette','Clean White & Editorial');p.byId('pw-style').value='Minimalist';p.byId('pw-timeline').value='Flexible';p.byId('pw-notes').value='Our launch brief.';await p.byId('projectWizardForm').emit('submit');
}
for(const category of Object.keys(PROJECT_TRACKS))test('validates a complete '+category+' brief and projects only known fields',()=>{
 const result=validateProjectRequest({...brief(category),status:'approved',createdAt:'fake',private_key:'ignored'});assert.equal(result.category,category);assert.equal(result.selectedFeatures[0],PROJECT_TRACKS[category].features[0]);assert.ok(!('status'in result));assert.ok(!('private_key'in result));assert.equal(Object.keys(result).length,16);
});
test('schema rejects cross-track features, duplicate features, unknown enums and oversized inputs',()=>{
 for(const patch of [{category:'__proto__'},{subType:'Not a real type'},{selectedFeatures:['Notifications']},{selectedFeatures:[PROJECT_TRACKS.websites.features[0],PROJECT_TRACKS.websites.features[0]]},{estimatedScale:'100000'},{timeline:'Tomorrow'},{aestheticStyle:'Anything'},{clientEmail:'bad/path@example.com'},{clientPhone:'<script>'},{projectName:'x'.repeat(121)},{notes:'x'.repeat(3001)},{uid:'x'.repeat(129)}])assert.throws(()=>validateProjectRequest(brief('websites',patch)));
});
test('guest completes each wizard branch and submits only to Master with status new',async()=>{
 for(const category of Object.keys(PROJECT_TRACKS)){
  const p=await wizard();await scope(p,category);p.byId('pw-client-name').value='Guest Client';p.byId('pw-client-email').value=' GUEST@EXAMPLE.COM ';p.byId('pw-company').value='Studio';await p.byId('projectWizardForm').emit('submit');await tick();
  assert.equal(rows(p).length,1);const saved=rows(p)[0][1];assert.equal(saved.category,category);assert.equal(saved.clientEmail,'guest@example.com');assert.equal(saved.uid,null);assert.equal(saved.status,'new');assert.ok(saved.createdAt.seconds);assert.equal(p.byId('pw-success').hidden,false);assert.equal(p.byId('projectWizardForm').hidden,true);assert.equal(p.state.calls.filter(c=>c.type==='login').length,0);
 }
});
test('wizard validation prevents advancing and preserves answers while moving Back',async()=>{
 const p=await wizard();await p.click({'data-start-project':''});await p.byId('projectWizardForm').emit('submit');assert.equal(p.byId('pw-error').hidden,false);assert.match(p.byId('pw-step-count').textContent,/01/);assert.equal(rows(p).length,0);
 await scope(p);await p.byId('pw-back').emit('click');assert.equal(p.byId('pw-project-name').value,'Example Studio');await p.byId('projectWizardForm').emit('submit');assert.match(p.byId('pw-step-count').textContent,/04/);
 await p.byId('projectWizardForm').emit('submit');assert.equal(p.byId('pw-success').hidden,true);assert.equal(rows(p).length,0);
});
test('changing solution clears old subtype/features/purpose while retaining brand answers',async()=>{
 const p=await wizard();await scope(p);await p.byId('pw-back').emit('click');await p.byId('pw-back').emit('click');await p.byId('pw-back').emit('click');await choose(p,'pw-category','applications');assert.equal(p.byId('pw-purpose').value,'');assert.equal(p.byId('pw-project-name').value,'Example Studio');assert.equal(p.allNodes().filter(n=>n.name==='pw-feature'&&n.checked).length,0);assert.equal(p.allNodes().filter(n=>n.name==='pw-subtype'&&n.checked).length,0);assert.match(p.byId('pw-purpose-label').textContent,/problem/);
});
test('Master user identity auto-binds and tenant-only identity never claims a Master UID',async()=>{
 const p=await wizard({landingAuth:true,masterSigned:true,masterRole:'client'});await scope(p);assert.equal(p.byId('pw-client-email').readOnly,true);assert.match(p.byId('pw-account-badge').textContent,/Account linked/);await p.byId('projectWizardForm').emit('submit');assert.equal(rows(p)[0][1].uid,'master-uid');assert.equal(rows(p)[0][1].company,'SQySystems');
 const records=new Map([[MASTER+'/merchant_stores/'+EMAIL,storeRecord()]]);const login=await harness({records});await login.login();const q=await wizard({landingAuth:true,storage:login.entries,records:login.records});await scope(q);assert.equal(q.byId('pw-client-email').value,EMAIL);assert.equal(q.byId('pw-client-email').readOnly,false);await q.byId('projectWizardForm').emit('submit');assert.equal(rows(q)[0][1].uid,null);
});
test('logout while wizard is open removes account binding and prefilled contact data',async()=>{
 const p=await wizard({landingAuth:true,masterSigned:true});await scope(p);await p.entry.namespace.handleLogout();assert.equal(p.byId('pw-account-badge').hidden,true);assert.equal(p.byId('pw-client-email').value,'');assert.equal(p.byId('pw-client-name').readOnly,false);assert.equal(p.byId('pw-project-name').value,'Example Studio');
});
test('submission service rejects spoofed Master UID/email and does not trust supplied status',async()=>{
 const p=await wizard({masterSigned:true});const data=await p.importModule('public/js/project-request-data.js');await assert.rejects(()=>data.submitProjectRequest(brief('websites',{uid:'different'})),/account changed/);await assert.rejects(()=>data.submitProjectRequest(brief('websites',{uid:'master-uid',clientEmail:'other@example.com'})),/account changed/);assert.equal(rows(p).length,0);await data.submitProjectRequest({...brief(),status:'approved'});assert.equal(rows(p)[0][1].status,'new');
});
test('one accepted submit cannot create a second request via double click',async()=>{
 const p=await wizard();await scope(p);p.byId('pw-client-name').value='Guest Client';p.byId('pw-client-email').value='client@example.com';await Promise.all([p.byId('projectWizardForm').emit('submit'),p.byId('projectWizardForm').emit('submit')]);assert.equal(rows(p).length,1);
});
test('admin new badge, newest list and rich details include all answers with escaped text',async()=>{
 const records=new Map([[MASTER+'/project_requests/old',{...brief(),createdAt:{seconds:1},status:'new'}],[MASTER+'/project_requests/new',{...brief('applications',{projectName:'Newest <img onerror=alert(1)>',notes:'<script>unsafe()</script>'}),createdAt:{seconds:2},status:'in_review'}]]);
 const p=await harness({entry:'sqy-admin.js',masterSigned:true,records});assert.equal(p.byId('nav-project-new').textContent,'1');assert.ok(p.byId('requests-list').innerHTML.indexOf('data-request-id="new"')<p.byId('requests-list').innerHTML.indexOf('data-request-id="old"'));assert.doesNotMatch(p.byId('requests-list').innerHTML,/<img/);
 await p.click({'data-section':'requests'});assert.equal(p.byId('page-label').textContent,'Project requests');await p.click({'data-request-id':'new'});assert.equal(p.byId('request-dialog').open,true);const html=p.byId('request-detail-content').innerHTML;for(const text of ['Jane Example','jane@example.com','+30 690','Example Ltd','Guest / store contact','Estimated scale','Preferred colors','Minimalist','1–3 Months'])assert.ok(html.includes(text),text);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
});
test('admin status changes update counts; payment/store actions prefill without writing or faking paid status',async()=>{
 const p=await harness({entry:'sqy-admin.js',masterSigned:true,records:new Map([[MASTER+'/project_requests/brief',{...brief(),status:'new',createdAt:{seconds:1}}]])});await p.click({'data-request-id':'brief'});p.byId('request-status').value='approved';await p.byId('save-request-status').emit('click');await tick();assert.equal(p.records.get(MASTER+'/project_requests/brief').status,'approved');assert.equal(p.byId('nav-project-new').textContent,'0');
 const writes=p.state.calls.filter(c=>c.type==='write').length;await p.byId('request-to-payment').emit('click');assert.equal(p.byId('payment-dialog').open,true);assert.equal(p.byId('payment-email').value,'jane@example.com');assert.equal(p.byId('payment-name').value,'Jane Example');assert.match(p.byId('payment-package').value,/Example Studio/);assert.equal(p.byId('payment-amount').value,'');assert.equal(p.state.calls.filter(c=>c.type==='write').length,writes);
 p.byId('payment-dialog').close();await p.click({'data-request-id':'brief'});await p.byId('request-to-store').emit('click');assert.equal(p.byId('merchant-email').value,'jane@example.com');assert.equal(p.byId('store-name').value,'Example Studio');assert.equal(p.byId('cfg-apiKey').value,'');assert.equal(p.state.calls.filter(c=>c.type==='write').length,writes);assert.equal(p.byId('kpi-paid').textContent,'0');
});
test('request mutations require Master admin and revoke/purge all request data on role loss',async()=>{
 const ordinary=await harness({entry:'sqy-admin.js',masterSigned:true,masterRole:'client'});const data=await ordinary.importModule('public/js/control-plane-data.js');await assert.rejects(()=>data.changeProjectRequestStatus('x','approved'));await assert.rejects(()=>data.deleteProjectRequest('x'));
 const p=await harness({entry:'sqy-admin.js',masterSigned:true,records:new Map([[MASTER+'/project_requests/x',{...brief(),status:'new'}]])});await p.click({'data-request-id':'x'});await p.put(MASTER,'users/master-uid',{uid:'master-uid',role:'client'});assert.equal(p.byId('request-dialog').open,false);assert.equal(p.byId('request-detail-content').innerHTML,'');assert.equal(p.byId('requests-list').innerHTML,'');assert.equal(p.byId('nav-project-new').textContent,'0');assert.equal(p.state.listeners.length,0);
});
test('deleting a request removes only its brief and closes the active drawer',async()=>{
 const p=await harness({entry:'sqy-admin.js',masterSigned:true,records:new Map([[MASTER+'/project_requests/x',{...brief(),status:'new'}]])});await p.click({'data-request-id':'x'});await p.byId('delete-request').emit('click');await tick();assert.equal(p.records.has(MASTER+'/project_requests/x'),false);assert.equal(p.byId('request-dialog').open,false);assert.equal(p.byId('nav-project-new').textContent,'0');
});
test('a failed Firestore submission retains the brief, permits retry, and shows no false success',async()=>{
 const p=await wizard();await scope(p);p.byId('pw-client-name').value='Guest Client';p.byId('pw-client-email').value='client@example.com';p.state.failWrite='permission-denied';await p.byId('projectWizardForm').emit('submit');assert.equal(rows(p).length,0);assert.equal(p.byId('pw-success').hidden,true);assert.equal(p.byId('pw-error').hidden,false);assert.equal(p.byId('pw-next').disabled,false);assert.equal(p.byId('pw-project-name').value,'Example Studio');p.state.failWrite=null;await p.byId('projectWizardForm').emit('submit');assert.equal(rows(p).length,1);assert.equal(p.byId('pw-success').hidden,false);
});

test('request status filter and global search keep the new count independent of the current view',async()=>{
 const p=await harness({entry:'sqy-admin.js',masterSigned:true,records:new Map([[MASTER+'/project_requests/a',{...brief(),status:'new'}],[MASTER+'/project_requests/b',{...brief('backend',{projectName:'Cloud Migration'}),status:'approved'}]])});
 p.byId('request-filter').value='approved';await p.byId('request-filter').emit('change');assert.match(p.byId('requests-list').innerHTML,/Cloud Migration/);assert.doesNotMatch(p.byId('requests-list').innerHTML,/data-request-id="a"/);assert.equal(p.byId('nav-project-new').textContent,'1');
 p.byId('request-filter').value='all';p.byId('global-search').value='cloud';await p.byId('global-search').emit('input');assert.match(p.byId('requests-list').innerHTML,/Cloud Migration/);assert.doesNotMatch(p.byId('requests-list').innerHTML,/data-request-id="a"/);
});
