import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SourceTextModule,createContext} from 'node:vm';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=new URL('../',import.meta.url);
const browserTest=readFileSync(new URL('portal-browser.mjs',import.meta.url),'utf8');
const fixture=name=>browserTest.match(new RegExp(`const ${name} = \x60([\\s\\S]*?)\x60;`))[1];
const config={storeName:'AURA',storeApiBaseUrl:'https://aura.example.com',firebaseConfig:{apiKey:'public-web-api-key',authDomain:'aura-test.firebaseapp.com',projectId:'aura-test',storageBucket:'aura-test.firebasestorage.app',messagingSenderId:'123456',appId:'1:123456:web:abc123'}};
class Element {
    constructor(attrs={}) {
        this.attrs=attrs;this.id=attrs.id;this.hidden='hidden' in attrs;this.value='';this.textContent='';this.innerHTML='';this.disabled=false;this.handlers={};
        const values=new Set((attrs.class||'').split(/\s+/));
        this.classList={add:(...keys)=>keys.forEach(k=>values.add(k)),remove:(...keys)=>keys.forEach(k=>values.delete(k)),contains:k=>values.has(k),replace:(a,b)=>{if(values.has(a)){values.delete(a);values.add(b)}}};
    }
    addEventListener(type,callback){(this.handlers[type]||=[]).push(callback)}
    async emit(type){for(const callback of this.handlers[type]||[])await callback({preventDefault(){},stopImmediatePropagation(){},target:this})}
    focus(){}
    setAttribute(key,value){this.attrs[key]=value}
}
const tick=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r))};
async function portal(seed={}) {
    const html=readFileSync(new URL('public/admin.html',root),'utf8');
    const nodes=[...html.matchAll(/<\w+\s+([^<>]+)>/g)].map(match=>new Element(Object.fromEntries([...match[1].matchAll(/([\w-]+)(?:="([^"]*)"|='([^']*)')?/g)].map(m=>[m[1],m[2]??m[3]??'']))));
    const byId=id=>nodes.find(n=>n.id===id)||null;
    const handlers={};
    const document={title:'',getElementById:byId,querySelectorAll(selector){if(/^\[[\w-]+\]$/.test(selector)){const attr=selector.slice(1,-1);return nodes.filter(n=>attr in n.attrs)}return []},addEventListener(type,callback){(handlers[type]||=[]).push(callback)}};
    const entries=new Map();
    const sessionStorage={getItem:k=>entries.get(k)??null,setItem:(k,v)=>entries.set(k,String(v)),removeItem:k=>entries.delete(k)};
    if(seed.masterSigned)sessionStorage.setItem('auth:[DEFAULT]','merchant@example.com');
    if(seed.configured)sessionStorage.setItem('mock-config',JSON.stringify(config));
    if(seed.boundTenant){sessionStorage.setItem('auth:tenantStoreApp','admin@example.com');sessionStorage.setItem('sqysystems:tenant-session',JSON.stringify({masterUid:seed.wrongBinding?'other':'master-uid',projectId:'aura-test',tenantUid:'tenant-uid'}))}
    let destination;
    const location={href:'https://sqysystems.com/public/admin.html'+(seed.configure?'?configure=1':''),search:seed.configure?'?configure=1':'',replace:url=>{destination=url},reload:()=>{destination=location.href}};
    const state={calls:[],listeners:[],auths:{},authListeners:[],role:seed.nonAdmin?'customer':'admin',denyMaster:seed.denyMaster,config:()=>JSON.parse(sessionStorage.getItem('mock-config')||'null')};
    const featureCalls=[];
    const window={location,__mock:state,__feature:(name,context)=>featureCalls.push({name,context}),dispatchEvent(){}};
    const context=createContext({window,document,sessionStorage,URL,URLSearchParams,console,setTimeout,clearTimeout,queueMicrotask,CustomEvent:class{},Date,Map,Set,JSON});
    const modules=new Map();
    const stubs=['admin-orders.js','admin-products.js','admin-cloud-and-logs.js','admin-settings.js','admin-analytics.js','admin-notifications.js','category-store.js','catalog-snapshot.js'];
    function load(url){
        if(modules.has(url))return modules.get(url);
        let source;
        if(url.includes('gstatic.com')) source=fixture(url.includes('firebase-app.js')?'mockApp':url.includes('firebase-auth.js')?'mockAuth':'mockFirestore');
        else {
            source=readFileSync(fileURLToPath(url),'utf8');
            const name=url.split('/').pop();
            if(stubs.includes(name)) source=[...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map(m=>`export function ${m[1]}(context){window.__feature('${m[1]}',context)}`).join('\n');
        }
        const module=new SourceTextModule(source,{context,identifier:url,initializeImportMeta(meta){meta.url=url.startsWith('file:')?'https://sqysystems.com/'+url.slice(root.href.length):url}});
        modules.set(url,module);return module;
    }
    const entry=load(new URL('public/js/admin.js',root).href);
    await entry.link((specifier,ref)=>load(new URL(specifier,ref.identifier).href));
    await entry.evaluate();
    for(const callback of handlers.DOMContentLoaded||[])callback();
    await tick();
    const bridge=modules.get(new URL('public/js/tenant-bridge.js',root).href).namespace;
    const utils=modules.get(new URL('public/js/admin-utils.js',root).href).namespace;
    const login=async(email='admin@example.com',password='correct-password')=>{byId('admin-email').value=email;byId('admin-password').value=password;await byId('admin-login-form').emit('submit');await tick()};
    return {state,bridge,utils,byId,document,featureCalls,sessionStorage,login,tick,nodes,get destination(){return destination}};
}
const initialisations=p=>p.featureCalls.filter(c=>c.name.startsWith('init'));

test('Master authentication precedes wizard, config merges only owner profile',async()=>{
    const p=await portal();assert.equal(p.byId('admin-login-form').hidden,false);assert.equal(p.bridge.db,null);
    await p.login('merchant@example.com');assert.equal(p.byId('tenant-setup-view').classList.contains('hidden'),false);
    p.byId('tenant-store-name').value='AURA';p.byId('tenant-api-base').value=config.storeApiBaseUrl;p.byId('tenant-firebase-config').value=JSON.stringify(config.firebaseConfig);
    await p.byId('tenant-setup-form').emit('submit');await tick();
    assert.deepEqual(p.state.config(),config);assert.equal(p.destination,'https://sqysystems.com/public/admin.html');
    assert.ok(p.state.calls.filter(c=>c.path).every(c=>c.project==='sqysystems-faa0e'&&c.path==='users/master-uid'));
    assert.equal(initialisations(p).length,0);
});
test('tenant admin gates all six modules; db and token belong to tenant',async()=>{
    const p=await portal({masterSigned:true,configured:true});assert.equal(p.byId('admin-login-form').hidden,false);assert.equal(initialisations(p).length,0);
    await p.login();assert.equal(p.byId('dashboard-view').classList.contains('flex'),true);
    assert.equal(initialisations(p).length,6);assert.ok(initialisations(p).every(c=>c.context.currentUser.uid==='tenant-uid'));
    assert.equal(p.bridge.db.app.options.projectId,'aura-test');assert.equal(await p.utils.getCurrentUser().getIdToken(),'TENANT-TOKEN');
    assert.equal(p.bridge.buildStoreApiUrl('/api/r2?action=upload-url'),'https://aura.example.com/api/r2?action=upload-url');
    assert.match(p.document.title,/AURA/);assert.equal(p.byId('admin-password').value,'');
});
test('wrong tenant password clears credentials and permits retry',async()=>{
    const p=await portal({masterSigned:true,configured:true});await p.login('admin@example.com','wrong');
    assert.equal(p.byId('login-error').classList.contains('hidden'),false);assert.equal(p.byId('login-submit-btn').disabled,false);assert.equal(initialisations(p).length,0);
    await p.login();assert.equal(initialisations(p).length,6);
});
test('non-admin tenant is rejected without feature reads or initialisation',async()=>{
    const p=await portal({masterSigned:true,configured:true,nonAdmin:true});await p.login();
    assert.equal(p.byId('dashboard-view').classList.contains('hidden'),true);assert.equal(initialisations(p).length,0);assert.equal(p.utils.getCurrentUser(),null);
    assert.match(p.byId('login-error').textContent,/role: admin/);assert.equal(p.bridge.auth.currentUser,null);
    assert.ok(p.state.calls.filter(c=>c.project==='aura-test'&&c.path).every(c=>c.path==='users/tenant-uid'));
});
test('unrelated Master identity cannot inherit persisted tenant session',async()=>{
    const p=await portal({masterSigned:true,configured:true,boundTenant:true,wrongBinding:true});assert.equal(p.bridge.auth.currentUser,null);assert.equal(initialisations(p).length,0);
    assert.equal(p.sessionStorage.getItem('sqysystems:tenant-session'),null);
});
test('matching identity resumes tenant session without password replay',async()=>{
    const p=await portal({masterSigned:true,configured:true,boundTenant:true});assert.equal(initialisations(p).length,6);assert.ok(!p.state.calls.some(c=>c.type==='login'));
});
test('configuration entry takes fresh page before touching tenant Firebase',async()=>{
    const p=await portal({masterSigned:true,configured:true,configure:true,boundTenant:true});assert.equal(p.byId('tenant-store-name').value,'AURA');assert.equal(p.bridge.auth,null);assert.equal(initialisations(p).length,0);
    await p.byId('tenant-cancel-setup').emit('click');await tick();assert.equal(p.destination,'https://sqysystems.com/public/admin.html');
});
test('logout clears both auth sessions, data identity and tenant binding',async()=>{
    const p=await portal({masterSigned:true,configured:true,boundTenant:true});p.byId('orders-table-body').innerHTML='sensitive-data';
    await p.bridge.logoutPortal();await tick();assert.equal(p.destination,'https://sqysystems.com/index.html');assert.equal(p.utils.getCurrentUser(),null);
    assert.equal(p.byId('orders-table-body').innerHTML,'');assert.equal(p.sessionStorage.getItem('auth:[DEFAULT]'),null);assert.equal(p.sessionStorage.getItem('auth:tenantStoreApp'),null);assert.equal(p.sessionStorage.getItem('sqysystems:tenant-session'),null);
});
test('tenant role revocation immediately locks and clears remembered session',async()=>{
    const p=await portal({masterSigned:true,configured:true,boundTenant:true});p.state.role='customer';p.state.emitProfiles();await tick();
    assert.equal(p.utils.getCurrentUser(),null);assert.equal(p.byId('dashboard-view').classList.contains('hidden'),true);assert.equal(p.sessionStorage.getItem('sqysystems:tenant-session'),null);assert.equal(p.destination,'https://sqysystems.com/public/admin.html');
});
test('cross-tab config edit reloads without rebinding old modules to new db',async()=>{
    const p=await portal({masterSigned:true,configured:true,boundTenant:true});const config=p.state.config();config.firebaseConfig.projectId='different-store';p.sessionStorage.setItem('mock-config',JSON.stringify(config));p.state.emitProfiles();await tick();
    assert.equal(p.destination,'https://sqysystems.com/public/admin.html');assert.equal(p.utils.getCurrentUser(),null);assert.equal(p.bridge.db.app.options.projectId,'aura-test');
});
test('Master signout invalidates active tenant and clears portal data',async()=>{
    const p=await portal({masterSigned:true,configured:true,boundTenant:true});const master=p.state.auths['[DEFAULT]'];master.currentUser=null;
    for(const entry of p.state.authListeners.filter(e=>e.auth===master))await entry.callback(null);await tick();
    assert.equal(p.utils.getCurrentUser(),null);assert.equal(p.bridge.auth.currentUser,null);assert.equal(p.destination,'https://sqysystems.com/public/admin.html');
});
test('Master profile permission errors show retry without touching tenant',async()=>{
    const p=await portal({masterSigned:true,configured:true,denyMaster:true});assert.equal(p.byId('portal-retry').hidden,false);assert.equal(p.byId('login-error').classList.contains('hidden'),false);assert.equal(p.bridge.auth,null);assert.equal(initialisations(p).length,0);
});
test('wizard rejects non-JSON and service-account config without writes',async()=>{
    const p=await portal({masterSigned:true});p.byId('tenant-store-name').value='AURA';p.byId('tenant-api-base').value=config.storeApiBaseUrl;
    p.byId('tenant-firebase-config').value='const firebaseConfig = {}';await p.byId('tenant-setup-form').emit('submit');assert.match(p.byId('tenant-setup-error').textContent,/JSON/);
    p.byId('tenant-firebase-config').value=JSON.stringify({...config.firebaseConfig,private_key:'secret'});await p.byId('tenant-setup-form').emit('submit');assert.equal(p.state.calls.filter(c=>c.type==='write').length,0);
});
