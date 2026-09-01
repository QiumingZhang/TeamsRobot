// Floating permission dialog for microphone access
let permissionDialog = null;

export function showPermissionDialog(onGrant, onDeny) {
  // Remove existing dialog if any
  removePermissionDialog();
  
  // Create floating dialog
  permissionDialog = document.createElement('div');
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
  
  // Add styles
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
  
  // Setup button handlers
  const grantBtn = permissionDialog.querySelector('#grant-mic-permission');
  const denyBtn = permissionDialog.querySelector('#deny-mic-permission');
  const statusDiv = permissionDialog.querySelector('#permission-status');
  
  grantBtn.addEventListener('click', async () => {
    grantBtn.disabled = true;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      await chrome.storage.local.set({ microphonePermissionGranted: true });
      await chrome.runtime.sendMessage({ type: 'MICROPHONE_PERMISSION_GRANTED' });
      statusDiv.textContent = '✓ 权限已授予。正在启动转写...';
      statusDiv.className = 'success';
      
      // Stop the test stream
      stream.getTracks().forEach(track => track.stop());
      
      // Close dialog after short delay
      setTimeout(() => {
        removePermissionDialog();
        if (onGrant) onGrant();
      }, 1500);
    } catch (error) {
      const text = error?.name === 'NotAllowedError' 
        ? '麦克风权限被拒绝，请在浏览器设置中允许。'
        : `${error?.name || 'Error'}: ${error?.message || error}`;
      await chrome.runtime.sendMessage({ type: 'MICROPHONE_PERMISSION_DENIED', error: text });
      statusDiv.textContent = '✗ ' + text;
      statusDiv.className = 'error';
      grantBtn.disabled = false;
      if (onDeny) onDeny(text);
    }
  });
  
  denyBtn.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ 
      type: 'MICROPHONE_PERMISSION_DENIED', 
      error: '用户拒绝授予麦克风权限。' 
    });
    removePermissionDialog();
    if (onDeny) onDeny('用户拒绝授予麦克风权限。');
  });
}

export function removePermissionDialog() {
  if (permissionDialog) {
    permissionDialog.remove();
    permissionDialog = null;
  }
}

export async function requestMicrophonePermission() {
  // Check if already granted
  const stored = await chrome.storage.local.get({ microphonePermissionGranted: false });
  if (stored.microphonePermissionGranted) {
    return true;
  }
  
  return new Promise((resolve) => {
    showPermissionDialog(
      () => resolve(true),
      () => resolve(false)
    );
  });
}
