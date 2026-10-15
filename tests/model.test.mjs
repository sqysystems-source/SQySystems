import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseFirebaseSnippet,validateProvisioning,parsePaymentAmount,validatePaidOrder,ticketStatus,canManageAgency,descriptorFromRecord,normalizeEmail} from '../public/js/agency-model.js';
import {fakeConfig,storeRecord,EMAIL,TENANT} from './harness.mjs';

test('Firebase snippet parser accepts JSON and literal JS config with comments/trailing commas',()=>{
 const config=fakeConfig(TENANT);assert.deepEqual(parseFirebaseSnippet(JSON.stringify(config)),config);
 const snippet=`// copied from Console\nconst firebaseConfig = { apiKey: 'test-public-key', authDomain: 'test-db-f6315.firebaseapp.com', projectId: 'test-db-f6315', storageBucket: 'test-db-f6315.firebasestorage.app', messagingSenderId: '123456', appId: '1:123456:web:abc123', measurementId: 'G-OPTIONAL', };`;
 assert.deepEqual(parseFirebaseSnippet(snippet),config);
});
test('parser rejects execution, script suffixes, expressions, duplicate keys and service accounts',()=>{
 const config=JSON.stringify(fakeConfig(TENANT));
 for(const raw of [config+';alert(1)',config.replace('"test-public-key"','fetch("https://bad.example")'),config.replace('"test-public-key"','`template`'),config.replace('"apiKey":','"apiKey":"duplicate","apiKey":'),JSON.stringify({...fakeConfig(TENANT),private_key:'secret'}),'{ apiKey: "missing" }','{...anotherConfig}', 'const cfg = '+config+'; initializeApp(cfg);'])assert.throws(()=>parseFirebaseSnippet(raw));
});
test('API origin and config validation reject malformed URLs and missing or secret fields',()=>{
 const record=storeRecord();const {updatedAt,...input}=record;assert.equal(validateProvisioning(input).merchantEmail,EMAIL);
 for(const url of ['http://store.example','https://user:pass@store.example','https://store.example/api','[https://store.example](https://store.example)','https://store.example:444'])assert.throws(()=>validateProvisioning({...input,storeApiBaseUrl:url}));
 assert.throws(()=>validateProvisioning({...input,firebaseConfig:{...input.firebaseConfig,private_key:'secret'}}));assert.throws(()=>validateProvisioning({...input,status:'deleted'}));
});
test('payment amounts preserve cents and reject ambiguous or invalid totals',()=>{
 assert.equal(parsePaymentAmount('700,50'),70050);assert.equal(parsePaymentAmount('0.01'),1);assert.equal(parsePaymentAmount('1000000.00'),100000000);
 for(const raw of ['-1','0','1.234,56','1e3','700.999','1000001','NaN'])assert.throws(()=>parsePaymentAmount(raw));
 assert.throws(()=>validatePaidOrder({clientEmail:EMAIL,clientName:'Client',packageDetails:'E-shop',amount:'700',paidDate:'2026-02-31'}));
});
test('routing identity, statuses and Master roles fail closed',()=>{
 assert.equal(normalizeEmail(' KOSTAS6603@GMAIL.COM '),EMAIL);assert.throws(()=>normalizeEmail('a/b@example.com'));
 for(const role of ['client','Admin','super-admin',null])assert.equal(canManageAgency({role}),false);assert.equal(canManageAgency({role:'admin'}),true);assert.equal(canManageAgency({role:'superadmin'}),true);
 assert.equal(ticketStatus({}),'unread');assert.equal(ticketStatus({status:'resolved'}),'resolved');
 assert.throws(()=>descriptorFromRecord(EMAIL,storeRecord('other@example.com')));assert.throws(()=>descriptorFromRecord(EMAIL,storeRecord(EMAIL,{status:'disabled'})));
});
