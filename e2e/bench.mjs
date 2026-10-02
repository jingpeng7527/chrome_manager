// Measures how long commands actually take, in a real browser, with the
// service worker cold — the state a click lands in after a pause.
//
//   npm run bench
//   GROQ_API_KEY=gsk_... npm run bench     # also measures the model path
//
// The model path needs a key because that request is the thing worth timing:
// everything this extension controls is a few milliseconds, and the wait is
// Groq's.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extensionId, launch, resolveBrowser, startFixtureServer } from './browser.mjs';
import { closeTarget, connect, evaluate, listTargets, openTarget } from './cdp.mjs';

const EXT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'chrome-manager-frontend');
const EXT_ID = extensionId(EXT_DIR);
const PORT = 7801;
const HOSTS = ['docs.stripe.com', 'github.com', 'example.com'];
const RUNS = 3;
const OPEN_RUNS = 12;   // opening is noisy; the median needs samples

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const workerAlive = async () =>
  (await listTargets()).some((t) => t.type === 'service_worker' && t.url.includes(EXT_ID));

async function withPopup(fn) {
  const target = await openTarget(`chrome-extension://${EXT_ID}/pop_up.html`);
  const popup = connect(target.webSocketDebuggerUrl);
  await popup.send('Runtime.enable');
  await sleep(900);
  try {
    return await fn(popup);
  } finally {
    popup.close();
    await closeTarget(target.id);
  }
}

// Times a click through to the status line settling, which is what a user
// actually waits for.
async function timeCommand(command) {
  // Cold every run: wait for Chrome to shut the worker down first.
  for (let i = 0; i < 40 && (await workerAlive()); i++) await sleep(3000);

  return withPopup(async (popup) => {
    const ms = await evaluate(popup, `(async () => {
      const el = document.getElementById('statusText');
      const settled = () => /^(Done|Failed|Nothing|AI returned)/.test(el.textContent);
      document.getElementById('userInput').value = ${JSON.stringify(command)};
      const t0 = performance.now();
      document.getElementById('sendBtn').click();
      while (!settled()) await new Promise((r) => setTimeout(r, 5));
      return Math.round(performance.now() - t0);
    })()`);
    const status = await evaluate(popup, `document.getElementById('statusText').textContent`);
    await evaluate(popup, `(async () => {
      const tabs = await chrome.tabs.query({});
      const ids = tabs.filter((t) => t.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE).map((t) => t.id);
      if (ids.length) await chrome.tabs.ungroup(ids);
    })()`);
    return { ms, status };
  });
}

