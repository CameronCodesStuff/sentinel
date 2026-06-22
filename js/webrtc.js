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
    this.stream   = stream;
    this.peers    = {};
    this.offerRef = ref(rtdb, "webrtc/offers");
    this._listening = false;
  }

  start() {
    if (this._listening) return;
    this._listening = true;

    onChildAdded(this.offerRef, async snap => {
      const viewerId = snap.key;
      const data     = snap.val();
      if (!data || !data.sdp) return;

      const pc = new RTCPeerConnection(ICE_SERVERS);
      this.peers[viewerId] = pc;

      this.stream.getTracks().forEach(t => pc.addTrack(t, this.stream));

      pc.onicecandidate = e => {
        if (e.candidate) {
          push(ref(rtdb, `webrtc/candidates/owner-to-${viewerId}`), e.candidate.toJSON());
        }
      };

      await pc.setRemoteDescription(new RTCSessionDescription(data));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      await set(ref(rtdb, `webrtc/answers/${viewerId}`), {
        sdp:  answer.sdp,
        type: answer.type
      });

      onChildAdded(ref(rtdb, `webrtc/candidates/${viewerId}-to-owner`), async candSnap => {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candSnap.val()));
        } catch (e) {}
      });
    });
  }

  stop() {
    Object.values(this.peers).forEach(pc => pc.close());
    this.peers = {};
    set(ref(rtdb, "webrtc/answers"), null);
    set(ref(rtdb, "webrtc/offers"), null);
    set(ref(rtdb, "webrtc/candidates"), null);
  }
}

export class ViewerReceiver {
  constructor(videoEl) {
    this.videoEl  = videoEl;
    this.pc       = null;
    this.viewerId = `viewer_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
  }

  async connect() {
    if (this.pc) { this.pc.close(); this.pc = null; }

    this.pc = new RTCPeerConnection(ICE_SERVERS);

    this.pc.ontrack = e => {
      if (e.streams && e.streams[0]) {
        this.videoEl.srcObject = e.streams[0];
        this.videoEl.style.display = "block";
        const off = document.getElementById("offline-screen");
        if (off) off.style.display = "none";
        const badge = document.getElementById("live-badge-overlay");
        if (badge) badge.style.display = "flex";
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      if (this.pc.iceConnectionState === "disconnected" || this.pc.iceConnectionState === "failed") {
        this._showOffline();
        setTimeout(() => this.connect(), 5000);
      }
    };

    this.pc.onicecandidate = e => {
      if (e.candidate) {
        push(ref(rtdb, `webrtc/candidates/${this.viewerId}-to-owner`), e.candidate.toJSON());
      }
    };

    this.pc.addTransceiver("video", { direction: "recvonly" });
    this.pc.addTransceiver("audio", { direction: "recvonly" });

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);

    await set(ref(rtdb, `webrtc/offers/${this.viewerId}`), {
      sdp:  offer.sdp,
      type: offer.type
    });

    const answerRef = ref(rtdb, `webrtc/answers/${this.viewerId}`);
    const unsub = onValue(answerRef, async snap => {
      const data = snap.val();
      if (!data || !data.sdp) return;
      if (this.pc.signalingState === "have-local-offer") {
        try {
          await this.pc.setRemoteDescription(new RTCSessionDescription(data));
        } catch (e) {}
      }
    });

    onChildAdded(ref(rtdb, `webrtc/candidates/owner-to-${this.viewerId}`), async snap => {
      try {
        if (this.pc.remoteDescription) {
          await this.pc.addIceCandidate(new RTCIceCandidate(snap.val()));
        }
      } catch (e) {}
    });
  }

  _showOffline() {
    if (this.videoEl) { this.videoEl.srcObject = null; this.videoEl.style.display = "none"; }
    const off = document.getElementById("offline-screen");
    if (off) off.style.display = "flex";
    const badge = document.getElementById("live-badge-overlay");
    if (badge) badge.style.display = "none";
  }

  disconnect() {
    if (this.pc) { this.pc.close(); this.pc = null; }
    remove(ref(rtdb, `webrtc/offers/${this.viewerId}`));
    remove(ref(rtdb, `webrtc/answers/${this.viewerId}`));
    remove(ref(rtdb, `webrtc/candidates/${this.viewerId}-to-owner`));
    remove(ref(rtdb, `webrtc/candidates/owner-to-${this.viewerId}`));
    this._showOffline();
  }
}
