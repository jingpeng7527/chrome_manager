const statusBar = document.getElementById('statusBar');
const statusText = document.getElementById('statusText');

function setStatus(text, state = '') {
    statusBar.className = 'status-bar' + (state ? ' ' + state : '');
    statusText.textContent = text;
}

function formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString();
}

function showLastStatus(s) {
    if (!s?.text) { setStatus('Ready'); return; }
    const suffix = s.updatedAt ? ` (${formatTime(s.updatedAt)})` : '';
    const state = s.text.startsWith('Done') ? 'ok' : s.text.startsWith('Failed') ? 'error' : '';
    setStatus(s.text + suffix, state);
}

// How long this document took to render — NOT how long the popup took to
// appear. The popup's clock starts after Chrome has already built the window,
// and that construction is roughly ten times this number. Nothing inside an
// extension can observe the click that starts it, so the figure a user waits
// on can only be measured externally, by recording the screen.
function showRenderTime() {
    window.addEventListener('load', () => {
        const nav = performance.getEntriesByType('navigation')[0];
        const ms = Math.round(nav?.loadEventEnd || performance.now());
        if (!ms) return;
        const el = document.getElementById('openTime');
        if (el) {
            el.textContent = `render ${ms} ms`;
            el.title = 'Time to render this popup. Chrome spends roughly ten times '
                + 'as long building the popup window before this clock starts, and '
                + 'that part cannot be measured from inside the extension.';
        }
    });
}

// Chrome only shows the popup once this page has finished loading, so
// nothing that talks to the browser runs before that. Storage and the tab
// query both go through Chrome's main process, the same one that has to build
// and show the popup window; asking it for every tab in the window first
// (titles, URLs, favicon data) makes the click wait on work the user cannot
// see yet. Everything below only fills in details, so it waits for the load
// event and then one more task, letting Chrome put the popup on screen first.
function afterShown(fn) {
    const run = () => setTimeout(fn, 0);
    if (document.readyState === 'complete') run();
    else window.addEventListener('load', run, { once: true });
}

// The tab count waits longer still, for the popup's first paint. With the
// "tabs" permission chrome.tabs.query returns every tab's favicon, and pages
// that set a data: URL favicon put the whole image in it: 300 such tabs came
// to 8 MB. Copying that out of Chrome's main process while the popup is still
// being put on screen added ~70 ms to the open (npm run stress, busy tabs).
// After the first paint it delays only the count.
function afterPainted(fn) {
    let done = false;
    const run = () => { if (!done) { done = true; setTimeout(fn, 0); } };
    if (performance.getEntriesByName('first-contentful-paint').length) { run(); return; }
    new PerformanceObserver((list) => {
        if (list.getEntriesByName('first-contentful-paint').length) run();
    }).observe({ type: 'paint', buffered: true });
    // Never leave the count blank if a paint entry does not arrive.
    afterShown(() => setTimeout(run, 500));
}

afterShown(() => {
    // One storage round trip for both values rather than two.
    chrome.storage.local.get(['groqApiKey', 'lastStatus'], (data) => {
        if (data?.groqApiKey) document.getElementById('apiKeyInput').value = data.groqApiKey;
        showLastStatus(data?.lastStatus);
    });
});

afterPainted(() => {
    refreshTabCount();
    trackTabCount();
});

showRenderTime();

// Example chips
document.querySelectorAll('.example-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
        document.getElementById('userInput').value = chip.textContent;
        document.getElementById('userInput').focus();
    });
});

// API key modal
document.getElementById('openKeyModal').onclick = () => {
    document.getElementById('modalOverlay').classList.add('open');
    document.getElementById('apiKeyInput').focus();
};
document.getElementById('modalCancel').onclick = () => {
    document.getElementById('modalOverlay').classList.remove('open');
};
document.getElementById('modalOverlay').onclick = (e) => {
    if (e.target === document.getElementById('modalOverlay')) {
        document.getElementById('modalOverlay').classList.remove('open');
    }
};

function saveKey(key) {
    const clean = key.replace(/[^\x20-\x7E]/g, '');
    if (!clean) return;
    chrome.runtime.sendMessage({ type: 'saveApiKey', apiKey: clean }, () => {
        setStatus('API key saved', 'ok');
        document.getElementById('modalOverlay').classList.remove('open');
    });
}

document.getElementById('saveKeyBtn').onclick = () => {
    const key = document.getElementById('apiKeyInput').value.trim();
    if (!key) { setStatus('Please enter an API key', 'error'); return; }
    saveKey(key);
};

document.getElementById('apiKeyInput').addEventListener('paste', (e) => {
    setTimeout(() => saveKey(document.getElementById('apiKeyInput').value.trim()), 0);
});

document.getElementById('apiKeyInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('saveKeyBtn').click();
});

let tabCount = null;
let windowId = null;

function showTabCount() {
    document.getElementById('tabCount').textContent = `${tabCount ?? 0} tabs`;
}

