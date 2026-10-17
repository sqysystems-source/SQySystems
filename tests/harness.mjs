import { SourceTextModule,createContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export const root=new URL('../',import.meta.url);
export const MASTER='sqysystems-faa0e';
export const TENANT='test-db-f6315';
export const EMAIL='kostas6603@gmail.com';
export const tick=async()=>{for(let i=0;i<10;i++)await new Promise(r=>setImmediate(r))};
export const fakeConfig=projectId=>({apiKey:'test-public-key',authDomain:`${projectId}.firebaseapp.com`,projectId,storageBucket:`${projectId}.firebasestorage.app`,messagingSenderId:'123456',appId:'1:123456:web:abc123'});
export const storeRecord=(email=EMAIL,extra={})=>({merchantEmail:email,storeName:'Managed AURA',storeApiBaseUrl:'https://dynamic.example.com',plan:'Custom E-Shop',status:'active',firebaseConfig:fakeConfig(TENANT),updatedAt:{seconds:1792100000,nanoseconds:0},...extra});
function parseElements(html){return [...html.matchAll(/<\w+\s+([^<>]+)>/g)].map(match=>new Element(Object.fromEntries([...match[1].matchAll(/([\w-]+)(?:="([^"]*)"|='([^']*)')?/g)].map(m=>[m[1],m[2]??m[3]??'']))));}
function matchElement(node,selector){
 const named=selector.match(/^input\[name="([^"]+)"\](:checked)?$/);
 if(named)return node.name===named[1]&&(!named[2]||node.checked);
 if(/^\[[\w-]+\]$/.test(selector))return selector.slice(1,-1) in node.attrs;
 if(selector.startsWith('.'))return (node.attrs.class||'').split(/\s+/).includes(selector.slice(1));
 return false;
}
class Element{
 constructor(attrs={}){attrs=Object.fromEntries(Object.entries(attrs).map(([k,v])=>[k,String(v).replaceAll('&quot;','"').replaceAll('&#39;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&')]));this.attrs=attrs;this.id=attrs.id;this.name=attrs.name;this.checked="checked" in attrs;this.hidden='hidden'in attrs;this.value=attrs.value||'';this.defaultValue=this.value;this.textContent='';this.innerHTML='';this.disabled=false;this.readOnly=false;this.open=false;this.handlers={};this.style={};this.dataset=Object.fromEntries(Object.entries(attrs).filter(([k])=>k.startsWith('data-')).map(([k,v])=>[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase()),v]));const values=new Set((attrs.class||'').split(/\s+/));this.classList={add:(...keys)=>keys.forEach(k=>values.add(k)),remove:(...keys)=>keys.forEach(k=>values.delete(k)),contains:k=>values.has(k),replace:(a,b)=>{if(values.has(a)){values.delete(a);values.add(b)}},toggle:(k,f)=>{const on=f===undefined?!values.has(k):f;if(on)values.add(k);else values.delete(k)}};}
 addEventListener(type,fn){(this.handlers[type]||=[]).push(fn)}
 async emit(type,extra={}){for(const fn of this.handlers[type]||[])await fn({preventDefault(){},stopImmediatePropagation(){},target:this,...extra})}
 get innerHTML(){return this._html||''} set innerHTML(value){this._html=value;this.children=parseElements(value)}
 appendChild(){} remove(){} removeAttribute(k){delete this.attrs[k]} setAttribute(k,v){this.attrs[k]=v}getAttribute(k){return this.attrs[k]}focus(){}reset(){}showModal(){this.open=true}close(){this.open=false}
 closest(selector){if(/^\[[\w-]+\]$/.test(selector)&&selector.slice(1,-1)in this.attrs)return this;return null}
 querySelector(selector){return this.querySelectorAll(selector)[0]||null}querySelectorAll(selector){return (this.allNodes?.()||this.children||[]).filter(n=>matchElement(n,selector))}
}
const appMock=`export function initializeApp(options,name='[DEFAULT]'){window.__mock.calls.push({type:'init',project:options.projectId});return {options,name}} export async function deleteApp(app){window.__mock.calls.push({type:'deleteApp',project:app.options.projectId})}`;
const authMock=`
const m=window.__mock;
function makeUser(auth,email,uid){return {uid:uid||(auth.app.options.projectId==='sqysystems-faa0e'?'master-uid':'tenant-uid'),email,metadata:{creationTime:'2026-01-01'},getIdToken:async()=>auth.app.options.projectId==='sqysystems-faa0e'?'MASTER-TOKEN':'TENANT-TOKEN'}};
export function getAuth(app){const project=app.options.projectId;if(!m.auths[project]){const saved=JSON.parse(sessionStorage.getItem('mock-auth:'+project)||'null');const auth={app,currentUser:null,authStateReady:async()=>{}};if(saved)auth.currentUser=makeUser(auth,saved.email,saved.uid);m.auths[project]=auth}return m.auths[project]}
function emit(auth){m.authListeners.filter(e=>e.auth===auth).forEach(e=>queueMicrotask(()=>{if(m.authListeners.includes(e))e.next(auth.currentUser)}))}
export function onAuthStateChanged(auth,next,error){const e={auth,next,error};m.authListeners.push(e);queueMicrotask(()=>{if(m.authListeners.includes(e))next(auth.currentUser)});return ()=>{m.authListeners=m.authListeners.filter(x=>x!==e)}}
export async function signInWithEmailAndPassword(auth,email,password){m.calls.push({type:'login',project:auth.app.options.projectId,email});if(password!=='correct-password')throw Object.assign(new Error('Invalid'),{code:'auth/invalid-credential'});auth.currentUser=makeUser(auth,m.wrongAuthEmail||email);sessionStorage.setItem('mock-auth:'+auth.app.options.projectId,JSON.stringify({uid:auth.currentUser.uid,email:auth.currentUser.email}));emit(auth);return {user:auth.currentUser}}
export async function signOut(auth){m.calls.push({type:'logout',project:auth.app.options.projectId});auth.currentUser=null;sessionStorage.removeItem('mock-auth:'+auth.app.options.projectId);emit(auth)}
export const browserSessionPersistence={};export async function setPersistence(){if(m.failPersistence)throw Object.assign(new Error('Storage disabled'),{code:'auth/web-storage-unsupported'})}
export async function sendPasswordResetEmail(auth,email){m.calls.push({type:'reset',project:auth.app.options.projectId,email})}
export async function createUserWithEmailAndPassword(auth,email,password){m.calls.push({type:'signup',project:auth.app.options.projectId});return signInWithEmailAndPassword(auth,email,password)}
export async function updateProfile(){}
`;
const firestoreMock=`
const m=window.__mock;
export const getFirestore=app=>({app});export const doc=(db,...parts)=>({db:db.db||db,path:parts.join('/'),kind:'doc'});export const collection=(db,...parts)=>({db:db.db||db,path:parts.join('/'),kind:'collection'});
export const serverTimestamp=()=>({__serverTimestamp:true});
export class Timestamp{static fromDate(date){return {seconds:Math.floor(date.getTime()/1000),nanoseconds:0,toMillis:()=>date.getTime()}}}
const key=ref=>ref.db.app.options.projectId+'/'+ref.path;
function single(ref){const data=m.records.get(key(ref));return {id:ref.path.split('/').pop(),exists:()=>data!==undefined,data:()=>data,metadata:{fromCache:false,hasPendingWrites:false}}}
function snapshot(ref){if(ref.kind==='doc')return single(ref);const prefix=key(ref)+'/';const docs=[...m.records].filter(([k])=>k.startsWith(prefix)&&!k.slice(prefix.length).includes('/')).map(([k,data])=>({id:k.slice(prefix.length),data:()=>data}));return {docs,metadata:{fromCache:false,hasPendingWrites:false}}}
function record(type,ref){m.calls.push({type,project:ref.db.app.options.projectId,path:ref.path})}
export async function getDocFromServer(ref){record('read',ref);await m.readHook?.(ref);if(ref.db.app.options.projectId==='sqysystems-faa0e'&&ref.path.startsWith('merchant_stores/'))m.directoryReadHook?.();if(m.directoryFailure&&ref.db.app.options.projectId==='sqysystems-faa0e'&&ref.path.startsWith('merchant_stores/'))throw Object.assign(new Error('Directory failure'),{code:m.directoryFailure});return single(ref)}
export const getDoc=getDocFromServer;
function resolveValues(value){if(value?.__serverTimestamp)return {seconds:++m.clock,nanoseconds:0};if(Array.isArray(value))return value.map(resolveValues);if(value&&typeof value==='object'&&!value.toMillis&&!value.toDate)return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,resolveValues(v)]));return value}
function write(ref,data,merge=false){if(m.failWrite)throw Object.assign(new Error('Write unavailable'),{code:m.failWrite});record('write',ref);m.records.set(key(ref),{...(merge?m.records.get(key(ref)):{}),...resolveValues(data)});m.emit(ref.db.app.options.projectId,ref.path)}
export async function setDoc(ref,data,options){write(ref,data,options?.merge)}
export async function updateDoc(ref,data){write(ref,data,true)}
export async function addDoc(ref,data){const target=doc(ref.db,ref.path,'auto-'+(++m.autoId));write(target,data);return {id:target.path.split('/').pop()}}
export async function deleteDoc(ref){record('delete',ref);m.records.delete(key(ref));m.emit(ref.db.app.options.projectId,ref.path)}
export async function runTransaction(db,callback){const ops=[];await callback({get:getDocFromServer,set:(ref,data)=>ops.push(()=>write(ref,data)),update:(ref,data)=>ops.push(()=>write(ref,data,true))});ops.forEach(fn=>fn())}
export function onSnapshot(ref,...args){const fns=args.filter(a=>typeof a==='function');const entry={ref,next:fns[0],error:fns[1]};m.listeners.push(entry);record('listen',ref);queueMicrotask(()=>{if(m.listeners.includes(entry))entry.next(snapshot(ref))});return ()=>{m.listeners=m.listeners.filter(e=>e!==entry)}}
m.emit=(project,path)=>m.listeners.filter(e=>e.ref.db.app.options.projectId===project&&(e.ref.kind==='collection'?path.startsWith(e.ref.path+'/'):e.ref.path===path)).forEach(e=>queueMicrotask(()=>{if(m.listeners.includes(e))e.next(snapshot(e.ref))}));
`;
export async function harness(options={}){
 const entryName=options.entry||'public/js/admin.js';const htmlName=entryName==='sqy-admin.js'?'sqy-admin.html':entryName==='app.js'?'index.html':'public/admin.html';
 const html=readFileSync(new URL(htmlName,root),'utf8');const nodes=[...html.matchAll(/<\w+\s+([^<>]+)>/g)].map(match=>new Element(Object.fromEntries([...match[1].matchAll(/([\w-]+)(?:="([^"]*)"|='([^']*)')?/g)].map(m=>[m[1],m[2]??m[3]??'']))));
 const byId=id=>nodes.find(n=>n.id===id)||null;const events={};
 const allNodes=()=>{const descendants=node=>[node,...(node.children||[]).flatMap(descendants)];return nodes.flatMap(descendants)};
 for(const node of nodes)node.allNodes=allNodes;
 if(byId('projectWizardForm'))byId('projectWizardForm').reset=()=>{for(const input of allNodes().filter(n=>n.id?.startsWith('pw-')||n.name?.startsWith('pw-'))){input.value=input.defaultValue||'';input.checked=false;}};
 const selectAll=selector=>{
  if(selector.startsWith('input[name=')||selector.startsWith('.'))return allNodes().filter(n=>matchElement(n,selector));
  if(selector.includes(','))return [...new Set(selector.split(',').flatMap(s=>selectAll(s.trim())))];
  if(/^\[[\w-]+\]$/.test(selector)){const attr=selector.slice(1,-1);return allNodes().filter(n=>attr in n.attrs)}
  if(selector==='.is-auth-only')return nodes.filter(n=>(n.attrs.class||'').split(/\s+/).includes('is-auth-only'));
  if(selector==='#contactForm [data-prefilled]')return nodes.filter(n=>n.id?.startsWith('contact')&&n.dataset.prefilled);
  if(/^#(?:provision-dialog|payment-dialog) (?:input|textarea)$/.test(selector))return nodes.filter(n=>n.id&&/^(merchant-|store-|cfg-|config-snippet|payment-)/.test(n.id));
  return [];
 };
 const document={title:'',createElement:()=>new Element(),body:{style:{},classList:new Element().classList},getElementById:byId,querySelector:s=>s.startsWith('#')?byId(s.slice(1)):selectAll(s)[0]||null,querySelectorAll:selectAll,addEventListener(type,fn){(events[type]||=[]).push(fn)}};
 for(const id of ['ticket-filter','store-filter','request-filter'])if(byId(id))byId(id).value=id==='store-filter'?'current':'all';
 const entries=options.storage||new Map();if(options.masterSigned)entries.set('mock-auth:'+MASTER,JSON.stringify({uid:'master-uid',email:'owner@sqysystems.com'}));
 const sessionStorage={getItem:k=>entries.get(k)??null,setItem(k,v){if(options.failHintWrite&&k==='sqysystems:managed-merchant:v1')throw Object.assign(new Error('Full'),{name:'QuotaExceededError'});entries.set(k,String(v))},removeItem:k=>entries.delete(k)};
 const records=options.records||new Map();
 if(!records.has(MASTER+'/users/master-uid'))records.set(MASTER+'/users/master-uid',{uid:'master-uid',role:options.masterRole||'superadmin',displayName:'Agency Owner',email:'owner@sqysystems.com',company:'SQySystems'});
 if(!records.has(TENANT+'/users/tenant-uid'))records.set(TENANT+'/users/tenant-uid',{uid:'tenant-uid',role:options.nonAdmin?'customer':'admin'});
 const state={records,calls:[],listeners:[],authListeners:[],auths:{},clock:1792100000,autoId:0,directoryFailure:options.directoryFailure,failPersistence:options.failPersistence,wrongAuthEmail:options.wrongAuthEmail};
 let destination;const location={href:'https://sqysystems.com/'+htmlName,assign:u=>{destination=u},replace:u=>{destination=u},reload:()=>{destination=location.href}};const featureCalls=[];
 const windowEvents={};
 const window={__mock:state,__feature:(name,context)=>featureCalls.push({name,context}),location,dispatchEvent(){},addEventListener(type,fn){(windowEvents[type]||=[]).push(fn)},scrollTo(){},confirm:()=>true};
 const context=createContext({window,document,sessionStorage,URL,URLSearchParams,console,setTimeout:(fn,ms)=>{const timer=setTimeout(fn,ms);timer.unref();return timer;},clearTimeout,queueMicrotask,Map,Set,JSON,Date,Intl,Object,CustomEvent:class{}});
 const modules=new Map();const stubs=['admin-orders.js','admin-products.js','admin-cloud-and-logs.js','admin-settings.js','admin-analytics.js','admin-notifications.js','category-store.js','catalog-snapshot.js'];
 function load(url){if(modules.has(url))return modules.get(url);let source;if(url.includes('gstatic.com'))source=url.includes('firebase-app.js')?appMock:url.includes('firebase-auth.js')?authMock:firestoreMock;else{source=readFileSync(fileURLToPath(url),'utf8');const name=url.split('/').pop();if(stubs.includes(name))source=[...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map(m=>`export function ${m[1]}(context){window.__feature('${m[1]}',context)}`).join('\n');if(name==='app.js')source=source.replace(/\ninit\(\);\s*$/,'\nexport { initLoginForm, initSignupForm, initProfileForm, initProjectWizard, startLandingAuth, handleLogout, View, state };');}
 const mod=new SourceTextModule(source,{context,identifier:url,initializeImportMeta(meta){meta.url=url.startsWith(root.href)?'https://sqysystems.com/'+url.slice(root.href.length):url}});modules.set(url,mod);return mod;}
 const entry=load(new URL(entryName,root).href);const linker=(specifier,ref)=>load(new URL(specifier,ref.identifier).href);await entry.link(linker);await entry.evaluate();
 if(entryName==='app.js'){entry.namespace.initLoginForm();entry.namespace.initProfileForm();if(options.landingAuth)await entry.namespace.startLandingAuth();if(options.wizard)entry.namespace.initProjectWizard();}else for(const fn of events.DOMContentLoaded||[])fn();await tick();
 const emitWindow=async(type,event={})=>{for(const fn of windowEvents[type]||[])await fn(event);await tick()};
 const importModule=async name=>{const mod=load(new URL(name,root).href);if(mod.status==='unlinked')await mod.link(linker);if(mod.status!=='evaluated')await mod.evaluate();return mod.namespace};
 const session=modules.get(new URL('public/js/merchant-session.js',root).href)?.namespace;
 const login=async(email=EMAIL,password='correct-password')=>{const prefix=entryName==='app.js'?'login':entryName==='sqy-admin.js'?'sqy-':'admin-';const emailId=prefix==='login'?'loginEmail':prefix+'email';const passId=prefix==='login'?'loginPassword':prefix+'password';const form=prefix==='login'?'loginForm':prefix==='sqy-'?'sqy-login-form':'admin-login-form';byId(emailId).value=email;byId(passId).value=password;await byId(form).emit('submit');await tick()};
 const click=async attrs=>{const target=new Element(attrs);for(const fn of events.click||[])await fn({target,preventDefault(){}});await tick()};
 const put=async(project,path,data)=>{records.set(project+'/'+path,data);state.emit(project,path);await tick()};
 return {entry,session,importModule,emitWindow,allNodes,byId,nodes,state,records,entries,featureCalls,login,click,put,get destination(){return destination}};
}
