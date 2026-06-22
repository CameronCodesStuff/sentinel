import { initAuth, showScreen, showToast } from "./auth.js";
import {
  DetectionEngine, setOwnerOnline, setOwnerOffline,
  subscribeToOwnerStatus, trackViewerPresence
} from "./detection.js";
import { db, rtdb } from "./firebase-config.js";
import {
  collection, query, orderBy, limit, onSnapshot,
  doc, getDoc, where, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { ref, onValue } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

let engine          = null;
let unsubDetections = null;
let notificationsOn = true;
let saveActive      = true;
let allClips        = [];

initAuth(
  async (userData) => {
    if (userData.username === "owner") {
      await initOwnerMode();
    } else {
      await initViewerMode(userData.username);
    }
  },
  () => {
    if (engine) { engine.stop(); engine = null; }
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
    showToast("Camera active", "success");
  } else {
    overlayEl.querySelector("span").textContent = "⚠ CAMERA ACCESS DENIED";
    showToast("Camera access denied", "error");
  }

  engine.onDetectionStart = (data) => {
    addEvent("events-list", `Motion detected`, `${data.blobs.length} zone(s) active`, new Date().toLocaleTimeString());
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
  document.getElementById("viewer-username-display").textContent = username.toUpperCase();

  trackViewerPresence(username);

  subscribeToOwnerStatus((status) => {
    const statusBadge = document.getElementById("stream-status");
    const liveInd     = document.getElementById("stream-live-indicator");
    const offScreen   = document.getElementById("offline-screen");
    const liveView    = document.getElementById("live-stream-view");
    const infoStatus  = document.getElementById("info-status");
    const pulse       = document.getElementById("viewer-pulse");

    if (status.online) {
      if (statusBadge) { statusBadge.textContent = "● LIVE"; statusBadge.className = "status-badge green"; }
      if (liveInd)     { liveInd.textContent = "● LIVE"; liveInd.classList.add("live"); }
      if (offScreen)   offScreen.style.display = "none";
      if (liveView)    liveView.style.display = "flex";
      if (infoStatus)  infoStatus.textContent = "Online";
      if (pulse)       pulse.className = "pulse-dot online";
    } else {
      if (statusBadge) { statusBadge.textContent = "● OFFLINE"; statusBadge.className = "status-badge dim"; }
      if (liveInd)     { liveInd.textContent = "OFFLINE"; liveInd.classList.remove("live"); }
      if (offScreen)   offScreen.style.display = "flex";
      if (liveView)    liveView.style.display = "none";
      if (infoStatus)  infoStatus.textContent = "Offline";
      if (pulse)       pulse.className = "pulse-dot";
      const detectEl = document.getElementById("viewer-detect-status");
      if (detectEl)    detectEl.textContent = "OWNER OFFLINE";
    }
  });

  onValue(ref(rtdb, "live/owner/latestDetection"), snap => {
    const data = snap.val();
    if (!data) return;
    const detectEl = document.getElementById("viewer-detect-status");
    if (detectEl) {
      if (data.status === "detected") {
        detectEl.textContent = `◉ MOTION — ${data.blobCount} zone(s)`;
        detectEl.className   = "detect-status detected";
      } else {
        detectEl.textContent = "● SCANNING...";
        detectEl.className   = "detect-status";
      }
    }
    if (notificationsOn && data.status === "detected") {
      addNotif(`Motion at ${new Date(data.timestamp).toLocaleTimeString()}`);
    }
  });

  setInterval(() => {
    const el = document.getElementById("viewer-timestamp");
    if (el) el.textContent = new Date().toTimeString().split(" ")[0];
  }, 1000);

  const statsSnap = await getDoc(doc(db, "stats", "owner"));
  if (statsSnap.exists()) {
    const s = statsSnap.data();
    const detEl  = document.getElementById("info-detections");
    const lastEl = document.getElementById("info-last-seen");
    if (detEl)  detEl.textContent = s.totalDetections || 0;
    if (lastEl && s.lastDetection) lastEl.textContent = new Date(s.lastDetection).toLocaleTimeString();
  }

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
      const data  = d.data();
      const time  = data.startTimestamp ? new Date(data.startTimestamp).toLocaleTimeString() : "—";
      const dur   = data.durationSeconds ? `${data.durationSeconds}s` : "—";
      const item  = document.createElement("div");
      item.className = "event-item";
      item.innerHTML = `<div class="event-time">${time}</div><div class="event-label">Motion detected</div><div class="event-meta">${dur} · ${data.frameCount||0} frames</div>`;
      listEl.appendChild(item);
    });

    if (updateInfo) {
      const detEl = document.getElementById("info-detections");
      if (detEl) detEl.textContent = snap.size;
    }
  });
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
  if (items.length > 20) items[items.length - 1].remove();
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
  grid.innerHTML = '<div class="lib-loading">Loading clips...</div>';

  try {
    let q;
    const now = Date.now();

    if (filter === "today") {
      const startOfDay = new Date(); startOfDay.setHours(0,0,0,0);
      q = query(collection(db, "detections"), where("startTimestamp", ">=", startOfDay.getTime()), orderBy("startTimestamp", "desc"), limit(50));
    } else if (filter === "week") {
      const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
      q = query(collection(db, "detections"), where("startTimestamp", ">=", weekAgo), orderBy("startTimestamp", "desc"), limit(100));
    } else {
      q = query(collection(db, "detections"), orderBy("startTimestamp", "desc"), limit(100));
    }

    const snap = await getDocs(q);
    allClips   = [];
    snap.forEach(d => allClips.push({ id: d.id, ...d.data() }));

    renderLibrary(allClips);
  } catch (e) {
    grid.innerHTML = '<div class="lib-empty">Failed to load clips.</div>';
    console.error(e);
  }
}

