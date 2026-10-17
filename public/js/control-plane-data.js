// All control-plane operations target Master, never the connected tenant db.
import { auth, db } from '../../firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js';
import { doc, collection, getDocFromServer, onSnapshot, runTransaction, addDoc, updateDoc, deleteDoc, serverTimestamp, Timestamp } from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js';
import { canManageAgency, normalizeEmail, validateProvisioning, validatePaidOrder, connectionVersion, PROJECT_STATUSES } from './agency-model.js';

const accessError = () => new Error('This account does not have SQySystems administrator access.');
export async function requireSuperAdmin() {
    const user = auth.currentUser;
    if (!user) throw accessError();
    const snapshot = await getDocFromServer(doc(db, 'users', user.uid));
    if (auth.currentUser?.uid !== user.uid || !canManageAgency(snapshot.data())) throw accessError();
    return user;
}
export function startControlPlane(callbacks) {
    let generation = 0;
    let verifiedUid = null;
    let stopped = false;
    const subscriptions = new Set();
    const clear = () => { subscriptions.forEach(stop => stop()); subscriptions.clear(); verifiedUid = null; callbacks.onLocked(); };
    const subscribe = (ref, onNext, ticket, onError) => {
        const stop = onSnapshot(ref, { includeMetadataChanges: true }, snapshot => {
            if (stopped || ticket !== generation || snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) return;
            onNext(snapshot);
        }, error => {
            if (!stopped && ticket === generation) onError(error);
        });
        subscriptions.add(stop);
    };
    const stopAuth = onAuthStateChanged(auth, async user => {
        if (stopped || (user && user.uid === verifiedUid)) return;
        const ticket = ++generation;
        clear();
        if (!user) return;
        try {
            const snapshot = await getDocFromServer(doc(db, 'users', user.uid));
            if (stopped || ticket !== generation || auth.currentUser?.uid !== user.uid) return;
            if (!canManageAgency(snapshot.data())) throw accessError();
            verifiedUid = user.uid;
            callbacks.onAuthorized(user, snapshot.data());
            const invalidate = error => { ++generation; clear(); callbacks.onError(error || accessError(), 'session'); };
            subscribe(doc(db,'users',user.uid), role => { if (!canManageAgency(role.data())) invalidate(); }, ticket, invalidate);
            for (const name of ['users','messages','project_requests','client_payments','merchant_stores']) {
                subscribe(collection(db,name), data => callbacks.onData(name, data.docs.map(record => ({ ...record.data(), id: record.id }))), ticket, error => callbacks.onError(error,name));
            }
        } catch (error) {
            if (!stopped && ticket === generation) { clear(); callbacks.onError(error,'session'); }
        }
    }, error => { if (!stopped) { ++generation; clear(); callbacks.onError(error,'session'); } });
    return () => { stopped = true; ++generation; stopAuth(); clear(); };
}
const conflict = () => new Error('This connection changed while the form was open. Close and reopen it to load the latest values.');
function checkVersion(snapshot, expectedVersion) {
    const actual = snapshot.exists() ? connectionVersion(snapshot.data()) : null;
    if (actual !== expectedVersion) throw conflict();
}
export async function saveConnection(input, expectedVersion = null) {
    await requireSuperAdmin();
    const value = validateProvisioning(input);
    await runTransaction(db, async transaction => {
        const ref = doc(db,'merchant_stores',value.merchantEmail);
        checkVersion(await transaction.get(ref), expectedVersion);
        // Exact public projection: no private billing/contact notes in this
        // collection, because public login can get a known email document.
        transaction.set(ref, { ...value, updatedAt: serverTimestamp() });
    });
    return value.merchantEmail;
}
export async function changeConnectionStatus(email, status, expectedVersion) {
    await requireSuperAdmin();
    if (!['active','disabled','deleted'].includes(status)) throw new Error('Invalid connection status.');
    await runTransaction(db, async transaction => {
        const ref = doc(db,'merchant_stores',normalizeEmail(email));
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists()) throw new Error('Connection no longer exists.');
        checkVersion(snapshot,expectedVersion);
        transaction.update(ref, { status, updatedAt: serverTimestamp() });
    });
}
export async function addPaidOrder(input) {
    const user = await requireSuperAdmin();
    const value = validatePaidOrder(input);
    const { paidDate, ...fields } = value;
    return addDoc(collection(db,'client_payments'), { ...fields, currency:'EUR', status:'paid', source:'manual', paidAt:Timestamp.fromDate(paidDate), createdBy:user.uid, createdAt:serverTimestamp(), updatedAt:serverTimestamp() });
}
export async function changeTicketStatus(id,status) {
    await requireSuperAdmin();
    if (!['unread','read','resolved'].includes(status)) throw new Error('Invalid ticket status.');
    await updateDoc(doc(db,'messages',id), { status, updatedAt:serverTimestamp() });
}
export async function deleteTicket(id) {
    await requireSuperAdmin();
    await deleteDoc(doc(db,'messages',id));
}

export async function changeProjectRequestStatus(id,status) {
    await requireSuperAdmin();
    if (!PROJECT_STATUSES.includes(status)) throw new Error('Choose a valid request status.');
    if (typeof id !== 'string' || !id || id.includes('/')) throw new Error('Invalid request.');
    await updateDoc(doc(db,'project_requests',id),{status,updatedAt:serverTimestamp()});
}
export async function deleteProjectRequest(id) {
    await requireSuperAdmin();
    if (typeof id !== 'string' || !id || id.includes('/')) throw new Error('Invalid request.');
    await deleteDoc(doc(db,'project_requests',id));
}
