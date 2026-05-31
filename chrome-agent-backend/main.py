import json
import logging
import re
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import httpx
from pydantic import BaseModel
from typing import List

logger = logging.getLogger(__name__)


def extract_json(text: str) -> str:
    # Qwen3 emits <think>...</think> before its answer; strip those first
    text = re.sub(r'<think>.*?</think>', '', text, flags=re.DOTALL).strip()
    # If the model wrapped JSON in prose, pull out the first {...} block
    match = re.search(r'\{.*\}', text, re.DOTALL)
    return match.group(0) if match else text

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

OLLAMA_BASE_URL = "http://localhost:11434"
OLLAMA_MODEL = "qwen3:4b"

class ChromeTab(BaseModel):
    id: int
    title: str
    url: str

class AgentRequest(BaseModel):
    user_prompt: str
    tabs: List[ChromeTab]


@app.get("/health")
async def health_check():
    ollama_reachable = False
    model_available = False
    error = None

    try:
        async with httpx.AsyncClient(timeout=5.0) as http_client:
            response = await http_client.get(f"{OLLAMA_BASE_URL}/api/tags")
            response.raise_for_status()
            payload = response.json()

        ollama_reachable = True
        models = payload.get("models", [])
        model_available = any(model.get("name") == OLLAMA_MODEL for model in models)
    except Exception as exc:
        error = str(exc)

    return {
        "backend": "ok",
        "ollamaReachable": ollama_reachable,
        "model": OLLAMA_MODEL,
        "modelAvailable": model_available,
        "error": error,
    }

@app.post(
    "/process_intent",
    responses={500: {"description": "Internal error while processing tab intent"}},
)
async def process_intent(request: AgentRequest):
    try:
        tab_info = "\n".join([f"ID:{t.id} | Title:{t.title} | URL:{t.url}" for t in request.tabs])

        system_instruction = (
            "You are a Chrome Tab Manager. "
            "Analyze the tabs and output a JSON object with a 'commands' list. "
            "Available Actions: "
            "{\"action\": \"group\", \"tabIds\": [number], \"title\": \"Group Name\"}, "
            "{\"action\": \"duplicate\", \"tabId\": number}, "
            "{\"action\": \"remove\", \"tabId\": number}. "
            "Constraint: Output ONLY valid JSON. No conversational text."
        )

        payload = {
            "model": OLLAMA_MODEL,
            "stream": False,
            "think": False,
            "format": "json",
            "options": {"temperature": 0.1},
            "messages": [
                {"role": "system", "content": system_instruction},
                {"role": "user", "content": f"Tabs:\n{tab_info}\n\nUser Request: {request.user_prompt}"},
            ],
        }

        async with httpx.AsyncClient(timeout=30.0) as http_client:
            resp = await http_client.post(f"{OLLAMA_BASE_URL}/api/chat", json=payload)
            resp.raise_for_status()

        content = resp.json()["message"]["content"]
        logger.debug("Raw model response: %s", content)
        try:
            return json.loads(extract_json(content))
        except json.JSONDecodeError as parse_err:
            logger.error("JSON parse failed. Raw content: %s", content)
            raise HTTPException(status_code=500, detail=f"Model returned invalid JSON: {parse_err}")

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))