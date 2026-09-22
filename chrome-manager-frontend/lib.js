// Pure tab-manipulation logic, free of Chrome and network APIs so it can be
// unit tested with plain node. background.js holds everything that touches
// chrome.* or fetch.

export function trimUrl(url) {
  try {
    const u = new URL(url);
    // Non-special schemes (chrome:, about:) have no origin — URL reports the
    // literal string "null" — so every chrome:// tab would otherwise be shown
    // to the model as "null" and look identical to every other one.
    const base = u.origin === 'null'
      ? u.protocol + (u.host ? '//' + u.host : '')
      : u.origin;
    return base + u.pathname.slice(0, 60);
  } catch { return String(url ?? '').slice(0, 80); }
}

function hostnameOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

// A bare term ("figma") matches any hostname label; a full domain ("x.com")
// must match the hostname exactly or as a suffix, so netflix.com != x.com.
export function hostMatches(hostname, target) {
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

export function siteTerm(rest) {
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
export function findLocalCommands(prompt, tabs, groups) {
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

// Reasoning models fence their JSON or put a sentence in front of it, and they
// don't always use the key we asked for — so extract the outermost JSON value
// and accept any of the shapes a model plausibly returns.
export function parseCommands(text) {
  const start = text.search(/[{[]/);
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (start === -1 || end <= start) return [];

  let value;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }

  if (Array.isArray(value)) return value;
  for (const key of ['commands', 'actions', 'result']) {
    if (Array.isArray(value?.[key])) return value[key];
  }
  return [];
}

// Chrome tab ids are 10 digits long, and models emit them unreliably — they
// run several together into one number with no commas, which then refers to no
// real tab. So the model only ever sees 1..N, and we map back here.
export function resolveIndexes(commands, tabs, groups) {
  const tabId = (n) => tabs[Number(n) - 1]?.id;
  const out = [];

  for (const c of commands) {
    const action = c?.action ?? c?.command;

    if (action === 'group' || action === 'ungroup') {
      const ids = (Array.isArray(c.tabIds) ? c.tabIds : [])
        .map(tabId)
        .filter((id) => id != null);
      if (!ids.length) continue;

      if (action === 'ungroup') {
        out.push({ action, tabIds: ids });
        continue;
      }

      const target = groups[Number(c.groupId) - 1];
      out.push(c.groupId != null && target
        ? { action, tabIds: ids, groupId: target.id }
        : { action, tabIds: ids, title: c.title || 'Group' });
    } else if (action === 'remove' || action === 'duplicate') {
      const id = tabId(c.tabId);
      if (id != null) out.push({ action, tabId: id });
    }
  }

  return out;
}

export function parseLabels(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  let value;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }

  const obj = value && typeof value.labels === 'object' && value.labels ? value.labels : value;
  return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
}

// Bucket tabs by the label the model gave them. The code owns which tabs end
// up together, so a mislabelled tab can only ever move itself.
export function commandsFromLabels(labels, tabs, groups) {
  const buckets = new Map();

  for (const [key, value] of Object.entries(labels ?? {})) {
    const tab = tabs[Number(key) - 1];
    const label = String(value ?? '').trim();
    if (!tab || !label || label.toLowerCase() === 'none') continue;

    const bucket = label.toLowerCase();
    if (!buckets.has(bucket)) buckets.set(bucket, { title: label, ids: [] });
    buckets.get(bucket).ids.push(tab.id);
  }

  const commands = [];
  for (const { title, ids } of buckets.values()) {
    if (ids.length < 2) continue; // a lone tab is not a group
    const existing = groups.find((g) => (g.title || '').toLowerCase() === title.toLowerCase());
    commands.push(existing
      ? { action: 'group', tabIds: ids, groupId: existing.id }
      : { action: 'group', tabIds: ids, title });
  }
  return commands;
}

// Grouping requests go through labelling; anything else still asks for commands.
export function isGroupingRequest(prompt) {
  return /\b(group|organi[sz]e|sort|categor|tidy|clean\s*up)\b/i.test(prompt);
}

// Tabs and groups are presented to the model as 1..N, never as Chrome ids.
export function buildUserMessage(tabs, groups, userPrompt) {
  const groupIndex = new Map(groups.map((g, i) => [g.id, i + 1]));
  const tabInfo = tabs
    .map((t, i) => {
      const inGroup = groupIndex.has(t.groupId) ? ` [group ${groupIndex.get(t.groupId)}]` : '';
      return `${i + 1}. ${(t.title || '').slice(0, 60)} — ${trimUrl(t.url)}${inGroup}`;
    })
    .join('\n');
  const groupInfo = groups.length
    ? groups.map((g, i) => `${i + 1}. ${g.title || '(untitled)'}`).join('\n')
    : 'none';

  return `Existing groups:\n${groupInfo}\n\nTabs:\n${tabInfo}\n\nUser Request: ${userPrompt}`;
}
