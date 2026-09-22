import {
  buildUserMessage,
  commandsFromLabels,
  findLocalCommands,
  isGroupingRequest,
  parseCommands,
  parseLabels,
  resolveIndexes,
} from './lib.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';
const GROQ_MODEL = 'openai/gpt-oss-120b';
const REQUEST_TIMEOUT_MS = 30000;

// Plain domain matching ("group stripe") is handled locally and never reaches
// the model, so this prompt covers only requests needing judgement — which are
// exactly the ones that must read page titles, not just URLs.
const SYSTEM_PROMPT =
  'You organize Chrome tabs. Reply with a JSON object: {"commands": [...]}.\n' +
  'Tabs are numbered 1..N in the list below, and existing groups are numbered ' +
  '1..M. Refer to them ONLY by those small numbers.\n' +
  'Commands:\n' +
  '  {"action":"group","tabIds":[1,2],"title":"Short Name"}\n' +
  '  {"action":"group","tabIds":[1,2],"groupId":3}   // add to existing group 3\n' +
  '  {"action":"ungroup","tabIds":[1,2]}             // leaves the tabs open\n' +
  '  {"action":"remove","tabId":1}\n' +
  '  {"action":"duplicate","tabId":1}\n' +
  'Write tabIds as separate numbers with commas between them, like [1,2,3]. ' +
  'Never run numbers together.\n' +
  'To group by topic or theme, read each tab\'s title AND url to work out what ' +
  'it is about, then emit one group command per theme. Aim for 2-5 groups, each ' +
  'holding at least 2 tabs, each titled in 1-2 words. Leave tabs that fit no ' +
  'theme ungrouped rather than forcing them together.\n' +
  'Prefer adding to an existing group over creating a second group with the ' +
  'same name. Return {"commands": []} only when nothing sensible applies.\n' +
  'Output JSON only — no prose, no markdown fences.';

// Grouping is asked for as one label per tab rather than as arrays of indices.
// Building a correct array of indices is where the model fails: it mixes tabs
// between arrays. Labelling each tab on its own line is answered positionally,
// so a mistake costs one tab instead of a whole group, and the code — not the
// model — decides which tabs end up together.
const SYSTEM_PROMPT_LABELS =
  'You sort Chrome tabs into topics. You are given a numbered list of tabs.\n' +
  'Reply with JSON: {"labels": {"1": "AWS", "2": "AWS", "3": "Stripe"}}\n' +
  'Rules:\n' +
  '- Give every tab number from the list exactly one label.\n' +
  '- Tabs that belong together must get the identical label string.\n' +
  '- A label is 1-3 words, taken from the tab\'s title and url.\n' +
  '- Prefer specific labels over broad ones, and split rather than merge: when ' +
  'two sets of tabs serve different purposes, label them separately — for ' +
  'example "Interview Prep" and "Job Listings" rather than one "Jobs". Aim for ' +
  '3-8 distinct labels.\n' +
  '- Use "none" for a tab that fits no topic.\n' +
  '- Judge each tab on its own line. Do not reorder or renumber the tabs.\n' +
  'Output JSON only — no prose, no markdown fences.';

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
    max_completion_tokens: 2048,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: labelling ? SYSTEM_PROMPT_LABELS : SYSTEM_PROMPT },
      { role: 'user', content: buildUserMessage(tabs, groups, userPrompt) },
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
  const msg = data.choices?.[0]?.message ?? {};
  // gpt-oss is a reasoning model: if the whole reply landed in the reasoning
  // channel, content comes back empty and the JSON is over in `reasoning`.
  const text = msg.content || msg.reasoning || '';
  console.log('Groq reply:', JSON.stringify(data.choices?.[0] ?? data));

  const commands = labelling
    ? commandsFromLabels(parseLabels(text), tabs, groups)
    : resolveIndexes(parseCommands(text), tabs, groups);

  return { commands, raw: text };
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
    try {
      const { prompt } = message;
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const tabData = tabs.map((tab) => ({
        id: tab.id,
        title: tab.title,
        url: tab.url,
        groupId: tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE ? tab.groupId : null,
      }));

      const groups = await chrome.tabGroups.query({ windowId: chrome.windows.WINDOW_ID_CURRENT });
      const groupData = groups.map((g) => ({ id: g.id, title: g.title }));

      let commands = findLocalCommands(prompt, tabData, groupData);
      const usedAI = commands === null;
      let aiRaw = '';

      if (usedAI) {
        const apiKey = await getApiKey();
        if (!apiKey) {
          saveLastStatus('No API key — please set your Groq API key first');
          sendResponse({ ok: false, error: 'No API key set' });
          return;
        }
        const res = await callGroq(apiKey, tabData, groupData, prompt);
        commands = res.commands;
        aiRaw = res.raw;
      }

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
        saveLastStatus(usedAI
          ? `AI returned no actions. Reply: ${(aiRaw || '(empty)').slice(0, 150)}`
          : 'Nothing to do');
      }

      sendResponse({ ok: true, commandCount: succeeded, usedAI, aiRaw });
    } catch (error) {
      const msg = error?.name === 'AbortError'
        ? 'Groq timeout after 30s'
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
      const options = { tabIds: command.tabIds };
      if (command.groupId) options.groupId = command.groupId;
      const groupId = await chrome.tabs.group(options);
      if (!command.groupId) {
        await chrome.tabGroups.update(groupId, { title: command.title || 'AI Group' });
      }
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
