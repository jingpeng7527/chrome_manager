const statusBar = document.getElementById('statusBar');
const statusText = document.getElementById('statusText');

function setStatus(text, state = '') {
    statusBar.className = 'status-bar' + (state ? ' ' + state : '');
    statusText.textContent = text;
}

function formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString();
}

function loadLastStatus() {
    chrome.storage.local.get('lastStatus', (data) => {
        const s = data?.lastStatus;
        if (!s?.text) { setStatus('Ready'); return; }
        const suffix = s.updatedAt ? ` (${formatTime(s.updatedAt)})` : '';
        const state = s.text.startsWith('Done') ? 'ok' : s.text.startsWith('Failed') ? 'error' : '';
        setStatus(s.text + suffix, state);
    });
}

// How long this popup took to open, reported from the browser it actually
// opened in. Measuring it from an automated harness understates it: that opens
// the page as a tab and never pays for Chrome constructing the popup window.
function showOpenTime() {
    window.addEventListener('load', () => {
        const nav = performance.getEntriesByType('navigation')[0];
        const ms = Math.round(nav?.loadEventEnd || performance.now());
        if (!ms) return;
        const el = document.getElementById('openTime');
        if (el) el.textContent = `${ms} ms`;
    });
}

// Load saved key
chrome.storage.local.get('groqApiKey', (data) => {
    if (data.groqApiKey) document.getElementById('apiKeyInput').value = data.groqApiKey;
});

loadLastStatus();
refreshTabCount();
showOpenTime();

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

function refreshTabCount() {
    chrome.tabs.query({ currentWindow: true }, (tabs) => {
        document.getElementById('tabCount').textContent = `${tabs?.length ?? 0} tabs`;
    });
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
