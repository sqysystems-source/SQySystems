import { SourceTextModule, createContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export const root = new URL('../', import.meta.url);
export const EMAIL = 'kostas6603@gmail.com';
export const SESSION_KEY = 'sqysystems:managed-merchant:v1';
export class Element {
    constructor(attrs = {}) {
        this.attrs = attrs; this.id = attrs.id; this.hidden = 'hidden' in attrs;
        this.value = ''; this.textContent = ''; this.innerHTML = ''; this.disabled = false;
        this.handlers = {}; this.dataset = {}; this.style = {};
        const classes = new Set((attrs.class || '').split(/\s+/));
        this.classList = {
            add: (...keys) => keys.forEach(k => classes.add(k)), remove: (...keys) => keys.forEach(k => classes.delete(k)),
            contains: k => classes.has(k), replace: (a,b) => { if (classes.has(a)) { classes.delete(a); classes.add(b); } },
            toggle: (k,force) => { const add = force === undefined ? !classes.has(k) : force; if (add) classes.add(k); else classes.delete(k); }
        };
    }
    addEventListener(type, callback) { (this.handlers[type] ||= []).push(callback); }
    async emit(type) { for (const callback of this.handlers[type] || []) await callback({ preventDefault(){}, stopImmediatePropagation(){}, target:this }); }
    setAttribute(k,v) { this.attrs[k] = v; }
    getAttribute(k) { return this.attrs[k]; }
    focus() {}
    reset() {}
    querySelector() { return null; }
    querySelectorAll() { return []; }
}
export const tick = async () => { for (let i=0; i<8; i++) await new Promise(r => setImmediate(r)); };
const mockApp = `
export function initializeApp(options,name='[DEFAULT]') { window.__mock.calls.push({type:'init',project:options.projectId,name}); return {options,name}; }
export async function deleteApp(app) { window.__mock.calls.push({type:'deleteApp',project:app.options.projectId}); }
`;
const mockAuth = `
const m=window.__mock;
function user(auth,email,uid='tenant-uid') { return {uid:auth.app.name==='[DEFAULT]'?'master-uid':uid,email,getIdToken:async()=>auth.app.name==='[DEFAULT]'?'MASTER-TOKEN':'TENANT-TOKEN',metadata:{creationTime:new Date().toISOString()}}; }
export function getAuth(app) {
 const id=app.options.projectId; if(!m.auths[id]) {
  const saved=JSON.parse(sessionStorage.getItem('mock-auth:'+id)||'null');
  m.auths[id]={app,currentUser:null,authStateReady:async()=>{}};
  if(saved) m.auths[id].currentUser=user(m.auths[id],saved.email,saved.uid);
 }
 return m.auths[id];
}
function emit(auth) { m.authListeners.filter(e=>e.auth===auth).forEach(e=>queueMicrotask(()=>{if(m.authListeners.includes(e))e.callback(auth.currentUser)})); }
export function onAuthStateChanged(auth,callback,error) {
 const e={auth,callback,error};m.authListeners.push(e);queueMicrotask(()=>{if(m.authListeners.includes(e))callback(auth.currentUser)});
 return ()=>{m.authListeners=m.authListeners.filter(x=>x!==e)};
}
export async function signInWithEmailAndPassword(auth,email,password) {
 m.calls.push({type:'login',project:auth.app.options.projectId,email});
 if(password!=='correct-password') throw Object.assign(new Error('Wrong password'),{code:'auth/invalid-credential'});
 auth.currentUser=user(auth,m.wrongAuthEmail||email);
 sessionStorage.setItem('mock-auth:'+auth.app.options.projectId,JSON.stringify({email:auth.currentUser.email,uid:auth.currentUser.uid}));emit(auth);
 return {user:auth.currentUser};
}
export async function signOut(auth) {
 m.calls.push({type:'logout',project:auth.app.options.projectId});
 auth.currentUser=null;sessionStorage.removeItem('mock-auth:'+auth.app.options.projectId);emit(auth);
}
export const browserSessionPersistence={};
export async function setPersistence() { if(m.failPersistence) throw Object.assign(new Error('Storage disabled'),{code:'auth/web-storage-unsupported'}); }
export async function sendPasswordResetEmail(auth,email) { m.calls.push({type:'reset',project:auth.app.options.projectId,email}); }
export async function createUserWithEmailAndPassword(auth,email,password) { m.calls.push({type:'signup',project:auth.app.options.projectId});return signInWithEmailAndPassword(auth,email,password); }
export async function updateProfile() {}
`;
const mockFirestore = `
const m=window.__mock;
export const getFirestore=app=>({app});
export const doc=(db,...parts)=>({db,path:parts.join('/')});
export const collection=doc;
export const serverTimestamp=()=>({seconds:1});
function snapshot(ref) {return {exists:()=>!m.missingProfile,data:()=>({role:m.role}),metadata:{fromCache:false,hasPendingWrites:false}};}
export async function getDocFromServer(ref) {m.calls.push({type:'read',project:ref.db.app.options.projectId,path:ref.path});if(m.failRead)throw Object.assign(new Error('Network offline'),{code:'unavailable'});return snapshot(ref);}
export const getDoc=getDocFromServer;
export async function setDoc(ref,data) {m.calls.push({type:'write',project:ref.db.app.options.projectId,path:ref.path,data});}
export const updateDoc=setDoc;
export async function addDoc(ref,data) {m.calls.push({type:'write',project:ref.db.app.options.projectId,path:ref.path,data});return {id:'new'};}
export function onSnapshot(ref,...args) {const callback=args.find(a=>typeof a==='function');const e={ref,callback,error:args.filter(a=>typeof a==='function')[1]};m.listeners.push(e);queueMicrotask(()=>{if(m.listeners.includes(e))callback(snapshot(ref))});return ()=>{m.listeners=m.listeners.filter(x=>x!==e)};}
m.emitProfile=()=>m.listeners.forEach(e=>e.callback(snapshot(e.ref)));
`;
export async function environment(options={}) {
    const html = readFileSync(new URL(options.landing ? 'index.html' : 'public/admin.html', root), 'utf8');
    const nodes = [...html.matchAll(/<\w+\s+([^<>]+)>/g)].map(match => new Element(Object.fromEntries([...match[1].matchAll(/([\w-]+)(?:="([^"]*)"|='([^']*)')?/g)].map(m=>[m[1],m[2]??m[3]??'']))));
    const byId = id => nodes.find(n=>n.id===id) || null;
    const events = {};
    const document = {
        title:'', body:{style:{}},
        getElementById:byId,
        querySelector:selector=>selector.startsWith('#') ? byId(selector.slice(1)) : null,
        querySelectorAll(selector) { if (/^\[[\w-]+\]$/.test(selector)) {const attr=selector.slice(1,-1);return nodes.filter(n=>attr in n.attrs)} return []; },
        addEventListener(type,cb) { (events[type] ||= []).push(cb); }
    };
    const entries = options.storage || new Map();
    const state = { calls:[], auths:{}, authListeners:[], listeners:[], role:options.nonAdmin?'customer':'admin', failRead:options.failRead, failPersistence:options.failPersistence, wrongAuthEmail:options.wrongAuthEmail };
    const sessionStorage = {
        getItem:k=>entries.get(k)??null,
        setItem(k,v){if(options.failHintWrite && k===SESSION_KEY)throw Object.assign(new Error('No storage'),{name:'QuotaExceededError'});entries.set(k,String(v));},
        removeItem:k=>entries.delete(k)
    };
    let destination;
    const location = {
        href:'https://sqysystems.com/'+(options.landing?'index.html':'public/admin.html'), search:'',
        assign:url=>{destination=url},replace:url=>{destination=url},reload:()=>{destination=location.href}
    };
    const featureCalls = [];
    const window = { __mock:state, __feature:(name,context)=>featureCalls.push({name,context}), location, dispatchEvent(){}, scrollTo(){} };
    const context = createContext({ window, document, sessionStorage, URL, URLSearchParams, console, queueMicrotask, setTimeout, clearTimeout, Map, Set, JSON, Date, CustomEvent:class{} });
    const modules = new Map();
    const stubs = ['admin-orders.js','admin-products.js','admin-cloud-and-logs.js','admin-settings.js','admin-analytics.js','admin-notifications.js','category-store.js','catalog-snapshot.js'];
    function load(url) {
        if(modules.has(url))return modules.get(url);
        let source;
        if(url.includes('gstatic.com')) source=url.includes('firebase-app.js')?mockApp:url.includes('firebase-auth.js')?mockAuth:mockFirestore;
        else {
            source=readFileSync(fileURLToPath(url),'utf8');
            const name=url.split('/').pop();
            if(name==='tenant-config.js' && options.extraStore) {
                source=source.replace('    // Add stores using', `    beta: { merchantEmails: ['beta@example.com'], storeName: 'BETA', storeApiBaseUrl: 'https://beta.example.com', firebaseConfig: { apiKey: 'beta-public-key', authDomain: 'beta-store.firebaseapp.com', projectId: 'beta-store', storageBucket: 'beta-store.firebasestorage.app', messagingSenderId: '789012', appId: '1:789012:web:def456' } },\n    // Add stores using`);
            }
            if(name==='tenant-config.js' && !options.unconfigured) {
                source=source.replace('PASTE_AURA_API_KEY','test-public-key').replace('PASTE_AURA_STORAGE_BUCKET','test-db-f6315.firebasestorage.app').replace('PASTE_AURA_MESSAGING_SENDER_ID','123456').replace('PASTE_AURA_APP_ID','1:123456:web:abc123');
            }
            if(stubs.includes(name)) source=[...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map(m=>`export function ${m[1]}(context){window.__feature('${m[1]}',context)}`).join('\n');
            if(name==='app.js' && options.landing) {
                source=source.replace(/\ninit\(\);\s*$/, '\nexport { initLoginForm, initSignupForm };');
            }
        }
        const module=new SourceTextModule(source,{context,identifier:url,initializeImportMeta(meta){meta.url=url.startsWith(root.href)?'https://sqysystems.com/'+url.slice(root.href.length):url}});
        modules.set(url,module);return module;
    }
    const entry=load(new URL(options.landing?'app.js':'public/js/admin.js',root).href);
    await entry.link((specifier,ref)=>load(new URL(specifier,ref.identifier).href));
    await entry.evaluate();
    if(options.landing) entry.namespace.initLoginForm();
    else for(const callback of events.DOMContentLoaded||[])callback();
    await tick();
    const session=modules.get(new URL('public/js/merchant-session.js',root).href).namespace;
    const utils=modules.get(new URL('public/js/admin-utils.js',root).href)?.namespace;
    const login=async(email=EMAIL,password='correct-password')=>{
        byId(options.landing?'loginEmail':'admin-email').value=email;
        byId(options.landing?'loginPassword':'admin-password').value=password;
        await byId(options.landing?'loginForm':'admin-login-form').emit('submit');await tick();
    };
    return {session,utils,entry,byId,document,nodes,state,featureCalls,entries,login,modules,get destination(){return destination}};
}
