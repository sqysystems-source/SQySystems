// Public submissions always target the SQySystems Master project.
import { auth, db } from '../../firebase-config.js';
import { collection, addDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js';
import { validateProjectRequest, normalizeEmail } from './agency-model.js';
export async function submitProjectRequest(input) {
    const value=validateProjectRequest(input);
    await auth.authStateReady();
    // Tenant UIDs are not Master UIDs. A tenant-only contact is saved with uid:null.
    if (value.uid !== null && (auth.currentUser?.uid !== value.uid || normalizeEmail(auth.currentUser?.email) !== value.clientEmail)) throw new Error('Your account changed. Review your contact details and submit again.');
    return addDoc(collection(db,'project_requests'),{...value,status:'new',createdAt:serverTimestamp()});
}
