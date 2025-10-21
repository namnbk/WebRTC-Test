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
const BYTES_PER_PIXEL = 2;

const logEl = document.querySelector("#log");
const roomInput = document.querySelector("#roomInput");
const statusEl = document.querySelector("#status");
const connectBtn = document.querySelector("#connectBtn");
const startBtn = document.querySelector("#startBtn");
const stopBtn = document.querySelector("#stopBtn");
const fpsInput = document.querySelector("#fpsInput");
const chunkInput = document.querySelector("#chunkInput");
const framesSentEl = document.querySelector("#framesSent");
const throughputEl = document.querySelector("#throughput");
const sendLatencyEl = document.querySelector("#sendLatency");
const frameGenTimeEl = document.querySelector("#frameGenTime");
const backpressureWaitEl = document.querySelector("#backpressureWait");
const backpressureEventsEl = document.querySelector("#backpressureEvents");
const bufferedAmountEl = document.querySelector("#bufferedAmount");

const socket = io({ transports: ["websocket"] });

let peerConnection = null;
let dataChannel = null;
let isInitiator = false;
let streaming = false;
let streamLoopPromise = null;
let streamAbortController = null;
let frameSequence = 0;

const metrics = {
  frames: 0,
  bytes: 0,
  startTime: null,
  sendLatencyAccum: 0,
  sendSamples: 0,
  frameGenAccum: 0,
  frameGenSamples: 0,
  backpressureTimeAccum: 0,
  backpressureEventsAccum: 0,
};

connectBtn.addEventListener("click", () => {
  if (!socket.connected) {
    appendLog("Socket disconnected. Retrying connect.");
    socket.connect();
  }
  const room = roomInput.value.trim();
  if (!room) {
    appendLog("Room name is required.");
    return;
  }
  socket.emit("createOrJoin", room);
  updateStatus("joining");
  connectBtn.disabled = true;
});

startBtn.addEventListener("click", () => {
  if (!dataChannel || dataChannel.readyState !== "open") {
    appendLog("DataChannel not ready. Wait for connection.");
    return;
  }
  if (!streaming) {
    startStreaming();
  }
});

stopBtn.addEventListener("click", stopStreaming);

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
  appendLog(`Joined room ${room} (${clientId}). Awaiting offer.`);
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
  resetMetrics();
  stopStreaming();
  teardownPeerConnection();
  updateStatus("peer-disconnected");
  connectBtn.disabled = false;
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
      stopStreaming();
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
  const chunkSize = Number(chunkInput.value) || 65536;
  const maxBufferedChunks = 64;
  const lowWatermarkFactor = 0.5;
  channel.bufferedAmountLowThreshold = Math.floor(
    chunkSize * maxBufferedChunks * lowWatermarkFactor
  );

  channel.onopen = () => {
    appendLog("DataChannel open.");
    startBtn.disabled = false;
  };

  channel.onclose = () => {
    appendLog("DataChannel closed.");
    startBtn.disabled = true;
    stopBtn.disabled = true;
    stopStreaming();
  };

  channel.onerror = (event) => {
    appendLog(`DataChannel error: ${event.message ?? event}`);
  };

  channel.onbufferedamountlow = () => {
    updateBufferedAmount();
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
  dataChannel = null;
  startBtn.disabled = true;
  stopBtn.disabled = true;
}

function startStreaming() {
  if (!dataChannel || dataChannel.readyState !== "open" || streaming) {
    return;
  }
  streaming = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;
  resetMetrics();
  streamAbortController = new AbortController();
  streamLoopPromise = runStreamLoop(streamAbortController.signal)
    .catch((err) => {
      appendLog(`Stream loop error: ${err.message}`);
    })
    .finally(() => {
      streaming = false;
      stopBtn.disabled = true;
      startBtn.disabled = !dataChannel || dataChannel.readyState !== "open";
    });
}

function stopStreaming() {
  streaming = false;
  if (streamAbortController) {
    streamAbortController.abort();
    streamAbortController = null;
  }
}

async function runStreamLoop(abortSignal) {
  const frameSender = new FrameSender(dataChannel);
  const generator = new TestFrameGenerator(FRAME_WIDTH, FRAME_HEIGHT);
  metrics.startTime = performance.now();

  while (!abortSignal.aborted) {
    const targetFps = Math.max(1, Number(fpsInput.value) || 45);
    const intervalMs = 1000 / targetFps;
    frameSender.setChunkSize(Number(chunkInput.value) || frameSender.chunkSize);

    const loopStart = performance.now();
    const genStart = performance.now();
    const { buffer, timestamp } = generator.next();
    const frameGenTime = performance.now() - genStart;
    const { totalSendTime, backpressureTime, backpressureEvents } =
      await frameSender.send(buffer, { timestamp });
    metrics.sendLatencyAccum += totalSendTime;
    metrics.sendSamples += 1;
    metrics.frameGenAccum += frameGenTime;
    metrics.frameGenSamples += 1;
    metrics.backpressureTimeAccum += backpressureTime;
    metrics.backpressureEventsAccum += backpressureEvents;

    metrics.frames += 1;
    metrics.bytes += buffer.byteLength;
    updateMetrics();

    const elapsed = performance.now() - loopStart;
    const waitMs = Math.max(0, intervalMs - elapsed);
    if (waitMs > 0) {
      await delay(waitMs, abortSignal);
    } else {
      await delay(0, abortSignal);
    }
  }
}

