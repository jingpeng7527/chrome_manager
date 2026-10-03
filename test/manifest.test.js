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
      manifest.action?.default_popup,
    ].filter(Boolean);

    assert.ok(referenced.length >= 2, 'expected a service worker and a popup');
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

describe('popup', () => {
  const html = read(manifest.action.default_popup);
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
});
