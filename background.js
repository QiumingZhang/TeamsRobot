// ==================== Central configuration ====================
const ASR_WS_URL =
  "ws://ccbdistweb.mfg.hynix-dl.com/asr/v1/asr/stream";

const CHAT_COMPLETIONS_URL =
  "http://ccbdistweb.mfg.hynix-dl.com/chat/v1/chat/completions";

// Change this constant to a model name accepted by your chat gateway.
// If the gateway ignores model, "default" can be retained.
const CHAT_MODEL = "qwen-3.8";

const OFFSCREEN_URL = "offscreen.html";
const PERMISSION_URL = "permission.html";

const DEFAULT_AUDIO_SETTINGS = {
  tabGain: 3.0,
  micGain: 1.0,
  speechThreshold: 0.006,
  silenceDurationMs: 2000,
  micMuted: false
};

const DEFAULT_STATE = {
  running: false,
  status: "idle",
  partial: "",
  final: "",
  segments: [],
  language: "",
  audioLevel: 0,
  micMuted: false,
  teamsTabTitle: "",
  summary: "",
  summaryStatus: "idle",
  error: ""
};

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });

  if (contexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["USER_MEDIA"],
      justification: "Mix Teams tab and microphone audio for user-requested meeting transcription"
    });
  }
}

async function setState(patch) {
  const stored = await chrome.storage.local.get({ asrState: DEFAULT_STATE });
  const asrState = { ...DEFAULT_STATE, ...stored.asrState, ...patch };
  await chrome.storage.local.set({ asrState });
  return asrState;
}

async function findTeamsTab() {
  const tabs = await chrome.tabs.query({
    url: [
      "https://teams.microsoft.com/*",
      "https://*.teams.microsoft.com/*"
    ]
  });

  if (tabs.length === 0) {
    throw new Error("未找到已打开的网页版 Teams 标签页。");
  }

  // Prefer an audible Teams tab, then an active tab, then the first match.
  return tabs.find((tab) => tab.audible)
    || tabs.find((tab) => tab.active)
    || tabs[0];
}

async function openMicrophonePermissionPage() {
  const url = chrome.runtime.getURL(PERMISSION_URL);
  const existing = await chrome.tabs.query({ url });

  if (existing[0]?.id) {
    await chrome.tabs.update(existing[0].id, { active: true });
    if (existing[0].windowId) {
      await chrome.windows.update(existing[0].windowId, { focused: true });
    }
    return;
  }

  await chrome.tabs.create({ url, active: true });
}

