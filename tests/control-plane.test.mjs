import {test} from 'node:test';
import assert from 'node:assert/strict';
import {harness,MASTER,TENANT,EMAIL,storeRecord,fakeConfig,tick} from './harness.mjs';
const payload=(email=EMAIL)=>({merchantEmail:email,storeName:'AURA',storeApiBaseUrl:'https://www.sqysystemsdev.org',plan:'Custom E-Shop',status:'active',firebaseConfig:fakeConfig(TENANT)});

test('anonymous and ordinary Master users never start collection listeners',async()=>{
 const p=await harness({entry:'sqy-admin.js'});assert.equal(p.byId('admin-view').hidden,true);assert.equal(p.state.calls.filter(c=>c.type==='listen').length,0);
 const q=await harness({entry:'sqy-admin.js',masterSigned:true,masterRole:'client'});assert.equal(q.byId('admin-view').hidden,true);assert.equal(q.state.calls.filter(c=>c.type==='listen').length,0);assert.match(q.byId('access-error').textContent,/administrator access/);
});
test('admin and superadmin can load protected Master collections once',async()=>{
 for(const role of ['admin','superadmin']){
  const p=await harness({entry:'sqy-admin.js',masterSigned:true,masterRole:role});assert.equal(p.byId('admin-view').hidden,false);const lists=p.state.calls.filter(c=>c.type==='listen'&&['users','messages','client_payments','merchant_stores'].includes(c.path));assert.equal(lists.length,4);assert.ok(lists.every(c=>c.project===MASTER));assert.equal(p.byId('kpi-clients').textContent,'1');
 }
});
test('ordinary or unsigned users cannot invoke protected mutations directly',async()=>{
 for(const role of ['client',null]){
  const p=await harness({entry:'sqy-admin.js',masterSigned:role!==null,masterRole:role||'client'});const data=await p.importModule('public/js/control-plane-data.js');await assert.rejects(()=>data.saveConnection(payload()));await assert.rejects(()=>data.addPaidOrder({}));await assert.rejects(()=>data.changeTicketStatus('ticket','read'));assert.ok(!p.state.calls.some(c=>c.type==='write'));
 }
});
test('provisioning saves exact public config in Master with optimistic conflict detection',async()=>{
 const p=await harness({entry:'sqy-admin.js',masterSigned:true});const data=await p.importModule('public/js/control-plane-data.js');const model=await p.importModule('public/js/agency-model.js');await data.saveConnection(payload());await tick();const saved=p.records.get(MASTER+'/merchant_stores/'+EMAIL);assert.equal(saved.status,'active');assert.equal(saved.merchantEmail,EMAIL);assert.ok(saved.updatedAt.seconds);assert.ok(!p.state.calls.some(c=>c.type==='write'&&c.project!==MASTER));
 await assert.rejects(()=>data.saveConnection(payload()),/changed/);const version=model.connectionVersion(saved);await data.saveConnection({...payload(),storeName:'Updated AURA'},version);assert.equal(p.records.get(MASTER+'/merchant_stores/'+EMAIL).storeName,'Updated AURA');await assert.rejects(()=>data.changeConnectionStatus(EMAIL,'disabled',version),/changed/);
});
test('store disable/enable/delete are durable states; Delete never removes the seed blocker',async()=>{
 const records=new Map([[MASTER+'/merchant_stores/'+EMAIL,storeRecord()]]);const p=await harness({entry:'sqy-admin.js',masterSigned:true,records});const data=await p.importModule('public/js/control-plane-data.js');const model=await p.importModule('public/js/agency-model.js');
 for(const status of ['disabled','active','deleted']){await data.changeConnectionStatus(EMAIL,status,model.connectionVersion(p.records.get(MASTER+'/merchant_stores/'+EMAIL)));await tick();assert.equal(p.records.get(MASTER+'/merchant_stores/'+EMAIL).status,status)}assert.ok(!p.state.calls.some(c=>c.type==='delete'&&c.path==='merchant_stores/'+EMAIL));assert.equal(p.byId('kpi-stores').textContent,'0');
});
test('recording a paid client validates euros in cents and writes only one manual order',async()=>{
 const p=await harness({entry:'sqy-admin.js',masterSigned:true});const data=await p.importModule('public/js/control-plane-data.js');await data.addPaidOrder({clientEmail:' NEW@EXAMPLE.COM ',clientName:'New Store',packageDetails:'Custom E-Shop + Viva Wallet',amount:'700,50',paidDate:'2026-10-15'});await tick();const payments=[...p.records].filter(([k])=>k.startsWith(MASTER+'/client_payments/'));assert.equal(payments.length,1);assert.equal(payments[0][1].amountCents,70050);assert.equal(payments[0][1].clientEmail,'new@example.com');assert.equal(payments[0][1].createdBy,'master-uid');assert.equal(payments[0][1].source,'manual');assert.equal(p.byId('kpi-paid').textContent,'1');assert.match(p.byId('paid-list').innerHTML,/Pending Setup/);
 await assert.rejects(()=>data.addPaidOrder({clientEmail:'n@example.com',clientName:'Name',packageDetails:'Eshop',amount:'-1',paidDate:'2026-10-15'}));
});
test('legacy messages without status count as unread; read/resolve/delete update live KPIs',async()=>{
 const records=new Map([[MASTER+'/messages/ticket',{name:'Prospect',email:'p@example.com',message:'I would like a new store.',createdAt:{seconds:1792100000}}]]);const p=await harness({entry:'sqy-admin.js',masterSigned:true,records});assert.equal(p.byId('kpi-unread').textContent,'1');const data=await p.importModule('public/js/control-plane-data.js');await data.changeTicketStatus('ticket','read');await tick();assert.equal(p.byId('kpi-unread').textContent,'0');await data.changeTicketStatus('ticket','resolved');await tick();assert.match(p.byId('messages-list').innerHTML,/resolved/);await data.deleteTicket('ticket');await tick();assert.equal(records.has(MASTER+'/messages/ticket'),false);
});
test('contact, client and paid text is HTML escaped',async()=>{
 const malicious='<img src=x onerror=alert(1)>';const records=new Map([[MASTER+'/users/client',{email:'x@example.com',displayName:malicious,company:malicious,role:'client'}],[MASTER+'/messages/x',{name:malicious,email:'x@example.com',message:malicious}],[MASTER+'/client_payments/x',{clientEmail:'x@example.com',clientName:malicious,packageDetails:malicious,amountCents:70000,status:'paid'}]]);const p=await harness({entry:'sqy-admin.js',masterSigned:true,records});for(const id of ['clients-body','messages-list','paid-list']){assert.ok(!p.byId(id).innerHTML.includes('<img'));assert.ok(p.byId(id).innerHTML.includes('&lt;img'));}
});
test('role revocation purges private rows/config and stops every collection subscription',async()=>{
 const records=new Map([[MASTER+'/merchant_stores/'+EMAIL,storeRecord()]]);const p=await harness({entry:'sqy-admin.js',masterSigned:true,records});await p.click({'data-edit-store':EMAIL});assert.equal(p.byId('provision-dialog').open,true);assert.ok(p.byId('cfg-apiKey').value);await p.put(MASTER,'users/master-uid',{uid:'master-uid',email:'owner@sqysystems.com',role:'client'});assert.equal(p.byId('admin-view').hidden,true);assert.equal(p.byId('provision-dialog').open,false);assert.equal(p.byId('cfg-apiKey').value,'');assert.equal(p.byId('clients-body').innerHTML,'');assert.equal(p.state.listeners.length,0);
});
test('paid-order setup and provisioning form work together with real parser and save service',async()=>{
 const email='store@example.com';const records=new Map([[MASTER+'/client_payments/payment',{clientEmail:email,clientName:'Store Client',packageDetails:'Custom E-Shop + Viva Wallet',amountCents:70000,status:'paid'}]]);const p=await harness({entry:'sqy-admin.js',masterSigned:true,records});await p.click({'data-setup-email':email});assert.equal(p.byId('merchant-email').value,email);assert.equal(p.byId('provision-dialog').open,true);
 p.byId('config-snippet').value='const firebaseConfig = '+JSON.stringify(fakeConfig(TENANT))+';';await p.byId('parse-config').emit('click');assert.equal(p.byId('cfg-projectId').value,TENANT);p.byId('store-name').value='Store';p.byId('store-origin').value='https://store.example.com';p.byId('store-status').value='active';await p.byId('provision-form').emit('submit');await tick();assert.equal(p.byId('provision-dialog').open,false);assert.equal(p.byId('kpi-stores').textContent,'1');assert.match(p.byId('paid-list').innerHTML,/Store Connected/);
});
test('AURA seed button prefills config but never writes before explicit save',async()=>{
 const p=await harness({entry:'sqy-admin.js',masterSigned:true});await p.byId('use-aura-seed').emit('click');assert.equal(p.byId('merchant-email').value,EMAIL);assert.equal(p.byId('cfg-projectId').value,TENANT);assert.equal(p.state.calls.filter(c=>c.type==='write').length,0);
});
test('mobile Master logout clears the private workspace and all subscriptions',async()=>{
 const p=await harness({entry:'sqy-admin.js',masterSigned:true});await p.byId('sqy-mobile-logout').emit('click');await tick();assert.equal(p.byId('admin-view').hidden,true);assert.equal(p.byId('master-email').textContent,'');assert.equal(p.state.listeners.length,0);
});
