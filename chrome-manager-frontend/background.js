const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'openai/gpt-oss-120b';
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
  'IMPORTANT: Match tabs by URL domain only, never by page title or search query keywords. ' +
  '"GitHub tabs" means tabs whose URL hostname contains github.com — not search results about GitHub. ' +
  'If the user wants to add tabs to an existing group, use the existing groupId instead of creating a new one. ' +
  'For the "group" action, include "groupId" (number) to add to an existing group, or omit it to create a new group. ' +
  'Never group unrelated tabs. If no tabs match, return {"commands": []}. ' +
  'Output ONLY valid JSON. No explanation, no markdown.';

function saveLastStatus(text) {
  chrome.storage.local.set({ lastStatus: { text, updatedAt: Date.now() } });
}

async function getApiKey() {
  return new Promise((resolve) => {
    chrome.storage.local.get('groqApiKey', (data) => resolve(data.groqApiKey || ''));
  });
}

function trimUrl(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname.slice(0, 60);
  } catch { return url.slice(0, 80); }
}

function hostnameOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

// A bare term ("figma") matches any hostname label; a full domain ("x.com")
// must match the hostname exactly or as a suffix, so netflix.com != x.com.
function hostMatches(hostname, target) {
  if (target.includes('.')) {
    return hostname === target || hostname.endsWith('.' + target);
  }
  return hostname.split('.').includes(target);
}

// Common site names the user is likely to type, mapped to their real hostname
const KNOWN_DOMAINS = {
  github: 'github.com',
  youtube: 'youtube.com',
  twitter: 'twitter.com',
  x: 'x.com',
  reddit: 'reddit.com',
  google: 'google.com',
  gmail: 'mail.google.com',
  stackoverflow: 'stackoverflow.com',
  linkedin: 'linkedin.com',
  notion: 'notion.so',
  figma: 'figma.com',
};

// Handle unambiguous commands locally — no API call, no rate limit, instant.
// Returns an array of commands, or null when the request needs the LLM.
function findLocalCommands(prompt, tabs, groups) {
  const p = prompt.toLowerCase().trim().replace(/[.!]+$/, '');

  // "ungroup all" / "ungroup everything"
  if (/^ungroup\s+(all|everything)(\s+tabs)?$/.test(p)) {
    const ids = tabs.filter((t) => t.groupId != null).map((t) => t.id);
    return ids.length ? [{ action: 'ungroup', tabIds: ids }] : [];
  }

  // "close duplicates" / "remove duplicate tabs"
  if (/^(close|remove)\s+duplicated?s?(\s+tabs)?$/.test(p)) {
    // Compare full URLs (minus the #fragment) — trimUrl drops the query string,
    // which would treat ?v=AAA and ?v=BBB as the same page and close one of them.
    const seen = new Set();
    const dupes = [];
    for (const t of tabs) {
      const key = (t.url || '').split('#')[0];
      if (seen.has(key)) dupes.push(t.id);
      else seen.add(key);
    }
    return dupes.map((id) => ({ action: 'remove', tabId: id }));
  }

  // "group github tabs" — single site name only, so "group by topic" falls through
  const match = p.match(/^group\s+(?:all\s+)?([a-z0-9.-]+)\s+tabs$/);
  if (match && !['all', 'my', 'the', 'these', 'those'].includes(match[1])) {
    const term = match[1];
    const domain = KNOWN_DOMAINS[term] || term;
    const ids = tabs.filter((t) => hostMatches(hostnameOf(t.url), domain)).map((t) => t.id);
    if (!ids.length) return [];

    // Add to an existing group with the same name rather than creating a second one
    const existing = groups.find((g) => (g.title || '').toLowerCase() === term);
    if (existing) return [{ action: 'group', tabIds: ids, groupId: existing.id }];

    return [{ action: 'group', tabIds: ids, title: term.charAt(0).toUpperCase() + term.slice(1) }];
  }

  return null;
}

async function callGroq(apiKey, tabs, groups, userPrompt) {
  const tabInfo = tabs
    .map((t) => `ID:${t.id} | GroupID:${t.groupId ?? 'none'} | Title:${t.title.slice(0, 60)} | URL:${trimUrl(t.url)}`)
    .join('\n');
  const groupInfo = groups.length
    ? groups.map((g) => `GroupID:${g.id} | Title:${g.title}`).join('\n')
    : 'none';
  const userMessage = `Existing groups:\n${groupInfo}\n\nTabs:\n${tabInfo}\n\nUser Request: ${userPrompt}`;

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

      if (usedAI) {
        const apiKey = await getApiKey();
        if (!apiKey) {
          saveLastStatus('No API key — please set your Groq API key first');
          sendResponse({ ok: false, error: 'No API key set' });
          return;
        }
        const result = await callGroq(apiKey, tabData, groupData, prompt);
        commands = Array.isArray(result.commands) ? result.commands : [];
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
        saveLastStatus('Done: no actions to execute');
      }

      sendResponse({ ok: true, commandCount: succeeded });
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
