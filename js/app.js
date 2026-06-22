// ============================================================
// app.js — Main orchestrator
// Wires auth → owner/viewer routing → detection → Firestore
// ============================================================

import { initAuth, showScreen, showToast, currentUsername } from "./auth.js";
import {
  DetectionEngine,
  setOwnerOnline,
  setOwnerOffline,
  subscribeToOwnerStatus,
  trackViewerPresence
} from "./detection.js";
import { db, rtdb } from "./firebase-config.js";
import {
  collection, query, orderBy, limit, onSnapshot, doc, getDoc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { ref, onValue } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

// ─── State ────────────────────────────────────────────────
let engine        = null;
let unsubDetections = null;
let notificationsOn = true;

// ─── Auth router ─────────────────────────────────────────
initAuth(
  async (userData) => {
    // Logged in
    if (userData.username === "owner") {
      await initOwnerMode();
    } else {
      await initViewerMode(userData.username);
    }
  },
  () => {
    // Logged out
    showScreen("auth-screen");
    if (engine) { engine.stop(); engine = null; }
    if (unsubDetections) { unsubDetections(); unsubDetections = null; }
  }
);

// ─────────────────────────────────────────────────────────
// OWNER MODE
// ─────────────────────────────────────────────────────────
async function initOwnerMode() {
  showScreen("owner-screen");

  // Set viewer URL
  const viewerUrlEl = document.getElementById("viewer-url");
  if (viewerUrlEl) viewerUrlEl.textContent = `${window.location.origin}${window.location.pathname}`;

  // Set RTDB presence
  await setOwnerOnline();

  // Start detection engine
  engine = new DetectionEngine();

  const videoEl  = document.getElementById("owner-video");
  const canvasEl = document.getElementById("detection-canvas");
  const overlayEl = document.getElementById("cam-overlay");

  const success = await engine.startCamera(videoEl, canvasEl);

  if (success) {
    overlayEl.classList.add("hidden");
    showToast("Camera active — detection running", "success");
  } else {
    overlayEl.querySelector("span").textContent = "⚠ CAMERA ACCESS DENIED";
    showToast("Could not access camera", "error");
  }

  // Detection callbacks
  engine.onDetectionStart = (data) => {
    addEventToList("owner", {
      type:  "detection",
      label: `Person detected`,
      meta:  `${data.blobs.length} region${data.blobs.length !== 1 ? "s" : ""} — saving clip`,
      time:  new Date().toLocaleTimeString()
    });
    showToast("⚡ Person detected!", "success");
  };

  engine.onDetectionEnd = (clip) => {
    addEventToList("owner", {
      type:  "alert",
      label: `Clip saved — ${clip.durationSeconds}s`,
      meta:  `${clip.frameCount} frames captured`,
      time:  new Date().toLocaleTimeString()
    });
  };

  // Track viewer count
  trackViewerPresence("__owner_host__");

  // Subscribe to own detection log
  subscribeToDetectionLog("owner-events-list");
}

// ─────────────────────────────────────────────────────────
// VIEWER MODE
// ─────────────────────────────────────────────────────────
async function initViewerMode(username) {
  showScreen("viewer-screen");

  const usernameEl = document.getElementById("viewer-username-display");
  if (usernameEl) usernameEl.textContent = username.toUpperCase();

  // Register viewer presence
  trackViewerPresence(username);

  // Watch owner live status
  subscribeToOwnerStatus((status) => {
    const statusBadge   = document.getElementById("stream-status");
    const liveIndicator = document.getElementById("stream-live-indicator");
    const offlineScreen = document.getElementById("offline-screen");
    const liveView      = document.getElementById("live-stream-view");
    const infoStatus    = document.getElementById("info-status");

    if (status.online) {
      if (statusBadge)   { statusBadge.textContent = "● LIVE"; }
      if (liveIndicator) { liveIndicator.textContent = "● LIVE"; liveIndicator.classList.add("live"); }
      if (offlineScreen) offlineScreen.style.display = "none";
      if (liveView)      liveView.style.display = "flex";
      if (infoStatus)    infoStatus.textContent = "Online";
    } else {
      if (statusBadge)   { statusBadge.textContent = "● OFFLINE"; }
      if (liveIndicator) { liveIndicator.textContent = "OFFLINE"; liveIndicator.classList.remove("live"); }
      if (offlineScreen) offlineScreen.style.display = "flex";
      if (liveView)      liveView.style.display = "none";
      if (infoStatus)    infoStatus.textContent = "Offline";
      const detectEl = document.getElementById("viewer-detect-status");
      if (detectEl) detectEl.textContent = "OWNER OFFLINE";
    }
  });

  // Watch latest detection via RTDB
  const latestRef = ref(rtdb, "live/owner/latestDetection");
  onValue(latestRef, (snap) => {
    const data = snap.val();
    if (!data) return;

    const detectEl = document.getElementById("viewer-detect-status");
    if (detectEl) {
      if (data.status === "detected") {
        detectEl.textContent = `◉ PERSON DETECTED — ${data.blobCount} region(s)`;
        detectEl.className   = "detect-status detected";
      } else {
        detectEl.textContent = "● SCANNING...";
        detectEl.className   = "detect-status scanning";
      }
    }

    // Notification
    if (notificationsOn && data.status === "detected") {
      addNotification(`Person detected at ${new Date(data.timestamp).toLocaleTimeString()}`);
    }
  });

  // Owner stats
  const statsRef = doc(db, "stats", "owner");
  const statsSnap = await getDoc(statsRef);
  if (statsSnap.exists()) {
    const s = statsSnap.data();
    const infoDetEl = document.getElementById("info-detections");
    if (infoDetEl) infoDetEl.textContent = s.totalDetections || 0;
    const lastEl = document.getElementById("info-last-seen");
    if (lastEl && s.lastDetection) lastEl.textContent = new Date(s.lastDetection).toLocaleTimeString();
  }

  // Live timestamp
  setInterval(() => {
    const ts  = new Date().toTimeString().split(" ")[0];
    const el  = document.getElementById("viewer-timestamp");
    if (el) el.textContent = ts;
  }, 1000);

  // Subscribe to detection log
  subscribeToDetectionLog("viewer-events-list", true);
}

// ─── Firestore detection log ──────────────────────────────
function subscribeToDetectionLog(listId, isViewer = false) {
  const q = query(
    collection(db, "detections"),
    orderBy("createdAt", "desc"),
    limit(20)
  );

  unsubDetections = onSnapshot(q, (snap) => {
    const listEl = document.getElementById(listId);
    if (!listEl) return;

    if (snap.empty) {
      listEl.innerHTML = '<div class="event-empty">No detections yet</div>';
      return;
    }

    listEl.innerHTML = "";
    snap.forEach((d) => {
      const data = d.data();
      const item = document.createElement("div");
      item.className = "event-item detection";

      const startTime = data.startTimestamp
        ? new Date(data.startTimestamp).toLocaleTimeString()
        : "—";
      const duration  = data.durationSeconds ? `${data.durationSeconds}s` : "—";

      item.innerHTML = `
        <div class="event-time">${startTime}</div>
        <div class="event-label">Person detected</div>
        <div class="event-meta">${duration} · ${data.frameCount || 0} frames captured</div>
      `;
      listEl.appendChild(item);
    });

    // Update viewer info counts
    if (isViewer) {
      const infoDetEl = document.getElementById("info-detections");
      if (infoDetEl) infoDetEl.textContent = snap.size;
    }
  });
}

// ─── UI helpers ───────────────────────────────────────────
function addEventToList(screen, { type, label, meta, time }) {
  const listId = screen === "owner" ? "events-list" : "viewer-events-list";
  const listEl = document.getElementById(listId);
  if (!listEl) return;

  const empty = listEl.querySelector(".event-empty");
  if (empty) empty.remove();

  const item = document.createElement("div");
  item.className = `event-item ${type}`;
  item.innerHTML = `
    <div class="event-time">${time}</div>
    <div class="event-label">${label}</div>
    <div class="event-meta">${meta}</div>
  `;
  listEl.prepend(item);

  // Keep list manageable
  const items = listEl.querySelectorAll(".event-item");
  if (items.length > 20) items[items.length - 1].remove();
}

function addNotification(msg) {
  const log = document.getElementById("notification-log");
  if (!log) return;
  const item = document.createElement("div");
  item.className = "notif-item";
  item.textContent = msg;
  log.prepend(item);
  if (log.children.length > 10) log.lastChild.remove();
}

// ─── Owner controls (wired to HTML) ──────────────────────
window.toggleDetection = () => {
  if (!engine) return;
  const paused = engine.toggle();
  const btn = document.getElementById("toggle-detection-btn");
  if (btn) btn.textContent = paused ? "RESUME DETECTION" : "PAUSE DETECTION";
  showToast(paused ? "Detection paused" : "Detection resumed", "info");
};

window.stopBroadcast = async () => {
  if (engine) { engine.stop(); engine = null; }
  await setOwnerOffline();
  showToast("Broadcast stopped", "info");
  const overlay = document.getElementById("cam-overlay");
  const span    = overlay && overlay.querySelector("span");
  if (overlay) overlay.classList.remove("hidden");
  if (span)    span.textContent = "BROADCAST STOPPED";
  const statusEl = document.getElementById("owner-status");
  if (statusEl) statusEl.textContent = "● OFFLINE";
};

window.updateSensitivity = (val) => {
  if (engine) engine.setSensitivity(val);
  const el = document.getElementById("sensitivity-val");
  if (el) el.textContent = val;
};

window.updateBuffer = (val) => {
  if (engine) engine.setBufferMinutes(val);
  const el = document.getElementById("buffer-val");
  if (el) el.textContent = val;
};

let saveActive = false;
window.toggleSave = () => {
  saveActive = !saveActive;
  if (engine) engine.setSaveClips(saveActive);
  const toggle = document.getElementById("save-toggle");
  if (toggle) toggle.classList.toggle("active", saveActive);
};

window.copyLink = () => {
  const url = window.location.href;
  navigator.clipboard.writeText(url).then(() => showToast("Link copied!", "success"));
};

window.toggleNotifications = (el) => {
  notificationsOn = !notificationsOn;
  el.classList.toggle("active", notificationsOn);
  showToast(notificationsOn ? "Notifications on" : "Notifications off", "info");
};

// Initialize save toggle to active
document.addEventListener("DOMContentLoaded", () => {
  const toggle = document.getElementById("save-toggle");
  if (toggle) { toggle.classList.add("active"); saveActive = true; }
});
