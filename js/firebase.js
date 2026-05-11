// js/firebase.js

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-analytics.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js"; // 🔥 NEW: Import Firestore

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyBhw93wSW9zW3gl9Lh4HAF6U-YtsQZk1V0",
  authDomain: "denio-4e615.firebaseapp.com",
  projectId: "denio-4e615",
  storageBucket: "denio-4e615.firebasestorage.app",
  messagingSenderId: "776093966053",
  appId: "1:776093966053:web:f57624a773e977a953fe0c",
  measurementId: "G-KT40PXXLLR"
};

// Initialize Firebase
export const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);

// Export auth AND db so your other files can use them!
export const auth = getAuth(app);
export const db = getFirestore(app); // 🔥 NEW: Initialize and Export Firestore
