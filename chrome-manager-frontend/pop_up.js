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

loadLastStatus();

document.getElementById('sendBtn').onclick = async () => {
    const inputField = document.getElementById('userInput');
    const sendBtn = document.getElementById('sendBtn');
    const prompt = inputField.value.trim();

    if (!prompt) {
        statusDiv.textContent = 'Please enter a command';
        return;
    }

    statusDiv.textContent = 'Processing in background, you can close this popup...';
    sendBtn.disabled = true;

    chrome.runtime.sendMessage(
        { type: 'runAgent', prompt },
        (result) => {
            sendBtn.disabled = false;

            if (chrome.runtime.lastError) {
                statusDiv.textContent = `Failed: ${chrome.runtime.lastError.message}`;
                return;
            }

            if (!result?.ok) {
                statusDiv.textContent = `Failed: ${result?.error || 'Unknown error'}`;
                return;
            }

            if (result.commandCount > 0) {
                statusDiv.textContent = `Done: executed ${result.commandCount} command(s)`;
            } else {
                statusDiv.textContent = 'Done: no actions to execute';
            }
        }
    );
};

document.getElementById('checkBtn').onclick = () => {
    const checkBtn = document.getElementById('checkBtn');

    statusDiv.textContent = 'Checking connection...';
    checkBtn.disabled = true;

    chrome.runtime.sendMessage(
        { type: 'checkHealth' },
        (result) => {
            checkBtn.disabled = false;

            if (chrome.runtime.lastError) {
                statusDiv.textContent = `Connection failed: ${chrome.runtime.lastError.message}`;
                return;
            }

            if (!result?.ok) {
                statusDiv.textContent = `Connection failed: ${result?.error || 'Unknown error'}`;
                return;
            }

            const health = result.health || {};
            const backendOk = health.backend === 'ok';
            const ollamaOk = Boolean(health.ollamaReachable);
            const modelOk = Boolean(health.modelAvailable);

            if (backendOk && ollamaOk && modelOk) {
                statusDiv.textContent = 'Connection OK: Backend + Ollama + model are available';
                return;
            }

            statusDiv.textContent = `Status: backend=${backendOk ? 'ok' : 'down'}, ollama=${ollamaOk ? 'ok' : 'down'}, model=${modelOk ? 'ok' : 'missing'}`;
        }
    );
};