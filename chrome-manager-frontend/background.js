const BACKEND_URL = 'http://localhost:8000/process_intent';
const BACKEND_HEALTH_URL = 'http://localhost:8000/health';
const REQUEST_TIMEOUT_MS = 30000;
const HEALTH_TIMEOUT_MS = 8000;

function saveLastStatus(text) {
  chrome.storage.local.set({
    lastStatus: {
      text,
      updatedAt: Date.now(),
    },
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'checkHealth') {
    (async () => {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

        let response;
        try {
          response = await fetch(BACKEND_HEALTH_URL, {
            method: 'GET',
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeoutId);
        }

        if (!response.ok) {
          throw new Error(`Backend health error: ${response.status}`);
        }

        const health = await response.json();
        const backendOk = health?.backend === 'ok';
        const ollamaOk = Boolean(health?.ollamaReachable);
        const modelOk = Boolean(health?.modelAvailable);

        if (backendOk && ollamaOk && modelOk) {
          saveLastStatus('Connection OK: Backend + Ollama + model are available');
        } else {
          saveLastStatus(`Status: backend=${backendOk ? 'ok' : 'down'}, ollama=${ollamaOk ? 'ok' : 'down'}, model=${modelOk ? 'ok' : 'missing'}`);
        }

        sendResponse({ ok: true, health });
      } catch (error) {
        const messageText = error?.name === 'AbortError'
          ? 'Health check timeout after 8s'
          : (error?.message || 'Unknown error');
        saveLastStatus(`Connection failed: ${messageText}`);
        sendResponse({ ok: false, error: messageText });
      }
    })();

    return true;
  }

  if (message?.type !== 'runAgent') {
    return false;
  }

  (async () => {
    try {
      const { prompt } = message;
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const tabData = tabs.map((tab) => ({ id: tab.id, title: tab.title, url: tab.url }));

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      let response;
      try {
        response = await fetch(BACKEND_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_prompt: prompt, tabs: tabData }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        throw new Error(`Backend error: ${response.status}`);
      }

      const result = await response.json();
      const commands = Array.isArray(result.commands) ? result.commands : [];

      let failed = 0;
      for (const command of commands) {
        try {
          await executeChromeCommand(command);
        } catch (cmdError) {
          failed++;
          console.error('Command failed:', command.action, cmdError?.message ?? String(cmdError));
        }
      }

      const succeeded = commands.length - failed;
      if (commands.length > 0) {
        const summary = failed > 0
          ? `Done: ${succeeded} command(s) succeeded, ${failed} failed`
          : `Done: executed ${commands.length} command(s)`;
        saveLastStatus(summary);
      } else {
        saveLastStatus('Done: no actions to execute');
      }

      sendResponse({ ok: true, commandCount: succeeded });
    } catch (error) {
      const messageText = error?.name === 'AbortError'
        ? 'Backend timeout after 30s'
        : (error?.message || error?.name || String(error) || 'Unknown error');
      console.error('Agent task failed:', error?.name, error?.message, error);
      saveLastStatus(`Failed: ${messageText}`);
      sendResponse({ ok: false, error: messageText });
    }
  })();

  return true;
});

async function executeChromeCommand(command) {
  // model sometimes returns "command" instead of "action"
  const action = command.action ?? command.command;
  switch (action) {
    case 'group': {
      const groupId = await chrome.tabs.group({ tabIds: command.tabIds });
      await chrome.tabGroups.update(groupId, { title: command.title || 'AI Group' });
      break;
    }
    case 'duplicate':
      await chrome.tabs.duplicate(command.tabId);
      break;
    case 'remove':
      await chrome.tabs.remove(command.tabId);
      break;
    default:
      console.warn('Unknown action:', action, command);
  }
}
