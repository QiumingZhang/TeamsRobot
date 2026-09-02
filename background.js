// ==================== Central configuration ====================
const ASR_WS_URL =
  "ws://ccbdistweb.mfg.hynix-dl.com/asr/v1/asr/stream";

const CHAT_COMPLETIONS_URL =
  "http://ccbdistweb.mfg.hynix-dl.com/chat/v1/chat/completions";

// Change this constant to a model name accepted by your chat gateway.
// If the gateway ignores model, "default" can be retained.
const CHAT_MODEL = "qwen-3.8";

const OFFSCREEN_URL = "offscreen.html";

const DEFAULT_AUDIO_SETTINGS = {
  tabGain: 3.0,
  micGain: 1.0,
  speechThreshold: 0.006,
  silenceDurationMs: 2000
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
  inMeeting: false,
  teamsMicOff: false,
  teamsTabTitle: "",
  summary: "",
  summaryStatus: "idle",
  error: ""
};

let meetingStatePoller = null;
let currentTeamsTabId = null;

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
      "https://*.teams.microsoft.com/*",
      "https://teams.cloud.microsoft/*",
      "https://*.teams.cloud.microsoft/*"
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

async function checkMeetingState(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const hangupButton = document.querySelector('button[data-inp="hangup-button"]');
        const inMeeting = !!hangupButton;
        
        const micButton = document.querySelector('button[data-inp="microphone-button"]');
        let teamsMicOff = false;
        if (micButton) {
          const dataState = micButton.getAttribute("data-state");
          teamsMicOff = dataState === "mic-off";
        }
        
        return { inMeeting, teamsMicOff };
      }
    });
    
    return results?.[0]?.result || { inMeeting: false, teamsMicOff: false };
  } catch (error) {
    console.error("Failed to check meeting state:", error);
    return { inMeeting: false, teamsMicOff: false };
  }
}

async function generateMeetingSummary(transcript) {
  // Stop polling when stopping capture
  if (meetingStatePoller) {
    clearInterval(meetingStatePoller);
    meetingStatePoller = null;
  }
  
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
    audioSettings: DEFAULT_AUDIO_SETTINGS
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === "START_MEETING_CAPTURE") {
      const requestedSettings = {
        ...DEFAULT_AUDIO_SETTINGS,
        ...(message.audioSettings || {})
      };

      const teamsTab = await findTeamsTab();
      if (!teamsTab.id) {
        throw new Error("未找到已打开的网页版 Teams 标签页。");
      }
      
      currentTeamsTabId = teamsTab.id;

      // Check meeting state and microphone status from Teams page
      const meetingState = await checkMeetingState(teamsTab.id);
      
      await ensureOffscreenDocument();

      const streamId = await chrome.tabCapture.getMediaStreamId({
        targetTabId: teamsTab.id
      });

      // Determine audio capture mode based on meeting state and mic status
      // If in meeting: 
      //   - If Teams mic is ON: capture both tab audio and mic, mix them
      //   - If Teams mic is OFF: capture only tab audio
      // If not in meeting: capture only mic audio
      const audioConfig = {
        inMeeting: meetingState.inMeeting,
        teamsMicOff: meetingState.teamsMicOff,
        // micMuted logic: 
        // - In meeting with mic ON: false (capture mic)
        // - In meeting with mic OFF: true (don't capture mic)
        // - Not in meeting: false (capture mic only)
        micMuted: meetingState.inMeeting && meetingState.teamsMicOff
      };

      const finalSettings = {
        ...requestedSettings,
        ...audioConfig
      };

      await chrome.storage.local.set({ audioSettings: finalSettings });
      await setState({
        ...DEFAULT_STATE,
        running: true,
        status: "connecting",
        inMeeting: meetingState.inMeeting,
        teamsMicOff: meetingState.teamsMicOff,
        micMuted: audioConfig.micMuted,
        teamsTabTitle: teamsTab.title || "Teams"
      });

      const result = await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "START_CAPTURE",
        streamId,
        wsUrl: ASR_WS_URL,
        audioSettings: finalSettings
      });

      if (!result?.ok) {
        throw new Error(result?.error || "无法启动会议音频捕获。");
      }
      
      // Start polling for meeting state changes (mic on/off, meeting end)
      if (meetingStatePoller) {
        clearInterval(meetingStatePoller);
      }
      meetingStatePoller = setInterval(async () => {
        if (!currentTeamsTabId) {
          return;
        }
        try {
          const newState = await checkMeetingState(currentTeamsTabId);
          const stored = await chrome.storage.local.get({ asrState: DEFAULT_STATE });
          const currentState = stored.asrState || DEFAULT_STATE;
          
          // Check if meeting ended
          if (currentState.inMeeting && !newState.inMeeting) {
            console.log('[background.js] Meeting ended detected');
            await setState({
              inMeeting: false,
              teamsMicOff: false,
              micMuted: false
            });
            // Notify offscreen to switch to mic-only mode
            await ensureOffscreenDocument();
            await chrome.runtime.sendMessage({
              target: "offscreen",
              type: "UPDATE_AUDIO_SETTINGS",
              settings: {
                inMeeting: false,
                teamsMicOff: false,
                micMuted: false
              }
            });
            return;
          }
          
          // Check if mic state changed
          if (currentState.inMeeting && currentState.teamsMicOff !== newState.teamsMicOff) {
            console.log('[background.js] Mic state changed:', newState.teamsMicOff ? 'OFF' : 'ON');
            const newMicMuted = newState.teamsMicOff;
            await setState({
              teamsMicOff: newState.teamsMicOff,
              micMuted: newMicMuted
            });
            // Notify offscreen to update mic capture
            await ensureOffscreenDocument();
            await chrome.runtime.sendMessage({
              target: "offscreen",
              type: "SET_MIC_MUTED",
              muted: newMicMuted
            });
          }
          
          // Check if we need to update stream ID (in case of tab switch or stream issues)
          if (currentState.inMeeting && newState.inMeeting) {
            try {
              const newStreamId = await chrome.tabCapture.getMediaStreamId({
                targetTabId: currentTeamsTabId
              });
              if (newStreamId) {
                await chrome.runtime.sendMessage({
                  target: "offscreen",
                  type: "UPDATE_STREAM_ID",
                  streamId: newStreamId
                });
              }
            } catch (error) {
              console.error('[background.js] Failed to update stream ID:', error);
            }
          }
        } catch (error) {
          console.error('[background.js] Polling error:', error);
        }
      }, 2000); // Poll every 2 seconds

      sendResponse({ ok: true });
      return;
    }

    if (message.type === "STOP_MEETING_CAPTURE") {
      // Stop polling when stopping capture
      if (meetingStatePoller) {
        clearInterval(meetingStatePoller);
        meetingStatePoller = null;
      }
      currentTeamsTabId = null;
      
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

    sendResponse({ ok: false, error: "不支持的消息类型。" });
  })().catch(async (error) => {
    const text = error?.message || String(error);
    await setState({ running: false, status: "error", error: text });
    sendResponse({ ok: false, error: text });
  });

  return true;
});
