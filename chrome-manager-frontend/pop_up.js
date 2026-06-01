const statusDiv = document.getElementById('status');

function formatTime(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleTimeString();
}

function loadLastStatus() {
    chrome.storage.local.get('lastStatus', (data) => {
        const lastStatus = data?.lastStatus;
        if (!lastStatus?.text) {
            statusDiv.textContent = 'Ready';
            return;
        }
        const suffix = lastStatus.updatedAt ? ` (${formatTime(lastStatus.updatedAt)})` : '';
        statusDiv.textContent = `${lastStatus.text}${suffix}`;
    });
}

// Load saved API key into the input field
chrome.storage.local.get('groqApiKey', (data) => {
    if (data.groqApiKey) {
        document.getElementById('apiKeyInput').value = data.groqApiKey;
    }
});

loadLastStatus();

function saveKey(key) {
    // Strip any non-ASCII characters that would break HTTP headers
    const clean = key.replace(/[^\x20-\x7E]/g, '');
    if (!clean) return;
    chrome.runtime.sendMessage({ type: 'saveApiKey', apiKey: clean }, () => {
        statusDiv.textContent = 'API key saved ✓';
    });
}

document.getElementById('saveKeyBtn').onclick = () => {
    const key = document.getElementById('apiKeyInput').value.trim();
    if (!key) { statusDiv.textContent = 'Please enter an API key'; return; }
    saveKey(key);
};

document.getElementById('apiKeyInput').addEventListener('paste', (e) => {
    setTimeout(() => {
        const key = document.getElementById('apiKeyInput').value.trim();
        saveKey(key);
    }, 0);
});

document.getElementById('sendBtn').onclick = async () => {
    const inputField = document.getElementById('userInput');
    const sendBtn = document.getElementById('sendBtn');
    const prompt = inputField.value.trim();

    if (!prompt) {
        statusDiv.textContent = 'Please enter a command';
        return;
    }

    statusDiv.textContent = 'Processing...';
    sendBtn.disabled = true;

    chrome.runtime.sendMessage({ type: 'runAgent', prompt }, (result) => {
        sendBtn.disabled = false;

        if (chrome.runtime.lastError) {
            statusDiv.textContent = `Failed: ${chrome.runtime.lastError.message}`;
            return;
        }

        if (!result?.ok) {
            statusDiv.textContent = `Failed: ${result?.error || 'Unknown error'}`;
            return;
        }

        statusDiv.textContent = result.commandCount > 0
            ? `Done: executed ${result.commandCount} command(s)`
            : 'Done: no actions to execute';
    });
};

document.getElementById('checkBtn').onclick = () => {
    const checkBtn = document.getElementById('checkBtn');
    statusDiv.textContent = 'Checking connection...';
    checkBtn.disabled = true;

    chrome.runtime.sendMessage({ type: 'checkHealth' }, (result) => {
        checkBtn.disabled = false;

        if (chrome.runtime.lastError) {
            statusDiv.textContent = `Connection failed: ${chrome.runtime.lastError.message}`;
            return;
        }

        statusDiv.textContent = result?.ok
            ? 'Connection OK: Groq API key is valid'
            : `Connection failed: ${result?.error || 'Unknown error'}`;
    });
};
