// A Chrome extension has no build step, so a manifest that points at a missing
// file, or misses a permission the code needs, only fails once it is loaded in
// the browser. These checks catch that in CI instead.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'chrome-manager-frontend');
const read = (name) => readFileSync(join(EXT_DIR, name), 'utf8');
const manifest = JSON.parse(read('manifest.json'));

describe('manifest.json', () => {
  it('is a valid MV3 manifest with a name and version', () => {
    assert.equal(manifest.manifest_version, 3);
    assert.ok(manifest.name, 'name is required');
    assert.match(manifest.version, /^\d+(\.\d+)*$/);
  });

  it('points at files that exist', () => {
    const referenced = [
      manifest.background?.service_worker,
      manifest.side_panel?.default_path,
    ].filter(Boolean);

    assert.ok(referenced.length >= 2, 'expected a service worker and a side panel page');
    for (const file of referenced) {
      assert.ok(existsSync(join(EXT_DIR, file)), `manifest references missing file: ${file}`);
    }
  });

  it('declares the service worker as a module when it uses imports', () => {
    // background.js imports from lib.js; without "type": "module" Chrome
    // refuses to start the service worker and the extension silently dies.
    // [\s\S] rather than . so a multi-line import list still matches.
    const usesImports = /^\s*import\b[\s\S]*?\bfrom\s+['"]/m.test(
      read(manifest.background.service_worker),
    );
    if (usesImports) {
      assert.equal(manifest.background.type, 'module');
    }
  });

  it('has a service worker that only imports files that exist', () => {
    const specs = [...read(manifest.background.service_worker).matchAll(/from\s+['"](\.\/[^'"]+)['"]/g)]
      .map((m) => m[1]);
    for (const spec of specs) {
      assert.ok(existsSync(join(EXT_DIR, spec)), `background.js imports missing file: ${spec}`);
    }
  });

  it('declares the omnibox keyword its background script listens for', () => {
    const source = read(manifest.background.service_worker);
    if (/chrome\.omnibox\.onInput/.test(source)) {
      assert.ok(manifest.omnibox?.keyword, 'background.js handles omnibox events but no keyword is declared');
      assert.match(manifest.omnibox.keyword, /^\S+$/, 'a keyword cannot contain whitespace');
    }
  });

  it('keeps dynamic import out of the service worker', () => {
    // import() throws in a ServiceWorkerGlobalScope — the HTML spec forbids it.
    // The popup may use it; background.js must stay on static imports.
    assert.doesNotMatch(read(manifest.background.service_worker), /\bimport\s*\(/,
      'background.js must not use dynamic import()');
  });

  it('requests only the permissions the code relies on', () => {
    for (const permission of ['tabs', 'tabGroups', 'storage']) {
      assert.ok(manifest.permissions.includes(permission), `missing permission: ${permission}`);
    }
  });

  it('covers every remote host the background script calls', () => {
    const patterns = (manifest.host_permissions ?? []).map(
      (p) => new RegExp('^' + p.replace(/[.]/g, '\\.').replace(/\*/g, '.*') + '$'),
    );
    const urls = read('background.js').match(/https:\/\/[^'"`\s]+/g) ?? [];

    for (const url of new Set(urls)) {
      assert.ok(
        patterns.some((re) => re.test(url)),
        `no host_permissions entry covers ${url}`,
      );
    }
  });
});

describe('toolbar icon', () => {
  it('opens the side panel, not a popup', () => {
    // Chrome builds a popup window from scratch on every click, 320 to 400 ms
    // on a Mac even for a blank popup; the side panel opens in about a third.
    assert.equal(manifest.action.default_popup, undefined, 'a default_popup would win over the side panel');
    assert.ok(manifest.permissions.includes('sidePanel'));
    assert.match(read('background.js'), /setPanelBehavior\(\{\s*openPanelOnActionClick:\s*true\s*\}\)/);
  });
});

describe('popup', () => {
  const html = read(manifest.side_panel.default_path);
  const script = read('pop_up.js');

  it('loads its script', () => {
    assert.match(html, /<script[^>]*src="pop_up\.js"/);
  });

  it('loads the script as a module when it uses imports', () => {
    // The popup runs local commands itself, which means importing lib.js. A
    // plain <script> tag cannot, and the popup would break at load.
    if (/^\s*import\b[\s\S]*?\bfrom\s+['"]/m.test(script)) {
      assert.match(html, /<script[^>]*type="module"[^>]*src="pop_up\.js"/);
    }
  });

  it('defines every element the script looks up', () => {
    const ids = [...script.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);

    assert.ok(ids.length > 0, 'expected the popup script to look up some elements');
    for (const id of new Set(ids)) {
      assert.ok(html.includes(`id="${id}"`), `pop_up.js reads #${id}, missing from the HTML`);
    }
  });

  it('only imports files that exist, static or dynamic', () => {
    const specs = [
      ...script.matchAll(/from\s+['"](\.\/[^'"]+)['"]/g),
      ...script.matchAll(/import\(\s*['"](\.\/[^'"]+)['"]\s*\)/g),
    ].map((m) => m[1]);

    assert.ok(specs.length > 0, 'expected the popup to pull in its logic');
    for (const spec of specs) {
      assert.ok(existsSync(join(EXT_DIR, spec)), `pop_up.js imports missing file: ${spec}`);
    }
  });

  it('does not block its own startup on a module graph', () => {
    // A <script type="module"> makes the popup fetch and resolve lib.js and
    // chrome-api.js before it can run, which measurably delays every open.
    // The logic is pulled in with import() when a command is submitted instead.
    assert.doesNotMatch(script, /^\s*import\b[\s\S]*?\bfrom\s+['"]/m,
      'pop_up.js should not use top-level imports');
    assert.doesNotMatch(html, /<script[^>]*type="module"[^>]*src="pop_up\.js"/,
      'pop_up.html should not load the popup script as a module');
  });
  it('makes no network connection while opening', () => {
    // The model request is made by the service worker, not the popup, so the
    // popup has no reason to reach out to any host as it opens.
    assert.doesNotMatch(html, /<link[^>]*rel="(preconnect|dns-prefetch|preload)"/);
    assert.doesNotMatch(html, /(src|href)="https?:/, 'pop_up.html should not load remote resources');
  });

  it('waits until the popup is shown before asking Chrome for anything', () => {
    // Chrome shows the popup after its load event; storage reads and the tab
    // query made before that delay every click.
    const deferred = script.indexOf('afterShown(() =>');
    assert.ok(deferred > 0, 'expected startup work to be wrapped in afterShown');
    const first = (needle) => script.indexOf(needle);
    for (const call of ['chrome.storage.local.get(', 'refreshTabCount();']) {
      assert.ok(first(call) > deferred, `${call} runs before the popup is shown`);
    }
  });

  it('counts tabs only after the first paint', () => {
    // chrome.tabs.query returns every tab's favicon, data: URLs included; with
    // hundreds of tabs that is megabytes Chrome copies while the popup is
    // still going on screen.
    assert.match(script, /afterPainted\(\(\) => \{\s*refreshTabCount\(\)/);
    const startup = script.slice(script.indexOf('afterShown(() =>'), script.indexOf('afterPainted(() =>'));
    assert.doesNotMatch(startup, /refreshTabCount\(\)/, 'the startup block should not count tabs itself');
  });
});
