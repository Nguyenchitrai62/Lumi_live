# Lumi Live

Lumi Live is a small Next.js experiment for real-time voice roleplay with an animated anime character. It uses Gemini 3.1 Flash Live Preview, live transcripts, switchable scenes and outfits, audio-driven lip sync, and optional screen or camera vision.

## Requirements

- Node.js `>=22.13.0`
- A Gemini API key from Google AI Studio

Python is not required.

## Run locally

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

Open `.env` and replace the placeholder with your key:

```dotenv
GEMINI_API_KEY=your_google_ai_studio_key
```

Then open [http://localhost:3000](http://localhost:3000).

The visual source defaults to `Screen`. Before starting a live chat, you can choose `Screen`, `Camera`, or `None`. The browser asks for the corresponding permission when the chat starts; Gemini receives at most one JPEG frame per second.

## Commands

```powershell
npm run dev
npm run lint
npm run build
npm run start
```

## Deploy to Vercel

Import the GitHub repository into Vercel with these settings:

- Framework Preset: `Next.js`
- Root Directory: `./`
- Build Command: keep the default (`npm run build`)
- Output Directory: keep the Next.js default
- Install Command: keep Vercel's automatic default

Add this Environment Variable for Production and Preview:

```text
GEMINI_API_KEY=your_google_ai_studio_key
```

Do not prefix the variable with `NEXT_PUBLIC_`. The API key is used only by the server route, which creates a short-lived token for the browser. Never commit `.env` or a real key to Git.
