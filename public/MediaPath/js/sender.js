const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun3.l.google.com:19302" },
  { urls: "stun:stun4.l.google.com:19302" },
];

const logEl = document.querySelector("#log");
const roomInput = document.querySelector("#roomInput");
const statusEl = document.querySelector("#status");
const connectBtn = document.querySelector("#connectBtn");
const localVideo = document.querySelector("#localVideo");

const socket = io({ transports: ["websocket"] });

let peerConnection = null;
let isInitiator = false;
let localStream = null;
let localTracksAdded = false;

connectBtn.addEventListener("click", async () => {
  if (!socket.connected) {
    appendLog("Socket disconnected. Retrying connect.");
    socket.connect();
  }
  const room = roomInput.value.trim();
  if (!room) {
    appendLog("Room name is required.");
    return;
  }
  // Proactively start camera so tracks are in the initial offer.
  await startLocalMedia();
  socket.emit("createOrJoin", room);
  updateStatus("joining");
  connectBtn.disabled = true;
});

socket.on("connect", () => {
  appendLog("Connected to signaling server.");
});

socket.on("disconnect", (reason) => {
  appendLog(`Signaling disconnected: ${reason}`);
  connectBtn.disabled = false;
  updateStatus("signaling-disconnected");
});

socket.on("created", (room, clientId) => {
  appendLog(`Created room ${room} as initiator (${clientId}).`);
  isInitiator = true;
  ensurePeerConnection();
  attachLocalTracks();
});

socket.on("joined", (room, clientId) => {
  appendLog(`Joined room ${room} (${clientId}). Waiting for offer.`);
  isInitiator = false;
  ensurePeerConnection();
  attachLocalTracks();
});

socket.on("ready", () => {
  appendLog("Peer ready, starting negotiation.");
  if (isInitiator) {
    void createOffer();
  }
});

socket.on("full", (room) => {
  appendLog(`Room ${room} is full. Choose a different room name.`);
  updateStatus("full");
  connectBtn.disabled = false;
});

socket.on("error", (message) => {
  appendLog(`Server error: ${message}`);
  connectBtn.disabled = false;
});

socket.on("peerDisconnected", () => {
  appendLog("Peer disconnected.");
  teardownPeerConnection();
  connectBtn.disabled = false;
  updateStatus("peer-disconnected");
});

socket.on("signal", async (payload) => {
  if (!peerConnection) {
    appendLog("Received signal before peer connection existed. Creating now.");
    ensurePeerConnection();
  }

  if (payload.description) {
    const description = payload.description;
    appendLog(`Received remote description (${description.type}).`);
    await peerConnection.setRemoteDescription(description);
    if (description.type === "offer") {
      attachLocalTracks();
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket.emit("signal", { description: peerConnection.localDescription });
    }
  } else if (payload.candidate) {
    try {
      await peerConnection.addIceCandidate(payload.candidate);
    } catch (err) {
      appendLog(`Failed to add ICE candidate: ${err.message}`);
    }
  }
});

function ensurePeerConnection() {
  if (peerConnection) return;

  peerConnection = new RTCPeerConnection({
    iceServers: ICE_SERVERS,
    iceTransportPolicy: "all",
    iceCandidatePoolSize: 10,
  });

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("signal", { candidate: event.candidate });
    }
  };

  peerConnection.onconnectionstatechange = () => {
    appendLog(`Connection state: ${peerConnection.connectionState}`);
    if (peerConnection.connectionState === "connected") {
      updateStatus("connected");
    }
    if (["disconnected", "failed", "closed"].includes(peerConnection.connectionState)) {
      updateStatus(peerConnection.connectionState);
    }
  };

  // Optional: handle remote tracks if the receiver also sends media in future.
  peerConnection.ontrack = (event) => {
    appendLog("Remote track received on sender (ignored). Tracks: " + event.streams[0]?.getTracks().length);
  };
}

async function startLocalMedia() {
  if (localStream) return;
  // getUserMedia requires a secure context (HTTPS) except on localhost.
  const isLocalhost = ["localhost", "127.0.0.1", "::1"].includes(
    location.hostname
  );
  if (!window.isSecureContext && !isLocalhost) {
    appendLog(
      `getUserMedia requires HTTPS for remote access. ` +
        `Current origin is insecure (${location.protocol}//${location.host}). ` +
        `Please serve over HTTPS or access via localhost.\n` +
        `Options:\n` +
        `- Run the server with TLS (recommended).\n` +
        `- Use a tunnel (e.g., ngrok/caddy) to get an https URL.\n` +
        `- Chrome dev-only: set 'unsafely-treat-insecure-origin-as-secure' for http://${location.host}`
    );
    return;
  }
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new TypeError("navigator.mediaDevices.getUserMedia is unavailable in this context");
    }
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    localVideo.srcObject = localStream;
    appendLog("Local camera stream started.");
    attachLocalTracks();
  } catch (err) {
    const name = err?.name || "Error";
    const message = err?.message || String(err);
    appendLog(`getUserMedia error: ${name}: ${message}`);
    if (name === "TypeError") {
      appendLog(
        "Likely cause: page not served over HTTPS (or not localhost)."
      );
    }
  }
}

function attachLocalTracks() {
  if (!peerConnection || !localStream || localTracksAdded) return;
  for (const track of localStream.getTracks()) {
    peerConnection.addTrack(track, localStream);
  }
  localTracksAdded = true;
  appendLog("Local tracks attached to RTCPeerConnection.");
}

async function createOffer() {
  if (!peerConnection) return;
  // Ensure local tracks are present in the initial offer
  attachLocalTracks();
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  socket.emit("signal", { description: peerConnection.localDescription });
}

function teardownPeerConnection() {
  if (peerConnection) {
    peerConnection.ontrack = null;
    peerConnection.onicecandidate = null;
    peerConnection.onconnectionstatechange = null;
    peerConnection.close();
    peerConnection = null;
  }
  localTracksAdded = false;
}

function appendLog(message) {
  const timestamp = new Date().toLocaleTimeString();
  logEl.value += `[${timestamp}] ${message}\n`;
  logEl.scrollTop = logEl.scrollHeight;
  console.log(message);
}

function updateStatus(status) {
  statusEl.textContent = status;
}
