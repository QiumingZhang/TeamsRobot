let websocket = null;
let audioContext = null;
let tabStream = null;
let micStream = null;
let tabSourceNode = null;
let micSourceNode = null;
let tabGainNode = null;
let micGainNode = null;
let mixGainNode = null;
let compressorNode = null;
let workletNode = null;
let silentSinkNode = null;
let tabMonitorNode = null;
let stopping = false;
let cleanupTimer = null;
let lastLevelUpdate = 0;

let committedSegments = [];
let committedText = "";
let currentPartialText = "";

let currentAudioSettings = {
  tabGain: 3.0,
  micGain: 1.0,
  speechThreshold: 0.006,
  silenceDurationMs: 2000,
  micMuted: false,
  inMeeting: false,
  teamsMicOff: false
};

function updateState(patch) {
  return chrome.runtime.sendMessage({
    type: "CAPTURE_STATE",
    patch
  }).catch(() => undefined);
}

function waitForSocketOpen(ws, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("连接 ASR WebSocket 超时。")),
      timeoutMs
    );
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("无法连接 ASR WebSocket。"));
    }, { once: true });
  });
}

async function createTabStream(streamId) {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });
}

async function createMicStream() {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: { ideal: 1 },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    },
    video: false
  });
}

function connectMicrophoneStream() {
  if (!micStream || !audioContext || !micGainNode) return;
  micSourceNode = audioContext.createMediaStreamSource(micStream);
  micSourceNode.connect(micGainNode);
}

async function startMicrophone() {
  if (micStream) return;
  micStream = await createMicStream();
  // Need to wait for audioContext and micGainNode to be ready
  if (audioContext && micGainNode) {
    connectMicrophoneStream();
  }
}

function stopMicrophone() {
  try { micSourceNode?.disconnect(); } catch {}
  micStream?.getTracks().forEach((track) => track.stop());
  micSourceNode = null;
  micStream = null;
}

async function setMicMuted(muted) {
  currentAudioSettings.micMuted = Boolean(muted);

  if (muted) {
    stopMicrophone();
  } else {
    await startMicrophone();
  }

  await updateState({
    micMuted: currentAudioSettings.micMuted,
    inMeeting: currentAudioSettings.inMeeting,
    teamsMicOff: currentAudioSettings.teamsMicOff,
    status: "recording",
    error: ""
  });
}

function applyAudioSettings(settings) {
  currentAudioSettings = {
    ...currentAudioSettings,
    ...(settings || {})
  };

  if (audioContext) {
    const now = audioContext.currentTime;
    tabGainNode?.gain.setTargetAtTime(
      Number(currentAudioSettings.tabGain) || 0,
      now,
      0.05
    );
    micGainNode?.gain.setTargetAtTime(
      Number(currentAudioSettings.micGain) || 0,
      now,
      0.05
    );
  }

  workletNode?.port.postMessage({
    type: "update_settings",
    speechThreshold: currentAudioSettings.speechThreshold,
    silenceDurationMs: currentAudioSettings.silenceDurationMs
  });
}

async function appendSegment(text, language) {
  const cleanText = (text || "").trim();
  if (!cleanText) return;

  const last = committedSegments[committedSegments.length - 1];
  if (!last || last.text !== cleanText) {
    committedSegments.push({
      text: cleanText,
      language: language || "",
      timestamp: Date.now()
    });
  }

  committedText = committedSegments
    .map((item) => item.text)
    .join("\n\n");
  currentPartialText = "";

  await updateState({
    running: true,
    status: "recording",
    final: committedText,
    partial: "",
    segments: [...committedSegments],
    language: language || "",
    error: ""
  });
}

