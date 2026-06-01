# chrome_manager

AI-powered Chrome tab manager using Groq.

## What this does

- Collects tabs from your current Chrome window.
- Sends your natural-language request and tab list to the Groq API.
- Uses `llama-3.1-8b-instant` to return structured tab commands.
- Executes those commands in Chrome (`group`, `ungroup`, `duplicate`, `remove`).

## Project structure

- `chrome-manager-frontend/`: Chrome extension popup UI and logic.
- `chrome-agent-backend/`: Legacy FastAPI/Ollama backend (no longer used).

## Prerequisites

- Google Chrome
- A free [Groq API key](https://console.groq.com)

## 1) Load Chrome extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select folder: `chrome-manager-frontend/`

## 2) Set your API key

Open the extension popup, expand **Groq API Key**, and paste your key. It saves automatically.

## 3) Use it

Run prompts like:

- `Group all GitHub tabs`
- `Ungroup the shopping tabs`
- `Duplicate the tab about FastAPI`
- `Remove tabs with YouTube`
