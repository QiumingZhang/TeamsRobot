<span class="fui-Button__icon rywnvv2 ___1vfe04r fjoy568 f1s184ao f22iagw f1pztt34 f1063pyq f122n59 f4d9j23 f10pi13n fqerorx fwk23hs f14z66ap"><div class="fui-Primitive ___1s6oeh9 f22iagw fb10uid frpp3y f537336 fdoo6yt"><svg class="fui-Icon-filled ___12fm75w f1w7gpdv fez10in fg4l7m0" fill="currentColor" aria-hidden="true" width="1em" height="1em" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg"><path d="M13 10a3 3 0 0 1-.1.78L7 4.88A3 3 0 0 1 13 5v5ZM7 7.7V10a3 3 0 0 0 4.74 2.45l1.07 1.07A4.5 4.5 0 0 1 5.5 10a.5.5 0 0 0-1.01 0 5.5 5.5 0 0 0 5 5.48v2.02a.5.5 0 0 0 1 0v-2.02a5.48 5.48 0 0 0 3.02-1.25l3.63 3.62a.5.5 0 0 0 .7-.7l-15-15a.5.5 0 1 0-.7.7L7 7.71Zm7.8 4.98c.45-.8.7-1.7.7-2.68a.5.5 0 0 0-1 0c0 .7-.16 1.35-.44 1.94l.74.74Z" fill="currentColor"></path></svg><svg class="fui-Icon-regular ___1vjqft9 fjseox fez10in fg4l7m0" fill="currentColor" aria-hidden="true" width="1em" height="1em" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg"><path d="M12 5v4.88l.9.9A3 3 0 0 0 13 10V5a3 3 0 0 0-6-.12l1 1V5a2 2 0 1 1 4 0ZM7 7.7 2.15 2.86a.5.5 0 1 1 .7-.7l15 15a.5.5 0 0 1-.7.7l-3.63-3.62a5.48 5.48 0 0 1-3.02 1.25v2.02a.5.5 0 0 1-1 0v-2.02a5.5 5.5 0 0 1-5-5.48.5.5 0 0 1 1 0 4.5 4.5 0 0 0 7.3 3.52l-1.06-1.07A3 3 0 0 1 7 10V7.7Zm4.02 4.02L8 8.71V10a2 2 0 0 0 3.02 1.72Zm3.78.96-.74-.74c.28-.59.44-1.25.44-1.94a.5.5 0 0 1 1 0c0 .97-.25 1.89-.7 2.68Z" fill="currentColor"></path></svg></div></span>// teams-mic-monitor.js
// 此脚本作为 Content Script 运行在 Teams 页面中

let lastState = null;
let checkInterval = null;

function getMicState() {
    // 优先使用 data-inp 属性定位，这是最稳定的标识
    const btn = document.querySelector('button[data-inp="microphone-button"]');
    
    if (!btn) {
        return null; // 未找到按钮
    }

    const stateAttr = btn.getAttribute('data-state');
    const ariaLabel = btn.getAttribute('aria-label');

    // 根据您提供的 HTML 分析：
    // 静音时: data-state="mic-off", aria-label="取消麦克风静音"
    // 开启时: data-state="mic", aria-label="将麦克风静音"
    
    if (stateAttr === 'mic-off' || (ariaLabel && ariaLabel.includes('取消'))) {
        return 'muted';
    } else if (stateAttr === 'mic' || (ariaLabel && ariaLabel.includes('静音'))) {
        return 'unmuted';
    }

    return null;
}

function sendStateToBackground(state) {
    if (state && state !== lastState) {
        lastState = state;
        console.log(`[Teams Mic Monitor] 检测到麦克风状态变化: ${state}`);
        
        chrome.runtime.sendMessage({
            type: 'TEAMS_MIC_STATUS_UPDATE',
            isMuted: state === 'muted'
        }).catch(err => {
            // Service Worker 可能未激活，忽略错误
            if (chrome.runtime.lastError) {
                // console.warn('Background not ready:', err);
            }
        });
    }
}

// 初始检测
const initialState = getMicState();
if (initialState) {
    sendStateToBackground(initialState);
}

// 使用 MutationObserver 监听 DOM 变化，比轮询更高效
const observer = new MutationObserver(() => {
    const currentState = getMicState();
    if (currentState) {
        sendStateToBackground(currentState);
    }
});

// 开始观察 body 的变化
if (document.body) {
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true, // 监听属性变化 (data-state)
        attributeFilter: ['data-state', 'aria-label']
    });
} else {
    // 如果 body 还没加载，等待加载完成
    document.addEventListener('DOMContentLoaded', () => {
        if (document.body) {
            observer.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['data-state', 'aria-label']
            });
            sendStateToBackground(getMicState());
        }
    });
}

// 兜底轮询：每 2 秒检查一次，防止 Observer 漏掉某些动态渲染
setInterval(() => {
    const currentState = getMicState();
    if (currentState) {
        sendStateToBackground(currentState);
    }
}, 2000);