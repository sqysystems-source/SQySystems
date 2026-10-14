/**
 * SQySystems — Firebase configuration & service initialisation
 * Firebase Web SDK v10+ (modular syntax, loaded from the official CDN).
 *
 * HOW TO SET UP
 * 1. Go to https://console.firebase.google.com and create a project.
 * 2. Add a "Web app" (</>) and copy its config object into `firebaseConfig` below.
 * 3. Build > Authentication > Sign-in method > enable "Email/Password".
 * 4. Build > Firestore Database > Create database.
 * 5. Paste the contents of firestore.rules into Firestore > Rules and publish.
 *
 * NOTE: These web config values are NOT secrets. Security is enforced by
 * Firestore Security Rules and Authentication, not by hiding this file.
 */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDZ1kuldn_Df3Fo8Y2LLicMNQsIGEn3ZEc",
  authDomain: "sqysystems-faa0e.firebaseapp.com",
  projectId: "sqysystems-faa0e",
  storageBucket: "sqysystems-faa0e.firebasestorage.app",
  messagingSenderId: "845387596551",
  appId: "1:845387596551:web:e668d40fc7178a8dde3ba2",
};

export const isFirebaseConfigured = !Object.values(firebaseConfig).some((v) =>
  String(v).startsWith("YOUR_")
);

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
