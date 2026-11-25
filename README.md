# Tab Agent

> Manage your Chrome tabs with plain English.

Too many tabs open? Tab Agent lets you group, close, and organize them using natural language. It is powered by Groq's free LLM API and runs entirely in the browser extension, with no local server required.

[![CI](https://github.com/jingpeng7527/chrome_manager/actions/workflows/ci.yml/badge.svg)](https://github.com/jingpeng7527/chrome_manager/actions/workflows/ci.yml)
![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-green)
![License](https://img.shields.io/badge/license-MIT-blue)

## Features

- **Natural language commands**: just describe what you want
- **Group tabs** by topic, domain, or any criteria
- **Ungroup, duplicate, or close** tabs in bulk
- **Instant for common commands**: naming a site or closing duplicates is matched locally, with no API call
- **Runs from the address bar** or from a side panel that stays open beside your tabs
- **Aware of existing groups**: adds to them instead of creating duplicates
- **No backend, free to use**: calls Groq directly, and Groq's free tier covers ordinary use

## Examples

| Command | Result |
|---|---|
| `group github` | Groups every tab on github.com (a search *about* GitHub is not included) |
| `close duplicates` | Closes tabs open at the same URL more than once |
| `ungroup all` | Moves every tab out of its group, closing nothing |
| `group by topic` | Reads the tabs and creates several named groups |

The site name can be written however you like: `group stripe`, `group all stripe tabs` and `group my stripe pages` all do the same thing.

## Getting started

1. **Get a free Groq API key** at [console.groq.com](https://console.groq.com). No credit card required.
2. **Load the extension**: open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the `chrome-manager-frontend/` folder.
3. **Add your key**: click the toolbar icon to open the side panel, click **API Key**, paste your key, and press Enter. It is saved locally in your browser.
4. **Run a command**, either way:
   - **Side panel**: type a command and press **Enter**. The example chips are a starting point.
   - **Address bar**: press `Cmd+L`, type `tab`, a space, then the command, for example `tab group stripe`.

## Development

No dependencies and no build step. Requires Node 18+.

```bash
npm test       # unit tests
npm run check  # parse check the extension scripts
npm run e2e    # drive the real extension in Chrome for Testing
npm run stress # compare two builds under heavy load
```

How it works, the code layout, testing, and performance measurement are covered in [docs/DESIGN.md](docs/DESIGN.md).

## Contributing

Contributions are welcome. Please open an issue before submitting a large PR.

## License

MIT
