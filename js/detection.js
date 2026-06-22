// ============================================================
// detection.js — Canvas-based motion/person detection engine
// Uses frame differencing + blob analysis for person detection.
// Stores 1 min before + 1 min after in a ring buffer.
// ============================================================

import { db, rtdb } from "./firebase-config.js";
import {
  collection, addDoc, serverTimestamp, doc, updateDoc, increment, setDoc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  ref, set, push, onValue, serverTimestamp as rtServerTimestamp, onDisconnect
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { currentUsername } from "./auth.js";

// ─── Config ───────────────────────────────────────────────
const DETECTION_INTERVAL_MS  = 200;   // how often to check for motion
const RING_BUFFER_SECONDS    = 120;   // 1 min before + 1 min after = 2 min total
const RING_BUFFER_FRAMES     = RING_BUFFER_SECONDS * 5; // ~5fps snapshots
const MIN_DETECTION_AREA     = 1500;  // px² blob area to count as person
const POST_DETECTION_HOLD_MS = 60000; // 1 min hold after last detection
const SNAPSHOT_INTERVAL_MS   = 200;   // how often to snapshot into ring buffer
const FPS_SAMPLE_WINDOW      = 30;    // frames to average FPS over

export class DetectionEngine {
  constructor() {
    this.video          = null;
    this.canvas         = null;
    this.ctx            = null;
    this.offCanvas      = null;
    this.offCtx         = null;
    this.prevFrame      = null;
    this.running        = false;
    this.paused         = false;
    this.sensitivity    = 60;         // 1-100; higher = more sensitive
    this.bufferMinutes  = 1;

    // Ring buffer: stores {timestamp, dataURL} objects
    this.ringBuffer     = [];
    this.maxRingFrames  = RING_BUFFER_FRAMES;

    // Detection state
    this.detecting      = false;      // currently in a detection window?
    this.detectionStart = null;
    this.lastDetected   = null;
    this.postHoldTimer  = null;
    this.totalDetections = 0;
    this.saveClips      = true;

    // FPS tracking
    this.frameTimestamps = [];
    this.fps             = 0;

    // Intervals
    this._detectionLoop  = null;
    this._snapshotLoop   = null;
    this._fpsLoop        = null;
    this._sessionTimer   = null;
    this._sessionSeconds = 0;

    // Callbacks
    this.onDetectionStart  = null;
    this.onDetectionEnd    = null;
    this.onFrameProcessed  = null;
    this.onFpsUpdate       = null;

    this._boundRenderLoop  = this._renderLoop.bind(this);
  }

  // ── Init camera ─────────────────────────────────────────
  async startCamera(videoEl, canvasEl) {
    this.video  = videoEl;
    this.canvas = canvasEl;
    this.ctx    = canvasEl.getContext("2d");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
        audio: false
      });
      this.video.srcObject = stream;
      await new Promise(r => { this.video.onloadedmetadata = r; });
      this.video.play();

      this.canvas.width  = this.video.videoWidth  || 1280;
      this.canvas.height = this.video.videoHeight || 720;

      // Off-screen canvas for pixel analysis
      this.offCanvas = document.createElement("canvas");
      this.offCanvas.width  = Math.floor(this.canvas.width  / 4); // downscaled for speed
      this.offCanvas.height = Math.floor(this.canvas.height / 4);
      this.offCtx   = this.offCanvas.getContext("2d");

      this.running = true;
      this._startLoops();
      return true;
    } catch (e) {
      console.error("Camera error:", e);
      return false;
    }
  }

  // ── Main loops ──────────────────────────────────────────
  _startLoops() {
    // Render loop (visual canvas overlay)
    requestAnimationFrame(this._boundRenderLoop);

    // Detection loop
    this._detectionLoop = setInterval(() => {
      if (!this.paused) this._analyzeFrame();
    }, DETECTION_INTERVAL_MS);

    // Ring buffer snapshot loop
    this._snapshotLoop = setInterval(() => {
      this._captureSnapshot();
    }, SNAPSHOT_INTERVAL_MS);

    // Session timer
    this._sessionTimer = setInterval(() => {
      this._sessionSeconds++;
      const m = String(Math.floor(this._sessionSeconds / 60)).padStart(2, "0");
      const s = String(this._sessionSeconds % 60).padStart(2, "0");
      const el = document.getElementById("session-time");
      if (el) el.textContent = `${m}:${s}`;
    }, 1000);

    // Live timestamp
    setInterval(() => {
      const now = new Date();
      const ts  = now.toTimeString().split(" ")[0];
      const el  = document.getElementById("live-timestamp");
      if (el) el.textContent = ts;
    }, 1000);
  }

  _renderLoop() {
    if (!this.running) return;
    requestAnimationFrame(this._boundRenderLoop);

    if (this.video.readyState < 2) return;

    // Track FPS
    const now = performance.now();
    this.frameTimestamps.push(now);
    if (this.frameTimestamps.length > FPS_SAMPLE_WINDOW) this.frameTimestamps.shift();
    if (this.frameTimestamps.length >= 2) {
      const elapsed = this.frameTimestamps[this.frameTimestamps.length - 1] - this.frameTimestamps[0];
      this.fps = Math.round(((this.frameTimestamps.length - 1) / elapsed) * 1000);
      const fpsEl = document.getElementById("fps-val");
      if (fpsEl) fpsEl.textContent = this.fps;
    }

    // Draw video to overlay canvas (transparent — video element is behind)
    // We only draw detection boxes here
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    if (this.detecting && this._lastBlobs) {
      this._drawDetectionBoxes(this._lastBlobs);
    }
  }

  // ── Frame analysis ──────────────────────────────────────
  _analyzeFrame() {
    if (!this.video || this.video.readyState < 2) return;

    const w = this.offCanvas.width;
    const h = this.offCanvas.height;

    // Draw downscaled current frame
    this.offCtx.drawImage(this.video, 0, 0, w, h);
    const current = this.offCtx.getImageData(0, 0, w, h);

    if (!this.prevFrame) {
      this.prevFrame = current;
      return;
    }

    // Pixel difference
    const threshold = Math.round(255 * (1 - this.sensitivity / 100) * 0.5) + 10; // 10-137
    const diff      = new Uint8Array(w * h);
    const cData     = current.data;
    const pData     = this.prevFrame.data;

    for (let i = 0; i < w * h; i++) {
      const idx  = i * 4;
      const dr   = Math.abs(cData[idx]   - pData[idx]);
      const dg   = Math.abs(cData[idx+1] - pData[idx+1]);
      const db   = Math.abs(cData[idx+2] - pData[idx+2]);
      diff[i]    = (dr + dg + db) / 3 > threshold ? 1 : 0;
    }

    // Find blobs (connected components via simple flood fill)
    const blobs = this._findBlobs(diff, w, h);
    const scaleFactor = this.canvas.width / w;

    // Scale blobs to full-res
    const scaledBlobs = blobs.map(b => ({
      x: b.x * scaleFactor,
      y: b.y * scaleFactor,
      w: b.w * scaleFactor,
      h: b.h * scaleFactor,
      area: b.area * (scaleFactor * scaleFactor)
    })).filter(b => b.area > MIN_DETECTION_AREA);

    this._lastBlobs    = scaledBlobs;
    this.prevFrame     = current;

    const personDetected = scaledBlobs.length > 0;
    const statusEl       = document.getElementById("detect-status");
    const flashEl        = document.getElementById("detection-flash");

    if (personDetected) {
      if (statusEl) { statusEl.textContent = `◉ PERSON DETECTED (${scaledBlobs.length})`; statusEl.className = "detect-status detected"; }
      if (flashEl)  { flashEl.classList.add("active"); setTimeout(() => flashEl.classList.remove("active"), 200); }
      this._onPersonDetected(scaledBlobs);
    } else {
      if (statusEl) { statusEl.textContent = "● SCANNING..."; statusEl.className = "detect-status scanning"; }
      this._onNoDetection();
    }
  }

  // ── Blob detection ──────────────────────────────────────
  _findBlobs(diff, w, h) {
    const visited = new Uint8Array(w * h);
    const blobs   = [];

    for (let i = 0; i < w * h; i++) {
      if (diff[i] && !visited[i]) {
        // BFS
        const queue   = [i];
        let minX = w, minY = h, maxX = 0, maxY = 0, area = 0;

        while (queue.length) {
          const idx = queue.pop();
          if (visited[idx]) continue;
          visited[idx] = 1;

          const x = idx % w;
          const y = Math.floor(idx / w);
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          area++;

          const neighbors = [idx-1, idx+1, idx-w, idx+w];
          for (const n of neighbors) {
            if (n >= 0 && n < w*h && diff[n] && !visited[n]) queue.push(n);
          }
        }

        if (area > 20) { // ignore tiny noise blobs
          blobs.push({ x: minX, y: minY, w: maxX - minX, h: maxY - minY, area });
        }
      }
    }

    // Merge overlapping blobs
    return this._mergeBlobs(blobs);
  }

  _mergeBlobs(blobs) {
    if (blobs.length < 2) return blobs;
    const merged = [];
    const used   = new Set();

    for (let i = 0; i < blobs.length; i++) {
      if (used.has(i)) continue;
      let b = { ...blobs[i] };
      for (let j = i + 1; j < blobs.length; j++) {
        if (used.has(j)) continue;
        const bj = blobs[j];
        // Check overlap (with margin)
        const margin = 20;
        if (b.x - margin < bj.x + bj.w && b.x + b.w + margin > bj.x &&
            b.y - margin < bj.y + bj.h && b.y + b.h + margin > bj.y) {
          const x1 = Math.min(b.x, bj.x);
          const y1 = Math.min(b.y, bj.y);
          const x2 = Math.max(b.x + b.w, bj.x + bj.w);
          const y2 = Math.max(b.y + b.h, bj.y + bj.h);
          b = { x: x1, y: y1, w: x2 - x1, h: y2 - y1, area: b.area + bj.area };
          used.add(j);
        }
      }
      merged.push(b);
    }
    return merged;
  }

  // ── Draw detection overlays ─────────────────────────────
  _drawDetectionBoxes(blobs) {
    const ctx = this.ctx;
    ctx.save();
    for (const b of blobs) {
      // Main box
      ctx.strokeStyle = "#00ff9d";
      ctx.lineWidth   = 2;
      ctx.shadowColor = "#00ff9d";
      ctx.shadowBlur  = 8;
      ctx.strokeRect(b.x + 8, b.y + 8, b.w - 16, b.h - 16);

      // Corner marks
      const len = 12;
      const [[bx, by, bw, bh]] = [[b.x + 8, b.y + 8, b.w - 16, b.h - 16]];
      ctx.lineWidth = 3;
      // TL
      ctx.beginPath(); ctx.moveTo(bx, by + len); ctx.lineTo(bx, by); ctx.lineTo(bx + len, by); ctx.stroke();
      // TR
      ctx.beginPath(); ctx.moveTo(bx + bw - len, by); ctx.lineTo(bx + bw, by); ctx.lineTo(bx + bw, by + len); ctx.stroke();
      // BL
      ctx.beginPath(); ctx.moveTo(bx, by + bh - len); ctx.lineTo(bx, by + bh); ctx.lineTo(bx + len, by + bh); ctx.stroke();
      // BR
      ctx.beginPath(); ctx.moveTo(bx + bw - len, by + bh); ctx.lineTo(bx + bw, by + bh); ctx.lineTo(bx + bw, by + bh - len); ctx.stroke();

      // Label
      ctx.shadowBlur = 0;
      ctx.fillStyle  = "rgba(0,0,0,0.7)";
      ctx.fillRect(bx, by - 20, 80, 18);
      ctx.fillStyle = "#00ff9d";
      ctx.font      = "bold 10px 'Space Mono', monospace";
      ctx.fillText("PERSON", bx + 4, by - 6);
    }
    ctx.restore();
  }

  // ── Ring buffer snapshot ─────────────────────────────────
  _captureSnapshot() {
    if (!this.video || this.video.readyState < 2) return;

    const snap   = document.createElement("canvas");
    snap.width   = 320;
    snap.height  = 180;
    const sCtx   = snap.getContext("2d");
    sCtx.drawImage(this.video, 0, 0, 320, 180);

    this.ringBuffer.push({ timestamp: Date.now(), dataURL: snap.toDataURL("image/jpeg", 0.6) });
    if (this.ringBuffer.length > this.maxRingFrames) this.ringBuffer.shift();
  }

  // ── Detection event handlers ─────────────────────────────
  _onPersonDetected(blobs) {
    this.lastDetected = Date.now();

    if (!this.detecting) {
      this.detecting      = true;
      this.detectionStart = Date.now();
      this.totalDetections++;

      const countEl = document.getElementById("total-detections");
      if (countEl) countEl.textContent = this.totalDetections;

      this._fireDetectionEvent(blobs);

      if (this.onDetectionStart) this.onDetectionStart({
        time: this.detectionStart,
        blobs,
        count: this.totalDetections
      });
    }

    // Reset the post-detection hold timer
    if (this.postHoldTimer) clearTimeout(this.postHoldTimer);
    this.postHoldTimer = setTimeout(() => {
      this._onDetectionWindowClosed();
    }, POST_DETECTION_HOLD_MS);
  }

  _onNoDetection() {
    // Detection window closes via timeout, not immediately
  }

  _onDetectionWindowClosed() {
    if (!this.detecting) return;
    this.detecting = false;

    const endTime   = Date.now();
    const duration  = Math.round((endTime - this.detectionStart) / 1000);

    // Collect frames: ring buffer already has 1 min before; capture 1 more min now
    const preBuffer  = this.ringBuffer.filter(f => f.timestamp >= this.detectionStart - 60000);
    const clip = {
      detectionId:    `det_${this.detectionStart}`,
      startTimestamp: this.detectionStart,
      endTimestamp:   endTime,
      durationSeconds: duration,
      frameCount:     preBuffer.length,
      previewFrame:   preBuffer.length > 0 ? preBuffer[Math.floor(preBuffer.length / 2)].dataURL : null
    };

    this._saveDetectionToFirestore(clip);

    if (this.onDetectionEnd) this.onDetectionEnd(clip);
  }

  // ── Firebase save ────────────────────────────────────────
  async _fireDetectionEvent(blobs) {
    try {
      // Realtime DB: push live event for viewers
      const liveRef = ref(rtdb, "live/owner/latestDetection");
      await set(liveRef, {
        timestamp: Date.now(),
        blobCount: blobs.length,
        status:    "detected"
      });
    } catch (e) { console.warn("RTDB write failed:", e); }
  }

  async _saveDetectionToFirestore(clip) {
    if (!this.saveClips) return;
    try {
      await addDoc(collection(db, "detections"), {
        owner:          "owner",
        detectionId:    clip.detectionId,
        startTimestamp: clip.startTimestamp,
        endTimestamp:   clip.endTimestamp,
        durationSeconds: clip.durationSeconds,
        frameCount:     clip.frameCount,
        previewFrame:   clip.previewFrame,
        createdAt:      serverTimestamp()
      });

      // Update owner stats
      await setDoc(doc(db, "stats", "owner"), {
        totalDetections: this.totalDetections,
        lastDetection:   clip.startTimestamp,
        updatedAt:       serverTimestamp()
      }, { merge: true });

    } catch (e) { console.warn("Firestore save failed:", e); }
  }

  // ── Controls ─────────────────────────────────────────────
  pause()  { this.paused = true;  }
  resume() { this.paused = false; }
  toggle() { this.paused = !this.paused; return this.paused; }

  setSensitivity(val) { this.sensitivity = parseInt(val); }
  setBufferMinutes(val) {
    this.bufferMinutes  = parseFloat(val);
    this.maxRingFrames  = Math.round(this.bufferMinutes * 60 * 5);
  }
  setSaveClips(val) { this.saveClips = val; }

  stop() {
    this.running = false;
    clearInterval(this._detectionLoop);
    clearInterval(this._snapshotLoop);
    clearInterval(this._sessionTimer);
    if (this.postHoldTimer) clearTimeout(this.postHoldTimer);
    if (this.video && this.video.srcObject) {
      this.video.srcObject.getTracks().forEach(t => t.stop());
    }
  }
}

