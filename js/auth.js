// js/auth.js
// 🔥 UPDATED: Added db and doc/getDoc imports for Firestore routing
import { auth, db } from './firebase.js'; 
import { createUserWithEmailAndPassword, signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { doc, getDoc, serverTimestamp, setDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { createAdminNotification } from "./admin-services.js";

function clearTemporaryProfileData() {
    const keys = [
        'denio_name', 'denio_age', 'denio_height', 'denio_weight', 
        'denio_gender', 'denio_level', 'denio_freq', 'denio_equip', 
        'denio_focus', 'denio_goals', 'denio_start_date', 
        'denio_completed_days', 'denio_last_duration'
    ];
    keys.forEach(key => localStorage.removeItem(key));
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

document.addEventListener('DOMContentLoaded', () => {

    // 1. User Login Logic
    const loginBtn = document.getElementById('loginBtn');
    if (loginBtn) {
        loginBtn.addEventListener('click', async () => {
            const email = document.getElementById('emailInput').value.trim();
            const password = document.getElementById('passwordInput').value.trim();
            
            if (email === '' || password === '') {
                window.showDenioAlert('Please fill in all fields.');
                return;
            }
            if (!isValidEmail(email)) {
                window.showDenioAlert('Please enter a valid email address.');
                return;
            }
            
            try {
                window.showDenioAlert('Authenticating...');
                const userCredential = await signInWithEmailAndPassword(auth, email, password);
                const user = userCredential.user;
                
                // 🔥 SMART ROUTING: Check FIRESTORE, not local storage!
                const userDocRef = doc(db, "users", user.uid);
                const userDocSnap = await getDoc(userDocRef);
                const userData = userDocSnap.exists() ? userDocSnap.data() : {};

                await setDoc(userDocRef, {
                    email: user.email,
                    isActive: true,
                    lastLoginAt: serverTimestamp(),
                    lastLoginAtIso: new Date().toISOString(),
                    lastSeenAt: serverTimestamp(),
                    lastSeenAtIso: new Date().toISOString()
                }, { merge: true });
                createAdminNotification("user_login", {
                    uid: user.uid,
                    email: user.email,
                    name: userData.name || userData.displayName || user.email
                });
                
                if (userDocSnap.exists() && userData.profileCompleted) {
                    // Profile exists in the cloud -> Go to Homepage
                    window.location.href = '../app/homepage.html';
                } else {
                    // No cloud profile -> Clear any old local data and go to Setup
                    clearTemporaryProfileData(); 
                    window.location.href = 'profile-step1.html'; 
                }
            } catch (error) {
                console.error("Login Error:", error);
                window.showDenioAlert("Invalid email or password.");
            }
        });
    }

    // 2. User Sign Up Logic
    const signupBtn = document.getElementById('signupBtn');
    if (signupBtn) {
        signupBtn.addEventListener('click', async () => {
            const name = document.getElementById('signupName').value.trim();
            const email = document.getElementById('signupEmail').value.trim();
            const password = document.getElementById('signupPassword').value.trim();
            const confirm = document.getElementById('signupConfirm').value.trim();

            if (name === '' || email === '' || password === '' || confirm === '') {
                window.showDenioAlert('Please fill in all fields.');
                return;
            } 
            if (!isValidEmail(email)) {
                window.showDenioAlert('Please enter a valid email address.');
                return;
            }
            if (password !== confirm) {
                window.showDenioAlert('Passwords do not match!');
                return;
            } 
            
            try {
                window.showDenioAlert('Creating account...');
                const userCredential = await createUserWithEmailAndPassword(auth, email, password);
                const createdUser = userCredential.user;
                await setDoc(doc(db, "users", createdUser.uid), {
                    name,
                    displayName: name,
                    email,
                    username: email.split("@")[0],
                    profileCompleted: false,
                    isActive: false,
                    createdAt: serverTimestamp(),
                    createdAtIso: new Date().toISOString()
                }, { merge: true });
                createAdminNotification("user_registered", {
                    uid: createdUser.uid,
                    name,
                    email
                });
                
                // Clear any old data so the new user starts fresh
                clearTemporaryProfileData();
                localStorage.setItem('denio_name', name);
                
                window.showDenioAlert('Account created! Please log in.');
                setTimeout(() => {
                    window.location.href = 'login.html';
                }, 1500);
            } catch (error) {
                console.error("Signup Error:", error);
                if (error.code === 'auth/email-already-in-use') {
                    window.showDenioAlert("Email is already in use.");
                } else if (error.code === 'auth/weak-password') {
                    window.showDenioAlert("Password must be at least 6 characters.");
                } else {
                    window.showDenioAlert("Error: " + error.message);
                }
            }
        });
    }

    // 3. Admin Login Logic
    const adminLoginBtn = document.getElementById('adminLoginBtn');
    if (adminLoginBtn) {
        adminLoginBtn.addEventListener('click', async () => {
            const email = document.getElementById('adminEmail').value.trim();
            const password = document.getElementById('adminPassword').value.trim();
            
            if (email === '' || password === '') {
                window.showDenioAlert('Please fill in all fields.');
                return;
            }
            if (!isValidEmail(email)) {
                window.showDenioAlert('Please enter a valid admin email address.');
                return;
            }

            if (email !== 'admin@denio.app') {
                window.showDenioAlert('Access Denied: Not an Admin account.');
                return;
            }
            
            try {
                window.showDenioAlert('Verifying Admin Credentials...');
                await signInWithEmailAndPassword(auth, email, password);
                await setDoc(doc(db, "users", auth.currentUser.uid), {
                    email,
                    isActive: true,
                    lastLoginAt: serverTimestamp(),
                    lastLoginAtIso: new Date().toISOString(),
                    lastSeenAt: serverTimestamp(),
                    lastSeenAtIso: new Date().toISOString(),
                    role: "admin",
                    isAdmin: true
                }, { merge: true });
                window.showDenioAlert('Admin Login Success!');
                setTimeout(() => {
                    window.location.href = '../starting/admin-dashboard.html';
                }, 1000);
            } catch (error) {
                console.error("Admin Login Error:", error);
                window.showDenioAlert("Invalid admin credentials.");
            }
        });
    }
});
