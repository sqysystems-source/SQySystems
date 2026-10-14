// Real browser and real application modules, with network-level Firebase/CDN
// fixtures. No production credentials, accounts or databases are modified.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';
let playwright;
try { playwright = await import('playwright'); }
catch {
    if (!process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES) throw new Error('Run npm install and npx playwright install chromium first.');
    playwright = createRequire(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES + '/')('playwright');
}
const root = fileURLToPath(new URL('../', import.meta.url));
const config = {
    storeName: 'AURA', storeApiBaseUrl: 'https://aura.example.com',
    firebaseConfig: { apiKey:'public-web-api-key', authDomain:'aura-test.firebaseapp.com', projectId:'aura-test', storageBucket:'aura-test.firebasestorage.app', messagingSenderId:'123456', appId:'1:123456:web:abc123' }
};
const server = createServer(async (req,res) => {
    const pathname = new URL(req.url,'http://local').pathname;
    const file = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    try {
        const body = await readFile(file);
        res.writeHead(200, { 'Content-Type': ({'.js':'text/javascript','.html':'text/html','.css':'text/css','.svg':'image/svg+xml'})[extname(file)] || 'text/plain', 'Cache-Control':'no-store' });
        res.end(body);
    } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0,'127.0.0.1',r));
const origin = `http://127.0.0.1:${server.address().port}`;
const mockApp = `
export function initializeApp(options,name='[DEFAULT]') { return {options,name}; }
`;
const mockAuth = `
const m=window.__mock;
function userFor(name,email) { return {uid:name==='[DEFAULT]'?'master-uid':'tenant-uid', email, getIdToken:async()=>name==='[DEFAULT]'?'MASTER-TOKEN':'TENANT-TOKEN', metadata:{creationTime:new Date().toISOString()}}; }
export function getAuth(app) {
 if(!m.auths[app.name]) {
  const email=sessionStorage.getItem('auth:'+app.name);
  m.auths[app.name]={app,currentUser:email?userFor(app.name,email):null,authStateReady:async()=>{}};
 }
 return m.auths[app.name];
}
export function onAuthStateChanged(auth,callback) {
 const entry={auth,callback};m.authListeners.push(entry);queueMicrotask(()=>{if(m.authListeners.includes(entry))callback(auth.currentUser)});
 return ()=>{m.authListeners=m.authListeners.filter(x=>x!==entry)};
}
export async function signInWithEmailAndPassword(auth,email,password) {
 m.calls.push({type:'login',project:auth.app.options.projectId,email});
 if(password!=='correct-password') {const error=new Error('Invalid password');error.code='auth/invalid-credential';throw error;}
 auth.currentUser=userFor(auth.app.name,email);sessionStorage.setItem('auth:'+auth.app.name,email);
 m.authListeners.filter(e=>e.auth===auth).forEach(e=>queueMicrotask(()=>e.callback(auth.currentUser)));
 return {user:auth.currentUser};
}
export async function signOut(auth) {
 auth.currentUser=null;sessionStorage.removeItem('auth:'+auth.app.name);
 m.calls.push({type:'logout',project:auth.app.options.projectId});
 m.authListeners.filter(e=>e.auth===auth).forEach(e=>queueMicrotask(()=>e.callback(null)));
}
export const browserSessionPersistence={};
export async function setPersistence() {}
export async function createUserWithEmailAndPassword(auth,email,password) {return signInWithEmailAndPassword(auth,email,password)}
export async function updateProfile() {}
export async function sendPasswordResetEmail() {}
`;
const mockFirestore = `
const m=window.__mock;
export const getFirestore=app=>({app});
export function doc(db,...parts) { return {db:db.db||db,path:parts.join('/'),kind:'doc'}; }
export function collection(db,...parts) {return {db:db.db||db,path:parts.join('/'),kind:'collection'};}
export function query(ref,...constraints) {return {...ref,constraints};}
const constraint=(...args)=>args;
export const where=constraint, orderBy=constraint, limit=constraint, startAfter=constraint, documentId=()=> '__name__';
export const serverTimestamp=()=>({seconds:1}), deleteField=()=>null;
export class Timestamp { static now(){return new Timestamp()} static fromDate(d){return {toDate:()=>d}} static fromMillis(n){return {toDate:()=>new Date(n)}} toDate(){return new Date()} }
function dataFor(ref) {
 if(ref.db.app.options.projectId==='sqysystems-faa0e' && ref.path.startsWith('users/')) return {uid:'master-uid',displayName:'Merchant',company:'Agency',role:'client',...(m.config()?{tenantStore:m.config()}: {})};
 if(ref.path==='users/tenant-uid') return {role:m.role,uid:'tenant-uid'};
 if(ref.path==='settings/categories') return {list:[{name:'ΦΟΡΕΜΑ',hasSizes:true,hasColors:true,subcategories:[{id:'mini',name:'MINI'}]}]};
 if(ref.path==='settings/shipping') return {baseCost:3,islandCost:4,remoteCost:5,freeThreshold:50};
 return undefined;
}
function snap(ref) {const data=dataFor(ref);return {id:ref.path.split('/').pop(),ref,exists:()=>!!data,data:()=>data,metadata:{fromCache:false,hasPendingWrites:false}};}
function empty(){return {docs:[],empty:true,size:0,metadata:{fromCache:false,hasPendingWrites:false},forEach(){},docChanges:()=>[]}}
function record(type,ref){m.calls.push({type,project:ref.db.app.options.projectId,path:ref.path})}
export async function getDocFromServer(ref) {record('server-read',ref);if(m.denyMaster && ref.db.app.options.projectId==='sqysystems-faa0e'){const e=new Error('Denied');e.code='permission-denied';throw e;}return snap(ref)}
export const getDoc=getDocFromServer;
export async function getDocs(ref) {record('query',ref);return empty()}
export async function getCountFromServer(){return {data:()=>({count:0})}}
export function onSnapshot(ref,...args){const callback=args.find(a=>typeof a==='function');const entry={ref,callback};m.listeners.push(entry);record('listen',ref);queueMicrotask(()=>{if(m.listeners.includes(entry))callback(ref.kind==='doc'?snap(ref):empty())});return ()=>{m.listeners=m.listeners.filter(e=>e!==entry)}}
export async function setDoc(ref,data) {record('write',ref);if(ref.db.app.options.projectId==='sqysystems-faa0e' && data.tenantStore) sessionStorage.setItem('mock-config',JSON.stringify(data.tenantStore));}
export const updateDoc=setDoc;
export async function addDoc(ref,data){record('write',ref);return {id:'new-record'}}
export async function deleteDoc(ref){record('delete',ref)}
export function writeBatch(){return {set(){},update(){},delete(){},commit:async()=>{}}}
export async function runTransaction(db,callback){return callback({get:getDoc,set:setDoc,update:setDoc,delete:deleteDoc})}
m.emitProfiles=()=>m.listeners.filter(e=>e.ref.kind==='doc' && e.ref.path.startsWith('users/')).forEach(e=>e.callback(snap(e.ref)));
`;
let browser;
const passed=[];
async function scenario(name, seed, run, viewport={width:1440,height:1000}) {
    const context = await browser.newContext({viewport});
    await context.addInitScript(({seed,config})=>{
        if(!sessionStorage.getItem('mock-seeded')) {
            sessionStorage.setItem('mock-seeded','1');
            if(seed.masterSigned) sessionStorage.setItem('auth:[DEFAULT]','merchant@example.com');
            if(seed.configured) sessionStorage.setItem('mock-config',JSON.stringify(config));
            if(seed.boundTenant) {
                sessionStorage.setItem('auth:tenantStoreApp','admin@example.com');
                sessionStorage.setItem('sqysystems:tenant-session',JSON.stringify({masterUid:seed.wrongBinding?'other-master':'master-uid',projectId:'aura-test',tenantUid:'tenant-uid'}));
            }
        }
        window.__mock={calls:[],listeners:[],auths:{},authListeners:[],role:seed.nonAdmin?'customer':'admin',denyMaster:seed.denyMaster,config:()=>JSON.parse(sessionStorage.getItem('mock-config')||'null')};
        window.alert=()=>{};
    },{seed,config});
    const page=await context.newPage();const errors=[];const apiCalls=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',async route=>{
        const url=route.request().url();
        if(url.startsWith(origin)) return route.continue();
        if(url.includes('firebase-app.js')) return route.fulfill({contentType:'text/javascript',body:mockApp});
        if(url.includes('firebase-auth.js')) return route.fulfill({contentType:'text/javascript',body:mockAuth});
        if(url.includes('firebase-firestore.js')) return route.fulfill({contentType:'text/javascript',body:mockFirestore});
        if(url.startsWith(config.storeApiBaseUrl)) {
            apiCalls.push({url,authorization:route.request().headers().authorization});
            return route.fulfill({contentType:'application/json',body:JSON.stringify({productImagesBytes:123,cloudDriveBytes:456})});
        }
        if(route.request().resourceType()==='script') return route.fulfill({contentType:'text/javascript',body:`window.tailwind={}; window.Quill=class { constructor(el){this.root=document.createElement('div');el.append(this.root)} setText(text){this.root.textContent=text} }; window.Chart=class {destroy(){}};`});
        return route.fulfill({body:'',contentType:'text/css'});
    });
    const waitStage=async stage=>page.waitForFunction(stage=>stage==='dashboard'?document.getElementById('dashboard-view')?.classList.contains('flex'):stage==='setup'?!document.getElementById('tenant-setup-view')?.classList.contains('hidden'):document.getElementById('portal-login-title')?.textContent.includes(stage),stage);
    try {
        await page.goto(origin+'/public/admin.html');
        await run({page,context,apiCalls,waitStage});
        assert.deepEqual(errors,[],`${name}: browser errors`);
        passed.push(name); console.log('PASS '+name);
    } finally {await context.close()}
}
async function login(page,email='admin@example.com',password='correct-password') {
    await page.locator('#admin-email').fill(email);await page.locator('#admin-password').fill(password);await page.locator('#login-submit-btn').click();
}
try {
    browser=await playwright.chromium.launch({headless:true});
    await scenario('Master login, wizard save, distinct tenant login and all admin tabs',{configured:false},async({page,apiCalls,waitStage})=>{
        await page.locator('#admin-login-form').waitFor({state:'visible'});
        assert.match(await page.locator('#portal-login-description').textContent(),/SQySystems/);
        await login(page,'merchant@example.com');await waitStage('setup');
        await page.locator('#tenant-store-name').fill('AURA');await page.locator('#tenant-api-base').fill(config.storeApiBaseUrl);
        await page.locator('#tenant-firebase-config').fill(JSON.stringify(config.firebaseConfig));await page.locator('#tenant-save-setup').click();
        await waitStage('Σύνδεση καταστήματος');
        assert.equal(await page.locator('#dashboard-view').isVisible(),false);
        await login(page);await waitStage('dashboard');
        assert.equal(await page.locator('[data-tenant-store-name]').textContent(),'AURA');
        for(const tab of ['products','customers','support','analytics','cloud-drive','logs','settings','orders']) await page.locator('#nav-'+tab).click();
        await page.waitForFunction(()=>window.__mock.calls.some(c=>c.type==='query' && c.path==='orders'));
        const calls=await page.evaluate(()=>window.__mock.calls);
        assert.ok(calls.some(c=>c.project==='aura-test' && c.path==='products'));
        assert.ok(calls.filter(c=>c.project==='sqysystems-faa0e'&&c.path).every(c=>c.path==='users/master-uid'));
        assert.ok(apiCalls.length>0);assert.ok(apiCalls.every(c=>c.authorization==='Bearer TENANT-TOKEN'));
    });
    await scenario('wrong password is retryable',{masterSigned:true,configured:true},async({page,waitStage})=>{
        await waitStage('Σύνδεση καταστήματος');await login(page,'admin@example.com','wrong-password');
        await page.locator('#login-error').waitFor({state:'visible'});
        assert.equal(await page.locator('#login-submit-btn').isDisabled(),false);
        await login(page);await waitStage('dashboard');
    });
    await scenario('tenant customer denied before feature data reads',{masterSigned:true,configured:true,nonAdmin:true},async({page,waitStage})=>{
        await waitStage('Σύνδεση καταστήματος');await login(page);
        await page.locator('#login-error').waitFor({state:'visible'});
        assert.match(await page.locator('#login-error').textContent(),/role: admin/);
        assert.equal(await page.locator('#dashboard-view').isVisible(),false);
        const calls=await page.evaluate(()=>window.__mock.calls);
        assert.ok(!calls.some(c=>c.project==='aura-test'&&c.path&&!c.path.startsWith('users/')));
    });
    await scenario('persisted tenant cannot cross Master identity',{masterSigned:true,configured:true,boundTenant:true,wrongBinding:true},async({page,waitStage})=>{
        await waitStage('Σύνδεση καταστήματος');
        assert.equal(await page.locator('#dashboard-view').isVisible(),false);
        assert.equal(await page.evaluate(()=>window.__mock.auths.tenantStoreApp.currentUser),null);
    });
    await scenario('valid bound tenant session resumes and mobile logout clears both accounts',{masterSigned:true,configured:true,boundTenant:true},async({page,waitStage})=>{
        await waitStage('dashboard');
        assert.equal(await page.evaluate(()=>window.__mock.calls.filter(c=>c.type==='login').length),0);
        const box=await page.locator('[data-configure-store]').last().boundingBox();assert.ok(box && box.width>0);
        await page.locator('#mobile-logout-btn').click();await page.waitForURL(origin+'/index.html');
        assert.equal(await page.evaluate(()=>sessionStorage.getItem('auth:[DEFAULT]')),null);
        assert.equal(await page.evaluate(()=>sessionStorage.getItem('auth:tenantStoreApp')),null);
        assert.equal(await page.evaluate(()=>sessionStorage.getItem('sqysystems:tenant-session')),null);
    },{width:390,height:844});
    await scenario('configure store reloads before allowing a config change',{masterSigned:true,configured:true,boundTenant:true},async({page,waitStage})=>{
        await waitStage('dashboard');await page.locator('[data-configure-store]').last().click();await waitStage('setup');
        assert.equal(await page.locator('#tenant-store-name').inputValue(),'AURA');
        assert.equal(await page.evaluate(()=>sessionStorage.getItem('auth:tenantStoreApp')),null);
        assert.equal(await page.evaluate(()=>window.__mock.calls.some(c=>c.project==='aura-test')),false);
        await page.locator('#tenant-cancel-setup').click();await waitStage('Σύνδεση καταστήματος');
    });
    await scenario('tenant role revocation locks and removes remembered session',{masterSigned:true,configured:true,boundTenant:true},async({page,waitStage})=>{
        await waitStage('dashboard');
        await page.evaluate(()=>{window.__mock.role='customer';window.__mock.emitProfiles()});
        await waitStage('Σύνδεση καταστήματος');
        assert.equal(await page.locator('#dashboard-view').isVisible(),false);
        assert.equal(await page.evaluate(()=>sessionStorage.getItem('sqysystems:tenant-session')),null);
    });
    await scenario('cross-tab Master signout removes tenant session',{masterSigned:true,configured:true,boundTenant:true},async({page,waitStage})=>{
        await waitStage('dashboard');
        await page.evaluate(async()=>{const {auth}=await import('/firebase-config.js');const {signOut}=await import('https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js');await signOut(auth)});
        await page.locator('#admin-login-form').waitFor({state:'visible'});
        await page.waitForFunction(()=>!sessionStorage.getItem('auth:tenantStoreApp'));
        assert.match(await page.locator('#portal-login-description').textContent(),/λογαριασμό SQySystems/);
    });
    await scenario('cross-tab config changes reset the module graph',{masterSigned:true,configured:true,boundTenant:true},async({page,waitStage})=>{
        await waitStage('dashboard');
        await page.evaluate(()=>{const config=window.__mock.config();config.storeName='NEXT STORE';sessionStorage.setItem('mock-config',JSON.stringify(config));window.__mock.emitProfiles()});
        await waitStage('Σύνδεση καταστήματος');
        assert.match(await page.locator('#portal-login-description').textContent(),/NEXT STORE/);
        assert.equal(await page.locator('#dashboard-view').isVisible(),false);
    });
    await scenario('Master read failures remain recoverable',{masterSigned:true,configured:true,denyMaster:true},async({page})=>{
        await page.locator('#login-error').waitFor({state:'visible'});
        assert.equal(await page.locator('#portal-retry').isVisible(),true);
        assert.equal(await page.locator('#portal-master-logout').isVisible(),true);
        assert.equal(await page.locator('#dashboard-view').isVisible(),false);
    });
    console.log(`${passed.length} browser scenarios passed (mock Firebase/CDN network).`);
} finally {await browser?.close();await new Promise(r=>server.close(r))}
