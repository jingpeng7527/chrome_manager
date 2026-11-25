# Tab Agent design notes

This document is for people working on the extension. For what it does and how to install it, see the [README](../README.md).

## How commands run

Most commands never reach the network. A request that names a site, or asks for a plain operation, is matched locally and runs immediately:

| Command | Path | Cost |
|---|---|---|
| `group stripe`, `ungroup all`, `close duplicates` | matched in `lib.js` | instant, no API call |
| `group by topic` | Groq (`openai/gpt-oss-120b`) | a second or two |

Anything needing judgement goes to the model. Rather than asking it to build arrays of tab ids, which is where models reliably go wrong by mixing tabs between groups, it is asked for **one topic label per tab**, and the code decides which tabs end up together. A mislabelled tab can then only move itself.

Tabs are shown to the model numbered `1..N`; raw Chrome tab ids never reach it.

### Entry points

There are two ways in:

- **Side panel.** Clicking the toolbar icon opens `pop_up.html` as a side panel (`openPanelOnActionClick` is set in `background.js`). The panel stays open beside the tabs, so repeat commands pay no window construction cost.
- **Address bar.** The `tab` omnibox keyword runs a command with no UI to open at all. Suggestions are built from the sites the user actually has open.

The side panel replaced an earlier toolbar popup. The popup cost around 300 ms per open, almost all of it Chrome building the window, and it closed again after every command.

## Project structure

```
chrome-manager-frontend/   # The Chrome extension
├── manifest.json          # MV3 manifest
├── lib.js                 # Pure logic: matching, parsing, grouping (unit tested)
├── chrome-api.js          # Thin chrome.* wrappers shared by the worker and the panel
├── background.js          # Service worker: Chrome APIs, omnibox, Groq calls
├── pop_up.html            # Side panel UI
└── pop_up.js              # Side panel logic

test/                      # Node test runner suites, no dependencies
├── lib.test.js            # Tab matching, model reply parsing, grouping
└── manifest.test.js       # Manifest and UI wiring

e2e/                       # Drives the real extension in a real browser
├── run.mjs                # The checks
├── bench.mjs              # Times commands with a cold service worker
├── stress.mjs             # Compares two builds under many tabs, big storage, slow Groq
├── stress-report.mjs      # Renders a stress run as an HTML page of charts
├── browser.mjs            # Finds or downloads Chrome for Testing and launches it
└── cdp.mjs                # Minimal DevTools Protocol client
```

### How the code is split

`background.js` cannot be imported by a test: it calls `chrome.*` on load and registers a message listener. So everything decidable without a browser lives in `lib.js`: site matching, parsing model replies, turning replies into commands, and building the prompt. `background.js` imports it and keeps only the Chrome and network calls.

`chrome-api.js` holds the thin wrappers over `chrome.tabs` and `chrome.tabGroups` that both the service worker and the side panel use, so both execute commands identically. It is kept apart from `lib.js`, which must stay free of `chrome.*` to remain importable by tests.

That is also why `manifest.json` sets `"background": { "type": "module" }`. Without it Chrome refuses to start the service worker, and the extension dies silently.

## Testing

Tests run on Node's built in test runner with no dependencies. CI runs `npm test` and `npm run check` on every push and pull request.

### Unit tests

**`test/lib.test.js`** covers site matching, model reply parsing, and group building. Every bug this project has hit has a test pinning it, each marked with a `Regression:` comment naming the failure it prevents:

- a Google search *about* GitHub joining the GitHub group
- `netflix.com` matching a request for `x.com`
- "close duplicates" closing two *different* YouTube videos
- the model running three 10 digit tab ids together into one number
- a single mislabelled tab becoming a group of its own
- `chrome://` urls all reaching the model as the literal string `"null"`

**`test/manifest.test.js`** checks what an extension with no build step cannot otherwise catch: that the manifest points at files which exist, that the service worker is declared a module while it uses imports, that `host_permissions` covers every URL `background.js` calls, and that every element `pop_up.js` looks up is present in the HTML.

### End to end check

The unit tests cannot tell you whether Chrome actually starts the extension. `npm run e2e` loads the extension into a real browser, drives it over the DevTools Protocol, and checks the things only a browser can answer:

- the ES module service worker and the UI start, with no exceptions
- a command produces a real Chrome tab group holding the right tabs
- a command needing no model runs **without waking the service worker**, and one needing the model does wake it

Hostnames such as `docs.stripe.com` are pointed at a local fixture server, so the run makes no external requests. The first run downloads Chrome for Testing (about 370 MB) into `~/.cache/chrome-manager-e2e`; later runs reuse it.

It is deliberately not part of `npm test` or CI, which stay dependency free and finish in seconds.

> Regular Chrome cannot be used here. `--load-extension` was removed in Chrome 154: it is silently ignored in both headless and headed mode, and `chrome://extensions` then reports no extensions at all. Chrome for Testing has no such restriction, which is why the script fetches it.

### Adding a test

New logic belongs in `lib.js` if it can be decided without a browser, since that is what makes it testable at all.

After writing a test, break the thing it guards and confirm it actually fails. A check that cannot fail is worse than no check, because it reads like coverage. One test in this suite was silently vacuous until it was verified that way: it matched `import ... from` on a single line, while the code it guarded used a multi line import.

## Performance measurement

### Bench

`npm run bench` times commands in a real browser with the service worker cold, the state a click lands in after a pause:

```bash
npm run bench                          # local commands only
GROQ_API_KEY=gsk_... npm run bench     # also times the model path
```

| | typical | who controls it |
|---|---|---|
| opening the UI | about 300 ms for the old popup, mostly Chrome building the window | Chrome |
| a local command | about 12 ms | this extension |
| a model command | needs `GROQ_API_KEY` | Groq |

The open time is measured through `chrome.action.openPopup()`, which makes Chrome build the real window. Loading `pop_up.html` as a tab looks faster because it skips exactly the part that dominates the wait.

That number is noisy: the same build lands anywhere from about 300 ms to about 1000 ms between runs. It is only worth reading as a split between Chrome's window construction and this extension's render, which is a small fraction of it. Comparing two builds needs a dozen runs each and a healthy suspicion of any difference under about 50 ms.

The UI also reports its own open time in the header, and its command timing in the status line, so the browser you actually use can be read directly.

### Stress testing

`npm run stress` compares two builds as the browser gets heavier, and writes an HTML report of charts to `e2e/results/stress-report.html`, with the raw numbers beside it as JSON:

```bash
npm run stress                                   # origin/main vs HEAD
BEFORE_REF=main AFTER_REF=HEAD npm run stress    # any two git refs
STRESS_TABS=1,50,200 STRESS_RUNS=6 npm run stress
CHROME_BIN=/path/to/chromium npm run stress      # use a browser you already have
```

It varies these things:

| | levels | what it shows |
|---|---|---|
| open tabs | 1, 50, 150, 300 | open time, data fill time, and model command overhead as tabs grow |
| storage | small, about 4 MB | whether a heavy `chrome.storage.local` slows the open |
| busy tabs | discarded, or loaded with timers and 20 KB `data:` favicons | whether a working browser slows the open |
| Groq latency | 0, 500, 2000, 5000 ms | the model path, with Groq replaced by a stub that answers after a fixed delay |

Both builds are loaded into one browser and opened in turn, so they always face the same tabs and the same machine load. Comparing builds from two separate browser sessions mostly measures run to run noise. A blank extension is opened in the same rotation as the floor Chrome itself sets. The report labels each build as popup or side panel according to how it opens.

Groq is stubbed over the DevTools protocol, so no API key is needed and the total minus the stub's delay is purely this extension's own time. A full run takes about 6 minutes.

### Results: popup vs side panel

On a MacBook, open time in ms (old popup / side panel / blank extension popup as Chrome's floor):

| tabs | popup | side panel | blank popup |
|---|---|---|---|
| 1 | 353 | 96 | 337 |
| 50 | 383 | 97 | 349 |
| 100 | 388 | 120 | 353 |
| 300 | 373 | 107 | 359 |
| 300, all loaded and busy | 632 | 210 | 420 |

The old popup was never far above the blank popup, so almost all of its cost was Chrome building the popup window. The side panel skips that window, which is why it opens 3 to 4 times faster and beats even the blank popup.
