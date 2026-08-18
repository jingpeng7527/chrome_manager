const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'openai/gpt-oss-120b';
const REQUEST_TIMEOUT_MS = 30000;

// Plain domain matching ("group stripe") is handled locally and never reaches
// the model, so this prompt covers only requests needing judgement — which are
// exactly the ones that must read page titles, not just URLs.
const SYSTEM_PROMPT =
  'You organize Chrome tabs. Reply with a JSON object: {"commands": [...]}.\n' +
  'Commands:\n' +
  '  {"action":"group","tabIds":[1,2],"title":"Short Name"}\n' +
  '  {"action":"group","tabIds":[1,2],"groupId":7}   // add to an existing group\n' +
  '  {"action":"ungroup","tabIds":[1,2]}             // leaves the tabs open\n' +
  '  {"action":"remove","tabId":1}\n' +
  '  {"action":"duplicate","tabId":1}\n' +
  'To group by topic or theme, read each tab\'s title AND url to work out what ' +
  'it is about, then emit one group command per theme. Aim for 2-5 groups, each ' +
  'holding at least 2 tabs, each titled in 1-2 words. Leave tabs that fit no ' +
  'theme ungrouped rather than forcing them together.\n' +
  'Only use tabIds from the list you are given. Prefer adding to an existing ' +
  'group over creating a second group with the same name. Return ' +
  '{"commands": []} only when nothing sensible applies.\n' +
  'Output JSON only — no prose, no markdown fences.';

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

// A site name on its own, optionally wrapped in filler: the trailing "tabs" is
// optional so plain "group stripe" works, and multi-word phrases never match.
const SITE_RE = /^(?:all\s+|the\s+|my\s+)?([a-z0-9.-]+)(?:\s+(?:tabs?|pages?))?$/;
const NOT_A_SITE = ['all', 'the', 'my', 'these', 'those', 'everything', 'them', 'tab', 'tabs', 'page', 'pages', 'by'];

function siteTerm(rest) {
  if (rest == null) return null;
  const m = rest.trim().match(SITE_RE);
  return m && !NOT_A_SITE.includes(m[1]) ? m[1] : null;
}

function tabsMatching(tabs, term) {
  const domain = KNOWN_DOMAINS[term] || term;
  return tabs.filter((t) => hostMatches(hostnameOf(t.url), domain)).map((t) => t.id);
}

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

  // "stripe", "all stripe tabs", "my github pages" -> "stripe" / "github".
  // Multi-word phrases like "by topic" never match, so they fall through to the LLM.
  const term = siteTerm(p.startsWith('group ') ? p.slice(6) : null);
  if (term) {
    const ids = tabsMatching(tabs, term);
    if (!ids.length) return null; // probably a topic, not a site — let the LLM try

    // Add to an existing group with the same name rather than creating a second one
    const existing = groups.find((g) => (g.title || '').toLowerCase() === term);
    if (existing) return [{ action: 'group', tabIds: ids, groupId: existing.id }];

    return [{ action: 'group', tabIds: ids, title: term.charAt(0).toUpperCase() + term.slice(1) }];
  }

  const ungroupTerm = siteTerm(p.startsWith('ungroup ') ? p.slice(8) : null);
  if (ungroupTerm) {
    const ids = tabsMatching(tabs, ungroupTerm).filter(
      (id) => tabs.find((t) => t.id === id)?.groupId != null
    );
    if (!ids.length) return null;
    return [{ action: 'ungroup', tabIds: ids }];
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
  const text = data.choices?.[0]?.message?.content || '';
  return parseCommands(text);
}

// Reasoning models sometimes fence the JSON or put a sentence in front of it,
// so pull out the outermost {...} rather than parsing the reply whole.
function parseCommands(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return [];
  const obj = JSON.parse(text.slice(start, end + 1));
  return Array.isArray(obj.commands) ? obj.commands : [];
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
        commands = await callGroq(apiKey, tabData, groupData, prompt);
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
        saveLastStatus(usedAI ? 'AI returned no actions — try rewording' : 'Nothing to do');
      }

      sendResponse({ ok: true, commandCount: succeeded, usedAI });
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
