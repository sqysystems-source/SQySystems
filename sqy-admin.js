import { auth } from './firebase-config.js';
import { signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js';
import { startControlPlane, saveConnection, changeConnectionStatus, addPaidOrder, changeTicketStatus, deleteTicket, changeProjectRequestStatus, deleteProjectRequest } from './public/js/control-plane-data.js';
import { normalizeEmail, WEB_CONFIG_KEYS, parseFirebaseSnippet, connectionVersion, ticketStatus, isPaidOrder, asMillis, PROJECT_TRACKS, PROJECT_STATUS_LABELS, projectPackageDetails } from './public/js/agency-model.js';
import { resolveMerchantStore } from './public/js/tenant-config.js';
import { escapeHTML as h } from './public/js/sanitize.js';

const $ = id => document.getElementById(id);
const labels = { users:'clients', messages:'contact tickets', project_requests:'project requests', client_payments:'paid orders', merchant_stores:'store connections' };
const state = { authorized:false, rows:{users:null,messages:null,project_requests:null,client_payments:null,merchant_stores:null}, errors:new Set(), query:'', page:0, section:'overview' };
const date = value => asMillis(value) ? new Intl.DateTimeFormat('en-GB',{dateStyle:'medium'}).format(new Date(asMillis(value))) : '—';
const money = value => new Intl.NumberFormat('el-GR',{style:'currency',currency:'EUR'}).format(value/100);
const matches = (...values) => !state.query || values.some(value => String(value ?? '').toLowerCase().includes(state.query));
const byNewest = (a,b) => asMillis(b.createdAt || b.paidAt || b.updatedAt) - asMillis(a.createdAt || a.paidAt || a.updatedAt);
const badge = (value,label=value) => `<span class="badge ${h(value)}">${h(label)}</span>`;
const empty = message => `<div class="empty">${h(message)}</div>`;
const blankRow = (columns,message) => `<tr><td colspan="${columns}" class="empty">${h(message)}</td></tr>`;
let selectedRequestId = null;
let editingEmail = null;
let editingVersion = null;
let savingConnection = false;
let savingPayment = false;
const currentStore = email => (state.rows.merchant_stores || []).find(store => store.id === email);
const connected = email => currentStore(String(email || '').toLowerCase())?.status === 'active';
function notice(message,error=false,target='global-notice') {
    const el = $(target);
    el.textContent = message;
    el.classList.toggle('error',error);
    el.hidden = !message;
}
function friendly(error) {
    if (error?.code === 'permission-denied') return 'Permission denied. Your administrator access or Master rules may have changed.';
    if (error?.code?.startsWith('auth/')) return 'Could not sign in. Check your Master account email and password.';
    if (error?.code === 'unavailable') return 'Connection unavailable. Check your network and try again.';
    return error?.message || 'The action could not be completed.';
}
function setBusy(button,busy) { button.disabled = busy; }
function clientsOptions() {
    const options = new Map();
    for (const user of state.rows.users || []) if (user.email) options.set(String(user.email).toLowerCase(),user.displayName || user.company || user.email);
    for (const order of state.rows.client_payments || []) if (order.clientEmail) options.set(String(order.clientEmail).toLowerCase(),order.clientName || order.clientEmail);
    for (const request of state.rows.project_requests || []) if(request.clientEmail) options.set(String(request.clientEmail).toLowerCase(),request.clientName || request.clientEmail);
    const selected = $('client-picker').value;
    $('client-picker').innerHTML = '<option value="">Select a client, or enter an email below</option>'+[...options].sort(([a],[b])=>a.localeCompare(b)).map(([email,name])=>`<option value="${h(email)}">${h(name)} · ${h(email)}</option>`).join('');
    $('client-picker').value = selected;
}
function renderKPIs() {
    $('kpi-clients').textContent = state.rows.users === null ? '—' : state.rows.users.length.toLocaleString();
    const unread = (state.rows.messages || []).filter(item=>ticketStatus(item)==='unread').length;
    $('kpi-unread').textContent = state.rows.messages === null ? '—' : String(unread);
    $('nav-unread').textContent = String(unread);
    $('nav-project-new').textContent=String((state.rows.project_requests || []).filter(item=>item.status==='new').length);
    $('kpi-paid').textContent = state.rows.client_payments === null ? '—' : String(state.rows.client_payments.filter(isPaidOrder).length);
    $('kpi-stores').textContent = state.rows.merchant_stores === null ? '—' : String(state.rows.merchant_stores.filter(store=>store.status==='active').length);
    $('live-status').innerHTML = `<span class="status-dot"></span> ${state.errors.size ? 'Needs attention' : Object.values(state.rows).some(rows=>rows===null) ? 'Connecting' : 'Live updates'}`;
}
function renderClients() {
    const rows = (state.rows.users || []).filter(user=>matches(user.displayName,user.email,user.company,user.role)).sort(byNewest);
    const pageSize=15, pages=Math.max(1,Math.ceil(rows.length/pageSize));
    state.page=Math.min(state.page,pages-1);
    const shown=rows.slice(state.page*pageSize,(state.page+1)*pageSize);
    $('clients-count').textContent=String(state.rows.users?.length ?? '—');
    $('clients-body').innerHTML = shown.length ? shown.map(user=>{
        const email=String(user.email || '').toLowerCase();
        const connection=currentStore(email);
        const status=connection?.status || 'pending';
        const label=connection?.status==='active'?'Connected':connection?.status==='disabled'?'Disabled':'Not connected';
        return `<tr><td><strong>${h(user.displayName || 'Unnamed client')}</strong><small class="client-email">${h(user.email || 'No email')}</small></td><td>${h(user.company || '—')}</td><td>${badge('role',user.role || 'client')}</td><td>${h(date(user.createdAt))}</td><td>${badge(status,label)}</td><td><button class="button subtle small" type="button" data-setup-email="${h(email)}" ${email?'':'disabled'}>Connect / Edit E-Shop</button></td></tr>`;
    }).join('') : blankRow(6,state.rows.users===null?'Loading clients…':'No clients match this view.');
    $('clients-page-label').textContent=rows.length?`${state.page*pageSize+1}–${Math.min((state.page+1)*pageSize,rows.length)} of ${rows.length} clients`:'0 clients';
    $('clients-prev').disabled=state.page===0;
    $('clients-next').disabled=state.page>=pages-1;
}
function renderMessages() {
    const filter=$('ticket-filter').value;
    const rows=(state.rows.messages || []).filter(item=>(filter==='all'||ticketStatus(item)===filter)&&matches(item.name,item.email,item.message)).sort(byNewest);
    $('messages-count').textContent=String(state.rows.messages?.length ?? '—');
    $('messages-list').innerHTML=rows.length?rows.map(item=>{
        const status=ticketStatus(item);
        const email=String(item.email || '');
        return `<article class="ticket"><div class="ticket-top"><div class="ticket-author"><strong>${h(item.name || 'Website visitor')}</strong><span>${h(email)}</span></div>${badge(status)}</div><p>${h(item.message || '')}</p><div class="ticket-bottom"><time>${h(date(item.createdAt))}</time><div class="ticket-actions">${status!=='read'?`<button class="row-action" data-ticket-status="read" data-id="${h(item.id)}" type="button">Mark read</button>`:''}${status!=='resolved'?`<button class="row-action" data-ticket-status="resolved" data-id="${h(item.id)}" type="button">Resolve</button>`:''}<a class="row-action" href="mailto:${h(encodeURIComponent(email))}?subject=${encodeURIComponent('Re: Your SQySystems enquiry')}">Reply ↗</a><button class="row-action danger" data-delete-ticket="${h(item.id)}" type="button">Delete</button></div></div></article>`;
    }).join(''):empty(state.rows.messages===null?'Loading contact tickets…':'Your inbox is clear for this view.');
}
function renderRequests() {
    const filter=$('request-filter').value;
    const rows=(state.rows.project_requests || []).filter(item=>(filter==='all'||item.status===filter)&&matches(item.clientName,item.clientEmail,item.company,item.projectName,PROJECT_TRACKS[item.category]?.label,item.subType,item.profession)).sort(byNewest);
    $('requests-count').textContent=String(state.rows.project_requests?.length ?? '—');
    $('requests-list').innerHTML=rows.length?rows.map(item=>`<button class="request-card" type="button" data-request-id="${h(item.id)}"><span class="request-icon" aria-hidden="true">${h(PROJECT_TRACKS[item.category]?.icon || '↗')}</span><span class="request-summary"><span class="request-card-top"><strong>${h(item.projectName || 'Project request')}</strong>${badge(item.status,PROJECT_STATUS_LABELS[item.status] || item.status)}</span><span class="request-track">${h(PROJECT_TRACKS[item.category]?.label || item.category)} · ${h(item.subType)}</span><span class="request-meta">${h(item.clientName)} <span>·</span> ${h(item.clientEmail)} <span>·</span> ${h(date(item.createdAt))}</span></span><span class="request-arrow" aria-hidden="true">↗</span></button>`).join(''):empty(state.rows.project_requests===null?'Loading project briefs…':'No project requests in this view. New briefs will appear here automatically.');
}
function renderRequestDetails() {
    if(!selectedRequestId || !$('request-dialog').open)return;
    const row=(state.rows.project_requests || []).find(item=>item.id===selectedRequestId);
    if(!row){$('request-dialog').close();$('request-detail-content').innerHTML='';selectedRequestId=null;return;}
    $('request-detail-title').textContent=row.projectName || 'Project request';
    $('request-status').value=row.status;
    const group=(title,fields)=>`<section class="brief-group"><h3>${h(title)}</h3><dl>${fields.map(([label,value])=>`<div><dt>${h(label)}</dt><dd>${h(value || '—')}</dd></div>`).join('')}</dl></section>`;
    $('request-detail-content').innerHTML=group('Client & account',[
        ['Name',row.clientName],['Email',row.clientEmail],['Phone',row.clientPhone],['Company',row.company],['Account UID',row.uid || 'Guest / store contact (no Master account link)'],['Submitted',date(row.createdAt)],['Status',PROJECT_STATUS_LABELS[row.status] || row.status]
    ])+group('Scope & deliverables',[
        ['Solution',PROJECT_TRACKS[row.category]?.label || row.category],['Project type',row.subType],['Business / industry',row.profession],['Products / services / purpose',row.productsOrServices],['Estimated scale',row.estimatedScale]
    ])+`<section class="brief-group"><h3>Selected features</h3><div class="brief-tags">${Array.isArray(row.selectedFeatures)&&row.selectedFeatures.length?row.selectedFeatures.map(feature=>`<span>${h(feature)}</span>`).join(''):'<span>To be discussed</span>'}</div></section>`+group('Brand & project identity',[
        ['Project / domain',row.projectName],['Preferred colors',row.preferredColors],['Aesthetic',row.aestheticStyle],['Timeline',row.timeline],['Notes & references',row.notes]
    ]);
}
function openRequest(id) {
    if(!state.authorized || !(state.rows.project_requests || []).some(item=>item.id===id))return;
    selectedRequestId=id;
    if(!$('request-dialog').open)$('request-dialog').showModal();
    renderRequestDetails();
}
const selectedRequest=()=>(state.rows.project_requests || []).find(item=>item.id===selectedRequestId);
function renderStores() {
    const filter=$('store-filter').value;
    const rows=(state.rows.merchant_stores || []).filter(store=>
        (filter==='all'||filter==='current'&&store.status!=='deleted'||store.status===filter) && matches(store.storeName,store.merchantEmail,store.plan,store.storeApiBaseUrl)
    ).sort((a,b)=>asMillis(b.updatedAt)-asMillis(a.updatedAt));
    $('stores-count').textContent=String((state.rows.merchant_stores || []).filter(store=>store.status!=='deleted').length);
    $('stores-body').innerHTML=rows.length?rows.map(store=>`<tr><td><strong>${h(store.storeName || 'Unnamed store')}</strong><small>${h(store.merchantEmail || store.id)}</small><small>${h(store.storeApiBaseUrl || '')}</small></td><td>${h(store.plan || 'Custom E-Shop')}</td><td>${badge(store.status || 'disabled')}</td><td>${h(date(store.updatedAt))}</td><td><div class="row-actions"><button class="row-action" type="button" data-edit-store="${h(store.id)}">${store.status==='deleted'?'Restore / Edit':'Edit'}</button>${store.status!=='deleted'?`<button class="row-action" type="button" data-toggle-store="${h(store.id)}">${store.status==='active'?'Disable':'Enable'}</button><button class="row-action danger" type="button" data-delete-store="${h(store.id)}">Delete</button>`:''}</div></td></tr>`).join(''):blankRow(5,state.rows.merchant_stores===null?'Loading connections…':'No connections in this view. Connect a client or use the AURA seed.');
}
function renderPaid() {
    const rows=(state.rows.client_payments || []).filter(isPaidOrder).filter(item=>matches(item.clientEmail,item.clientName,item.packageDetails)).sort((a,b)=>asMillis(b.paidAt)-asMillis(a.paidAt));
    $('paid-list').innerHTML=rows.length?rows.map(item=>{
        const ready=connected(item.clientEmail);
        const cents=Number.isSafeInteger(item.amountCents)?item.amountCents:Math.round(Number(item.amountPaid || 0)*100);
        return `<article class="paid-card"><div class="paid-card-top"><strong>${h(item.clientName || 'Client payment')}</strong><time>${h(date(item.paidAt || item.createdAt))}</time></div><p class="paid-email">${h(item.clientEmail || '')}</p><p class="paid-package">${h(item.packageDetails || 'Project request')}</p><div class="amount">${h(money(Number.isFinite(cents)?cents:0))}</div>${badge(ready?'connected':'pending',ready?'Store Connected':'Pending Setup')}<button class="button subtle" type="button" data-setup-email="${h(item.clientEmail || '')}">Setup Tenant &amp; API Keys <span aria-hidden="true">→</span></button></article>`;
    }).join(''):empty(state.rows.client_payments===null?'Loading paid clients…':'No paid client records yet. Add the first payment above.');
}
function renderAll() {
    renderKPIs(); renderClients(); renderMessages(); renderRequests(); renderStores(); renderPaid(); clientsOptions(); renderRequestDetails();
}
function closeDialogs() { for (const id of ['provision-dialog','payment-dialog','request-dialog']) if ($(id).open) $(id).close(); }
function clearPrivateUI() {
    state.authorized=false;
    state.rows={users:null,messages:null,project_requests:null,client_payments:null,merchant_stores:null};
    state.errors.clear(); state.query=''; state.page=0;
    closeDialogs();
    $('provision-form').reset(); $('payment-form').reset();
    selectedRequestId=null; $('request-detail-content').innerHTML=''; $('request-detail-title').textContent='Project request'; $('request-status').value='new'; $('nav-project-new').textContent='0'; $('requests-count').textContent='—';
    // reset() does not clear defaultValue-backed form contents or generated
    // HTML. Explicitly purge all private rows, selections and config values.
    document.querySelectorAll('#provision-dialog input, #provision-dialog textarea, #payment-dialog input, #payment-dialog textarea').forEach(el=>{el.value='';});
    for(const id of ['clients-body','stores-body','messages-list','requests-list','paid-list']) $(id).innerHTML='';
    $('client-picker').innerHTML='<option value="">Select a client, or enter an email below</option>';
    $('identity-avatar').textContent='S';
    for(const id of ['identity-name','identity-role','master-email']) $(id).textContent='';
    for(const id of ['kpi-clients','kpi-unread','kpi-paid','kpi-stores']) $(id).textContent='—';
    $('global-search').value='';
    $('admin-view').hidden=true; $('access-view').hidden=false;
    $('switch-master-account').hidden=!auth.currentUser;
    $('sqy-login-form').hidden=Boolean(auth.currentUser);
    $('sqy-password').value='';
    notice('');
    editingEmail=editingVersion=null;
}
function populateConnection(email) {
    if (savingConnection) return;
    let normalized='';
    try { if(email) normalized=normalizeEmail(email); } catch { /* Let form validation guide manual entry. */ }
    const record=currentStore(normalized);
    let seed;
    if (!record && normalized) { try { seed=resolveMerchantStore(normalized).tenantStore; } catch { /* Not a seed store. */ } }
    const client=(state.rows.users || []).find(user=>String(user.email || '').toLowerCase()===normalized);
    const value=record || seed;
    editingEmail=record?.id || null;
    editingVersion=record?connectionVersion(record):null;
    $('provision-form').reset(); notice('',false,'provision-error');
    $('merchant-email').value=normalized;
    $('merchant-email').readOnly=Boolean(record);
    $('client-picker').disabled=Boolean(record);
    $('client-picker').value=normalized;
    $('email-edit-note').hidden=!record;
    $('store-name').value=value?.storeName || client?.company || '';
    $('store-plan').value=record?.plan || 'Custom E-Shop';
    $('store-origin').value=value?.storeApiBaseUrl || '';
    $('store-status').value=record?.status==='disabled'?'disabled':'active';
    for(const key of WEB_CONFIG_KEYS) $(`cfg-${key}`).value=value?.firebaseConfig?.[key] || '';
    $('config-snippet').value='';
    $('provision-title').textContent=record?'Edit store connection':'Connect an e-shop';
}
function openProvision(email='',projectName='') {
    if (!state.authorized || savingConnection) return;
    populateConnection(email);
    if(projectName && !currentStore(String(email).toLowerCase())) $('store-name').value=projectName.slice(0,80);
    if (!$('provision-dialog').open) $('provision-dialog').showModal();
}
function openPayment(request=null) {
    if (!state.authorized || savingPayment) return;
    $('payment-form').reset();notice('',false,'payment-error');
    $('payment-email').value=request?.clientEmail || ''; $('payment-name').value=request?.clientName || ''; $('payment-package').value=request?.clientEmail?projectPackageDetails(request):''; $('payment-amount').value='';
    const now=new Date();$('payment-date').value=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    $('payment-dialog').showModal();
}
function selectSection(section) {
    state.section=section;
    document.querySelectorAll('[data-section]').forEach(button=>button.classList.toggle('active',button.dataset.section===section));
    document.querySelectorAll('[data-panel]').forEach(panel=>{panel.hidden=section!=='overview'&&panel.dataset.panel!==section;});
    document.querySelector('.split-layout').classList.toggle('requests-focused',section==='requests');
    const titles={overview:['Overview','Agency overview'],clients:['Clients','Your client directory'],messages:['Contact inbox','Conversations that matter'],requests:['Project requests','Ideas ready for your attention'],stores:['Store connections','Connected client stores']};
    $('page-label').textContent=titles[section][0];$('page-title').textContent=titles[section][1];
}
async function rowAction(button,work,message) {
    if (!state.authorized || button.disabled) return;
    setBusy(button,true);
    try { await work(); if(state.authorized) notice(message); }
    catch(error) { if(state.authorized) notice(friendly(error),true); }
    finally { setBusy(button,false); }
}
$('sqy-login-form').addEventListener('submit',async event=>{
    event.preventDefault();const button=$('sqy-login-submit');if(button.disabled)return;
    const password=$('sqy-password').value;$('sqy-password').value='';setBusy(button,true);$('access-error').hidden=true;
    try { await signInWithEmailAndPassword(auth,$('sqy-email').value.trim(),password); }
    catch(error) { notice(friendly(error),true,'access-error'); }
    finally { setBusy(button,false); }
});
const performLogout=async()=>{
    clearPrivateUI();
    try { await signOut(auth); }
    catch(error) { $('sqy-login-form').hidden=false;notice(friendly(error),true,'access-error'); }
};
$('sqy-logout').addEventListener('click',performLogout);
$('sqy-mobile-logout').addEventListener('click',performLogout);
$('switch-master-account').addEventListener('click',performLogout);
$('global-search').addEventListener('input',()=>{state.query=$('global-search').value.trim().toLowerCase();state.page=0;if(state.authorized)renderAll();});
$('request-filter').addEventListener('change',()=>{if(state.authorized)renderRequests();});
$('save-request-status').addEventListener('click',()=>{
    const row=selectedRequest();if(!row)return;
    void rowAction($('save-request-status'),()=>changeProjectRequestStatus(row.id,$('request-status').value),'Project request status updated.');
});
$('request-to-payment').addEventListener('click',()=>{
    const row=selectedRequest();if(!state.authorized||!row)return;
    $('request-dialog').close();openPayment(row);
});
$('request-to-store').addEventListener('click',()=>{
    const row=selectedRequest();if(!state.authorized||!row)return;
    $('request-dialog').close();openProvision(row.clientEmail,row.projectName);
});
$('delete-request').addEventListener('click',()=>{
    const row=selectedRequest();if(!row||!window.confirm('Permanently delete this project request?'))return;
    void rowAction($('delete-request'),()=>deleteProjectRequest(row.id),'Project request deleted.');
});
$('ticket-filter').addEventListener('change',()=>{if(state.authorized)renderMessages();});
$('store-filter').addEventListener('change',()=>{if(state.authorized)renderStores();});
$('clients-prev').addEventListener('click',()=>{if(state.authorized){state.page=Math.max(0,state.page-1);renderClients();}});
$('clients-next').addEventListener('click',()=>{if(state.authorized){state.page++;renderClients();}});
$('open-payment').addEventListener('click',openPayment);
$('use-aura-seed').addEventListener('click',()=>openProvision('kostas6603@gmail.com'));
$('client-picker').addEventListener('change',()=>{if(!editingEmail&&$('client-picker').value)populateConnection($('client-picker').value);});
$('merchant-email').addEventListener('change',()=>{if(!editingEmail){try{if(currentStore(normalizeEmail($('merchant-email').value)))populateConnection($('merchant-email').value);}catch{/* Native validation handles invalid addresses. */}}});
$('parse-config').addEventListener('click',()=>{
    try { const parsed=parseFirebaseSnippet($('config-snippet').value);for(const key of WEB_CONFIG_KEYS)$(`cfg-${key}`).value=parsed[key];notice('',false,'provision-error'); }
    catch(error){notice(friendly(error),true,'provision-error');}
});
$('provision-form').addEventListener('submit',async event=>{
    event.preventDefault();if(savingConnection||!state.authorized)return;
    savingConnection=true;setBusy($('save-connection'),true);notice('',false,'provision-error');
    try {
        const input={merchantEmail:$('merchant-email').value,storeName:$('store-name').value,storeApiBaseUrl:$('store-origin').value,plan:$('store-plan').value,status:$('store-status').value,firebaseConfig:Object.fromEntries(WEB_CONFIG_KEYS.map(key=>[key,$(`cfg-${key}`).value]))};
        if(editingEmail&&normalizeEmail(input.merchantEmail)!==editingEmail)throw new Error('Create a new connection to change the merchant email.');
        await saveConnection(input,editingVersion);
        if(state.authorized){$('provision-dialog').close();notice('Store connection saved. The merchant can use their existing store login.');}
    } catch(error){if(state.authorized)notice(friendly(error),true,'provision-error');}
    finally{savingConnection=false;setBusy($('save-connection'),false);}
});
$('payment-form').addEventListener('submit',async event=>{
    event.preventDefault();if(savingPayment||!state.authorized)return;
    savingPayment=true;setBusy($('save-payment'),true);notice('',false,'payment-error');
    try{
        await addPaidOrder({clientEmail:$('payment-email').value,clientName:$('payment-name').value,packageDetails:$('payment-package').value,amount:$('payment-amount').value,paidDate:$('payment-date').value});
        if(state.authorized){$('payment-dialog').close();notice('Paid client order recorded. You can now set up their store.');}
    }catch(error){if(state.authorized)notice(friendly(error),true,'payment-error');}
    finally{savingPayment=false;setBusy($('save-payment'),false);}
});
document.addEventListener('click',event=>{
    const close=event.target.closest('[data-close-dialog]');if(close){close.closest('dialog').close();return;}
    if(!state.authorized)return;
    const nav=event.target.closest('[data-section]');if(nav){selectSection(nav.dataset.section);return;}
    if(event.target.closest('[data-new-connection]')){openProvision();return;}
    const setup=event.target.closest('[data-setup-email]');if(setup){openProvision(setup.dataset.setupEmail);return;}
    const request=event.target.closest('[data-request-id]');if(request){openRequest(request.dataset.requestId);return;}
    const edit=event.target.closest('[data-edit-store]');if(edit){openProvision(edit.dataset.editStore);return;}
    const toggle=event.target.closest('[data-toggle-store]');if(toggle){const row=currentStore(toggle.dataset.toggleStore);if(row)void rowAction(toggle,()=>changeConnectionStatus(row.id,row.status==='active'?'disabled':'active',connectionVersion(row)),'Connection status updated.');return;}
    const remove=event.target.closest('[data-delete-store]');if(remove){const row=currentStore(remove.dataset.deleteStore);if(row&&window.confirm(`Delete the connection for ${row.merchantEmail}? Portal access will stop. Store data stays intact.`))void rowAction(remove,()=>changeConnectionStatus(row.id,'deleted',connectionVersion(row)),'Connection removed from the current directory.');return;}
    const status=event.target.closest('[data-ticket-status]');if(status){void rowAction(status,()=>changeTicketStatus(status.dataset.id,status.dataset.ticketStatus),'Contact ticket updated.');return;}
    const ticket=event.target.closest('[data-delete-ticket]');if(ticket&&window.confirm('Permanently delete this contact ticket?'))void rowAction(ticket,()=>deleteTicket(ticket.dataset.deleteTicket),'Contact ticket deleted.');
});
const stop=startControlPlane({
    onLocked(){clearPrivateUI();},
    onAuthorized(user,profile){
        state.authorized=true;$('access-view').hidden=true;$('admin-view').hidden=false;$('access-error').hidden=true;
        $('master-email').textContent=user.email || '';$('identity-name').textContent=profile.displayName || user.email || 'Administrator';$('identity-role').textContent=profile.role;$('identity-avatar').textContent=(profile.displayName || user.email || 'S').slice(0,1).toUpperCase();
        renderAll();
    },
    onData(name,rows){if(!state.authorized)return;state.rows[name]=rows;state.errors.delete(name);renderAll();},
    onError(error,name){
        if(name==='session'){$('sqy-login-form').hidden=false;$('switch-master-account').hidden=!auth.currentUser;notice(friendly(error),true,'access-error');return;}
        state.errors.add(name);state.rows[name]=null;notice(`Could not load ${labels[name] || name}. ${friendly(error)}`,true);renderAll();
    }
});
window.addEventListener('pagehide',stop,{once:true});
window.addEventListener('pageshow',event=>{if(event.persisted)window.location.reload();});
