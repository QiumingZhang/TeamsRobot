// ==================== Central configuration ====================
const ASR_WS_URL =
  "ws://ccbdistweb.mfg.hynix-dl.com/asr/v1/asr/stream";

const CHAT_COMPLETIONS_URL =
  "http://ccbdistweb.mfg.hynix-dl.com/chat/v1/chat/completions";

// Change this constant to a model name accepted by your chat gateway.
// If the gateway ignores model, "default" can be retained.
const CHAT_MODEL = "qwen-3.8";

const OFFSCREEN_URL = "offscreen.html";
const PERMISSION_URL = "permission.html";  // Deprecated: now using floating dialog

const DEFAULT_AUDIO_SETTINGS = {
  tabGain: 3.0,
  micGain: 1.0,
  speechThreshold: 0.006,
  silenceDurationMs: 2000,
  micMuted: false,
  autoMicSync: true  // 新增：自动同步 Teams 麦克风状态
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
  error: "",
  inTeamsMeeting: false,
  teamsMicMuted: false
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
      "https://*.teams.microsoft.com/*",
      "https://teams.cloud.microsoft/*",
      "https://*.teams.cloud.microsoft/*"
    ]
  });

  if (tabs.length === 0) {
    return null;
  }

  // Prefer an audible Teams tab, then an active tab, then the first match.
  return tabs.find((tab) => tab.audible)
    || tabs.find((tab) => tab.active)
    || tabs[0];
}

// Check if user is in a Teams meeting by looking for meeting-specific URL patterns
async function checkTeamsMeetingStatus(tab) {
  if (!tab?.url) return false;
  
  // Teams meeting URLs typically contain /l/meetingJoin/ or /meet/
  // For both teams.microsoft.com and teams.cloud.microsoft domains
  const meetingPatterns = [
    /\/l\/meetingJoin\//i,
    /\/meet\//i,
    /[?&]meetingId=/i,
    /[?&]otn=/i,  // One-Time Numerical identifier for meetings
    /\/call\//i,  // For calls
    /[?&]callId=/i
  ];
  
  return meetingPatterns.some(pattern => pattern.test(tab.url));
}

// Inject content script to get Teams microphone mute status with retry logic
async function getTeamsMicStatus(tabId, maxRetries = 5) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          // This code runs in the context of the Teams page
          // Look for Teams microphone button using the stable data-inp attribute
          const micButton = document.querySelector('button[data-inp="microphone-button"]');
          
          let debugInfo = {
            found: !!micButton,
            state: null,
            ariaLabel: null,
            allAttributes: []
          };

          if (!micButton) {
            console.log('[Teams Sync] Microphone button not found (attempt ' + attempt + ')');
            return { success: false, debug: debugInfo };
          }

          // Get all data-* attributes for debugging
          for (let i = 0; i < micButton.attributes.length; i++) {
            const attr = micButton.attributes[i];
            if (attr.name.startsWith('data-')) {
              debugInfo.allAttributes.push(`${attr.name}="${attr.value}"`);
            }
          }

          // Check the data-state attribute:
          // - "mic" means microphone is ON (not muted)
          // - "mic-off" means microphone is OFF (muted)
          const state = micButton.getAttribute('data-state');
          const ariaLabel = micButton.getAttribute('aria-label');
          
          debugInfo.state = state;
          debugInfo.ariaLabel = ariaLabel;
          
          console.log('[Teams Sync] Button found:', debugInfo);
          
          if (state === 'mic-off') {
            console.log('[Teams Sync] Mic is MUTED (data-state="mic-off")');
            return { success: true, muted: true, debug: debugInfo };
          } else if (state === 'mic') {
            console.log('[Teams Sync] Mic is UNMUTED (data-state="mic")');
            return { success: true, muted: false, debug: debugInfo };
          }
          
          console.log('[Teams Sync] Unknown data-state:', state);
          return { success: false, debug: debugInfo };
        }
      });

      const result = results[0]?.result;
      
      if (result?.success === true) {
        return result.muted;
      }
      
      // Log debug info if available
      if (result?.debug) {
        console.log('[Teams Sync] Debug info:', result.debug);
      }
      
      // If we couldn't determine the state, wait and retry
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 800));
      }
    } catch (error) {
      console.warn('Failed to get Teams mic status (attempt ' + attempt + '):', error);
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 800));
      }
    }
  }
  
  // If all retries failed, assume mic is not muted (conservative approach)
  console.log('[Teams Sync] All retries failed, assuming mic is NOT muted');
  return false;
}

