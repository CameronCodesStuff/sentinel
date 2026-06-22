// ============================================================
// auth.js — Firebase Auth (email/password using username)
// Usernames are stored in Firestore. "owner" is the superuser.
// ============================================================

import { auth, db } from "./firebase-config.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  doc, setDoc, getDoc, collection, query, where, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ─── Public state ─────────────────────────────────────────
export let currentUser    = null;
export let currentUsername = null;

// ─── Convert username → fake email for Firebase Auth ──────
function usernameToEmail(username) {
  return `${username.toLowerCase()}@sentinel.local`;
}

// ─── Register new user ────────────────────────────────────
export async function register() {
  const username = document.getElementById("reg-username").value.trim().toLowerCase();
  const password = document.getElementById("reg-password").value;
  const errEl    = document.getElementById("reg-error");
  errEl.textContent = "";

  if (!username || !password) { errEl.textContent = "All fields required."; return; }
  if (username.length < 3)    { errEl.textContent = "Username must be 3+ characters."; return; }
  if (password.length < 6)    { errEl.textContent = "Password must be 6+ characters."; return; }

  // Check username uniqueness
  const usernameRef = doc(db, "usernames", username);
  const snap = await getDoc(usernameRef);
  if (snap.exists()) { errEl.textContent = "Username already taken."; return; }

  try {
    const cred = await createUserWithEmailAndPassword(auth, usernameToEmail(username), password);
    // Store username → uid mapping
    await setDoc(usernameRef, { uid: cred.user.uid, createdAt: Date.now() });
    // Store user profile
    await setDoc(doc(db, "users", cred.user.uid), {
      username,
      role: username === "owner" ? "owner" : "viewer",
      createdAt: Date.now()
    });
    showToast("Account created!", "success");
  } catch (e) {
    errEl.textContent = e.message;
  }
}

// ─── Login ────────────────────────────────────────────────
export async function login() {
  const username = document.getElementById("login-username").value.trim().toLowerCase();
  const password = document.getElementById("login-password").value;
  const errEl    = document.getElementById("login-error");
  errEl.textContent = "";

  if (!username || !password) { errEl.textContent = "All fields required."; return; }

  try {
    await signInWithEmailAndPassword(auth, usernameToEmail(username), password);
    showToast(`Welcome, ${username}`, "success");
  } catch (e) {
    errEl.textContent = "Invalid username or password.";
  }
}

// ─── Logout ───────────────────────────────────────────────
export async function logout() {
  await signOut(auth);
  currentUser    = null;
  currentUsername = null;
  showScreen("auth-screen");
}

// ─── Auth state observer ──────────────────────────────────
export function initAuth(onLogin, onLogout) {
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      const snap = await getDoc(doc(db, "users", user.uid));
      if (snap.exists()) {
        currentUser     = user;
        currentUsername = snap.data().username;
        onLogin(snap.data());
      }
    } else {
      onLogout();
    }
  });
}

// ─── UI helpers (shared) ──────────────────────────────────
export function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => {
    s.classList.remove("active");
    s.style.display = "none";
  });
  const el = document.getElementById(id);
  if (el) {
    el.style.display = "flex";
    el.classList.add("active");
  }
}

export function showToast(msg, type = "info") {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = "0"; toast.style.transition = "opacity 0.3s"; }, 3000);
  setTimeout(() => toast.remove(), 3300);
}

export function switchTab(tab) {
  document.getElementById("tab-login").classList.toggle("active", tab === "login");
  document.getElementById("tab-register").classList.toggle("active", tab === "register");
  document.getElementById("login-form").classList.toggle("active", tab === "login");
  document.getElementById("register-form").classList.toggle("active", tab === "register");
}

// Expose to window for inline HTML calls
window.login      = login;
window.register   = register;
window.logout     = logout;
window.switchTab  = switchTab;
