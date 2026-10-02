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

// How long the popup takes to appear after the toolbar icon is clicked. This
// is measured separately from command latency on purpose: a change can make
// commands faster while making every single open slower, which is a bad trade
// and easy to miss if only commands are timed.
async function reportOpen() {
  const paints = [];
  const loads = [];

  for (let i = 0; i < RUNS + 2; i++) {
    const target = await openTarget(`chrome-extension://${EXT_ID}/pop_up.html`);
    const popup = connect(target.webSocketDebuggerUrl);
    await popup.send('Runtime.enable');
    await sleep(600);
    const m = await evaluate(popup, `(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      const paint = performance.getEntriesByName('first-contentful-paint')[0];
      return { fcp: paint ? Math.round(paint.startTime) : null, dcl: Math.round(nav.domContentLoadedEventEnd) };
    })()`);
    if (m.fcp != null) paints.push(m.fcp);
    loads.push(m.dcl);
    popup.close();
    await closeTarget(target.id);
    await sleep(250);
  }

  console.log(`  first contentful paint : ${String(median(paints)).padStart(6)} ms   ${JSON.stringify(paints)}`);
  console.log(`  DOMContentLoaded       : ${String(median(loads)).padStart(6)} ms   ${JSON.stringify(loads)}\n`);
  return median(paints);
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

  console.log('\nopening the popup\n');
  const open = await reportOpen();

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
