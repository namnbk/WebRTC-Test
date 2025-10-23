const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun3.l.google.com:19302" },
  { urls: "stun:stun4.l.google.com:19302" },
];

const roomInput = document.querySelector("#roomInput");
const statusEl = document.querySelector("#status");
const connectBtn = document.querySelector("#connectBtn");
const remoteVideo = document.querySelector("#remoteVideo");
const logEl = document.querySelector("#log");

const socket = io({ transports: ["websocket"] });

let peerConnection = null;
let isInitiator = false;

connectBtn.addEventListener("click", () => {
  if (!socket.connected) {
    appendLog("Socket disconnected. Attempting reconnect.");
    socket.connect();
  }

  const room = roomInput.value.trim();
  if (!room) {
    appendLog("Room name is required.");
    return;
  }

  socket.emit("createOrJoin", room);
  connectBtn.disabled = true;
  updateStatus("joining");
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
});

socket.on("joined", (room, clientId) => {
  appendLog(`Joined room ${room} (${clientId}). Waiting for offer.`);
  isInitiator = false;
  ensurePeerConnection();
});

socket.on("ready", () => {
  appendLog("Peer ready, starting negotiation.");
  if (isInitiator) {
    void createOffer();
  }
});

socket.on("full", (room) => {
  appendLog(`Room ${room} is full. Choose another room.`);
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
    appendLog("Received signal before RTCPeerConnection existed. Creating now.");
    ensurePeerConnection();
  }

  if (payload.description) {
    const description = payload.description;
    appendLog(`Received remote description (${description.type}).`);
    await peerConnection.setRemoteDescription(description);
    if (description.type === "offer") {
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

  peerConnection.ontrack = (event) => {
    const [stream] = event.streams;
    if (stream) {
      remoteVideo.srcObject = stream;
      appendLog("Remote stream set on video element.");
    }
  };
}

async function createOffer() {
  if (!peerConnection) return;
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  socket.emit("signal", { description: peerConnection.localDescription });
}

function teardownPeerConnection() {
  if (peerConnection) {
    peerConnection.ontrack = null;
    peerConnection.onicecandidate = null;
    peerConnection.onconnectionstatechange = null;
    try { peerConnection.close(); } catch {}
    peerConnection = null;
  }
  if (remoteVideo.srcObject) {
    try {
      const tracks = remoteVideo.srcObject.getTracks?.() || [];
      tracks.forEach(t => t.stop?.());
    } catch {}
    remoteVideo.srcObject = null;
  }
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

