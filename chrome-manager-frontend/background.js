import {
  buildUserMessage,
  commandsFromLabels,
  findLocalCommands,
  groqErrorMessage,
  isGroupingRequest,
  omniboxSuggestions,
  parseCommands,
  parseLabels,
  resolveIndexes,
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_LABELS,
} from './lib.js';
import { collectTabState, executeCommands } from './chrome-api.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';
const GROQ_MODEL = 'openai/gpt-oss-120b';
const REQUEST_TIMEOUT_MS = 30000;

// Chrome shuts an idle service worker down and restarts it on the next
// message. Comparing this to the moment a request arrives shows how much of
// that request was spent waiting for the worker to come back.
const WORKER_STARTED_AT = Date.now();

function saveLastStatus(text) {
  chrome.storage.local.set({ lastStatus: { text, updatedAt: Date.now() } });
}

async function getApiKey() {
  return new Promise((resolve) => {
    chrome.storage.local.get('groqApiKey', (data) => resolve(data.groqApiKey || ''));
  });
}

async function callGroq(apiKey, tabs, groups, userPrompt) {
  const labelling = isGroupingRequest(userPrompt);

  const body = {
    model: GROQ_MODEL,
    // temperature 0 + a fixed seed so the same tabs keep landing in the same
    // groups; inference on shared hardware still varies a little.
    temperature: 0,
    seed: 7,
    max_completion_tokens: 4096,
    // gpt-oss reasons before answering. JSON mode rejects reasoning_format
    // "raw", and hiding the reasoning keeps the reply channel to just the JSON;
    // low effort leaves more of the token budget for that JSON, which has to
    // arrive complete or Groq's validator refuses the whole response.
    reasoning_format: 'hidden',
    reasoning_effort: 'low',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: labelling ? SYSTEM_PROMPT_LABELS : SYSTEM_PROMPT },
      { role: 'user', content: buildUserMessage(tabs, groups, userPrompt) },
    ],
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const apiStart = Date.now();
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
    const payload = await response.json().catch(() => ({}));
    throw new Error(groqErrorMessage(payload, response.status));
  }

  const data = await response.json();
  const apiMs = Date.now() - apiStart;
  const msg = data.choices?.[0]?.message ?? {};
  // gpt-oss is a reasoning model: if the whole reply landed in the reasoning
  // channel, content comes back empty and the JSON is over in `reasoning`.
  const text = msg.content || msg.reasoning || '';
  console.log('Groq reply:', JSON.stringify(data.choices?.[0] ?? data));

  const commands = labelling
    ? commandsFromLabels(parseLabels(text), tabs, groups)
    : resolveIndexes(parseCommands(text), tabs, groups);

  return { commands, raw: text, apiMs };
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
        const resp = await fetch(GROQ_MODELS_URL, {
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
    chrome.storage.local.set({ groqApiKey: message.apiKey }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message?.type !== 'runAgent') {
    return false;
  }

  (async () => {
    const result = await runCommand(message.prompt);
    sendResponse(result);
  })();

  return true;
});

// One path for every entry point: the popup, and the address-bar keyword.
// Returns the same shape the popup already expects.
async function runCommand(prompt) {
  const requestStart = Date.now();
  // Small when Chrome had just restarted the worker for this very request.
  const sinceWorkerStart = requestStart - WORKER_STARTED_AT;

  try {
    const { tabs: tabData, groups: groupData } = await collectTabState();

    let commands = findLocalCommands(prompt, tabData, groupData);
    const usedAI = commands === null;
    let aiRaw = '';
    let apiMs = 0;

    if (usedAI) {
      const apiKey = await getApiKey();
      if (!apiKey) {
        saveLastStatus('No API key — please set your Groq API key first');
        return { ok: false, error: 'No API key set' };
      }
      const res = await callGroq(apiKey, tabData, groupData, prompt);
      commands = res.commands;
      aiRaw = res.raw;
      apiMs = res.apiMs;
    }

    const { succeeded, failed } = await executeCommands(commands);
    const totalMs = Date.now() - requestStart;
    // Logged rather than shown: useful when a request feels slow, and it
    // separates waiting on Groq from everything this extension controls.
    console.log('timing', JSON.stringify({
      totalMs, apiMs, workerWaitMs: sinceWorkerStart < 1000 ? sinceWorkerStart : 0,
    }));

    if (commands.length > 0) {
      saveLastStatus(failed > 0
        ? `Done: ${succeeded} command(s) succeeded, ${failed} failed`
        : `Done: executed ${commands.length} command(s)`);
    } else {
      saveLastStatus(usedAI
        ? `AI returned no actions. Reply: ${(aiRaw || '(empty)').slice(0, 150)}`
        : 'Nothing to do');
    }

    return { ok: true, commandCount: succeeded, usedAI, aiRaw, totalMs, apiMs };
  } catch (error) {
    const msg = error?.name === 'AbortError'
      ? 'Groq timeout after 30s'
      : (error?.message || String(error) || 'Unknown error');
    console.error('Agent task failed:', error);
    saveLastStatus(`Failed: ${msg}`);
    return { ok: false, error: msg };
  }
}

// Address-bar keyword. This never builds a popup window, which measurements
// put at roughly 290 ms — an order of magnitude more than running the command.
chrome.omnibox.onInputChanged.addListener((text, suggest) => {
  (async () => {
    const { tabs } = await collectTabState();
    suggest(omniboxSuggestions(text, tabs));
  })();
});

chrome.omnibox.onInputEntered.addListener((text) => {
  (async () => {
    const result = await runCommand(text.trim());
    // There is no popup to report into, so the toolbar icon carries the result
    // briefly instead.
    await showBadge(result.ok
      ? (result.commandCount > 0 ? String(result.commandCount) : '0')
      : '!');
  })();
});

async function showBadge(text) {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: text === '!' ? '#c0392b' : '#4f8ef7' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
}