async function startCapture({ streamId, wsUrl, audioSettings }) {
  await cleanup(true);
  stopping = false;
  committedSegments = [];
  committedText = "";
  currentPartialText = "";
  currentAudioSettings = {
    ...currentAudioSettings,
    ...(audioSettings || {})
  };

  const inMeeting = currentAudioSettings.inMeeting || false;
  const teamsMicOff = currentAudioSettings.teamsMicOff || false;
  
  // Determine capture mode:
  // - In meeting + mic ON: capture both tab and mic
  // - In meeting + mic OFF: capture only tab (teamsMicOff = true means micMuted = true)
  // - Not in meeting: capture only mic
  const captureTabAudio = inMeeting;
  const captureMicAudio = !inMeeting || (inMeeting && !teamsMicOff);

  await updateState({
    running: true,
    status: "requesting-audio",
    partial: "",
    final: "",
    segments: [],
    language: "",
    audioLevel: 0,
    micMuted: !captureMicAudio,
    inMeeting,
    teamsMicOff,
    summary: "",
    summaryStatus: "idle",
    error: ""
  });

  // Create tab stream if needed (in meeting)
  if (captureTabAudio) {
    tabStream = await createTabStream(streamId);
  }
  
  audioContext = new AudioContext({ latencyHint: "interactive" });
  await audioContext.resume();
  await audioContext.audioWorklet.addModule("pcm-worklet.js");

  // Set up audio nodes
  tabGainNode = audioContext.createGain();
  micGainNode = audioContext.createGain();
  mixGainNode = audioContext.createGain();
  compressorNode = audioContext.createDynamicsCompressor();

  tabGainNode.gain.value = currentAudioSettings.tabGain;
  micGainNode.gain.value = currentAudioSettings.micGain;
  mixGainNode.gain.value = 0.8;

  compressorNode.threshold.value = -18;
  compressorNode.knee.value = 16;
  compressorNode.ratio.value = 4;
  compressorNode.attack.value = 0.003;
  compressorNode.release.value = 0.25;

  workletNode = new AudioWorkletNode(
    audioContext,
    "pcm16-vad-processor",
    {
      processorOptions: {
        chunkDurationMs: 100,
        silenceDurationMs: currentAudioSettings.silenceDurationMs,
        speechThreshold: currentAudioSettings.speechThreshold,
        minimumSpeechMs: 300
      }
    }
  );

  // Connect tab audio source if capturing tab audio
  if (captureTabAudio && tabStream) {
    tabSourceNode = audioContext.createMediaStreamSource(tabStream);
    tabSourceNode.connect(tabGainNode);
    tabGainNode.connect(mixGainNode);
    
    // Preserve normal Teams playback without applying ASR gain
    tabMonitorNode = audioContext.createGain();
    tabMonitorNode.gain.value = 1;
    tabSourceNode.connect(tabMonitorNode);
    tabMonitorNode.connect(audioContext.destination);
  }

  // Connect mic source if capturing mic audio
  if (captureMicAudio) {
    await startMicrophone();
    // After micStream is created, connect it to the audio graph
    if (micStream && audioContext && micGainNode) {
      micSourceNode = audioContext.createMediaStreamSource(micStream);
      micSourceNode.connect(micGainNode);
      micGainNode.connect(mixGainNode);
    }
  }

  // Complete the audio chain
  mixGainNode.connect(compressorNode);
  compressorNode.connect(workletNode);

  silentSinkNode = audioContext.createGain();
  silentSinkNode.gain.value = 0;
  workletNode.connect(silentSinkNode);
  silentSinkNode.connect(audioContext.destination);

  websocket = new WebSocket(wsUrl);
  websocket.binaryType = "arraybuffer";

  websocket.addEventListener("message", async (event) => {
    if (typeof event.data !== "string") return;

    let result;
    try { result = JSON.parse(event.data); } catch { return; }

    if (result.type === "ready") {
      websocket.send(JSON.stringify({
        type: "start",
        sampleRate: Math.round(audioContext.sampleRate),
        channels: 1,
        sampleWidth: 2,
        encoding: "pcm_s16le"
      }));
      return;
    }

    if (result.type === "started") {
      await updateState({
        running: true,
        status: "recording",
        micMuted: currentAudioSettings.micMuted,
        error: ""
      });
      return;
    }

    if (result.type === "partial") {
      currentPartialText = (result.text || "").trim();
      await updateState({
        running: true,
        status: "recording",
        final: committedText,
        partial: currentPartialText,
        segments: [...committedSegments],
        language: result.language || "",
        error: ""
      });
      return;
    }

    if (result.type === "segment") {
      await appendSegment(result.text || "", result.language || "");
      return;
    }

    if (result.type === "segment_ready") {
      currentPartialText = "";
      workletNode?.port.postMessage({ type: "reset_vad" });
      await updateState({
        running: true,
        status: "recording",
        final: committedText,
        partial: "",
        segments: [...committedSegments],
        error: ""
      });
      return;
    }

    if (result.type === "final") {
      stopping = true;
      const serverFinal = (result.text || "").trim();
      let finalText = serverFinal || committedText || currentPartialText;

      await updateState({
        running: false,
        status: "complete",
        final: finalText,
        partial: "",
        segments: [...committedSegments],
        language: result.language || "",
        audioLevel: 0,
        error: ""
      });

      chrome.runtime.sendMessage({
        type: "GENERATE_SUMMARY",
        transcript: finalText
      }).catch(() => undefined);

      await cleanup(true);
      return;
    }

    if (result.type === "error") {
      await updateState({
        running: false,
        status: "error",
        final: committedText,
        partial: currentPartialText,
        error: result.message || "ASR 服务返回错误。"
      });
      await cleanup(true);
    }
  });

  websocket.addEventListener("close", async (event) => {
    if (!stopping && event.code !== 1000) {
      await updateState({
        running: false,
        status: "disconnected",
        final: committedText,
        partial: currentPartialText,
        audioLevel: 0,
        error: `ASR WebSocket 意外关闭，code=${event.code}。`
      });
    }
  });

  await waitForSocketOpen(websocket);

  workletNode.port.onmessage = (event) => {
    const message = event.data;

    if (
      message?.type === "audio"
      && message.buffer instanceof ArrayBuffer
      && websocket?.readyState === WebSocket.OPEN
    ) {
      websocket.send(message.buffer);
      return;
    }

    if (
      message?.type === "segment_end"
      && websocket?.readyState === WebSocket.OPEN
    ) {
      websocket.send(JSON.stringify({
        type: "segment_end",
        silenceMs: message.silenceMs || 2000
      }));
      updateState({
        status: "segmenting",
        final: committedText,
        partial: currentPartialText
      }).catch(() => undefined);
      return;
    }

    if (message?.type === "level") {
      const now = Date.now();
      if (now - lastLevelUpdate >= 500) {
        lastLevelUpdate = now;
        updateState({ audioLevel: message.rms || 0 })
          .catch(() => undefined);
      }
    }
  };
}