class FrameSender {
  constructor(channel) {
    this.channel = channel;
    this.chunkSize = 65536;
    this.maxBufferedChunks = 64; // allow ~4 MB outstanding when chunk=64 KB
    this.lowWatermarkFactor = 0.5;
    this.maxBufferedAmount = this.chunkSize * this.maxBufferedChunks;
    this.lowWatermark = Math.floor(
      this.maxBufferedAmount * this.lowWatermarkFactor
    );
    if (this.channel) {
      this.channel.bufferedAmountLowThreshold = this.lowWatermark;
    }
  }

  setChunkSize(size) {
    if (!Number.isFinite(size) || size <= 0) {
      return;
    }
    this.chunkSize = size;
    this.maxBufferedAmount = this.chunkSize * this.maxBufferedChunks;
    this.lowWatermark = Math.floor(
      this.maxBufferedAmount * this.lowWatermarkFactor
    );
    if (this.channel) {
      this.channel.bufferedAmountLowThreshold = this.lowWatermark;
    }
  }

  async send(buffer, { timestamp }) {
    if (!this.channel) {
      throw new Error("DataChannel missing");
    }
    const frameId = frameSequence++;
    const totalChunks = Math.ceil(buffer.byteLength / this.chunkSize) || 1;
    const sendStart = performance.now();
    let backpressureTime = 0;
    let backpressureEvents = 0;

    const metadata = {
      type: "frame-metadata",
      frameId,
      totalChunks,
      byteLength: buffer.byteLength,
      timestamp: timestamp ?? Date.now(),
    };
    this.channel.send(JSON.stringify(metadata));

    const source = new Uint8Array(buffer);

    for (let i = 0; i < totalChunks; i += 1) {
      const start = i * this.chunkSize;
      const end = Math.min(source.length, start + this.chunkSize);
      const payloadLength = end - start;
      const packet = new Uint8Array(8 + payloadLength);
      const view = new DataView(packet.buffer);
      view.setUint32(0, frameId);
      view.setUint32(4, i);
      packet.set(source.subarray(start, end), 8);
      this.channel.send(packet.buffer);

      updateBufferedAmount();
      if (this.channel.bufferedAmount > this.maxBufferedAmount) {
        const waitStart = performance.now();
        await waitForEvent(this.channel, "bufferedamountlow");
        backpressureTime += performance.now() - waitStart;
        backpressureEvents += 1;
      }
    }

    return {
      totalSendTime: performance.now() - sendStart,
      backpressureTime,
      backpressureEvents,
      totalChunks,
    };
  }
}

class TestFrameGenerator {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.stride = width * height;
  }

  next() {
    const buffer = new ArrayBuffer(this.stride * BYTES_PER_PIXEL);
    const view = new Uint16Array(buffer);
    if (window.crypto && window.crypto.getRandomValues) {
      const maxElements = Math.floor(65536 / BYTES_PER_PIXEL);
      for (let offset = 0; offset < view.length; offset += maxElements) {
        const slice = view.subarray(
          offset,
          Math.min(offset + maxElements, view.length)
        );
        window.crypto.getRandomValues(slice);
      }
    } else {
      for (let i = 0; i < view.length; i += 1) {
        view[i] = Math.floor(Math.random() * 65535);
      }
    }
    return {
      buffer,
      timestamp: Date.now(),
    };
  }
}

function resetMetrics() {
  metrics.frames = 0;
  metrics.bytes = 0;
  metrics.startTime = null;
  metrics.sendLatencyAccum = 0;
  metrics.sendSamples = 0;
  metrics.frameGenAccum = 0;
  metrics.frameGenSamples = 0;
  metrics.backpressureTimeAccum = 0;
  metrics.backpressureEventsAccum = 0;
  updateMetrics();
}

function updateMetrics() {
  framesSentEl.textContent = metrics.frames.toString();
  const elapsed = metrics.startTime
    ? (performance.now() - metrics.startTime) / 1000
    : 0;
  const throughput =
    elapsed > 0 ? (metrics.bytes * 8) / (elapsed * 1_000_000) : 0;
  throughputEl.textContent = throughput.toFixed(2);
  const latency =
    metrics.sendSamples > 0
      ? metrics.sendLatencyAccum / metrics.sendSamples
      : 0;
  sendLatencyEl.textContent = latency.toFixed(2);
  const frameGen =
    metrics.frameGenSamples > 0
      ? metrics.frameGenAccum / metrics.frameGenSamples
      : 0;
  frameGenTimeEl.textContent = frameGen.toFixed(2);
  const backpressureTime =
    metrics.frames > 0 ? metrics.backpressureTimeAccum / metrics.frames : 0;
  backpressureWaitEl.textContent = backpressureTime.toFixed(2);
  const backpressureEvents =
    metrics.frames > 0 ? metrics.backpressureEventsAccum / metrics.frames : 0;
  backpressureEventsEl.textContent = backpressureEvents.toFixed(2);
  updateBufferedAmount();
}

function updateBufferedAmount() {
  bufferedAmountEl.textContent = dataChannel
    ? dataChannel.bufferedAmount.toString()
    : "0";
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

function waitForEvent(target, eventName) {
  return new Promise((resolve) => {
    const handler = () => {
      target.removeEventListener(eventName, handler);
      resolve();
    };
    target.addEventListener(eventName, handler, { once: true });
  });
}

function delay(ms, abortSignal) {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const cleanup = () => {
      clearTimeout(id);
      abortSignal?.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };

    if (abortSignal) {
      if (abortSignal.aborted) {
        cleanup();
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
