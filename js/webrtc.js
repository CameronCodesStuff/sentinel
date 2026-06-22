import { rtdb } from "./firebase-config.js";
import { ref, set, onValue, remove, push, onChildAdded, get } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" }
  ]
};

export class OwnerBroadcaster {
  constructor(stream) {
    this.stream     = stream;
    this.peers      = {};
    this.offerRef   = ref(rtdb, "webrtc/offers");
    this._listening = false;
  }

  start() {
    if (this._listening) return;
    this._listening = true;

    // Clear any stale signaling data from previous sessions
    set(ref(rtdb, "webrtc/answers"), null);
    set(ref(rtdb, "webrtc/candidates"), null);

    onChildAdded(this.offerRef, async snap => {
      const viewerId = snap.key;
      const data     = snap.val();
      if (!data || !data.sdp) return;

      // Close any existing peer for this viewer
      if (this.peers[viewerId]) {
        this.peers[viewerId].close();
        delete this.peers[viewerId];
      }

      const pc = new RTCPeerConnection(ICE_SERVERS);
      this.peers[viewerId] = pc;

      this.stream.getTracks().forEach(t => pc.addTrack(t, this.stream));

      pc.onicecandidate = e => {
        if (e.candidate) {
          push(ref(rtdb, `webrtc/candidates/owner-to-${viewerId}`), e.candidate.toJSON());
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
          pc.close();
          delete this.peers[viewerId];
        }
      };

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(data));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await set(ref(rtdb, `webrtc/answers/${viewerId}`), { sdp: answer.sdp, type: answer.type });

        onChildAdded(ref(rtdb, `webrtc/candidates/${viewerId}-to-owner`), async candSnap => {
          try {
            if (pc.remoteDescription) await pc.addIceCandidate(new RTCIceCandidate(candSnap.val()));
          } catch (e) {}
        });
      } catch (e) { console.warn("Broadcaster peer error:", e); }
    });
  }

  stop() {
    Object.values(this.peers).forEach(pc => pc.close());
    this.peers = {};
    set(ref(rtdb, "webrtc"), null);
  }
}

export class ViewerReceiver {
  constructor(videoEl) {
    this.videoEl      = videoEl;
    this.pc           = null;
    this.viewerId     = `v_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
    this._unsubAnswer = null;
    this._reconnectTimer = null;
    this._connected   = false;
  }

  async connect() {
    this._cleanup();

    this.pc = new RTCPeerConnection(ICE_SERVERS);

    this.pc.ontrack = e => {
      if (e.streams && e.streams[0]) {
        this.videoEl.srcObject = e.streams[0];
        this.videoEl.style.display = "block";
        this._connected = true;
        this._setOffline(false);
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      const state = this.pc.iceConnectionState;
      if (state === "connected" || state === "completed") {
        this._connected = true;
      }
      if ((state === "disconnected" || state === "failed") && this._connected) {
        this._connected = false;
        this._setOffline(true);
        this._scheduleReconnect();
      }
    };

    this.pc.onicecandidate = e => {
      if (e.candidate) {
        push(ref(rtdb, `webrtc/candidates/${this.viewerId}-to-owner`), e.candidate.toJSON());
      }
    };

    this.pc.addTransceiver("video", { direction: "recvonly" });
    this.pc.addTransceiver("audio", { direction: "recvonly" });

    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      await set(ref(rtdb, `webrtc/offers/${this.viewerId}`), { sdp: offer.sdp, type: offer.type });

      // Listen for answer
      const answerRef = ref(rtdb, `webrtc/answers/${this.viewerId}`);
      this._unsubAnswer = onValue(answerRef, async snap => {
        const data = snap.val();
        if (!data || !data.sdp) return;
        if (this.pc && this.pc.signalingState === "have-local-offer") {
          try {
            await this.pc.setRemoteDescription(new RTCSessionDescription(data));
          } catch (e) {}
        }
      });

      // Listen for ICE candidates from owner
      onChildAdded(ref(rtdb, `webrtc/candidates/owner-to-${this.viewerId}`), async snap => {
        try {
          if (this.pc && this.pc.remoteDescription) {
            await this.pc.addIceCandidate(new RTCIceCandidate(snap.val()));
          }
        } catch (e) {}
      });

      // Timeout — if no track in 8s, retry
      setTimeout(() => {
        if (!this._connected) {
          this._scheduleReconnect();
        }
      }, 8000);

    } catch (e) {
      console.warn("Viewer connect error:", e);
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, 4000);
  }

  _cleanup() {
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this.pc) { this.pc.close(); this.pc = null; }
    remove(ref(rtdb, `webrtc/offers/${this.viewerId}`));
    remove(ref(rtdb, `webrtc/answers/${this.viewerId}`));
    remove(ref(rtdb, `webrtc/candidates/${this.viewerId}-to-owner`));
    remove(ref(rtdb, `webrtc/candidates/owner-to-${this.viewerId}`));
  }

  _setOffline(isOffline) {
    const off   = document.getElementById("offline-screen");
    const badge = document.getElementById("live-badge-overlay");
    if (isOffline) {
      if (this.videoEl) { this.videoEl.srcObject = null; this.videoEl.style.display = "none"; }
      if (off)   off.style.display = "flex";
      if (badge) badge.style.display = "none";
    } else {
      if (off)   off.style.display = "none";
      if (badge) badge.style.display = "flex";
    }
  }

  disconnect() {
    this._cleanup();
    this._setOffline(true);
  }
}
