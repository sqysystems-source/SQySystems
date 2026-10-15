import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {SourceTextModule,SyntheticModule,createContext} from 'node:vm';
const root=fileURLToPath(new URL('../',import.meta.url));
const files=['app.js','firebase-config.js','sqy-admin.js',...readdirSync(resolve(root,'public/js')).filter(n=>n.endsWith('.js')).map(n=>'public/js/'+n)].map(n=>resolve(root,n));
test('all project JavaScript parses and actual ES module graph links without broken imports',async()=>{
 const context=createContext({}),modules=new Map(),external=new Map();
 for(const file of files){const source=readFileSync(file,'utf8');const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);for(const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](https:[^'"]+)['"]/g)){const names=external.get(match[2])||new Set();match[1].split(',').map(n=>n.trim().split(/\s+as\s+/)[0]).filter(Boolean).forEach(n=>names.add(n));external.set(match[2],names)}assert.ok(!/fetch\(['"]\/api\//.test(source),file);assert.ok(!source.includes('10.12.2'),file);}
 const load=id=>{if(modules.has(id))return modules.get(id);const mod=id.startsWith('https:')?new SyntheticModule([...external.get(id)],function(){for(const name of external.get(id))this.setExport(name,()=>{})},{context,identifier:id}):new SourceTextModule(readFileSync(id,'utf8'),{context,identifier:id});modules.set(id,mod);return mod};
 for(const file of files){const mod=load(file);if(mod.status==='unlinked')await mod.link((name,ref)=>load(name.startsWith('https:')?name:resolve(dirname(ref.identifier),name)));assert.equal(mod.status,'linked');}
});
test('all local HTML assets resolve; IDs are unique; config JSON parses',()=>{
 for(const file of ['index.html','public/admin.html','sqy-admin.html']){const path=resolve(root,file),html=readFileSync(path,'utf8'),ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);assert.equal(ids.length,new Set(ids).size);for(const [,value]of html.matchAll(/\b(?:src|href)="([^"]+)"/g)){if(/^(https?:|#|mailto:|tel:|data:)/.test(value))continue;assert.ok(existsSync(resolve(dirname(path),value.split('?')[0])),`${file}: ${value}`)}}
 for(const file of ['package.json','firebase.json','vercel.json'])JSON.parse(readFileSync(resolve(root,file),'utf8'));
});
test('landing contact colors outrank generic form rules and navbar auth links default hidden',()=>{
 const html=readFileSync(resolve(root,'index.html'),'utf8'),css=readFileSync(resolve(root,'styles.css'),'utf8');
 assert.match(html,/<a href="public\/admin.html"[^>]*data-user-only[^>]*hidden/);assert.match(html,/<a href="sqy-admin.html"[^>]*data-sqy-admin[^>]*hidden/);
 assert.match(css,/#contact \.field--dark > span \{ color: #f1f4f8; \}/);assert.match(css,/#contact \.field__count, #contact \.field__count span \{ color: #c3ccd5; \}/);
 assert.ok(css.lastIndexOf('#contact .field--dark')>css.lastIndexOf('.field span'));
});
test('merchant screen retains one login and the superadmin workspace uses its own entry point',()=>{
 const html=readFileSync(resolve(root,'public/admin.html'),'utf8');assert.doesNotMatch(html,/tenant-setup|data-configure-store/);assert.equal([...html.matchAll(/type="password"/g)].length,1);
 const admin=readFileSync(resolve(root,'sqy-admin.html'),'utf8');assert.match(admin,/src="sqy-admin.js"/);assert.match(admin,/id="admin-view"[^>]*hidden/);assert.match(admin,/id="sqy-mobile-logout"/);
});