// ─── RTDB Presence: mark owner as live ────────────────────
export async function setOwnerOnline() {
  const liveRef    = ref(rtdb, "live/owner");
  const connectedRef = ref(rtdb, ".info/connected");

  onValue(connectedRef, (snap) => {
    if (snap.val()) {
      onDisconnect(liveRef).update({ online: false, updatedAt: Date.now() });
      set(liveRef, { online: true, updatedAt: Date.now() });
    }
  });
}

export async function setOwnerOffline() {
  const liveRef = ref(rtdb, "live/owner");
  await set(liveRef, { online: false, updatedAt: Date.now() });
}

// ─── Subscribe to owner live status (for viewers) ─────────
export function subscribeToOwnerStatus(callback) {
  const liveRef = ref(rtdb, "live/owner");
  return onValue(liveRef, (snap) => {
    callback(snap.val() || { online: false });
  });
}

// ─── Subscribe to viewer count via RTDB ───────────────────
export function trackViewerPresence(username) {
  const viewerRef  = ref(rtdb, `viewers/${username}`);
  const countRef   = ref(rtdb, "viewerCount");
  onDisconnect(viewerRef).remove();
  set(viewerRef, { username, joinedAt: Date.now() });
  return onValue(ref(rtdb, "viewers"), (snap) => {
    const count = snap.val() ? Object.keys(snap.val()).length : 0;
    set(countRef, count);
    const el = document.getElementById("viewer-count");
    if (el) el.textContent = count;
    const infoEl = document.getElementById("info-viewers");
    if (infoEl) infoEl.textContent = count;
  });
}
