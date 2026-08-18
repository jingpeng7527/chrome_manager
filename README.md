# Tab Agent

> Manage your Chrome tabs with plain English.

Too many tabs open? Tab Agent lets you group, close, and organize them using natural language — powered by Groq's free LLM API, running entirely in your browser extension with no local server required.

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-green)
![License](https://img.shields.io/badge/license-MIT-blue)

---

## Features

- **Natural language commands** — just describe what you want
- **Group tabs** by topic, domain, or any criteria
- **Ungroup, duplicate, or close** tabs in bulk
- **Aware of existing groups** — adds to them instead of creating duplicates
- **No backend required** — calls the Groq API directly from the extension
- **Free** — Groq's free tier supports 1,000+ requests/day

## Demo

| Command | Result |
|---|---|
| `Group all GitHub tabs` | Groups every tab on github.com |
| `Close duplicate tabs` | Removes tabs you have open more than once |
| `Ungroup everything` | Moves all tabs out of their groups |
| `Group tabs by topic` | Creates multiple thematic groups |

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

```
User prompt + tab list → Groq API (llama-3.3-70b-versatile) → JSON commands → Chrome APIs
```

The extension collects your open tabs (ID, title, URL, current group), sends them to the Groq API along with your prompt, and executes the returned commands using Chrome's `tabs` and `tabGroups` APIs.

## Project structure

```
chrome-manager-frontend/   # The Chrome extension
├── manifest.json          # MV3 manifest
├── background.js          # Service worker — local fast path, Groq calls, command execution
├── pop_up.html            # Popup UI
└── pop_up.js              # Popup logic
```

## Contributing

Contributions are welcome. Please open an issue before submitting a large PR.

1. Fork the repo
2. Create a branch: `git checkout -b feat/your-feature`
3. Commit your changes
4. Open a pull request

## License

MIT
