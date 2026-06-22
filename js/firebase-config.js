// ============================================================
// firebase-config.js
// !! REPLACE THESE VALUES with your actual Firebase project !!
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth }       from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore }  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getDatabase }   from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

const firebaseConfig = {
  apiKey:            "AIzaSyCT35CumnmzGrkiqqI8GFEjCKS8yONlF_k",
  authDomain:        "myroom-66b80.firebaseapp.com",
  databaseURL:       "https://myroom-66b80-default-rtdb.firebaseio.com",
  projectId:         "myroom-66b80",
  storageBucket:     "myroom-66b80.firebasestorage.app",
  messagingSenderId: "957015132762",
  appId:             "1:957015132762:web:94501b979bc2c967012663",
  measurementId:     "G-QPWC39M5PK"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db   = getFirestore(app);
export const rtdb = getDatabase(app);
