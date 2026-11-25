// How long a group command takes as the number of open tabs grows.
//
//   npm run group-time
//   GROUP_TABS=1,50,100,300 GROUP_RUNS=5 npm run group-time
//
// For each tab count it times, from clicking Send to the status line showing
// Done:
//   group <site>    the local path, no model involved
//   group by topic  the model path, with Groq stubbed over CDP to answer at
//                   once with a label for every tab, so what is left is this
//                   extension's own work plus Chrome's
//
// Tabs are spread over five hostnames, so one site has about a fifth of them.
// Every hostname resolves to a local fixture server; nothing leaves the
// machine and no API key is needed. Everything is ungrouped between runs.
//
// It also times the two Chrome calls a command is made of, on their own: the
// tab query and moving tabs into a group. That shows where the time goes.

import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extensionId, launch, resolveBrowser } from './browser.mjs';
import { closeTarget, connect, evaluate, listTargets, openTarget } from './cdp.mjs';

const PORT = 7803;
const list = (v, fallback) => (v ? v.split(',').map((x) => Number(x.trim())) : fallback);
const TAB_LEVELS = list(process.env.GROUP_TABS, [1, 50, 100, 300]);
const RUNS = Number(process.env.GROUP_RUNS ?? 5);
const SITES = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

async function waitFor(fn, { tries = 100, every = 50 } = {}) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(every);
  }
  return null;
}

function startPages(port) {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><title>${req.headers.host} | A realistic page title of some length ${req.url}</title><body>fixture</body>`);
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r({ close: () => server.close() })));
}

// The popup page opened as a tab, to drive commands from.
async function withPage(id, fn) {
  const target = await openTarget(`chrome-extension://${id}/pop_up.html`);
  const page = connect(target.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  const ready = await waitFor(() => evaluate(page,
    `location.protocol === 'chrome-extension:' && document.readyState === 'complete'`).catch(() => false));
  if (!ready) throw new Error(`${target.url} never finished loading`);
  try {
    return await fn(page);
  } finally {
    page.close();
    await closeTarget(target.id);
  }
}

// Opens tabs up to n in the first window, lets them load so they carry
// titles, then discards them so hundreds fit. The starting about:blank tab
// becomes the first site tab.
function setTabCount(page, n) {
  return evaluate(page, `(async () => {
    const [win] = await chrome.windows.getAll({ windowTypes: ['normal'] });
    const all = await chrome.tabs.query({ windowId: win.id });
    const blank = all.find((t) => t.url === 'about:blank');
    if (blank) await chrome.tabs.update(blank.id, { url: 'http://site0.test/page-0' });
    const ours = all.filter((t) => t.url.includes('.test/') || t === blank);
    const created = [];
    for (let i = ours.length; i < ${n}; i++) {
      const site = 'site' + (i % ${SITES}) + '.test';
      created.push(await chrome.tabs.create({ windowId: win.id, url: 'http://' + site + '/page-' + i, active: false }));
    }
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const now = await chrome.tabs.query({ windowId: win.id });
      if (now.every((t) => t.status === 'complete' || t.discarded)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    for (const t of created) await chrome.tabs.discard(t.id).catch(() => {});
    return (await chrome.tabs.query({ windowId: win.id })).filter((t) => !t.url.startsWith('chrome-extension:')).length;
  })()`);
}

const UNGROUP_ALL = `(async () => {
  const ids = (await chrome.tabs.query({})).filter((t) => t.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE).map((t) => t.id);
  if (ids.length) await chrome.tabs.ungroup(ids);
  return (await chrome.tabGroups.query({})).length;
})()`;

// Groq answers at once with a label for every tab in the request, 1..N: one
// topic per site, so each site becomes a group. The driving page itself (a
// chrome-extension: tab) joins the first one, so even one site tab makes a group.
function stubGroq(worker) {
  worker.on('Fetch.requestPaused', async (p) => {
    if (!p.request.url.startsWith('https://api.groq.com/')) {
      await worker.send('Fetch.continueRequest', { requestId: p.requestId });
      return;
    }
    const body = JSON.parse(p.request.postData ?? '{}');
    const user = body.messages?.[1]?.content ?? '';
    const topics = ['Docs', 'Code', 'Shopping', 'News', 'Mail'];
    const labels = {};
    for (const line of user.match(/^\d+\. .*$/gm) ?? []) {
      const site = Number(line.match(/site(\d+)\.test/)?.[1] ?? 0);
      labels[parseInt(line, 10)] = topics[site % topics.length];
    }
    const reply = JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ labels }) } }] });
    await worker.send('Fetch.fulfillRequest', {
      requestId: p.requestId,
      responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      body: Buffer.from(reply).toString('base64'),
    });
  });
  return worker.send('Fetch.enable', { patterns: [{ urlPattern: 'https://api.groq.com/*', requestStage: 'Request' }] });
}

// The worker logs {totalMs, apiMs} for every model command; apiMs is the time
// spent on the (stubbed) request, which the table leaves out.
function watchTiming(worker) {
  const seen = [];
  worker.on('Runtime.consoleAPICalled', (p) => {
    const [a, b] = p.args ?? [];
    if (a?.value === 'timing' && typeof b?.value === 'string') seen.push(JSON.parse(b.value));
  });
  return seen;
}

