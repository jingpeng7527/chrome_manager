// End-to-end check: loads the real extension in a real browser and drives it.
//
// Covers what the unit tests cannot — that Chrome actually starts the ES-module
// service worker and popup, that commands produce real tab groups, and that a
// command needing no model runs without waking the service worker.
//
// Not part of `npm test`: it needs a browser download. Run it with `npm run e2e`.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extensionId, launch, resolveBrowser, startFixtureServer } from './browser.mjs';
import { closeTarget, connect, evaluate, exceptionsOf, listTargets, openTarget } from './cdp.mjs';

const EXT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'chrome-manager-frontend');
const EXT_ID = extensionId(EXT_DIR);
const PORT = 7801;
const HOSTS = ['docs.stripe.com', 'github.com', 'example.com'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ExtensionDidNotLoad extends Error {}

let passed = 0;
let failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
}

const workerAlive = async () =>
  (await listTargets()).some((t) => t.type === 'service_worker' && t.url.includes(EXT_ID));

// Opens the popup, runs one command, and reports what happened. Deliberately
// never attaches to the service worker: attaching keeps it alive, which would
// invalidate every measurement of whether a command woke it.
async function runCommand(command) {
  const target = await openTarget(`chrome-extension://${EXT_ID}/pop_up.html`);
  const popup = connect(target.webSocketDebuggerUrl);
  await popup.send('Runtime.enable');
  await sleep(1200);

  const loaded = await evaluate(popup, `({
    url: location.href,
    rendered: !!document.getElementById('sendBtn'),
  })`);

  await evaluate(popup, `(async () => {
    document.getElementById('userInput').value = ${JSON.stringify(command)};
    document.getElementById('sendBtn').click();
    await new Promise((r) => setTimeout(r, 1500));
  })()`);

  const status = await evaluate(popup, `document.getElementById('statusText').textContent`);
  const groups = await evaluate(popup, `(async () => {
    const gs = await chrome.tabGroups.query({});
    const out = [];
    for (const g of gs) {
      const tabs = await chrome.tabs.query({ groupId: g.id });
      out.push({ title: g.title, urls: tabs.map((t) => t.url) });
    }
    return out;
  })()`);

  const woke = await workerAlive();
  const errors = exceptionsOf(popup);
  popup.close();
  await closeTarget(target.id);
  return { loaded, status, groups, woke, errors };
}

const profileDir = mkdtempSync(join(tmpdir(), 'chrome-manager-e2e-'));
let fixtures;
let browser;

try {
  const binary = resolveBrowser();
  fixtures = await startFixtureServer(PORT);
  browser = await launch({ binary, extensionDir: EXT_DIR, profileDir, hosts: HOSTS, port: PORT });
  await sleep(2000);

  console.log('\nextension loads in a real browser');
  const workerTarget = (await listTargets()).find((t) => t.type === 'service_worker' && t.url.includes(EXT_ID));
  check('service worker starts', !!workerTarget, `no service_worker target for ${EXT_ID}`);
  if (!workerTarget) {
    // Everything below drives the extension, so there is nothing left to learn.
    // Report cleanly rather than crashing on a missing target.
    console.log('  .... the extension did not load; skipping the rest');
    throw new ExtensionDidNotLoad();
  }

  const worker = connect(workerTarget.webSocketDebuggerUrl);
  await worker.send('Runtime.enable');
  await sleep(500);
  check('service worker raises no exceptions', exceptionsOf(worker).length === 0, exceptionsOf(worker).join('; '));

  await evaluate(worker, `(async () => {
    for (const url of ['http://docs.stripe.com/api', 'http://docs.stripe.com/pay',
                       'http://github.com/a', 'http://example.com/dup', 'http://example.com/dup'])
      await chrome.tabs.create({ url, active: false });
  })()`);
  await sleep(2500);
  worker.close();

  console.log('\ncommands produce real tab groups');
  const grouped = await runCommand('group stripe');
  check('popup loads at its extension URL', grouped.loaded.url.startsWith(`chrome-extension://${EXT_ID}`), grouped.loaded.url);
  check('popup renders', grouped.loaded.rendered);
  check('popup raises no exceptions', grouped.errors.length === 0, grouped.errors.join('; '));

  const stripe = grouped.groups.find((g) => g.title === 'Stripe');
  check('a group named Stripe exists', !!stripe, JSON.stringify(grouped.groups));
  check('it holds both stripe tabs', stripe?.urls.length === 2, JSON.stringify(stripe?.urls));
  check('it excludes unrelated tabs',
    !!stripe && stripe.urls.every((u) => u.includes('docs.stripe.com')),
    JSON.stringify(stripe?.urls));

  console.log('\na command needing no model does not wake the service worker');
  process.stdout.write('  (waiting for Chrome to shut the idle worker down)');
  for (let i = 0; i < 40 && (await workerAlive()); i++) {
    process.stdout.write('.');
    await sleep(3000);
  }
  console.log('');
  check('worker is idle before the test', !(await workerAlive()));

  const local = await runCommand('ungroup all');
  check('local command succeeds', local.status.startsWith('Done'), local.status);
  check('local command leaves no groups', local.groups.length === 0, JSON.stringify(local.groups));
  check('local command does NOT wake the worker', local.woke === false);

  const model = await runCommand('group by topic');
  check('model command wakes the worker', model.woke === true, model.status);
} catch (error) {
  if (!(error instanceof ExtensionDidNotLoad)) {
    failed++;
    console.log(`  FAIL unexpected error\n       ${error?.stack ?? error}`);
  }
} finally {
  browser?.kill();
  fixtures?.close();
  rmSync(profileDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