function refreshTabCount() {
    chrome.tabs.query({ currentWindow: true }, (tabs) => {
        tabCount = tabs?.length ?? 0;
        windowId = tabs?.[0]?.windowId ?? windowId;
        showTabCount();
    });
}

// The side panel stays open while tabs come and go. Keep the count current
// from tab events instead of querying again: a query returns every tab with
// its favicon, megabytes with hundreds of tabs, and opening a batch of tabs
// would repeat it for each one.
function trackTabCount() {
    const adjust = (inWindow, delta) => {
        if (tabCount == null || windowId == null || inWindow !== windowId) return;
        tabCount = Math.max(0, tabCount + delta);
        showTabCount();
    };
    chrome.tabs.onCreated.addListener((tab) => adjust(tab.windowId, +1));
    chrome.tabs.onRemoved.addListener((_id, info) => {
        if (!info.isWindowClosing) adjust(info.windowId, -1);
    });
    chrome.tabs.onAttached.addListener((_id, info) => adjust(info.newWindowId, +1));
    chrome.tabs.onDetached.addListener((_id, info) => adjust(info.oldWindowId, -1));
}

// Commands that need no model run here rather than in the service worker.
// Chrome shuts that worker down after about 30s idle, so routing through it
// would make every "ungroup all" wait on a cold start it does not need.
async function runLocally(prompt) {
    // Loaded on demand rather than at startup. As static imports these cost
    // the popup roughly 60ms of extra open time on every click, with a long
    // tail approaching a second; by the time a command is submitted the user
    // has been typing for seconds and will not notice the load.
    const [{ findLocalCommands }, { collectTabState, executeCommands }] =
        await Promise.all([import('./lib.js'), import('./chrome-api.js')]);

    const { tabs, groups } = await collectTabState();
    const commands = findLocalCommands(prompt, tabs, groups);
    if (commands === null) return false; // needs the model

    const { succeeded, failed } = await executeCommands(commands);
    refreshTabCount();

    if (!commands.length) {
        setStatus('Nothing to do', '');
    } else if (failed) {
        setStatus(`Done — ${succeeded} succeeded, ${failed} failed`, 'error');
    } else {
        setStatus(`Done — ${succeeded} action(s) executed`, 'ok');
    }
    return true;
}

// Send command
async function runAgent() {
    const prompt = document.getElementById('userInput').value.trim();
    if (!prompt) { setStatus('Please enter a command', 'error'); return; }

    const sendBtn = document.getElementById('sendBtn');
    sendBtn.disabled = true;

    try {
        if (await runLocally(prompt)) {
            sendBtn.disabled = false;
            return;
        }
    } catch (error) {
        sendBtn.disabled = false;
        setStatus(`Failed: ${error?.message || String(error)}`, 'error');
        return;
    }

    // Hand off to the service worker: a model call takes seconds and must
    // survive the popup closing.
    setStatus('Thinking…', 'loading');

    chrome.runtime.sendMessage({ type: 'runAgent', prompt }, (result) => {
        sendBtn.disabled = false;
        refreshTabCount();

        if (chrome.runtime.lastError) {
            setStatus(`Failed: ${chrome.runtime.lastError.message}`, 'error');
            return;
        }

        if (!result?.ok) {
            setStatus(`Failed: ${result?.error || 'Unknown error'}`, 'error');
            return;
        }

        if (result.commandCount > 0) {
            // Show where a slow request went: "3.1s" alone invites guessing,
            // "3.1s, 2.9s waiting on Groq" does not.
            const took = result.totalMs ? ` in ${(result.totalMs / 1000).toFixed(1)}s` : '';
            const api = result.apiMs ? ` (${(result.apiMs / 1000).toFixed(1)}s waiting on Groq)` : '';
            setStatus(`Done — ${result.commandCount} action(s)${took}${api}`, 'ok');
        } else {
            setStatus(
                result.usedAI
                    ? `AI returned no actions. Reply: ${(result.aiRaw || '(empty)').slice(0, 150)}`
                    : 'Nothing to do',
                ''
            );
        }
    });
}

document.getElementById('sendBtn').onclick = runAgent;

document.getElementById('userInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        runAgent();
    }
});

// Check connection
document.getElementById('checkBtn').onclick = () => {
    setStatus('Checking…', 'loading');
    document.getElementById('checkBtn').disabled = true;

    chrome.runtime.sendMessage({ type: 'checkHealth' }, (result) => {
        document.getElementById('checkBtn').disabled = false;

        if (chrome.runtime.lastError) {
            setStatus(`Failed: ${chrome.runtime.lastError.message}`, 'error');
            return;
        }

        setStatus(
            result?.ok ? 'Connection OK — Groq API key is valid' : `Failed: ${result?.error || 'Unknown error'}`,
            result?.ok ? 'ok' : 'error'
        );
    });
};
