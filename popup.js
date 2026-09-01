const $ = (selector) => document.querySelector(selector);

const startButton = $("#start");
const stopButton = $("#stop");
const statusBadge = $("#statusBadge");
const teamsTab = $("#teamsTab");
const transcript = $("#transcript");
const summary = $("#summary");
const language = $("#language");
const errorBox = $("#error");
const audioLevel = $("#audioLevel");
const tabGain = $("#tabGain");
const micGain = $("#micGain");
const threshold = $("#speechThreshold");
const silenceDuration = $("#silenceDuration");
const autoMicSyncCheckbox = $("#autoMicSync");
const tabGainValue = $("#tabGainValue");
const micGainValue = $("#micGainValue");
const thresholdValue = $("#thresholdValue");
const silenceValue = $("#silenceValue");

const DEFAULT_SETTINGS = {
  tabGain: 3.0,
  micGain: 1.0,
  speechThreshold: 0.006,
  silenceDurationMs: 2000,
  autoMicSync: true
};

const DEFAULT_STATE = {
  running: false,
  status: "idle",
  partial: "",
  final: "",
  segments: [],
  language: "",
  audioLevel: 0,
  teamsTabTitle: "",
  summary: "",
  summaryStatus: "idle",
  error: "",
  inTeamsMeeting: false,
  teamsMicMuted: false
};

const STATUS_TEXT = {
  idle: "空闲",
  connecting: "连接中",
  "requesting-audio": "请求音频",
  "permission-required": "等待麦克风权限",
  connected: "已连接",
  recording: "识别中",
  segmenting: "提交分段",
  finalizing: "生成最终文字",
  complete: "转写完成",
  disconnected: "已断开",
  error: "错误"
};

function normalize(value) {
  return (value || "").trim();
}

function buildTranscript(state) {
  const committed = normalize(state.final)
    || (Array.isArray(state.segments)
      ? state.segments.map((item) => normalize(item?.text)).filter(Boolean).join("\n\n")
      : "");
  const partial = normalize(state.partial);

  if (!committed) return partial;
  if (!partial || committed.endsWith(partial)) return committed;
  if (partial.startsWith(committed)) return partial;
  return `${committed}\n\n${partial}`;
}

function readSettings() {
  return {
    tabGain: Number(tabGain.value),
    micGain: Number(micGain.value),
    speechThreshold: Number(threshold.value),
    silenceDurationMs: Number(silenceDuration.value),
    autoMicSync: autoMicSyncCheckbox.checked
  };
}

function renderSettings(settings) {
  const safe = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  tabGain.value = String(safe.tabGain);
  micGain.value = String(safe.micGain);
  threshold.value = String(safe.speechThreshold);
  silenceDuration.value = String(safe.silenceDurationMs);
  autoMicSyncCheckbox.checked = Boolean(safe.autoMicSync);
  tabGainValue.textContent = `${safe.tabGain.toFixed(1)}x`;
  micGainValue.textContent = `${safe.micGain.toFixed(1)}x`;
  thresholdValue.textContent = safe.speechThreshold.toFixed(3);
  silenceValue.textContent = `${(safe.silenceDurationMs / 1000).toFixed(1)}秒`;
}

function renderState(input) {
  const state = { ...DEFAULT_STATE, ...(input || {}) };
  startButton.disabled = state.running;
  stopButton.disabled = !state.running;
  statusBadge.textContent = STATUS_TEXT[state.status] || state.status;
  statusBadge.className = `badge ${state.status}`;
  teamsTab.textContent = state.teamsTabTitle
    ? `Teams：${state.teamsTabTitle}`
    : "自动选择正在播放声音的 Teams 标签页";
  transcript.value = buildTranscript(state);
  transcript.scrollTop = transcript.scrollHeight;
  summary.value = state.summary || (
    state.summaryStatus === "generating" ? "正在生成会议纪要……" : ""
  );
  language.textContent = state.language || "";
  audioLevel.value = Math.min(0.1, Number(state.audioLevel) || 0);

  if (state.error) {
    errorBox.hidden = false;
    errorBox.textContent = state.error;
  } else {
    errorBox.hidden = true;
    errorBox.textContent = "";
  }
}

async function saveAndSendSettings() {
  const settings = readSettings();
  await chrome.storage.local.set({ audioSettings: settings });
  const stored = await chrome.storage.local.get({ asrState: DEFAULT_STATE });
  if (stored.asrState.running) {
    await chrome.runtime.sendMessage({
      type: "UPDATE_AUDIO_SETTINGS",
      settings
    });
  }
  renderSettings(settings);
  return settings;
}

async function copyText(text, button) {
  if (!text.trim()) return;
  await navigator.clipboard.writeText(text);
  const original = button.textContent;
  button.textContent = "已复制";
  setTimeout(() => { button.textContent = original; }, 1200);
}

startButton.addEventListener("click", async () => {
  try {
    const settings = await saveAndSendSettings();
    const response = await chrome.runtime.sendMessage({
      type: "START_MEETING_CAPTURE",
      audioSettings: settings
    });
    if (response?.permissionRequired) return;
    if (!response?.ok) throw new Error(response?.error || "启动失败。");
  } catch (error) {
    errorBox.hidden = false;
    errorBox.textContent = error?.message || String(error);
  }
});

stopButton.addEventListener("click", async () => {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "STOP_MEETING_CAPTURE"
    });
    if (!response?.ok) throw new Error(response?.error || "停止失败。");
  } catch (error) {
    errorBox.hidden = false;
    errorBox.textContent = error?.message || String(error);
  }
});

for (const control of [tabGain, micGain, threshold, silenceDuration]) {
  control.addEventListener("input", () => {
    saveAndSendSettings().catch((error) => {
      errorBox.hidden = false;
      errorBox.textContent = error?.message || String(error);
    });
  });
}

// Auto mic sync checkbox listener
autoMicSyncCheckbox.addEventListener("change", () => {
  saveAndSendSettings().catch((error) => {
    errorBox.hidden = false;
    errorBox.textContent = error?.message || String(error);
  });
});

$("#copyTranscript").addEventListener("click", (event) => {
  copyText(transcript.value, event.currentTarget);
});

$("#copySummary").addEventListener("click", (event) => {
  copyText(summary.value, event.currentTarget);
});

$("#clear").addEventListener("click", async () => {
  const stored = await chrome.storage.local.get({ asrState: DEFAULT_STATE });
  if (stored.asrState.running) {
    throw new Error("请先结束当前会议转写。另请确保参会者知情并符合公司政策。");
  }
  await chrome.storage.local.set({ asrState: DEFAULT_STATE });
  renderState(DEFAULT_STATE);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.asrState) renderState(changes.asrState.newValue);
  if (changes.audioSettings) renderSettings(changes.audioSettings.newValue);
});

const initial = await chrome.storage.local.get({
  asrState: DEFAULT_STATE,
  audioSettings: DEFAULT_SETTINGS
});
renderSettings(initial.audioSettings);
renderState(initial.asrState);