async function stopCapture() {
  if (stopping) return;
  stopping = true;

  await updateState({
    status: "finalizing",
    final: committedText,
    partial: currentPartialText
  });

  workletNode?.port.postMessage({ type: "flush" });
  tabStream?.getTracks().forEach((track) => track.stop());
  stopMicrophone();

  if (websocket?.readyState === WebSocket.OPEN && audioContext) {
    const silence = new Int16Array(
      Math.round(audioContext.sampleRate * 0.8)
    );
    websocket.send(silence.buffer);
    await new Promise((resolve) => setTimeout(resolve, 250));
    websocket.send(JSON.stringify({ type: "stop" }));

    cleanupTimer = setTimeout(() => {
      cleanup(true).catch(() => undefined);
    }, 15000);
    return;
  }

  await cleanup(true);
}

async function cleanup(closeSocket) {
  if (cleanupTimer) {
    clearTimeout(cleanupTimer);
    cleanupTimer = null;
  }

  try { tabSourceNode?.disconnect(); } catch {}
  try { micSourceNode?.disconnect(); } catch {}
  try { tabGainNode?.disconnect(); } catch {}
  try { micGainNode?.disconnect(); } catch {}
  try { mixGainNode?.disconnect(); } catch {}
  try { compressorNode?.disconnect(); } catch {}
  try { workletNode?.disconnect(); } catch {}
  try { silentSinkNode?.disconnect(); } catch {}
  try { tabMonitorNode?.disconnect(); } catch {}

  tabStream?.getTracks().forEach((track) => track.stop());
  micStream?.getTracks().forEach((track) => track.stop());

  if (audioContext && audioContext.state !== "closed") {
    try { await audioContext.close(); } catch {}
  }

  if (closeSocket && websocket?.readyState === WebSocket.OPEN) {
    try { websocket.close(1000, "Capture stopped"); } catch {}
  }

  tabStream = null;
  micStream = null;
  tabSourceNode = null;
  micSourceNode = null;
  tabGainNode = null;
  micGainNode = null;
  mixGainNode = null;
  compressorNode = null;
  workletNode = null;
  silentSinkNode = null;
  tabMonitorNode = null;
  audioContext = null;
  if (closeSocket) websocket = null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== "offscreen") return;

  (async () => {
    if (message.type === "START_CAPTURE") {
      await startCapture(message);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "STOP_CAPTURE") {
      await stopCapture();
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "UPDATE_AUDIO_SETTINGS") {
      applyAudioSettings(message.settings);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "SET_MIC_MUTED") {
      await setMicMuted(message.muted);
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: "不支持的 Offscreen 消息类型。" });
  })().catch(async (error) => {
    const text = error?.message || String(error);
    await updateState({
      running: false,
      status: "error",
      final: committedText,
      partial: currentPartialText,
      error: text
    });
    await cleanup(true);
    sendResponse({ ok: false, error: text });
  });

  return true;
});
