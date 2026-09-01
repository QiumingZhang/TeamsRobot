// Content script for Teams meeting detection and microphone state monitoring
let teamsMeetingStatus = null;
let teamsMicState = null;
let lastTeamsMicState = null;
let monitorInterval = null;

// Send initial status when script loads
chrome.runtime.sendMessage({ 
  type: 'TEAMS_STATUS_UPDATE', 
  inMeeting: false,
  micMuted: null 
}).catch(() => {});

// Function to detect if we're in a Teams meeting
function isInMeeting() {
  // Check for meeting-specific elements
  const meetingElements = document.querySelectorAll('[data-track-app-name="meeting"]');
  return meetingElements.length > 0;
}

// Function to get microphone button state
function getMicButtonState() {
  // Try multiple selectors for the microphone button
  const micButton = document.querySelector('[data-inp="microphone-button"]') || 
                    document.querySelector('#microphone-button') ||
                    document.querySelector('[aria-label*="麦克风"]');
  
  if (!micButton) {
    return null;
  }
  
  // Get the data-state attribute
  const dataState = micButton.getAttribute('data-state');
  const ariaLabel = micButton.getAttribute('aria-label');
  
  // Log for debugging
  console.log('[Teams ASR] Mic button found:', {
    dataState,
    ariaLabel,
    allDataAttrs: Array.from(micButton.attributes)
      .filter(attr => attr.name.startsWith('data-'))
      .map(attr => `${attr.name}="${attr.value}"`)
      .join(' ')
  });
  
  // Determine if mic is muted based on data-state
  if (dataState === 'mic-off') {
    return true; // Muted
  } else if (dataState === 'mic') {
    return false; // Not muted
  }
  
  // Fallback: check aria-label
  if (ariaLabel) {
    if (ariaLabel.includes('取消静音') || ariaLabel.includes('取消麦克风静音') || ariaLabel.includes('Unmute')) {
      return true; // Muted (button shows "unmute")
    } else if (ariaLabel.includes('静音') || ariaLabel.includes('将麦克风静音') || ariaLabel.includes('Mute')) {
      return false; // Not muted (button shows "mute")
    }
  }
  
  return null; // Unknown state
}

// Function to check Teams meeting status and mic state
function checkTeamsStatus() {
  const inMeeting = isInMeeting();
  const micMuted = inMeeting ? getMicButtonState() : null;
  
  // Only send update if status changed
  if (inMeeting !== teamsMeetingStatus || micMuted !== teamsMicState) {
    teamsMeetingStatus = inMeeting;
    teamsMicState = micMuted;
    
    console.log('[Teams ASR] Status update:', { inMeeting, micMuted });
    
    chrome.runtime.sendMessage({ 
      type: 'TEAMS_STATUS_UPDATE', 
      inMeeting: teamsMeetingStatus,
      micMuted: teamsMicState 
    }).catch(() => {});
    
    // Also notify if mic state changed while in meeting
    if (inMeeting && micMuted !== null && micMuted !== lastTeamsMicState) {
      console.log('[Teams ASR] Mic state changed:', micMuted);
      chrome.runtime.sendMessage({ 
        type: 'TEAMS_MIC_STATE_CHANGED',
        micMuted: micMuted
      }).catch(() => {});
      lastTeamsMicState = micMuted;
    }
  }
}

// Start monitoring
checkTeamsStatus();
monitorInterval = setInterval(checkTeamsStatus, 2000);

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_TEAMS_STATUS') {
    sendResponse({ 
      inMeeting: teamsMeetingStatus, 
      micMuted: teamsMicState 
    });
  } else if (message.type === 'STOP_MONITORING') {
    if (monitorInterval) {
      clearInterval(monitorInterval);
      monitorInterval = null;
    }
    sendResponse({ ok: true });
  }
  return true;
});

// Clean up on page unload
window.addEventListener('beforeunload', () => {
  if (monitorInterval) {
    clearInterval(monitorInterval);
  }
});
