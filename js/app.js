import { initAuth, showScreen, showToast } from "./auth.js";
import { DetectionEngine, setOwnerOnline, setOwnerOffline, subscribeToOwnerStatus, trackViewerPresence } from "./detection.js";
import { OwnerBroadcaster, ViewerReceiver } from "./webrtc.js";
import { db, rtdb } from "./firebase-config.js";
import {
  collection, query, orderBy, limit, onSnapshot,
  doc, getDoc, getDocs, where
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { ref, onValue } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

let engine          = null;
let broadcaster     = null;
let receiver        = null;
let unsubDetections = null;
let notificationsOn = true;
let saveActive      = true;
let currentFilter   = "all";

initAuth(
  async (userData) => {
    if (userData.username === "owner") {
      await initOwnerMode();
    } else {
      await initViewerMode(userData.username);
    }
  },
  () => {
    if (engine)      { engine.stop(); engine = null; }
    if (broadcaster) { broadcaster.stop(); broadcaster = null; }
    if (receiver)    { receiver.disconnect(); receiver = null; }
    if (unsubDetections) { unsubDetections(); unsubDetections = null; }
    showScreen("auth-screen");
  }
);

async function initOwnerMode() {
  showScreen("owner-screen");
  await setOwnerOnline();

  engine = new DetectionEngine();
  engine.setSensitivity(30);
  engine.setSaveClips(true);

  const videoEl   = document.getElementById("owner-video");
  const canvasEl  = document.getElementById("detection-canvas");
  const overlayEl = document.getElementById("cam-overlay");

  const ok = await engine.startCamera(videoEl, canvasEl);
  if (ok) {
    overlayEl.classList.add("hidden");
    showToast("Camera active — broadcasting", "success");

    broadcaster = new OwnerBroadcaster(videoEl.srcObject);
    broadcaster.start();
  } else {
    overlayEl.querySelector("span").textContent = "⚠ CAMERA ACCESS DENIED";
    showToast("Camera access denied", "error");
  }

  engine.onDetectionStart = (data) => {
    addEvent("events-list", "Motion detected", `${data.blobs.length} zone(s) active`, new Date().toLocaleTimeString());
    showToast("⚡ Motion detected!", "success");
  };
  engine.onDetectionEnd = (clip) => {
    addEvent("events-list", `Clip saved — ${clip.durationSeconds}s`, `${clip.frameCount} frames`, new Date().toLocaleTimeString());
  };

  trackViewerPresence("__owner__");
  subscribeDetectionLog("events-list");
}

async function initViewerMode(username) {
  showScreen("viewer-screen");
  const unEl = document.getElementById("viewer-username-display");
  if (unEl) unEl.textContent = username.toUpperCase();

  trackViewerPresence(username);

  subscribeToOwnerStatus(async (status) => {
    const statusBadge = document.getElementById("stream-status");
    const liveInd     = document.getElementById("stream-live-indicator");
    const offScreen   = document.getElementById("offline-screen");
    const viewerVideo = document.getElementById("viewer-video");
    const infoStatus  = document.getElementById("info-status");
    const pulse       = document.getElementById("viewer-pulse");
    const liveBadge   = document.getElementById("live-badge-overlay");

    if (status.online) {
      if (statusBadge) { statusBadge.textContent = "● LIVE"; statusBadge.className = "status-badge green"; }
      if (liveInd)     { liveInd.textContent = "● LIVE"; liveInd.classList.add("live"); }
      if (infoStatus)  infoStatus.textContent = "Online";
      if (pulse)       pulse.className = "pulse-dot online";

      if (!receiver) {
        receiver = new ViewerReceiver(viewerVideo);
        await receiver.connect();
      }
    } else {
      if (statusBadge) { statusBadge.textContent = "● OFFLINE"; statusBadge.className = "status-badge dim"; }
      if (liveInd)     { liveInd.textContent = "OFFLINE"; liveInd.classList.remove("live"); }
      if (offScreen)   offScreen.style.display = "flex";
      if (viewerVideo) { viewerVideo.srcObject = null; viewerVideo.style.display = "none"; }
      if (liveBadge)   liveBadge.style.display = "none";
      if (infoStatus)  infoStatus.textContent = "Offline";
      if (pulse)       pulse.className = "pulse-dot";

      const detectEl = document.getElementById("viewer-detect-status");
      if (detectEl)    detectEl.textContent = "OWNER OFFLINE";

      if (receiver) { receiver.disconnect(); receiver = null; }
    }
  });

  onValue(ref(rtdb, "live/owner/latestDetection"), snap => {
    const data = snap.val();
    if (!data) return;
    const detectEl = document.getElementById("viewer-detect-status");
    if (detectEl) {
      detectEl.textContent = data.status === "detected"
        ? `◉ MOTION — ${data.blobCount} zone(s)`
        : "● SCANNING...";
      detectEl.className = data.status === "detected" ? "detect-status detected" : "detect-status";
    }
    if (notificationsOn && data.status === "detected") {
      addNotif(`Motion at ${new Date(data.timestamp).toLocaleTimeString()}`);
    }
  });

  setInterval(() => {
    const el = document.getElementById("viewer-timestamp");
    if (el) el.textContent = new Date().toTimeString().split(" ")[0];
  }, 1000);

  try {
    const statsSnap = await getDoc(doc(db, "stats", "owner"));
    if (statsSnap.exists()) {
      const s = statsSnap.data();
      const detEl  = document.getElementById("info-detections");
      const lastEl = document.getElementById("info-last-seen");
      if (detEl)  detEl.textContent = s.totalDetections || 0;
      if (lastEl && s.lastDetection) lastEl.textContent = new Date(s.lastDetection).toLocaleTimeString();
    }
  } catch (e) {}

  subscribeDetectionLog("viewer-events-list", true);
}

function subscribeDetectionLog(listId, updateInfo = false) {
  const q = query(collection(db, "detections"), orderBy("createdAt", "desc"), limit(20));
  unsubDetections = onSnapshot(q, snap => {
    const listEl = document.getElementById(listId);
    if (!listEl) return;
    if (snap.empty) { listEl.innerHTML = '<div class="event-empty">No detections yet</div>'; return; }
    listEl.innerHTML = "";
    snap.forEach(d => {
      const data = d.data();
      const time = data.startTimestamp ? new Date(data.startTimestamp).toLocaleTimeString() : "—";
      const dur  = data.durationSeconds ? `${data.durationSeconds}s` : "—";
      const item = document.createElement("div");
      item.className = "event-item";
      item.innerHTML = `<div class="event-time">${time}</div><div class="event-label">Motion detected</div><div class="event-meta">${dur} · ${data.frameCount||0} frames</div>`;
      listEl.appendChild(item);
    });
    if (updateInfo) {
      const detEl = document.getElementById("info-detections");
      if (detEl) detEl.textContent = snap.size;
    }
  }, err => console.warn("Snapshot error:", err));
}

function addEvent(listId, label, meta, time) {
  const listEl = document.getElementById(listId);
  if (!listEl) return;
  listEl.querySelector(".event-empty")?.remove();
  const item = document.createElement("div");
  item.className = "event-item";
  item.innerHTML = `<div class="event-time">${time}</div><div class="event-label">${label}</div><div class="event-meta">${meta}</div>`;
  listEl.prepend(item);
  const items = listEl.querySelectorAll(".event-item");
  if (items.length > 20) items[items.length-1].remove();
}

function addNotif(msg) {
  const log = document.getElementById("notification-log");
  if (!log) return;
  const item = document.createElement("div");
  item.className = "notif-item";
  item.textContent = msg;
  log.prepend(item);
  if (log.children.length > 10) log.lastChild.remove();
}

async function loadLibrary(filter = "all") {
  const grid = document.getElementById("library-grid");
  if (!grid) return;
  grid.innerHTML = '<div class="lib-loading">Loading clips...</div>';

  try {
    let q;
    if (filter === "today") {
      const sod = new Date(); sod.setHours(0,0,0,0);
      q = query(collection(db, "detections"), where("startTimestamp",">=",sod.getTime()), orderBy("startTimestamp","desc"), limit(50));
    } else if (filter === "week") {
      const wa = Date.now() - 7*24*60*60*1000;
      q = query(collection(db, "detections"), where("startTimestamp",">=",wa), orderBy("startTimestamp","desc"), limit(100));
    } else {
      q = query(collection(db, "detections"), orderBy("createdAt","desc"), limit(100));
    }

    const snap = await getDocs(q);
    if (snap.empty) { grid.innerHTML = '<div class="lib-empty">No detections found.</div>'; return; }

    grid.innerHTML = "";
    snap.forEach(d => {
      const clip    = { id: d.id, ...d.data() };
      const date    = clip.startTimestamp ? new Date(clip.startTimestamp) : null;
      const dateStr = date ? date.toLocaleDateString() : "Unknown";
      const timeStr = date ? date.toLocaleTimeString() : "Unknown";
      const dur     = clip.durationSeconds ? `${clip.durationSeconds}s` : "—";

      const card = document.createElement("div");
      card.className = "clip-card";
      card.innerHTML = `
        <div class="clip-thumb">
          ${clip.previewFrame
            ? `<img src="${clip.previewFrame}" alt="Preview" loading="lazy"/>`
            : `<div class="clip-thumb-placeholder">📹</div>`}
          <div class="clip-duration-badge">${dur}</div>
        </div>
        <div class="clip-info">
          <div class="clip-date">${dateStr}</div>
          <div class="clip-time">${timeStr}</div>
          <div class="clip-frames">${clip.frameCount||0} frames</div>
        </div>`;
      card.onclick = () => openClip(clip);
      grid.appendChild(card);
    });
  } catch (e) {
    console.error("Library load error:", e);
    grid.innerHTML = `<div class="lib-empty">Error: ${e.message}<br><br>Make sure Firestore indexes are deployed.</div>`;
  }
}

function openClip(clip) {
  const date    = clip.startTimestamp ? new Date(clip.startTimestamp) : null;
  const dateStr = date ? date.toLocaleDateString() : "Unknown";
  const timeStr = date ? date.toLocaleTimeString() : "Unknown";
  const dur     = clip.durationSeconds ? `${clip.durationSeconds}s` : "—";

  document.getElementById("clip-modal-title").textContent = `DETECTION — ${timeStr}`;
  document.getElementById("clip-modal-meta").textContent  = dateStr;

  const img = document.getElementById("clip-preview-img");
  if (clip.previewFrame) { img.src = clip.previewFrame; img.style.display = "block"; }
  else img.style.display = "none";

  document.getElementById("clip-info-grid").innerHTML = `
    <div class="clip-stat"><div class="clip-stat-label">DATE</div><div class="clip-stat-val">${dateStr}</div></div>
    <div class="clip-stat"><div class="clip-stat-label">TIME</div><div class="clip-stat-val">${timeStr}</div></div>
    <div class="clip-stat"><div class="clip-stat-label">DURATION</div><div class="clip-stat-val">${dur}</div></div>
    <div class="clip-stat"><div class="clip-stat-label">FRAMES</div><div class="clip-stat-val">${clip.frameCount||0}</div></div>`;

  document.getElementById("clip-modal").classList.add("open");
}

window.openLibrary        = () => { document.getElementById("library-modal").classList.add("open"); loadLibrary(currentFilter); };
window.closeLibrary       = () => document.getElementById("library-modal").classList.remove("open");
window.closeLibraryOutside = (e) => { if (e.target.id === "library-modal") window.closeLibrary(); };
window.closeClip          = () => document.getElementById("clip-modal").classList.remove("open");
window.closeClipOutside   = (e) => { if (e.target.id === "clip-modal") window.closeClip(); };
window.filterLibrary      = (filter, btn) => {
  currentFilter = filter;
  document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  loadLibrary(filter);
};

window.toggleFullscreen = (wrapperId) => {
  const el = document.getElementById(wrapperId);
  if (!el) return;
  el.classList.add("fullscreen");
  document.body.classList.add("has-fullscreen");
};
window.exitFullscreen = () => {
  document.querySelectorAll(".fullscreen").forEach(el => el.classList.remove("fullscreen"));
  document.body.classList.remove("has-fullscreen");
};
document.addEventListener("keydown", e => { if (e.key === "Escape") window.exitFullscreen(); });

window.toggleDetection = () => {
  if (!engine) return;
  const paused = engine.toggle();
  document.getElementById("toggle-detection-btn").textContent = paused ? "RESUME" : "PAUSE";
  showToast(paused ? "Detection paused" : "Detection resumed", "info");
};

window.stopBroadcast = async () => {
  if (engine)      { engine.stop(); engine = null; }
  if (broadcaster) { broadcaster.stop(); broadcaster = null; }
  await setOwnerOffline();
  const overlay = document.getElementById("cam-overlay");
  if (overlay) { overlay.classList.remove("hidden"); overlay.querySelector("span").textContent = "BROADCAST STOPPED"; }
  document.getElementById("owner-status").textContent = "● OFFLINE";
  showToast("Broadcast stopped", "info");
};

window.updateSensitivity = (val) => {
  if (engine) engine.setSensitivity(val);
  document.getElementById("sensitivity-val").textContent = val;
};

window.toggleSave = () => {
  saveActive = !saveActive;
  if (engine) engine.setSaveClips(saveActive);
  document.getElementById("save-toggle").classList.toggle("active", saveActive);
};

window.toggleNotifications = (el) => {
  notificationsOn = !notificationsOn;
  el.classList.toggle("active", notificationsOn);
  showToast(notificationsOn ? "Notifications on" : "Notifications off", "info");
};