function renderLibrary(clips) {
  const grid = document.getElementById("library-grid");

  if (!clips.length) { grid.innerHTML = '<div class="lib-empty">No detections found.</div>'; return; }

  grid.innerHTML = "";
  clips.forEach(clip => {
    const date     = clip.startTimestamp ? new Date(clip.startTimestamp) : null;
    const dateStr  = date ? date.toLocaleDateString() : "Unknown";
    const timeStr  = date ? date.toLocaleTimeString() : "Unknown";
    const dur      = clip.durationSeconds ? `${clip.durationSeconds}s` : "—";

    const card = document.createElement("div");
    card.className = "clip-card";
    card.innerHTML = `
      <div class="clip-thumb">
        ${clip.previewFrame
          ? `<img src="${clip.previewFrame}" alt="Detection preview" loading="lazy"/>`
          : `<div class="clip-thumb-placeholder">📹</div>`}
        <div class="clip-duration-badge">${dur}</div>
      </div>
      <div class="clip-info">
        <div class="clip-date">${dateStr}</div>
        <div class="clip-time">${timeStr}</div>
        <div class="clip-frames">${clip.frameCount || 0} frames captured</div>
      </div>`;
    card.onclick = () => openClip(clip);
    grid.appendChild(card);
  });
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
  else                   { img.style.display = "none"; }

  document.getElementById("clip-info-grid").innerHTML = `
    <div class="clip-stat"><div class="clip-stat-label">DATE</div><div class="clip-stat-val">${dateStr}</div></div>
    <div class="clip-stat"><div class="clip-stat-label">TIME</div><div class="clip-stat-val">${timeStr}</div></div>
    <div class="clip-stat"><div class="clip-stat-label">DURATION</div><div class="clip-stat-val">${dur}</div></div>
    <div class="clip-stat"><div class="clip-stat-label">FRAMES</div><div class="clip-stat-val">${clip.frameCount || 0}</div></div>`;

  document.getElementById("clip-modal").classList.add("open");
}

let currentFilter = "all";

window.openLibrary = () => {
  document.getElementById("library-modal").classList.add("open");
  loadLibrary(currentFilter);
};

window.closeLibrary = () => document.getElementById("library-modal").classList.remove("open");
window.closeLibraryOutside = (e) => { if (e.target.id === "library-modal") window.closeLibrary(); };

window.closeClip = () => document.getElementById("clip-modal").classList.remove("open");
window.closeClipOutside = (e) => { if (e.target.id === "clip-modal") window.closeClip(); };

window.filterLibrary = (filter, btn) => {
  currentFilter = filter;
  document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  loadLibrary(filter);
};

window.toggleDetection = () => {
  if (!engine) return;
  const paused = engine.toggle();
  document.getElementById("toggle-detection-btn").textContent = paused ? "RESUME" : "PAUSE";
  showToast(paused ? "Detection paused" : "Detection resumed", "info");
};

window.stopBroadcast = async () => {
  if (engine) { engine.stop(); engine = null; }
  await setOwnerOffline();
  const overlay = document.getElementById("cam-overlay");
  const span    = overlay?.querySelector("span");
  if (overlay) overlay.classList.remove("hidden");
  if (span)    span.textContent = "BROADCAST STOPPED";
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
