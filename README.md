# Lumi Live

Lumi Live is a lightweight anime roleplay web app with real-time voice chat, live transcripts, switchable scenes/outfits, and audio-driven lip sync. The web runtime uses Gemini 3.1 Flash Live Preview through `@google/genai` and a server-created ephemeral token.

## Local setup

Requirements:

- Node.js `>=22.13.0`
- Python 3.12 virtual environment at `.venv`

PowerShell:

```powershell
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
$env:GEMINI_API_KEY="your_google_ai_studio_key"
npm install
npm run dev
```

The same `GEMINI_API_KEY` environment variable works for both the web token route and Python Gemini scripts started from that PowerShell session. Never put a real key in `.env.example` or commit it to Git.

## Useful commands

```powershell
npm run dev
npm run build
```

The web UI lives in `app/`, generated character frames are under `public/avatars/`, and the secure token endpoint is `app/api/token/route.ts`.

## Gemini screen-sharing sample

The included `test.py` defaults to screen sharing rather than camera capture:

```powershell
.\.venv\Scripts\Activate.ps1
python test.py
```

Its `DEFAULT_MODE` is `"screen"`; you can still override it with `--mode camera` or `--mode none`.