async function commandOnce(page, command) {
  const ms = await evaluate(page, `(async () => {
    const el = document.getElementById('statusText');
    const settled = () => /^(Done|Failed|Nothing|AI returned|No API key)/.test(el.textContent);
    el.textContent = '';
    document.getElementById('userInput').value = ${JSON.stringify(command)};
    const t0 = performance.now();
    document.getElementById('sendBtn').click();
    while (!settled()) await new Promise((r) => setTimeout(r, 2));
    return performance.now() - t0;
  })()`);
  const status = await evaluate(page, `document.getElementById('statusText').textContent`);
  const groups = await evaluate(page, `chrome.tabGroups.query({}).then((g) => g.length)`);
  const left = await evaluate(page, UNGROUP_ALL);
  if (left) throw new Error(`${left} groups left after ungrouping`);
  // A success is "Done — N action(s) …" with N > 0, never "N succeeded, M failed".
  const ok = /^Done — [1-9]\d* action\(s\)/.test(status) && groups > 0;
  return { ms, status, groups, ok };
}

// The two Chrome calls on their own: reading the tabs, and grouping one site.
function chromeCalls(page) {
  return evaluate(page, `(async () => {
    let t = performance.now();
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const query = performance.now() - t;
    const ids = tabs.filter((x) => (x.url || '').includes('site0.test')).map((x) => x.id);
    if (!ids.length) return { query, group: null, size: 0 };
    t = performance.now();
    const g = await chrome.tabs.group({ tabIds: ids });
    await chrome.tabGroups.update(g, { title: 'Site0' });
    const group = performance.now() - t;
    await chrome.tabs.ungroup(ids);
    return { query, group, size: ids.length };
  })()`);
}

const workDir = realpathSync(mkdtempSync(join(tmpdir(), 'chrome-manager-group-time-')));
const extDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'chrome-manager-frontend');
const id = extensionId(extDir);
let fixtures;
let browser;
const rows = [];
let failures = 0;

try {
  fixtures = await startPages(PORT);
  browser = await launch({
    binary: resolveBrowser(), extensionDir: extDir, profileDir: join(workDir, 'profile'),
    hosts: ['*.test'], port: PORT,
  });
  const wt = await waitFor(async () => (await listTargets()).find((t) => t.type === 'service_worker' && t.url.includes(id)), { tries: 120, every: 250 });
  if (!wt) throw new Error('service worker never started');
  const worker = connect(wt.webSocketDebuggerUrl);
  await worker.send('Runtime.enable');
  const timing = watchTiming(worker);
  await stubGroq(worker);
  await withPage(id, (page) => evaluate(page, `chrome.storage.local.set({ groqApiKey: 'gsk_group_time_placeholder' })`));

  for (const n of TAB_LEVELS) {
    // In steps, so each call stays well inside the DevTools reply timeout.
    let actual = 0;
    for (let step = 50; actual < n; step += 50) actual = await withPage(id, (page) => setTabCount(page, Math.min(step, n)));
    await sleep(5000);  // let Chrome settle after opening and discarding
    const row = { tabs: actual, local: [], topic: [], api: [], worker: [], query: [], group: [], groupSize: 0 };

    await withPage(id, async (page) => {
      for (let i = 0; i < RUNS; i++) {
        const local = await commandOnce(page, 'group site0');
        const seenBefore = timing.length;
        const topic = await commandOnce(page, 'group by topic');
        const t = await waitFor(() => timing[seenBefore], { tries: 40, every: 25 });
        for (const [name, r] of [['local', local], ['topic', topic]]) {
          if (!r.ok) { failures++; console.log(`  tabs=${actual} ${name} run ${i}: NOT OK: ${r.status.slice(0, 100)}`); }
        }
        row.local.push(local.ms);
        row.topic.push(topic.ms - (t?.apiMs ?? 0));
        row.api.push(t?.apiMs ?? null);
        row.worker.push(t ? t.totalMs - t.apiMs : null);
        const c = await chromeCalls(page);
        row.query.push(c.query);
        row.group.push(c.group);
        row.groupSize = c.size;
      }
    });

    const m = (xs) => median(xs);
    const f = (x) => (x == null ? '   -' : String(Math.round(x)).padStart(5));
    console.log(`tabs=${String(actual).padStart(3)}  group <site> ${f(m(row.local))} ms   group by topic ${f(m(row.topic))} ms (stub ${f(m(row.api))} ms excluded)`
      + `   tabs.query ${f(m(row.query))} ms   tabs.group of ${row.groupSize} ${f(m(row.group))} ms`);
    console.log(`          raw local ${JSON.stringify(row.local.map(Math.round))}  raw topic ${JSON.stringify(row.topic.map(Math.round))}  in the worker ${JSON.stringify(row.worker)}`);
    rows.push({ ...row, median: { local: m(row.local), topic: m(row.topic), api: m(row.api), query: m(row.query), group: m(row.group) } });
  }
  worker.close();
} finally {
  browser?.kill();
  fixtures?.close();
  rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

console.log('\n| Open tabs | `group <site>` | `group by topic` |\n|---:|---:|---:|');
for (const r of rows) console.log(`| ${r.tabs} | ${(r.median.local / 1000).toFixed(2)} s | ${(r.median.topic / 1000).toFixed(2)} s |`);
if (failures) {
  console.log(`\n${failures} run(s) did not end in a successful Done`);
  process.exit(1);
}
process.exit(0);
