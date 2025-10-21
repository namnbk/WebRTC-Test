const ICE_SERVERS = [
  // Multiple STUN servers increase chance of srflx success
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun3.l.google.com:19302" },
  { urls: "stun:stun4.l.google.com:19302" },
];

const FRAME_WIDTH = 512;
const FRAME_HEIGHT = 512;

const roomInput = document.querySelector("#roomInput");
const statusEl = document.querySelector("#status");
const connectBtn = document.querySelector("#connectBtn");
const framesReceivedEl = document.querySelector("#framesReceived");
const fpsEl = document.querySelector("#fps");
const throughputEl = document.querySelector("#throughput");
const latencyEl = document.querySelector("#latency");
const frameLossEl = document.querySelector("#frameLoss");
const logEl = document.querySelector("#log");
const canvas = document.querySelector("#frameCanvas");
const ctx = canvas.getContext("2d");
const imageData = ctx.createImageData(FRAME_WIDTH, FRAME_HEIGHT);

class FrameAssembler {
  constructor(onComplete) {
    this.frames = new Map();
    this.onComplete = onComplete;
  }

  registerMetadata({ frameId, totalChunks, byteLength, timestamp }) {
    const frame = this.ensure(frameId);
    frame.totalChunks = totalChunks;
    frame.byteLength = byteLength;
    frame.timestamp = timestamp;
    this.tryComplete(frameId);
  }

  pushChunk(frameId, chunkIndex, chunkBuffer) {
    const frame = this.ensure(frameId);
    if (!frame.chunks.has(chunkIndex)) {
      frame.chunks.set(chunkIndex, chunkBuffer);
      frame.receivedChunks += 1;
      frame.receivedBytes += chunkBuffer.byteLength;
    }
    this.tryComplete(frameId);
  }

  ensure(frameId) {
    if (!this.frames.has(frameId)) {
      this.frames.set(frameId, {
        chunks: new Map(),
        receivedChunks: 0,
        receivedBytes: 0,
      });
    }
    return this.frames.get(frameId);
  }

  tryComplete(frameId) {
    const frame = this.frames.get(frameId);
    if (!frame || frame.totalChunks === undefined) {
      return;
    }
    if (frame.receivedChunks < frame.totalChunks) {
      return;
    }
    const combined = new Uint8Array(frame.byteLength);
    const sortedChunks = Array.from(frame.chunks.entries()).sort(
      (a, b) => a[0] - b[0]
    );
    let offset = 0;
    for (const [, chunk] of sortedChunks) {
      const view = new Uint8Array(chunk);
      combined.set(view, offset);
      offset += view.length;
    }
    this.frames.delete(frameId);
    this.onComplete({
      frameId,
      buffer: combined.buffer,
      timestamp: frame.timestamp,
    });
  }

  reset() {
    this.frames.clear();
  }
}

const socket = io({ transports: ["websocket"] });

let peerConnection = null;
let dataChannel = null;
let isInitiator = false;

const metrics = {
  frames: 0,
  bytes: 0,
  startTime: null,
  frameTimes: [],
  lastFrameId: null,
  frameLoss: 0,
  latency: 0,
};

const assembler = new FrameAssembler(handleCompleteFrame);

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
  appendLog(`Socket disconnected: ${reason}`);
  teardownPeerConnection();
  connectBtn.disabled = false;
  updateStatus("disconnected");
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
    appendLog(
      "Received signal before RTCPeerConnection existed. Creating now."
    );
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
  if (peerConnection) {
    return;
  }

  peerConnection = new RTCPeerConnection({
    iceServers: ICE_SERVERS,
    iceTransportPolicy: "all", // Try all connection types
    iceCandidatePoolSize: 10, // Generate more candidates
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
    if (
      ["disconnected", "failed", "closed"].includes(
        peerConnection.connectionState
      )
    ) {
      updateStatus(peerConnection.connectionState);
    }
  };

  if (isInitiator) {
    dataChannel = peerConnection.createDataChannel("frame-channel", {
      ordered: true,
    });
    configureDataChannel(dataChannel);
  } else {
    peerConnection.ondatachannel = (event) => {
      dataChannel = event.channel;
      configureDataChannel(dataChannel);
    };
  }
}

