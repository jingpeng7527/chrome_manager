// Finds (or downloads) Chrome for Testing and runs the extension in it.
//
// Regular Chrome cannot be used: --load-extension was removed in Chrome 154
// and is now silently ignored, in both headless and headed mode, leaving
// chrome://extensions reporting no extensions at all.

import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const CACHE = join(process.env.HOME ?? '.', '.cache', 'chrome-manager-e2e');

// Chrome derives an unpacked extension's id from the absolute path it was
// loaded from: the first 16 bytes of its SHA-256, with each nibble mapped
// 0-f onto a-p.
export function extensionId(absolutePath) {
  const hash = createHash('sha256').update(absolutePath).digest('hex').slice(0, 32);
  return [...hash].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

function findBinary() {
  if (!existsSync(CACHE)) return null;
  for (const dir of readdirSync(CACHE)) {
    const mac = join(CACHE, dir, 'chrome-mac-arm64', 'Google Chrome for Testing.app',
      'Contents', 'MacOS', 'Google Chrome for Testing');
    if (existsSync(mac)) return mac;
    const macIntel = join(CACHE, dir, 'chrome-mac-x64', 'Google Chrome for Testing.app',
      'Contents', 'MacOS', 'Google Chrome for Testing');
    if (existsSync(macIntel)) return macIntel;
    const linux = join(CACHE, dir, 'chrome-linux64', 'chrome');
    if (existsSync(linux)) return linux;
  }
  return null;
}

export function resolveBrowser() {
  const found = findBinary();
  if (found) return found;

  console.log('Chrome for Testing not found; downloading it once into');
  console.log(`  ${CACHE}`);
  execFileSync('npx', ['-y', '@puppeteer/browsers', 'install', 'chrome@stable', '--path', CACHE], {
    stdio: 'inherit',
  });

  const binary = findBinary();
  if (!binary) throw new Error('download finished but no Chrome binary was found');
  return binary;
}

// The extension matches tabs on hostname, so the fixtures need real hostnames.
// Chrome's resolver is pointed at this local server, so nothing leaves the machine.
export function startFixtureServer(port) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>fixture</title><body>fixture</body>');
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ close: () => server.close() }));
  });
}

export async function launch({ binary, extensionDir, profileDir, hosts, port }) {
  const mapping = hosts.map((h) => `MAP ${h} 127.0.0.1:${port}`).join(', ');
  const child = spawn(binary, [
    '--headless=new',
    '--remote-debugging-port=9222',
    `--user-data-dir=${profileDir}`,
    `--load-extension=${extensionDir}`,
    `--host-resolver-rules=${mapping}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { stdio: 'ignore' });

  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      await fetch('http://localhost:9222/json/version');
      break;
    } catch {
      if (Date.now() > deadline) throw new Error('Chrome did not expose a debugging port');
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  return { kill: () => child.kill('SIGKILL') };
}