async function generateMeetingSummary(transcript) {
  const cleanText = (transcript || "").trim();
  if (!cleanText) {
    await setState({
      summaryStatus: "error",
      summary: "",
      error: "没有可用于生成会议纪要的转写文字。"
    });
    return;
  }

  await setState({ summaryStatus: "generating", summary: "" });

  const response = await fetch(CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages: [
        {
          role: "system",
          content: "你是一名专业会议秘书。请根据会议转写整理会议纪要，会议转写是通过ASR生成的，中英文混合，有同音错别字，注意纠正，会议纪要使用英文，控制在200字以内。突出讨论主题、关键结论、决定事项、行动项和责任人。不要虚构转写中不存在的信息。只输出会议纪要正文。"
        },
        {
          role: "user",
          content: `以下是会议转写：\n\n${cleanText}`
        }
      ],
      temperature: 0.2,
      max_tokens: 10000,
      stream: false,
	  chat_template_kwargs: {
			enable_thinking: false
		}
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `会议纪要接口失败：HTTP ${response.status} ${detail.slice(0, 300)}`
    );
  }

  const data = await response.json();
  console.log(
	  "[Meeting Summary] HTTP status:",
	  response.status
	);

	console.log(
	  "[Meeting Summary] raw response:",
	  data
	);
	
  const summary = (
    data?.choices?.[0]?.message?.content
    || data?.choices?.[0]?.text
    || ""
  ).trim();
  
  console.log(
	"[Meeting Summary] parsed summary:",
	summary
  );
  
  if (!summary) {
    throw new Error("会议纪要接口未返回有效文字。");
  }

  await setState({
    summaryStatus: "complete",
    summary,
    error: ""
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set({
    asrState: DEFAULT_STATE,
    audioSettings: DEFAULT_AUDIO_SETTINGS,
    microphonePermissionGranted: false
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === "START_MEETING_CAPTURE") {
      const permission = await chrome.storage.local.get({
        microphonePermissionGranted: false,
        audioSettings: DEFAULT_AUDIO_SETTINGS
      });

      const requestedSettings = {
        ...DEFAULT_AUDIO_SETTINGS,
        ...permission.audioSettings,
        ...(message.audioSettings || {})
      };

      // Muted start doesn't require microphone permission.
      if (
        !requestedSettings.micMuted
        && !permission.microphonePermissionGranted
      ) {
        await openMicrophonePermissionPage();
        await setState({
          running: false,
          status: "permission-required",
          error: "请在新页面允许麦克风权限，然后再次点击开始。"
        });
        sendResponse({ ok: false, permissionRequired: true });
        return;
      }

      const teamsTab = await findTeamsTab();
      if (!teamsTab.id) {
        throw new Error("Teams 标签页没有有效 tabId。");
      }

      await ensureOffscreenDocument();

      const streamId = await chrome.tabCapture.getMediaStreamId({
        targetTabId: teamsTab.id
      });

      await chrome.storage.local.set({ audioSettings: requestedSettings });
      await setState({
        ...DEFAULT_STATE,
        running: true,
        status: "connecting",
        micMuted: requestedSettings.micMuted,
        teamsTabTitle: teamsTab.title || "Teams"
      });

      const result = await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "START_CAPTURE",
        streamId,
        wsUrl: ASR_WS_URL,
        audioSettings: requestedSettings
      });

      if (!result?.ok) {
        throw new Error(result?.error || "无法启动会议音频捕获。");
      }

      sendResponse({ ok: true });
      return;
    }

    if (message.type === "STOP_MEETING_CAPTURE") {
      await ensureOffscreenDocument();
      const result = await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "STOP_CAPTURE"
      });
      sendResponse(result || { ok: true });
      return;
    }

    if (message.type === "UPDATE_AUDIO_SETTINGS") {
      const settings = {
        ...DEFAULT_AUDIO_SETTINGS,
        ...(message.settings || {})
      };
      await chrome.storage.local.set({ audioSettings: settings });
      await ensureOffscreenDocument();
      const result = await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "UPDATE_AUDIO_SETTINGS",
        settings
      });
      sendResponse(result || { ok: true });
      return;
    }

    if (message.type === "SET_MIC_MUTED") {
      const stored = await chrome.storage.local.get({
        audioSettings: DEFAULT_AUDIO_SETTINGS,
        microphonePermissionGranted: false
      });

      if (!message.muted && !stored.microphonePermissionGranted) {
        await openMicrophonePermissionPage();
        sendResponse({ ok: false, permissionRequired: true });
        return;
      }

      const settings = {
        ...DEFAULT_AUDIO_SETTINGS,
        ...stored.audioSettings,
        micMuted: Boolean(message.muted)
      };
      await chrome.storage.local.set({ audioSettings: settings });
      await ensureOffscreenDocument();
      const result = await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "SET_MIC_MUTED",
        muted: settings.micMuted
      });
      await setState({ micMuted: settings.micMuted });
      sendResponse(result || { ok: true });
      return;
    }

    if (message.type === "CAPTURE_STATE") {
      await setState(message.patch || {});
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "GENERATE_SUMMARY") {
      generateMeetingSummary(message.transcript).catch(async (error) => {
        await setState({
          summaryStatus: "error",
          error: error?.message || String(error)
        });
      });
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "MICROPHONE_PERMISSION_GRANTED") {
      await chrome.storage.local.set({ microphonePermissionGranted: true });
      await setState({ status: "idle", error: "" });
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "MICROPHONE_PERMISSION_DENIED") {
      await chrome.storage.local.set({ microphonePermissionGranted: false });
      await setState({
        running: false,
        status: "permission-required",
        error: message.error || "麦克风权限未授予。"
      });
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: "不支持的消息类型。" });
  })().catch(async (error) => {
    const text = error?.message || String(error);
    await setState({ running: false, status: "error", error: text });
    sendResponse({ ok: false, error: text });
  });

  return true;
});
