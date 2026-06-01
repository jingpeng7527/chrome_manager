const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.1-8b-instant';
const REQUEST_TIMEOUT_MS = 30000;

const SYSTEM_PROMPT =
  'You are a Chrome Tab Manager. ' +
  'Analyze the tabs and output a JSON object with a "commands" list. ' +
  'Available actions: ' +
  '{"action": "group", "tabIds": [number], "title": "Group Name"}, ' +
  '{"action": "ungroup", "tabIds": [number]}, ' +
  '{"action": "duplicate", "tabId": number}, ' +
  '{"action": "remove", "tabId": number}. ' +
  '"ungroup" moves tabs out of their group without closing them. ' +
  'Output ONLY valid JSON. No explanation, no markdown.';

function saveLastStatus(text) {
  chrome.storage.local.set({ lastStatus: { text, updatedAt: Date.now() } });
}

async function getApiKey() {
  return new Promise((resolve) => {
    chrome.storage.local.get('geminiApiKey', (data) => resolve(data.geminiApiKey || ''));
  });
}

async function callGroq(apiKey, tabs, userPrompt) {
  const tabInfo = tabs.map((t) => `ID:${t.id} | Title:${t.title} | URL:${t.url}`).join('\n');
  const userMessage = `Tabs:\n${tabInfo}\n\nUser Request: ${userPrompt}`;

  const body = {
    model: GROQ_MODEL,
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Groq error: ${response.status}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || '{}';
  return JSON.parse(text);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'checkHealth') {
    (async () => {
      const apiKey = await getApiKey();
      if (!apiKey) {
        saveLastStatus('No API key set');
        sendResponse({ ok: false, error: 'No API key set' });
        return;
      }
      // Minimal probe: list models to verify the key works
      try {
        const resp = await fetch('https://api.groq.com/openai/v1/models', {
          headers: { 'Authorization': `Bearer ${apiKey}` },
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err?.error?.message || `Status ${resp.status}`);
        }
        saveLastStatus('Connection OK: Groq API key is valid');
        sendResponse({ ok: true });
      } catch (error) {
        const msg = error?.message || 'Unknown error';
        saveLastStatus(`Connection failed: ${msg}`);
        sendResponse({ ok: false, error: msg });
      }
    })();
    return true;
  }

  if (message?.type === 'saveApiKey') {
    chrome.storage.local.set({ geminiApiKey: message.apiKey }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message?.type !== 'runAgent') {
    return false;
  }

  (async () => {
    try {
      const apiKey = await getApiKey();
      if (!apiKey) {
        saveLastStatus('No API key — please set your Gemini API key first');
        sendResponse({ ok: false, error: 'No API key set' });
        return;
      }

      const { prompt } = message;
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const tabData = tabs.map((tab) => ({ id: tab.id, title: tab.title, url: tab.url }));

      const result = await callGroq(apiKey, tabData, prompt);
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
      const msg = error?.name === 'AbortError'
        ? 'Gemini timeout after 30s'
        : (error?.message || String(error) || 'Unknown error');
      console.error('Agent task failed:', error);
      saveLastStatus(`Failed: ${msg}`);
      sendResponse({ ok: false, error: msg });
    }
  })();

  return true;
});

async function executeChromeCommand(command) {
  const action = command.action ?? command.command;
  switch (action) {
    case 'group': {
      const groupId = await chrome.tabs.group({ tabIds: command.tabIds });
      await chrome.tabGroups.update(groupId, { title: command.title || 'AI Group' });
      break;
    }
    case 'ungroup':
      await chrome.tabs.ungroup(command.tabIds);
      break;
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
