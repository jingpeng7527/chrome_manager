// Stress test: how opening the popup and running a model command hold up as
// the browser gets heavier, for two builds side by side.
//
//   npm run stress                                   # origin/main vs HEAD
//   BEFORE_REF=main AFTER_REF=HEAD npm run stress    # any two git refs
//   STRESS_TABS=1,50,200 STRESS_RUNS=6 npm run stress
//
// Writes e2e/results/stress-<time>.json and e2e/results/stress-report.html.
//
// Both builds are loaded into the SAME browser and their popups are opened in
// alternation, so they always see the same tabs, the same machine load and the
// same moment in time. Run to run noise in popup timing is large (see bench),
// and comparing two builds from two separate browser sessions mostly measures
// that noise.
//
// What is varied:
//   tabs     how many tabs are open (they are loaded once, then discarded so
//            hundreds fit in memory, which is also how Chrome keeps old tabs)
//   storage  "small" is a key and a status line; "large" adds ~4 MB of other
//            keys, the size an extension accumulates over months
//   busy     tabs stay loaded, each page runs a small timer and carries a
//            ~20 KB data: URL favicon, which chrome.tabs.query hands back in
//            full for every tab. A worst case, but web apps do this.
//   latency  Groq is replaced by a stub answering after a fixed delay, so the
//            model path measures this extension's own overhead around the
//            request, not Groq's mood that minute. No API key is needed.
//
// A third, blank extension whose popup is a single line of text is opened in
// the same rotation: it is what Chrome alone costs, the floor neither build
// can go under.
//
// Each build gets a probe script (stress-probe.js) inserted ahead of pop_up.js
// in its copy of pop_up.html. It only records when the tab count and the
// status line get filled in; both builds get the identical probe.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer } from 'node:http';

import { extensionId, launch, resolveBrowser } from './browser.mjs';
import { closeTarget, connect, evaluate, listTargets, openTarget } from './cdp.mjs';
import { renderReport } from './stress-report.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'e2e', 'results');
const PORT = 7802;

const list = (v, fallback) => (v ? v.split(',').map((x) => Number(x.trim())) : fallback);
const TAB_LEVELS = list(process.env.STRESS_TABS, [1, 50, 150, 300]);
const OPEN_RUNS = Number(process.env.STRESS_RUNS ?? 10);     // per build, per cell
const COMMAND_RUNS = Number(process.env.STRESS_COMMAND_RUNS ?? 3);
const LATENCIES = list(process.env.STRESS_LATENCIES, [0, 500, 2000, 5000]);
const SWEEP_LATENCY = 800;  // Groq's usual reply time for this prompt, roughly
const LATENCY_SWEEP_TABS = 50;
const FAVICON_KB = 20;
const SCENARIOS = [
  { scenario: 'small', storage: 'small', busy: false },
  { scenario: 'large', storage: 'large', busy: false },
  { scenario: 'busy', storage: 'small', busy: true },
];