// Monitor Teams tab for meeting status and microphone changes
let teamsMonitorInterval = null;

async function startTeamsMonitoring() {
  // Clear any existing monitor
  if (teamsMonitorInterval) {
    clearInterval(teamsMonitorInterval);
  }
  
  const checkStatus = async () => {
    const teamsTab = await findTeamsTab();
    
    if (!teamsTab) {
      await setState({
        inTeamsMeeting: false,
        teamsMicMuted: false,
        teamsTabTitle: ""
      });
      return;
    }
    
    const inMeeting = await checkTeamsMeetingStatus(teamsTab);
    let micMuted = null;
    
    if (inMeeting) {
      micMuted = await getTeamsMicStatus(teamsTab.id);
    }
    
    await setState({
      inTeamsMeeting: inMeeting,
      teamsMicMuted: micMuted === true ? true : false,
      teamsTabTitle: teamsTab.title || "Teams"
    });
    
    // If in meeting and auto sync is enabled, notify offscreen to reconfigure audio
    if (inMeeting && micMuted !== null) {
      const settings = await chrome.storage.local.get({
        audioSettings: DEFAULT_AUDIO_SETTINGS
      });
      
      if (settings.audioSettings.autoMicSync) {
        // Send updated mic state to offscreen for audio reconfiguration
        await chrome.runtime.sendMessage({
          target: "offscreen",
          type: "TEAMS_MIC_STATUS_CHANGED",
          muted: micMuted
        });
        await chrome.storage.local.set({
          audioSettings: {
            ...settings.audioSettings,
            micMuted: micMuted
          }
        });
        await setState({ micMuted: micMuted });
      }
    }
  };
  
  // Initial check
  await checkStatus();
  
  // Then check every 2 seconds
  teamsMonitorInterval = setInterval(checkStatus, 2000);
}

function stopTeamsMonitoring() {
  if (teamsMonitorInterval) {
    clearInterval(teamsMonitorInterval);
    teamsMonitorInterval = null;
  }
}