function configureDataChannel(channel) {
  channel.binaryType = "arraybuffer";

  channel.onopen = () => {
    appendLog("DataChannel open.");
    updateStatus("channel-open");
  };

  channel.onclose = () => {
    appendLog("DataChannel closed.");
    updateStatus("channel-closed");
  };

  channel.onerror = (event) => {
    appendLog(`DataChannel error: ${event.message ?? event}`);
  };

  channel.onmessage = async (event) => {
    let payload = event.data;

    if (typeof payload === "string") {
      try {
        const message = JSON.parse(payload);
        if (message.type === "frame-metadata") {
          assembler.registerMetadata(message);
        }
      } catch (err) {
        appendLog(`Failed to parse metadata: ${err.message}`);
      }
      return;
    }

    if (payload instanceof Blob) {
      payload = await payload.arrayBuffer();
    }

    if (payload instanceof ArrayBuffer) {
      const view = new DataView(payload);
      const frameId = view.getUint32(0);
      const chunkIndex = view.getUint32(4);
      const chunk = payload.slice(8);
      assembler.pushChunk(frameId, chunkIndex, chunk);
    }
  };
}

async function createOffer() {
  if (!peerConnection) {
    return;
  }
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  socket.emit("signal", { description: peerConnection.localDescription });
}

function teardownPeerConnection() {
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  if (dataChannel) {
    dataChannel.close();
    dataChannel = null;
  }
  assembler.reset();
  resetMetrics();
}

function handleCompleteFrame(frame) {
  if (!metrics.startTime) {
    metrics.startTime = performance.now();
  }

  const now = performance.now();
  metrics.frames += 1;
  metrics.bytes += frame.buffer.byteLength;
  metrics.frameTimes.push(now);
  while (metrics.frameTimes.length > 60 && metrics.frameTimes[0] < now - 1000) {
    metrics.frameTimes.shift();
  }

  if (metrics.lastFrameId !== null && frame.frameId > metrics.lastFrameId + 1) {
    metrics.frameLoss += frame.frameId - metrics.lastFrameId - 1;
  }
  metrics.lastFrameId = frame.frameId;

  if (frame.timestamp) {
    metrics.latency = Date.now() - frame.timestamp;
  }

  drawFrame(frame.buffer);
  updateMetrics();
}

function drawFrame(buffer) {
  const pixels16 = new Uint16Array(buffer);
  const rgba = imageData.data;

  for (let i = 0; i < pixels16.length; i += 1) {
    const value = pixels16[i] >>> 8; // map 16-bit grayscale to 8-bit
    const index = i * 4;
    rgba[index] = value;
    rgba[index + 1] = value;
    rgba[index + 2] = value;
    rgba[index + 3] = 255;
  }

  ctx.putImageData(imageData, 0, 0);
}

function updateMetrics() {
  framesReceivedEl.textContent = metrics.frames.toString();

  const elapsedSeconds = metrics.startTime
    ? (performance.now() - metrics.startTime) / 1000
    : 0;
  const throughput =
    elapsedSeconds > 0 ? (metrics.bytes * 8) / (elapsedSeconds * 1_000_000) : 0;
  throughputEl.textContent = throughput.toFixed(2);

  const times = metrics.frameTimes;
  if (times.length > 1) {
    const span = (times[times.length - 1] - times[0]) / 1000;
    const fps = span > 0 ? (times.length - 1) / span : 0;
    fpsEl.textContent = fps.toFixed(1);
  } else {
    fpsEl.textContent = "0";
  }

  latencyEl.textContent = metrics.latency.toFixed(1);
  frameLossEl.textContent = metrics.frameLoss.toString();
}

function resetMetrics() {
  metrics.frames = 0;
  metrics.bytes = 0;
  metrics.startTime = null;
  metrics.frameTimes = [];
  metrics.lastFrameId = null;
  metrics.frameLoss = 0;
  metrics.latency = 0;
  updateMetrics();
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
