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

// Tab count
chrome.tabs?.query({ currentWindow: true }, (tabs) => {
    document.getElementById('tabCount').textContent = `${tabs?.length ?? 0} tabs`;
});

// Load saved key
chrome.storage.local.get('groqApiKey', (data) => {
    if (data.groqApiKey) document.getElementById('apiKeyInput').value = data.groqApiKey;
});

loadLastStatus();

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

// Send command
function runAgent() {
    const prompt = document.getElementById('userInput').value.trim();
    if (!prompt) { setStatus('Please enter a command', 'error'); return; }

    const sendBtn = document.getElementById('sendBtn');
    setStatus('Thinking…', 'loading');
    sendBtn.disabled = true;

    chrome.runtime.sendMessage({ type: 'runAgent', prompt }, (result) => {
        sendBtn.disabled = false;

        if (chrome.runtime.lastError) {
            setStatus(`Failed: ${chrome.runtime.lastError.message}`, 'error');
            return;
        }

        if (!result?.ok) {
            setStatus(`Failed: ${result?.error || 'Unknown error'}`, 'error');
            return;
        }

        setStatus(
            result.commandCount > 0 ? `Done — ${result.commandCount} action(s) executed` : 'Done — no actions taken',
            'ok'
        );
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