async function openMicrophonePermissionDialog() {
  // Get the active tab to inject the floating dialog
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    console.error('[Teams ASR] No active tab found for permission dialog');
    return false;
  }
  
  // Inject the content script to show floating dialog
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        // Check if already granted
        const stored = await new Promise(resolve => 
          chrome.storage.local.get({ microphonePermissionGranted: false }, resolve)
        );
        if (stored.microphonePermissionGranted) {
          return true;
        }
        
        return new Promise((resolve) => {
          // Create floating dialog
          const permissionDialog = document.createElement('div');
          permissionDialog.id = 'mic-permission-dialog';
          permissionDialog.innerHTML = `
            <div class="permission-overlay"></div>
            <div class="permission-dialog">
              <h2>🎤 麦克风权限</h2>
              <p>会议助手需要读取麦克风并与 Teams 页面声音混音。</p>
              <p class="notice">请确保参会者知情并符合公司会议录音和隐私政策。</p>
              <div class="permission-buttons">
                <button id="grant-mic-permission" class="primary-btn">允许使用麦克风</button>
                <button id="deny-mic-permission" class="secondary-btn">暂不允许</button>
              </div>
              <div id="permission-status"></div>
            </div>
          `;
          
          const style = document.createElement('style');
          style.textContent = `
            #mic-permission-dialog {
              position: fixed;
              top: 0;
              left: 0;
              right: 0;
              bottom: 0;
              z-index: 10000;
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            }
            .permission-overlay {
              position: absolute;
              top: 0;
              left: 0;
              right: 0;
              bottom: 0;
              background: rgba(0, 0, 0, 0.5);
              backdrop-filter: blur(2px);
            }
            .permission-dialog {
              position: absolute;
              top: 50%;
              left: 50%;
              transform: translate(-50%, -50%);
              background: white;
              padding: 32px;
              border-radius: 12px;
              box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
              max-width: 400px;
              width: 90%;
              text-align: center;
            }
            .permission-dialog h2 {
              margin: 0 0 16px 0;
              color: #1a1a1a;
              font-size: 20px;
            }
            .permission-dialog p {
              margin: 12px 0;
              color: #4a4a4a;
              line-height: 1.5;
              font-size: 14px;
            }
            .permission-dialog .notice {
              background: #fff3cd;
              padding: 12px;
              border-radius: 6px;
              font-size: 13px;
              color: #856404;
            }
            .permission-buttons {
              display: flex;
              gap: 12px;
              justify-content: center;
              margin-top: 24px;
            }
            .permission-buttons button {
              padding: 10px 20px;
              border-radius: 6px;
              font-size: 14px;
              font-weight: 500;
              cursor: pointer;
              transition: all 0.2s;
              border: none;
            }
            .primary-btn {
              background: #0078d4;
              color: white;
            }
            .primary-btn:hover {
              background: #106ebe;
            }
            .primary-btn:disabled {
              background: #ccc;
              cursor: not-allowed;
            }
            .secondary-btn {
              background: #f0f0f0;
              color: #333;
            }
            .secondary-btn:hover {
              background: #e0e0e0;
            }
            #permission-status {
              margin-top: 16px;
              font-size: 13px;
              min-height: 20px;
            }
            #permission-status.success {
              color: #28a745;
            }
            #permission-status.error {
              color: #dc3545;
            }
          `;
          
          document.head.appendChild(style);
          document.body.appendChild(permissionDialog);
          
          const grantBtn = permissionDialog.querySelector('#grant-mic-permission');
          const denyBtn = permissionDialog.querySelector('#deny-mic-permission');
          const statusDiv = permissionDialog.querySelector('#permission-status');
          
          grantBtn.addEventListener('click', async () => {
            grantBtn.disabled = true;
            let stream;
            try {
              stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
              await chrome.storage.local.set({ microphonePermissionGranted: true });
              statusDiv.textContent = '✓ 权限已授予。正在启动转写...';
              statusDiv.className = 'success';
              stream.getTracks().forEach(track => track.stop());
              setTimeout(() => {
                permissionDialog.remove();
                resolve(true);
              }, 1500);
            } catch (error) {
              const text = error?.name === 'NotAllowedError' 
                ? '麦克风权限被拒绝，请在浏览器设置中允许。'
                : `${error?.name || 'Error'}: ${error?.message || error}`;
              statusDiv.textContent = '✗ ' + text;
              statusDiv.className = 'error';
              grantBtn.disabled = false;
              resolve(false);
            }
          });
          
          denyBtn.addEventListener('click', async () => {
            permissionDialog.remove();
            resolve(false);
          });
        });
      }
    });
    return true;
  } catch (error) {
    console.error('[Teams ASR] Failed to show permission dialog:', error);
    return false;
  }
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
  
  // Start monitoring Teams tab for meeting status and mic state
  startTeamsMonitoring();
});

