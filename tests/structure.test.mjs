import {test} from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { SourceTextModule, createContext, SyntheticModule } from 'node:vm';
import { AURA_FIREBASE_CONFIG, STORE_DIRECTORY, hasManagedMerchant, resolveMerchantStore, validateTenantStore, storeApiUrl } from '../public/js/tenant-config.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const config={storeName:'AURA',storeApiBaseUrl:'https://www.sqysystemsdev.org',firebaseConfig:{apiKey:'test-public-key',authDomain:'test-db-f6315.firebaseapp.com',projectId:'test-db-f6315',storageBucket:'test-db-f6315.firebasestorage.app',messagingSenderId:'123456',appId:'1:123456:web:abc123'}};
const files=[resolve(root,'app.js'),resolve(root,'firebase-config.js'),...readdirSync(resolve(root,'public/js')).filter(n=>n.endsWith('.js')).map(n=>resolve(root,'public/js',n))];

test('directory has supplied AURA mapping; missing real keys are explicit and rejected',()=>{
 assert.equal(STORE_DIRECTORY.aura.storeName,'AURA');assert.equal(STORE_DIRECTORY.aura.storeApiBaseUrl,'https://www.sqysystemsdev.org');assert.equal(AURA_FIREBASE_CONFIG.projectId,'test-db-f6315');assert.ok(hasManagedMerchant(' KOSTAS6603@GMAIL.COM '));assert.ok(!hasManagedMerchant('other@example.com'));assert.throws(()=>resolveMerchantStore('kostas6603@gmail.com'),e=>e.code==='portal/store-not-configured');
});
test('strict public web configuration and API-origin validation',()=>{
 assert.deepEqual(validateTenantStore(config),config);
 for(const url of ['http://unsafe.example','https://user:secret@unsafe.example','https://unsafe.example/api','//unsafe.example','https://unsafe.example/?q=1','https://unsafe.example/#fragment','https://unsafe.example:444'])assert.throws(()=>validateTenantStore({...config,storeApiBaseUrl:url}));
 assert.throws(()=>validateTenantStore({...config,firebaseConfig:{...config.firebaseConfig,private_key:'secret'}}));
 assert.throws(()=>validateTenantStore({...config,firebaseConfig:{...config.firebaseConfig,projectId:'sqysystems-faa0e'}}));
});
test('only the tenant R2 and email endpoints can be built',()=>{
 assert.equal(storeApiUrl(config,'/api/r2?action=download-url'),'https://www.sqysystemsdev.org/api/r2?action=download-url');
 for(const path of ['//evil.example','https://evil.example/api/r2','/api/r2/../else','/api/else','/api/send-email#x','/api/r2\n'])assert.throws(()=>storeApiUrl(config,path));
});
test('all JS parses and actual ES module import/export graph links',async()=>{
 const context=createContext({});const modules=new Map();const externalExports=new Map();
 for(const file of files){
  const source=readFileSync(file,'utf8');const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  for(const m of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](https:[^'"]+)['"]/g)){
   const names=externalExports.get(m[2])||new Set();m[1].split(',').map(n=>n.trim().split(/\s+as\s+/)[0]).filter(Boolean).forEach(n=>names.add(n));externalExports.set(m[2],names);
  }
  assert.ok(!/fetch\(['"]\/api\//.test(source),`${file}: unbridged endpoint`);
  assert.ok(!source.includes('10.12.2'),`${file}: mixed Firebase SDK`);
 }
 const load=(id)=>{
  if(modules.has(id))return modules.get(id);
  const mod=id.startsWith('https:')?new SyntheticModule([...externalExports.get(id)],function(){for(const name of externalExports.get(id))this.setExport(name,()=>{})},{context,identifier:id}):new SourceTextModule(readFileSync(id,'utf8'),{context,identifier:id});modules.set(id,mod);return mod;
 };
 const linker=(name,ref)=>load(name.startsWith('https:')?name:resolve(dirname(ref.identifier),name));
 // Link only, without evaluation or any live SDK network/Firestore calls.
 for(const file of files){const mod=load(file);if(mod.status==='unlinked')await mod.link(linker);assert.ok(['linked','evaluated'].includes(mod.status),file)}
});
test('merchant HTML contains exactly one credential form and no setup controls',()=>{
 const html=readFileSync(resolve(root,'public/admin.html'),'utf8');
 assert.doesNotMatch(html,/tenant-setup|data-configure-store|tenant-firebase-config|portal-master-logout/);
 assert.equal([...html.matchAll(/type="password"/g)].length,1);assert.equal([...html.matchAll(/id="admin-login-form"/g)].length,1);
 for(const file of ['public/js/tenant-bridge.js','public/js/merchant-session.js'])assert.doesNotMatch(readFileSync(resolve(root,file),'utf8'),/masterAuth|masterDb|firebase-config\.js|store_directory/);
});
test('HTML local assets and IDs resolve; config files parse',()=>{
 for(const path of ['index.html','public/admin.html']){
  const file=resolve(root,path),html=readFileSync(file,'utf8');const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);assert.equal(new Set(ids).size,ids.length);
  for(const [,value]of html.matchAll(/\b(?:src|href)="([^"]+)"/g)){if(/^(https?:|#|mailto:|tel:|data:)/.test(value))continue;assert.ok(existsSync(resolve(dirname(file),value.split('?')[0])),`${path}: ${value}`)}
 }
 for(const path of ['firebase.json','vercel.json','package.json'])JSON.parse(readFileSync(resolve(root,path),'utf8'));
});
test('Master policy freezes agency routing fields and denies directory client access',()=>{
 const rules=readFileSync(resolve(root,'firestore.rules'),'utf8');assert.match(rules,/affectedKeys\(\)\.hasAny\(\['role', 'tenantStore', 'storeSlug'\]\)/);assert.match(rules,/match \/store_directory\/\{storeId\} \{\s*allow read, write: if false;/);assert.match(rules,/allow read, update, delete: if false;/);
});
