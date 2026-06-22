import { db, rtdb } from "./firebase-config.js";
import {
  collection, addDoc, serverTimestamp, doc, setDoc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  ref, set, onValue, onDisconnect
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

const ANALYSIS_INTERVAL   = 80;
const SNAPSHOT_INTERVAL   = 500;
const POST_HOLD_MS        = 60000;
const RING_BUFFER_MS      = 70000;
const DIFF_SCALE          = 6;

export class DetectionEngine {
  constructor() {
    this.video          = null;
    this.canvas         = null;
    this.ctx            = null;
    this.offCanvas      = null;
    this.offCtx         = null;
    this.prevFrameData  = null;
    this.running        = false;
    this.paused         = false;
    this.sensitivity    = 30;
    this.saveClips      = true;

    this.ringBuffer       = [];
    this.detecting        = false;
    this.detectionStart   = null;
    this.lastDetected     = null;
    this.postHoldTimer    = null;
    this.totalDetections  = 0;

    this.fpsTimes         = [];
    this.fps              = 0;
    this._sessionSecs     = 0;

    this._rafId           = null;
    this._detLoop         = null;
    this._snapLoop        = null;
    this._sessionLoop     = null;
    this._tsLoop          = null;

    this.onDetectionStart = null;
    this.onDetectionEnd   = null;

    this._renderBound     = this._renderLoop.bind(this);
    this._lastBlobs       = [];
  }

  async startCamera(videoEl, canvasEl) {
    this.video  = videoEl;
    this.canvas = canvasEl;
    this.ctx    = canvasEl.getContext("2d");

    try {
      const isMobile = /Mobi|Android/i.test(navigator.userAgent);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: isMobile
          ? { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }
          : { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
      this.video.srcObject = stream;
      await new Promise(r => { this.video.onloadedmetadata = r; });
      await this.video.play();

      this.canvas.width  = this.video.videoWidth  || 1280;
      this.canvas.height = this.video.videoHeight || 720;

      this.offCanvas        = document.createElement("canvas");
      this.offCanvas.width  = Math.floor(this.canvas.width  / DIFF_SCALE);
      this.offCanvas.height = Math.floor(this.canvas.height / DIFF_SCALE);
      this.offCtx           = this.offCanvas.getContext("2d", { willReadFrequently: true });

      this.running = true;
      this._startLoops();
      return true;
    } catch (e) {
      console.error(e);
      return false;
    }
  }

  _startLoops() {
    this._rafId     = requestAnimationFrame(this._renderBound);
    this._detLoop   = setInterval(() => { if (!this.paused) this._analyzeFrame(); }, ANALYSIS_INTERVAL);
    this._snapLoop  = setInterval(() => this._captureSnapshot(), SNAPSHOT_INTERVAL);
    this._sessionLoop = setInterval(() => {
      this._sessionSecs++;
      const el = document.getElementById("session-time");
      if (el) el.textContent =
        String(Math.floor(this._sessionSecs / 60)).padStart(2,"0") + ":" +
        String(this._sessionSecs % 60).padStart(2,"0");
    }, 1000);
    this._tsLoop = setInterval(() => {
      const t = new Date().toTimeString().split(" ")[0];
      const el = document.getElementById("live-timestamp");
      if (el) el.textContent = t;
    }, 1000);
  }

  _renderLoop() {
    if (!this.running) return;
    this._rafId = requestAnimationFrame(this._renderBound);

    const now = performance.now();
    this.fpsTimes.push(now);
    if (this.fpsTimes.length > 30) this.fpsTimes.shift();
    if (this.fpsTimes.length >= 2) {
      const elapsed = this.fpsTimes[this.fpsTimes.length - 1] - this.fpsTimes[0];
      this.fps = Math.round(((this.fpsTimes.length - 1) / elapsed) * 1000);
      const fpsEl = document.getElementById("fps-val");
      if (fpsEl) fpsEl.textContent = this.fps;
    }

    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this._lastBlobs.length) this._drawBoxes(this._lastBlobs);
  }

  _analyzeFrame() {
    if (!this.video || this.video.readyState < 2) return;

    const w = this.offCanvas.width;
    const h = this.offCanvas.height;

    this.offCtx.drawImage(this.video, 0, 0, w, h);
    const imageData = this.offCtx.getImageData(0, 0, w, h);
    const curr = imageData.data;

    if (!this.prevFrameData) {
      this.prevFrameData = new Uint8ClampedArray(curr);
      return;
    }

    const threshold = Math.round(15 + (100 - this.sensitivity) * 1.2);
    const diff      = new Uint8Array(w * h);
    let   changes   = 0;

    for (let i = 0; i < w * h; i++) {
      const p  = i * 4;
      const dr = Math.abs(curr[p]   - this.prevFrameData[p]);
      const dg = Math.abs(curr[p+1] - this.prevFrameData[p+1]);
      const db = Math.abs(curr[p+2] - this.prevFrameData[p+2]);
      if ((dr + dg + db) / 3 > threshold) { diff[i] = 1; changes++; }
    }

    this.prevFrameData = new Uint8ClampedArray(curr);

    const changeRatio = changes / (w * h);

    if (changeRatio > 0.005) {
      const blobs = this._findBlobs(diff, w, h);
      const scale = this.canvas.width / w;
      this._lastBlobs = blobs.map(b => ({
        x: b.x * scale, y: b.y * scale,
        w: b.w * scale, h: b.h * scale,
        area: b.area * scale * scale
      })).filter(b => b.area > 800);

      if (this._lastBlobs.length > 0) {
        this._onDetected(this._lastBlobs);
        const statusEl = document.getElementById("detect-status");
        const flashEl  = document.getElementById("detection-flash");
        if (statusEl) { statusEl.textContent = `◉ MOTION — ${this._lastBlobs.length} zone(s)`; statusEl.className = "detect-status detected"; }
        if (flashEl)  { flashEl.classList.add("active"); setTimeout(() => flashEl.classList.remove("active"), 150); }
        return;
      }
    }

    this._lastBlobs = [];
    const statusEl = document.getElementById("detect-status");
    if (statusEl && !this.paused) { statusEl.textContent = "● SCANNING..."; statusEl.className = "detect-status"; }
  }

  _findBlobs(diff, w, h) {
    const visited = new Uint8Array(w * h);
    const blobs   = [];

    for (let i = 0; i < w * h; i++) {
      if (!diff[i] || visited[i]) continue;

      const stack = [i];
      let minX = w, minY = h, maxX = 0, maxY = 0, area = 0;

      while (stack.length) {
        const idx = stack.pop();
        if (visited[idx]) continue;
        visited[idx] = 1;

        const x = idx % w;
        const y = Math.floor(idx / w);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        area++;

        if (x > 0     && !visited[idx-1] && diff[idx-1]) stack.push(idx-1);
        if (x < w-1   && !visited[idx+1] && diff[idx+1]) stack.push(idx+1);
        if (y > 0     && !visited[idx-w] && diff[idx-w]) stack.push(idx-w);
        if (y < h-1   && !visited[idx+w] && diff[idx+w]) stack.push(idx+w);
      }

      if (area > 8) blobs.push({ x: minX, y: minY, w: maxX-minX, h: maxY-minY, area });
    }

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
        const m  = 15;
        if (b.x-m < bj.x+bj.w && b.x+b.w+m > bj.x && b.y-m < bj.y+bj.h && b.y+b.h+m > bj.y) {
          const x1 = Math.min(b.x, bj.x), y1 = Math.min(b.y, bj.y);
          const x2 = Math.max(b.x+b.w, bj.x+bj.w), y2 = Math.max(b.y+b.h, bj.y+bj.h);
          b = { x: x1, y: y1, w: x2-x1, h: y2-y1, area: b.area + bj.area };
          used.add(j);
        }
      }
      merged.push(b);
    }
    return merged;
  }

  _drawBoxes(blobs) {
    const ctx = this.ctx;
    ctx.save();

    for (const b of blobs) {
      const bx = b.x + 8, by = b.y + 8, bw = b.w - 16, bh = b.h - 16;
      const len = 14;

      ctx.strokeStyle = "#00ff9d";
      ctx.lineWidth   = 1.5;
      ctx.shadowColor = "#00ff9d";
      ctx.shadowBlur  = 10;
      ctx.strokeRect(bx, by, bw, bh);

      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(bx, by+len); ctx.lineTo(bx,by); ctx.lineTo(bx+len,by); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(bx+bw-len,by); ctx.lineTo(bx+bw,by); ctx.lineTo(bx+bw,by+len); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(bx,by+bh-len); ctx.lineTo(bx,by+bh); ctx.lineTo(bx+len,by+bh); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(bx+bw-len,by+bh); ctx.lineTo(bx+bw,by+bh); ctx.lineTo(bx+bw,by+bh-len); ctx.stroke();

      ctx.shadowBlur = 0;
      ctx.fillStyle  = "rgba(0,0,0,0.75)";
      ctx.fillRect(bx, by - 18, 72, 16);
      ctx.fillStyle  = "#00ff9d";
      ctx.font       = "bold 9px 'Space Mono', monospace";
      ctx.fillText("MOTION", bx + 4, by - 5);
    }

    ctx.restore();
  }

  _captureSnapshot() {
    if (!this.video || this.video.readyState < 2) return;
    const snap = document.createElement("canvas");
    snap.width = 320; snap.height = 180;
    snap.getContext("2d").drawImage(this.video, 0, 0, 320, 180);
    const now = Date.now();
    this.ringBuffer.push({ timestamp: now, dataURL: snap.toDataURL("image/jpeg", 0.55) });
    const cutoff = now - RING_BUFFER_MS;
    this.ringBuffer = this.ringBuffer.filter(f => f.timestamp >= cutoff);
  }

  _onDetected(blobs) {
    this.lastDetected = Date.now();

    if (!this.detecting) {
      this.detecting      = true;
      this.detectionStart = Date.now();
      this.totalDetections++;

      const countEl = document.getElementById("total-detections");
      if (countEl) countEl.textContent = this.totalDetections;

      this._pushLiveEvent(blobs.length);

      if (this.onDetectionStart) this.onDetectionStart({ time: this.detectionStart, blobs, count: this.totalDetections });
    }

    if (this.postHoldTimer) clearTimeout(this.postHoldTimer);
    this.postHoldTimer = setTimeout(() => this._closeDetection(), POST_HOLD_MS);
  }

  _closeDetection() {
    if (!this.detecting) return;
    this.detecting = false;

    const endTime  = Date.now();
    const duration = Math.round((endTime - this.detectionStart) / 1000);
    const preview  = this.ringBuffer.length > 0
      ? this.ringBuffer[Math.floor(this.ringBuffer.length / 2)].dataURL
      : null;

    const clip = { detectionId: `det_${this.detectionStart}`, startTimestamp: this.detectionStart, endTimestamp: endTime, durationSeconds: duration, frameCount: this.ringBuffer.length, previewFrame: preview };

    if (this.saveClips) this._saveClip(clip);
    if (this.onDetectionEnd) this.onDetectionEnd(clip);
  }

  async _pushLiveEvent(blobCount) {
    try {
      await set(ref(rtdb, "live/owner/latestDetection"), { timestamp: Date.now(), blobCount, status: "detected" });
    } catch (e) {}
  }

  async _saveClip(clip) {
    try {
      await addDoc(collection(db, "detections"), {
        owner:           "owner",
        startTimestamp:  clip.startTimestamp,
        endTimestamp:    clip.endTimestamp,
        durationSeconds: clip.durationSeconds,
        frameCount:      clip.frameCount,
        previewFrame:    clip.previewFrame,
        createdAt:       serverTimestamp()
      });
      await setDoc(doc(db, "stats", "owner"), {
        totalDetections: this.totalDetections,
        lastDetection:   clip.startTimestamp,
        updatedAt:       serverTimestamp()
      }, { merge: true });
    } catch (e) { console.warn("Firestore save failed:", e); }
  }

  pause()  { this.paused = true;  const el = document.getElementById("detect-status"); if (el) { el.textContent = "⏸ PAUSED"; el.className = "detect-status"; } }
  resume() { this.paused = false; }
  toggle() { this.paused ? this.resume() : this.pause(); return this.paused; }
  setSensitivity(v) { this.sensitivity = parseInt(v); }
  setSaveClips(v)   { this.saveClips = v; }

  stop() {
    this.running = false;
    if (this._rafId)       cancelAnimationFrame(this._rafId);
    if (this._detLoop)     clearInterval(this._detLoop);
    if (this._snapLoop)    clearInterval(this._snapLoop);
    if (this._sessionLoop) clearInterval(this._sessionLoop);
    if (this._tsLoop)      clearInterval(this._tsLoop);
    if (this.postHoldTimer) clearTimeout(this.postHoldTimer);
    if (this.video?.srcObject) this.video.srcObject.getTracks().forEach(t => t.stop());
  }
}

export async function setOwnerOnline() {
  const liveRef     = ref(rtdb, "live/owner");
  const connRef     = ref(rtdb, ".info/connected");
  onValue(connRef, snap => {
    if (snap.val()) {
      onDisconnect(liveRef).update({ online: false, updatedAt: Date.now() });
      set(liveRef, { online: true, updatedAt: Date.now() });
    }
  });
}

export async function setOwnerOffline() {
  await set(ref(rtdb, "live/owner"), { online: false, updatedAt: Date.now() });
}

export function subscribeToOwnerStatus(cb) {
  return onValue(ref(rtdb, "live/owner"), snap => cb(snap.val() || { online: false }));
}

export function trackViewerPresence(username) {
  const vRef = ref(rtdb, `viewers/${username}`);
  onDisconnect(vRef).remove();
  set(vRef, { username, joinedAt: Date.now() });
  return onValue(ref(rtdb, "viewers"), snap => {
    const count = snap.val() ? Object.keys(snap.val()).length : 0;
    ["viewer-count","info-viewers"].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = count; });
  });
}
