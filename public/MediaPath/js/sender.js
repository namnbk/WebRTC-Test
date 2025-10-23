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
const resolutionSelect = document.querySelector("#resolutionSelect");
const frameRateSelect = document.querySelector("#frameRateSelect");

const RESOLUTION_PRESETS = {
  p180: { width: 320, height: 180, label: "320x180 (p180)" },
  qvga: { width: 320, height: 240, label: "320x240 (QVGA)" },
  p360: { width: 640, height: 360, label: "640x360 (p360)" },
  vga: { width: 640, height: 480, label: "640x480 (VGA)" },
  hd: { width: 1280, height: 720, label: "1280x720 (HD)" },
  fullHd: { width: 1920, height: 1080, label: "1920x1080 (Full HD)" },
  televisionFourK: { width: 3840, height: 2160, label: "3840x2160 (4K UHD)" },
  cinemaFourK: { width: 4096, height: 2160, label: "4096x2160 (Cinema 4K)" },
  eightK: { width: 7680, height: 4320, label: "7680x4320 (8K)" },
};

const DEFAULT_RESOLUTION_KEY = "hd";

if (resolutionSelect && !(resolutionSelect.value in RESOLUTION_PRESETS)) {
  resolutionSelect.value = DEFAULT_RESOLUTION_KEY;
}

const socket = io({ transports: ["websocket"] });

let peerConnection = null;
let isInitiator = false;
let localStream = null;

if (resolutionSelect) {
  resolutionSelect.addEventListener("change", () => {
    const key = getSelectedResolutionKey();
    const preset = getPresetDetails(key);
    appendLog(`Switching camera request to ${preset.label}.`);
    void startLocalMedia({ forceRestart: true });
  });
}

if (frameRateSelect) {
  frameRateSelect.addEventListener("change", () => {
    const fps = getSelectedFrameRate();
    appendLog(`Switching camera frame rate to ${fps} fps.`);
    void startLocalMedia({ forceRestart: true });
  });
}

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

socket.on("created", async (room, clientId) => {
  appendLog(`Created room ${room} as initiator (${clientId}).`);
  isInitiator = true;
  ensurePeerConnection();
  await attachLocalTracks();
});

socket.on("joined", async (room, clientId) => {
  appendLog(`Joined room ${room} (${clientId}). Waiting for offer.`);
  isInitiator = false;
  ensurePeerConnection();
  await attachLocalTracks();
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
      await attachLocalTracks();
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

async function startLocalMedia({ forceRestart = false } = {}) {
  if (localStream && !forceRestart) return;
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
    const resolutionKey = getSelectedResolutionKey();
    const preset = getPresetDetails(resolutionKey);
    const frameRate = getSelectedFrameRate();
    const constraints = buildConstraintsForPreset(preset, frameRate);
    appendLog(
      `Requesting camera at ${preset.width}x${preset.height} @ ${frameRate} fps.`
    );

    const previousStream = forceRestart ? localStream : null;
    const newStream = await navigator.mediaDevices.getUserMedia(constraints);

    localStream = newStream;
    localVideo.srcObject = localStream;
    appendLog(`Local camera stream started (${preset.label}, ${frameRate} fps).`);
    await attachLocalTracks();

    if (previousStream && previousStream !== newStream) {
      stopStream(previousStream);
      appendLog("Previous camera stream stopped.");
    }
  } catch (err) {
    const name = err?.name || "Error";
    const message = err?.message || String(err);
    appendLog(`getUserMedia error: ${name}: ${message}`);
    if (name === "TypeError") {
      appendLog(
        "Likely cause: page not served over HTTPS (or not localhost)."
      );
    } else if (name === "OverconstrainedError") {
      const attempted = getPresetDetails(getSelectedResolutionKey());
      const fps = getSelectedFrameRate();
      appendLog(
        `Selected resolution ${attempted.width}x${attempted.height} @ ${fps} fps is not supported by this camera.`
      );
    }
    if (forceRestart && localStream) {
      appendLog("Keeping previous camera stream active.");
    }
  }
}

async function attachLocalTracks() {
  if (!peerConnection || !localStream) {
    return false;
  }

  const peerSenders = (peerConnection.getSenders && peerConnection.getSenders()) || [];
  const senderByKind = new Map();
  for (const sender of peerSenders) {
    if (sender.track) {
      senderByKind.set(sender.track.kind, sender);
    }
  }

  let updates = 0;
  const activeKinds = new Set();

  for (const track of localStream.getTracks()) {
    activeKinds.add(track.kind);
    const existingSender = senderByKind.get(track.kind);
    if (existingSender) {
      if (existingSender.track === track) {
        continue;
      }
      try {
        await existingSender.replaceTrack(track);
        appendLog(`Replaced ${track.kind} track with new stream.`);
        updates += 1;
      } catch (err) {
        appendLog(`replaceTrack failed for ${track.kind}: ${err?.message || err}`);
      }
    } else {
      peerConnection.addTrack(track, localStream);
      appendLog(`Added ${track.kind} track to RTCPeerConnection.`);
      updates += 1;
    }
  }

  for (const sender of peerSenders) {
    const kind = sender.track?.kind;
    if (kind && !activeKinds.has(kind)) {
      try {
        peerConnection.removeTrack(sender);
        appendLog(`Removed ${kind} track from RTCPeerConnection.`);
        updates += 1;
      } catch (err) {
        appendLog(`removeTrack failed for ${kind}: ${err?.message || err}`);
      }
    }
  }

  if (updates > 0) {
    appendLog("Local tracks synchronized with RTCPeerConnection.");
  }

  return updates > 0;
}

async function createOffer() {
  if (!peerConnection) return;
  // Ensure local tracks are present in the initial offer
  await attachLocalTracks();
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
}

function getSelectedResolutionKey() {
  const key = resolutionSelect?.value || DEFAULT_RESOLUTION_KEY;
  if (key in RESOLUTION_PRESETS) {
    return key;
  }
  return DEFAULT_RESOLUTION_KEY;
}

function getPresetDetails(key) {
  return RESOLUTION_PRESETS[key] || RESOLUTION_PRESETS[DEFAULT_RESOLUTION_KEY];
}

function getSelectedFrameRate() {
  const value = Number(frameRateSelect?.value || "30");
  if (Number.isFinite(value) && value > 0) {
    return value;
  }
  return 30;
}

function buildConstraintsForPreset(preset, frameRate) {
  return {
    video: {
      width: { exact: preset.width },
      height: { exact: preset.height },
      frameRate: { ideal: frameRate, max: frameRate },
    },
    audio: false,
  };
}

function stopStream(stream) {
  if (!stream) return;
  try {
    const tracks = stream.getTracks?.() || [];
    for (const track of tracks) {
      track.stop();
    }
  } catch (err) {
    appendLog(`Failed to stop previous stream: ${err?.message || err}`);
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
