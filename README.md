# Tab Agent

> Manage your Chrome tabs with plain English.

Too many tabs open? Tab Agent lets you group, close, and organize them using natural language — powered by Groq's free LLM API, running entirely in your browser extension with no local server required.

[![CI](https://github.com/jingpeng7527/chrome_manager/actions/workflows/ci.yml/badge.svg)](https://github.com/jingpeng7527/chrome_manager/actions/workflows/ci.yml)
![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-green)
![License](https://img.shields.io/badge/license-MIT-blue)

---

## Features

- **Natural language commands** — just describe what you want
- **Group tabs** by topic, domain, or any criteria
- **Ungroup, duplicate, or close** tabs in bulk
- **Instant for common commands** — naming a site or closing duplicates is matched locally, with no API call at all
- **Aware of existing groups** — adds to them instead of creating duplicates
- **No backend required** — calls the Groq API directly from the extension
- **Free** — Groq's free tier covers ordinary use

## Demo

| Command | Result |
|---|---|
| `group github` | Groups every tab on github.com — a search *about* GitHub is not included |
| `close duplicates` | Closes tabs open at the same URL more than once |
| `ungroup all` | Moves every tab out of its group, closing nothing |
| `group by topic` | Reads the tabs and creates several named groups |

The site name can be written however you like: `group stripe`, `group all
stripe tabs` and `group my stripe pages` all do the same thing.

## Getting started

### 1. Get a free Groq API key

Sign up at [console.groq.com](https://console.groq.com) and create an API key. No credit card required.

### 2. Load the extension

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `chrome-manager-frontend/` folder

### 3. Add your API key

Click the extension icon, click **API Key**, paste your Groq key, and press Enter. It's saved locally in your browser.

### 4. Start managing tabs

Type a command in the popup and press **Enter** (or click the ↑ button). Use the example chips as a starting point.

## How it works

Most commands never reach the network. A request that names a site, or asks for
a plain operation, is matched locally and runs immediately:

| Command | Path | Cost |
|---|---|---|
| `group stripe`, `ungroup all`, `close duplicates` | matched in `lib.js` | instant, no API call |
| `group by topic` | Groq (`openai/gpt-oss-120b`) | a second or two |

Anything needing judgement goes to the model. Rather than asking it to build
arrays of tab ids — which is where models reliably go wrong, mixing tabs
between groups — it is asked for **one topic label per tab**, and the code
decides which tabs end up together. A mislabelled tab can then only move
itself.

Tabs are shown to the model numbered `1..N`; raw Chrome tab ids never reach it.

## Project structure

```
chrome-manager-frontend/   # The Chrome extension
├── manifest.json          # MV3 manifest
├── lib.js                 # Pure logic — matching, parsing, grouping (unit tested)
├── background.js          # Service worker — Chrome APIs and Groq calls
├── pop_up.html            # Popup UI
└── pop_up.js              # Popup logic

test/                      # Node test-runner suites, no dependencies
├── lib.test.js            # Tab matching, model-reply parsing, grouping
└── manifest.test.js       # Manifest and popup wiring
```

## Development

No dependencies, no build step. Tests run on Node's built-in test runner
(Node 18+):

```bash
npm test       # run both suites
npm run check  # parse-check the extension scripts
```

CI runs both on every push and pull request.

### How the code is split

`background.js` cannot be imported by a test — it calls `chrome.*` on load and
registers a message listener. So everything decidable without a browser lives
in `lib.js`: site matching, parsing model replies, turning replies into
commands, and building the prompt. `background.js` imports it and keeps only
the Chrome and network calls.

That is also why `manifest.json` sets `"background": { "type": "module" }`.
Without it Chrome refuses to start the service worker, and the extension dies
silently.

### What the tests cover

**`test/lib.test.js`** — site matching, model-reply parsing, group building.
Every bug this project has hit has a test pinning it, each marked with a
`Regression:` comment naming the failure it prevents:

- a Google search *about* GitHub joining the GitHub group
- `netflix.com` matching a request for `x.com`
- "close duplicates" closing two *different* YouTube videos
- the model running three 10-digit tab ids together into one number
- a single mislabelled tab becoming a group of its own
- `chrome://` urls all reaching the model as the literal string `"null"`

**`test/manifest.test.js`** — what an extension has no build step to catch:
that the manifest points at files which exist, that the service worker is
declared a module while it uses imports, that `host_permissions` covers every
URL `background.js` calls, and that every element `pop_up.js` looks up is
present in the HTML.

### Adding a test

New logic belongs in `lib.js` if it can be decided without a browser — that is
what makes it testable at all.

After writing a test, break the thing it guards and confirm it actually fails.
A check that cannot fail is worse than no check, because it reads like
coverage. One test in this suite was silently vacuous until it was verified
that way: it matched `import ... from` on a single line, while the code it
guarded used a multi-line import.

## Contributing

Contributions are welcome. Please open an issue before submitting a large PR.

1. Fork the repo
2. Create a branch: `git checkout -b feat/your-feature`
3. Commit your changes
4. Open a pull request

## License

MIT