// Also start monitoring when the service worker restarts
chrome.runtime.onStartup.addListener(() => {
  startTeamsMonitoring();
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

      const teamsTab = await findTeamsTab();
      if (!teamsTab?.id) {
        throw new Error("未找到已打开的网页版 Teams 标签页。");
      }

      // Check if in Teams meeting and get mic status first
      const inMeeting = await checkTeamsMeetingStatus(teamsTab);
      let teamsMicMuted = false;
      
      if (inMeeting) {
        const micStatus = await getTeamsMicStatus(teamsTab.id);
        teamsMicMuted = micStatus === true ? true : false;
      }
      
      // Determine if we need microphone based on meeting status
      // In meeting with mic muted: only need tab audio (no mic permission needed)
      // In meeting with mic unmuted: need both tab and mic (mic permission needed)
      // Not in meeting: only need mic (mic permission needed)
      const needsMicrophone = inMeeting ? !teamsMicMuted : true;

      if (needsMicrophone && !permission.microphonePermissionGranted) {
        // Show floating permission dialog instead of opening a new page
        const granted = await openMicrophonePermissionDialog();
        if (!granted) {
          await setState({
            running: false,
            status: "permission-required",
            error: "麦克风权限未授予。"
          });
          sendResponse({ ok: false, permissionRequired: true });
          return;
        }
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
        micMuted: !inMeeting || teamsMicMuted,
        inTeamsMeeting: inMeeting,
        teamsMicMuted: teamsMicMuted,
        teamsTabTitle: teamsTab.title || "Teams"
      });

      const result = await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "START_CAPTURE",
        streamId,
        wsUrl: ASR_WS_URL,
        audioSettings: requestedSettings,
        inTeamsMeeting: inMeeting,
        teamsMicMuted: teamsMicMuted
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
      
      // If autoMicSync setting changed, restart monitoring
      if (message.settings?.autoMicSync !== undefined) {
        stopTeamsMonitoring();
        startTeamsMonitoring();
      }
      
      sendResponse(result || { ok: true });
      return;
    }

    if (message.type === "SET_MIC_MUTED") {
      const stored = await chrome.storage.local.get({
        audioSettings: DEFAULT_AUDIO_SETTINGS,
        microphonePermissionGranted: false
      });

      if (!message.muted && !stored.microphonePermissionGranted) {
        // Show floating permission dialog
        const granted = await openMicrophonePermissionDialog();
        if (!granted) {
          sendResponse({ ok: false, permissionRequired: true });
          return;
        }
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

    if (message.type === "TEAMS_MIC_STATUS_CHANGED") {
      // Handle Teams mic status change during meeting
      // Reconfigure offscreen audio based on new mic state
      const stored = await chrome.storage.local.get({
        audioSettings: DEFAULT_AUDIO_SETTINGS,
        asrState: DEFAULT_STATE
      });
      
      const inMeeting = stored.asrState.inTeamsMeeting;
      const teamsMicMuted = message.muted === true;
      
      if (inMeeting && stored.asrState.running) {
        // Notify offscreen to reconfigure audio sources
        await chrome.runtime.sendMessage({
          target: "offscreen",
          type: "RECONFIGURE_AUDIO",
          inTeamsMeeting: inMeeting,
          teamsMicMuted: teamsMicMuted
        });
      }
      
      await setState({
        teamsMicMuted: teamsMicMuted,
        micMuted: teamsMicMuted
      });
      
      sendResponse({ ok: true });
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

    if (message.type === "TEAMS_STATUS_UPDATE") {
      // Handle status update from content script
      const inMeeting = message.inMeeting === true;
      const micMuted = message.micMuted === true;
      
      await setState({
        inTeamsMeeting: inMeeting,
        teamsMicMuted: micMuted
      });
      
      // If in meeting and running, notify offscreen to reconfigure audio
      const stored = await chrome.storage.local.get({
        asrState: DEFAULT_STATE
      });
      
      if (stored.asrState.running && inMeeting) {
        await chrome.runtime.sendMessage({
          target: "offscreen",
          type: "RECONFIGURE_AUDIO",
          inTeamsMeeting: inMeeting,
          teamsMicMuted: micMuted
        }).catch(() => {});
      }
      
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