const BUILDS = [
  { name: 'before', ref: process.env.BEFORE_REF ?? 'origin/main' },
  { name: 'after', ref: process.env.AFTER_REF ?? 'HEAD' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

// --- builds -----------------------------------------------------------------

const PROBE = `// Inserted by e2e/stress.mjs. Records when the popup's data arrives.
window.__probe = {};
(() => {
  const mark = (k) => { if (!(k in window.__probe)) window.__probe[k] = performance.now(); };
  new MutationObserver(() => {
    const tabs = document.getElementById('tabCount');
    if (tabs && /^\\d+ tabs/.test(tabs.textContent)) mark('tabs');
    const status = document.getElementById('statusText');
    if (status && status.textContent && status.textContent !== 'Ready') mark('status');
  }).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
})();
`;

function prepareBuild(build, workDir) {
  const dir = join(workDir, build.name);
  mkdirSync(dir, { recursive: true });
  const sha = git('rev-parse', '--short', build.ref);
  execFileSync('sh', ['-c', `git archive ${sha} chrome-manager-frontend | tar -x -C "${dir}"`], { cwd: ROOT });
  const ext = join(dir, 'chrome-manager-frontend');
  writeFileSync(join(ext, 'stress-probe.js'), PROBE);
  const html = join(ext, 'pop_up.html');
  const page = readFileSync(html, 'utf8');
  if (!page.includes('<script src="pop_up.js">')) throw new Error(`${build.ref}: pop_up.html has no pop_up.js script tag`);
  writeFileSync(html, page.replace('<script src="pop_up.js">', '<script src="stress-probe.js"></script>\n    <script src="pop_up.js">'));
  return { ...build, sha, subject: git('log', '-1', '--format=%s', sha), dir: ext, id: extensionId(ext) };
}

function prepareBlank(workDir) {
  const ext = join(workDir, 'blank');
  mkdirSync(ext, { recursive: true });
  writeFileSync(join(ext, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'Blank popup', version: '1',
    action: { default_popup: 'pop_up.html' }, background: { service_worker: 'bg.js' },
  }));
  writeFileSync(join(ext, 'bg.js'), '');
  writeFileSync(join(ext, 'stress-probe.js'), PROBE);
  writeFileSync(join(ext, 'fill.js'), `document.getElementById('tabCount').textContent = '0 tabs';
document.getElementById('statusText').textContent = 'blank';`);
  writeFileSync(join(ext, 'pop_up.html'), `<!doctype html><html><head><meta charset="utf-8"><script src="stress-probe.js"></script></head>
<body><span id="tabCount"></span> <span id="statusText"></span><script src="fill.js"></script></body></html>`);
  return { name: 'blank', ref: '(blank popup)', sha: '-', subject: 'Chrome alone: a popup with one line of text', dir: ext, id: extensionId(ext), blank: true };
}

// Pages for the tabs. Real hostnames per site so the extension's matching
// sees variety; long titles like real pages. Busy pages also run a timer and
// declare an inline favicon.
function startPages(port) {
  const icon = 'data:image/svg+xml;base64,' + Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg"><!--${'x'.repeat(FAVICON_KB * 750)}--></svg>`).toString('base64');
  const server = createServer((req, res) => {
    const busy = req.url.includes('busy');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><title>${req.headers.host} | A realistic page title of some length ${req.url}</title>`
      + (busy ? `<link rel="icon" href="${icon}">` : '')
      + '<body><p id="d">fixture</p>'
      + (busy ? `<script>setInterval(() => { const t = performance.now(); while (performance.now() - t < 1); d.textContent = t; }, 200);</script>` : ''));
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r({ close: () => server.close() })));
}

// --- browser helpers --------------------------------------------------------

async function waitFor(fn, { tries = 100, every = 50 } = {}) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(every);
  }
  return null;
}

const findTarget = async (pred) => (await listTargets()).find(pred);

async function workerOf(build) {
  const t = await waitFor(() => findTarget((x) => x.type === 'service_worker' && x.url.includes(build.id)), { tries: 60, every: 250 });
  if (!t) throw new Error(`${build.name}: service worker never started`);
  const cdp = connect(t.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  return cdp;
}

// A popup opened as a tab, for setup and for running commands. Opening the
// real popup is reserved for timing the open itself.
async function withPage(build, fn) {
  const target = await openTarget(`chrome-extension://${build.id}/pop_up.html`);
  const page = connect(target.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await waitFor(() => evaluate(page, 'document.readyState === "complete"').catch(() => false));
  try {
    return await fn(page);
  } finally {
    page.close();
    await closeTarget(target.id);
  }
}

async function setTabCount(build, n, busy = false) {
  return withPage(build, (page) => evaluate(page, `(async () => {
    const [win] = await chrome.windows.getAll({ windowTypes: ['normal'] });
    const tabs = await chrome.tabs.query({ windowId: win.id });
    const ours = tabs.filter((t) => t.url.includes('.test/'));
    const have = ours.length + 1;  // plus the starting about:blank tab
    if (have > ${n}) await chrome.tabs.remove(ours.slice(${n} - 1).map((t) => t.id));
    const created = [];
    for (let i = have; i < ${n}; i++) {
      const site = 'site' + (i % 24) + '.test';
      created.push(await chrome.tabs.create({ windowId: win.id, url: 'http://' + site + '/page-' + i + (${busy} ? '-busy' : ''), active: false }));
    }
    // Let them load so they carry real titles, then discard them.
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const now = await chrome.tabs.query({ windowId: win.id });
      if (now.every((t) => t.status === 'complete' || t.discarded)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!${busy}) for (const t of created) await chrome.tabs.discard(t.id).catch(() => {});
    // Not counting this setup page itself, which closes right after.
    return (await chrome.tabs.query({ windowId: win.id })).filter((t) => !t.url.startsWith('chrome-extension:')).length;
  })()`));
}

const LAST_STATUS = { text: 'Done: grouped 12 tabs into 3 groups', updatedAt: Date.now() };

async function setStorage(build, level) {
  await withPage(build, (page) => evaluate(page, `(async () => {
    await chrome.storage.local.clear();
    const data = { groqApiKey: 'gsk_stress_placeholder', lastStatus: ${JSON.stringify(LAST_STATUS)} };
    if (${JSON.stringify(level)} === 'large') {
      // 400 keys of 10 KB: history, caches, saved sessions.
      const blob = 'x'.repeat(10000);
      for (let i = 0; i < 400; i++) data['history-' + i] = { at: i, blob };
    }
    await chrome.storage.local.set(data);
    return chrome.storage.local.getBytesInUse(null);
  })()`));
}

// --- popup open -------------------------------------------------------------

// One real popup open: from chrome.action.openPopup() through to pixels and
// then to the data being filled in. Same method as bench.mjs, see there for
// why the popup's timeOrigin can be compared against Date.now().
async function openOnce(build, worker) {
  const t0 = Date.now();
  const result = await evaluate(worker, `chrome.action.openPopup().then(() => 'ok').catch((e) => e.message)`);
  if (result !== 'ok') return { error: result };

  const target = await waitFor(() => findTarget((t) => t.type === 'page' && t.url.includes(`${build.id}/pop_up.html`) && !t.url.includes('?tab')), { every: 10 });
  if (!target) return { error: 'popup target never appeared' };

  const popup = connect(target.webSocketDebuggerUrl);
  await popup.send('Runtime.enable');
  const m = await waitFor(() => evaluate(popup, `(() => {
    const p = window.__probe || {};
    const paint = performance.getEntriesByName('first-contentful-paint')[0];
    const nav = performance.getEntriesByType('navigation')[0];
    if (!paint || p.tabs == null || p.status == null) return null;
    return { origin: performance.timeOrigin, fcp: paint.startTime, load: nav.loadEventEnd, tabs: p.tabs, status: p.status };
  })()`).catch(() => null), { tries: 200, every: 25 });

  // How long Chrome takes to answer the popup's tab query, asked now that the
  // popup is idle. Its cost is what the "after" build moved off the open.
  const query = m ? await evaluate(popup, `(async () => {
    const t = performance.now();
    await chrome.tabs.query({ currentWindow: true });
    return performance.now() - t;
  })()`) : null;

  await evaluate(popup, 'window.close()').catch(() => {});
  popup.close();
  await waitFor(async () => !(await findTarget((t) => t.type === 'page' && t.url.includes(`${build.id}/pop_up.html`))), { every: 50 });
  await sleep(300);

  if (!m) return { error: 'probe never reported' };
  if (m.origin < t0) return { error: 'reused popup' };
  const r = (x) => Math.round(x);
  const window_ = m.origin - t0;
  return {
    window: r(window_),                 // Chrome building the popup window
    fcp: r(m.fcp),                      // popup page to first paint
    load: r(m.load),                    // popup page load event
    visible: r(window_ + m.fcp),        // click to pixels
    ready: r(window_ + Math.max(m.tabs, m.status)),  // click to data filled in
    query: r(query),
  };
}

async function measureOpens(builds, workers, cell, results) {
  for (let i = 0; i < OPEN_RUNS; i++) {
    // Alternate which build goes first so neither always pays for warming up.
    const order = i % 2 ? [...builds].reverse() : builds;
    for (const build of order) {
      const run = await openOnce(build, workers[build.name]);
      results.push({ kind: 'open', build: build.name, ...cell, run: i, ...run });
      if (run.error) console.log(`    ${build.name} run ${i}: ${run.error}`);
    }
  }
}

// --- model path with a stubbed Groq ----------------------------------------

function stubGroq(worker, state) {
  worker.on('Fetch.requestPaused', async (p) => {
    if (!p.request.url.startsWith('https://api.groq.com/')) {
      await worker.send('Fetch.continueRequest', { requestId: p.requestId });
      return;
    }
    let content = '{"commands": []}';
    try {
      const body = JSON.parse(p.request.postData ?? '{}');
      const user = body.messages?.[1]?.content ?? '';
      const n = (user.match(/^\d+\. /gm) ?? []).length;
      const topics = ['Docs', 'Code', 'Shopping', 'News', 'Mail'];
      const labels = {};
      for (let i = 1; i <= n; i++) labels[i] = topics[i % topics.length];
      content = JSON.stringify({ labels });
    } catch { /* fall through with no commands */ }
    const reply = JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] });
    await sleep(state.latency);
    await worker.send('Fetch.fulfillRequest', {
      requestId: p.requestId,
      responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      body: Buffer.from(reply).toString('base64'),
    });
  });
  return worker.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
}

async function commandOnce(build) {
  return withPage(build, async (page) => {
    const ms = await evaluate(page, `(async () => {
      const el = document.getElementById('statusText');
      const settled = () => /^(Done|Failed|Nothing|AI returned)/.test(el.textContent);
      // The popup shows the last status on open; start from a clean line.
      el.textContent = '';
      document.getElementById('userInput').value = 'group by topic';
      const t0 = performance.now();
      document.getElementById('sendBtn').click();
      while (!settled()) await new Promise((r) => setTimeout(r, 5));
      return Math.round(performance.now() - t0);
    })()`);
    const status = await evaluate(page, `document.getElementById('statusText').textContent`);
    await evaluate(page, `(async () => {
      const tabs = await chrome.tabs.query({});
      const ids = tabs.filter((t) => t.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE).map((t) => t.id);
      if (ids.length) await chrome.tabs.ungroup(ids);
    })()`);
    return { ms, status };
  });
}

async function measureCommands(builds, stubState, cell, results) {
  stubState.latency = cell.latency;
  for (let i = 0; i < COMMAND_RUNS; i++) {
    for (const build of builds) {
      const { ms, status } = await commandOnce(build);
      const ok = status.startsWith('Done');
      results.push({ kind: 'command', build: build.name, ...cell, run: i, total: ms, overhead: ms - cell.latency, ok, status: status.slice(0, 80) });
      if (!ok) console.log(`    ${build.name}: ${status.slice(0, 80)}`);
    }
  }
}

// --- main -------------------------------------------------------------------

const median = (xs) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

function summarize(results, builds, cell, fields) {
  for (const b of builds) {
    const rows = results.filter((r) => r.build === b.name && !r.error && Object.entries(cell).every(([k, v]) => r[k] === v));
    const parts = fields.map((f) => `${f} ${String(median(rows.map((r) => r[f]))).padStart(5)}`);
    console.log(`    ${b.name.padEnd(6)} ${parts.join('   ')}  (${rows.length} ok)`);
  }
}

const workDir = mkdtempSync(join(tmpdir(), 'chrome-manager-stress-'));
const results = [];
let fixtures;
let browser;
let builds;
const started = new Date();

try {
  builds = BUILDS.map((b) => prepareBuild(b, workDir));
  for (const b of builds) console.log(`${b.name.padEnd(6)} ${b.ref} @ ${b.sha}  ${b.subject}`);

  builds.push(prepareBlank(workDir));
  const real = builds.filter((b) => !b.blank);
  fixtures = await startPages(PORT);
  const binary = resolveBrowser();

  // Popup opens: every tab count, at both storage sizes. A fresh browser per
  // storage size, tabs added as the sweep goes up.
  for (const { scenario, storage, busy } of SCENARIOS) {
    const profileDir = mkdtempSync(join(workDir, 'profile-'));
    browser = await launch({
      binary, extensionDir: builds.map((b) => b.dir).join(','), profileDir, hosts: ['*.test'], port: PORT,
    });
    const workers = {};
    for (const b of builds) workers[b.name] = await workerOf(b);
    for (const b of real) await setStorage(b, storage);

    for (const tabs of TAB_LEVELS) {
      const actual = await setTabCount(builds[0], tabs, busy);
      console.log(`\npopup open  ${scenario}  tabs=${actual}`);
      await sleep(busy ? 3000 : 1000);
      const cell = { scenario, tabs };
      await measureOpens(builds, workers, cell, results);
      summarize(results.filter((r) => r.kind === 'open'), builds, cell, ['visible', 'ready', 'query']);
    }

    Object.values(workers).forEach((w) => w.close());
    browser.kill();
    browser = null;
    rmSync(profileDir, { recursive: true, force: true });
  }

  // Model path: overhead against tab count at a typical Groq latency, then
  // against latency at a typical tab count.
  {
    const profileDir = mkdtempSync(join(workDir, 'profile-'));
    browser = await launch({
      binary, extensionDir: real.map((b) => b.dir).join(','), profileDir, hosts: ['*.test'], port: PORT,
    });
    const stubState = { latency: 0 };
    const workers = [];
    for (const b of real) {
      const w = await workerOf(b);
      await stubGroq(w, stubState);
      workers.push(w);
      await setStorage(b, 'small');
    }

    for (const tabs of TAB_LEVELS) {
      const actual = await setTabCount(builds[0], tabs);
      console.log(`\nmodel command  tabs=${actual}  stub latency=${SWEEP_LATENCY} ms`);
      const cell = { sweep: 'tabs', tabs, latency: SWEEP_LATENCY };
      await measureCommands(real, stubState, cell, results);
      summarize(results.filter((r) => r.kind === 'command'), real, cell, ['total', 'overhead']);
    }

    await setTabCount(builds[0], LATENCY_SWEEP_TABS);
    for (const latency of LATENCIES) {
      console.log(`\nmodel command  tabs=${LATENCY_SWEEP_TABS}  stub latency=${latency} ms`);
      const cell = { sweep: 'latency', tabs: LATENCY_SWEEP_TABS, latency };
      await measureCommands(real, stubState, cell, results);
      summarize(results.filter((r) => r.kind === 'command'), real, cell, ['total', 'overhead']);
    }

    workers.forEach((w) => w.close());
  }
} finally {
  browser?.kill();
  fixtures?.close();
  rmSync(workDir, { recursive: true, force: true });
}

const run = {
  startedAt: started.toISOString(),
  finishedAt: new Date().toISOString(),
  machine: { platform: process.platform, arch: process.arch, cpus: (await import('node:os')).cpus().length },
  browser: resolveBrowser(),
  config: { TAB_LEVELS, OPEN_RUNS, COMMAND_RUNS, LATENCIES, SWEEP_LATENCY, LATENCY_SWEEP_TABS, SCENARIOS, FAVICON_KB },
  builds: builds.map(({ name, ref, sha, subject }) => ({ name, ref, sha, subject })),
  results,
};

mkdirSync(OUT_DIR, { recursive: true });
const stamp = started.toISOString().replace(/[:.]/g, '-').slice(0, 19);
const jsonPath = join(OUT_DIR, `stress-${stamp}.json`);
writeFileSync(jsonPath, JSON.stringify(run, null, 2));
const htmlPath = join(OUT_DIR, 'stress-report.html');
writeFileSync(htmlPath, renderReport(run));
console.log(`\nresults: ${jsonPath}\nreport:  ${htmlPath}`);
process.exit(0);