// Times the real popup, from the click through to pixels.
//
// Opening pop_up.html as a tab measures the wrong thing: it skips Chrome
// constructing the popup window, which turns out to be most of the wait.
// chrome.action.openPopup() makes Chrome build the genuine popup instead.
//
// timeOrigin and Date.now() are both epoch milliseconds, so the gap between
// the call and the popup's own timeline start is the construction, and FCP on
// top of it is the render.
async function reportOpen(worker) {
  const constructs = [];
  const paints = [];

  for (let i = 0; i < OPEN_RUNS; i++) {
    const t0 = Date.now();
    await evaluate(worker, `chrome.action.openPopup().then(() => 'ok').catch((e) => e.message)`);

    let target;
    for (let w = 0; w < 100 && !target; w++) {
      target = (await listTargets()).find((t) => t.type === 'page' && t.url.includes(`${EXT_ID}/pop_up.html`));
      if (!target) await sleep(20);
    }
    if (!target) continue;

    const popup = connect(target.webSocketDebuggerUrl);
    await popup.send('Runtime.enable');
    await sleep(400);
    const m = await evaluate(popup, `(() => {
      const paint = performance.getEntriesByName('first-contentful-paint')[0];
      return { origin: performance.timeOrigin, fcp: paint ? paint.startTime : null };
    })()`);

    // A popup Chrome reused carries the previous run's timeline, so its origin
    // predates this run. Discard it rather than record the wrong thing.
    if (m.origin >= t0 && m.fcp != null) {
      constructs.push(Math.round(m.origin - t0));
      paints.push(Math.round(m.fcp));
    }

    // An extension popup is not a window chrome.windows will remove; it has to
    // close itself.
    await evaluate(popup, 'window.close()').catch(() => {});
    popup.close();
    for (let w = 0; w < 50; w++) {
      const open = (await listTargets()).some((t) => t.type === 'page' && t.url.includes(`${EXT_ID}/pop_up.html`));
      if (!open) break;
      await sleep(100);
    }
    await sleep(400);
  }

  if (!constructs.length) {
    console.log('  no valid runs — every popup was reused\n');
    return null;
  }

  const totals = constructs.map((c, i) => c + paints[i]);
  console.log(`  counted                : ${constructs.length}/${OPEN_RUNS} runs`);
  console.log('  (noisy: the same build measures anywhere from ~300 to ~1000 ms');
  console.log('   run to run. Read the split, not the absolute number.)');
  console.log(`  Chrome builds the window:${String(median(constructs)).padStart(6)} ms   ${JSON.stringify(constructs)}`);
  console.log(`  this extension renders  :${String(median(paints)).padStart(6)} ms   ${JSON.stringify(paints)}`);
  console.log(`  TOTAL click -> pixels   :${String(median(totals)).padStart(6)} ms\n`);
  return median(totals);
}

async function report(label, command) {
  const results = [];
  for (let i = 0; i < RUNS; i++) {
    const { ms, status } = await timeCommand(command);
    results.push(ms);
    console.log(`  ${label} run ${i + 1}: ${String(ms).padStart(6)} ms   ${status.slice(0, 54)}`);
  }
  console.log(`  ${label} median : ${String(median(results)).padStart(6)} ms\n`);
  return median(results);
}

const profileDir = mkdtempSync(join(tmpdir(), 'chrome-manager-bench-'));
let fixtures;
let browser;

try {
  fixtures = await startFixtureServer(PORT);
  browser = await launch({
    binary: resolveBrowser(), extensionDir: EXT_DIR, profileDir, hosts: HOSTS, port: PORT,
  });
  await sleep(2000);

  console.log('\nopening the popup\n');
  const workerTarget = (await listTargets()).find((t) => t.type === 'service_worker' && t.url.includes(EXT_ID));
  const worker = connect(workerTarget.webSocketDebuggerUrl);
  await worker.send('Runtime.enable');
  const open = await reportOpen(worker);
  worker.close();

  await withPopup(async (popup) => {
    await evaluate(popup, `(async () => {
      for (const url of ['http://docs.stripe.com/a', 'http://docs.stripe.com/b', 'http://github.com/c'])
        await chrome.tabs.create({ url, active: false });
    })()`);
  });
  await sleep(2000);

  const key = process.env.GROQ_API_KEY;
  if (key) {
    await withPopup(async (popup) => {
      await evaluate(popup, `new Promise((r) => chrome.storage.local.set({ groqApiKey: ${JSON.stringify(key)} }, r))`);
    });
  }

  console.log('cold service worker, time from click to the status settling\n');
  const local = await report('local  ', 'group stripe');

  if (key) {
    const model = await report('model  ', 'group by topic');
    console.log('summary');
    console.log(`  popup opens    : ${open} ms`);
    console.log(`  local command  : ${local} ms`);
    console.log(`  model command  : ${model} ms`);
    console.log(`  cost of the model: ${model - local} ms of the wait is Groq`);
  } else {
    console.log('summary');
    console.log(`  popup opens    : ${open} ms`);
    console.log(`  local command  : ${local} ms`);
    console.log('  model command  : skipped — set GROQ_API_KEY to measure it');
  }
} finally {
  browser?.kill();
  fixtures?.close();
  rmSync(profileDir, { recursive: true, force: true });
}

process.exit(0);
