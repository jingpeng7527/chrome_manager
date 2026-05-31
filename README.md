# chrome_manager

Local AI-powered Chrome tab manager.

## What this does

- Collects tabs from your current Chrome window.
- Sends your natural-language request and tab list to a local FastAPI backend.
- Uses a local Ollama model (`qwen3:4b`) to return structured tab commands.
- Executes those commands in Chrome (`group`, `duplicate`, `remove`).

## Project structure

- `chrome-agent-backend/`: FastAPI service that calls Ollama.
- `chrome-manager-frontend/`: Chrome extension popup UI and logic.

## Prerequisites

- Python 3.10+
- Google Chrome
- Ollama running locally

## 1) Start Ollama model

Make sure Ollama is installed and running, then pull the model:

```bash
ollama pull qwen3:4b
```

Ollama should be reachable at:

`http://localhost:11434/v1`

## 2) Start backend

From `chrome-agent-backend/`:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

Backend endpoint:

- `POST http://localhost:8000/process_intent`

## 3) Load Chrome extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select folder: `chrome-manager-frontend/`

Then pin/open the extension popup and run prompts like:

- `Group all GitHub tabs`
- `Duplicate the tab about FastAPI`
- `Remove tabs with YouTube`

## Notes

- The backend is configured with permissive CORS for local development.
- If no commands are returned, the popup shows `No actions taken.`