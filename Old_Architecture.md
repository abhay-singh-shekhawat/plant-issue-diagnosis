# SC-Main — How the System Works

> A farmer sends a crop photo + location (from web or WhatsApp).
> The server looks at the photo, checks the weather/soil for that place,
> and asks the farmer extra questions only if it is still unsure.
> The final answer comes back in the farmer's own language, as text (and voice on WhatsApp).

> This file describes what the code **actually does today**.
> The old pitch doc `docs/Flow.md` is kept for history, but this file is the truth.

---

## Contents

1. [The big idea](#1-the-big-idea)
2. [How diagnosis works — the 3 layers](#2-how-diagnosis-works--the-3-layers)
3. [What tech we use](#3-what-tech-we-use)
4. [Where the code lives](#4-where-the-code-lives)
5. [Web and WhatsApp flows](#5-web-and-whatsapp-flows)
6. [Cases — one chat, many crop problems](#6-cases--one-chat-many-crop-problems)
7. [What happens when something fails](#7-what-happens-when-something-fails)
8. [Settings and running locally](#8-settings-and-running-locally)
9. [What is still missing](#9-what-is-still-missing)

---

## 1. The big idea

A photo alone is not enough. The same yellow spot can be fungus, bacteria,
or just missing nutrients. You can only tell the difference if you also know
the weather and soil (humid weather = fungus is more likely, for example).

So the app does this:

* **One brain, two doors.** The web chat and the WhatsApp bot both send the
same simple package to one function: `processMessage()` in `agent.service.js`.
That function does all the thinking. The doors only handle sending/receiving.
* **One chat can hold many problems.** A phone number (or browser) = one
conversation. Inside it there can be several cases (Case 1 = tomato spots,
Case 2 = wheat yellowing). A finished case can be re-opened later if the same
disease gets worse, instead of re-using the old answer.
* **Never go silent.** If Gemini, weather, voice, or Chrome fails, the bot
still replies — just with lower detail. An outage costs accuracy, not silence.

---

## 2. How diagnosis works — the 3 layers

Think of diagnosis as 3 layers stacked on top of each other.
We always collect Layer 1 + Layer 2 together, then use Layer 3 only if needed.

```
Farmer sends photo + location
        │
        ▼
┌───────────────────┐
│ Layer 1:          │  Look at the photo (Gemini vision).
│ What does it      │  "Brown spots with yellow rings, looks like early blight.
│ look like?        │   Also could be bacterial spot." + a guess-score.
│ vision.service.js │  If vision is down → safe default (score 0), keep going.
└─────────┬─────────┘
          │  runs TOGETHER with ↓ on every new photo
┌─────────▼─────────┐
│ Layer 2:          │  Check the field: live weather (Open-Meteo) + soil guess
│ What is the       │  (Gemini pretends to be a satellite, using real weather
│ field like?       │  to make believable numbers: moisture, nitrogen, pH).
│ weather +         │  If down → safe defaults (28°C, 60% humidity, average soil).
│ satellite.service │  Why? Humid + warm + low nitrogen makes fungus more likely.
└─────────┬─────────┘
          ▼
   Gemini (agronomist mode) reads Layer 1 + Layer 2 + chat history
   and gives a confidence score out of 100.
          │
          ├─ score >= 85 → done, send final advice (remedy steps).
          │
          └─ score < 85 ─►┌───────────────────┐
                          │ Layer 3:          │  Ask the farmer 1–2 simple questions:
                          │ Ask the farmer    │  "What fertilizer did you use?
                          │ agent.service.js  │   When did this start? How often do
                          │ (max 2 rounds)    │   you water?" — in their own language.
                          └─────────┬─────────┘
                                    │  answer comes back → re-score
                                    ├─ now >= 85 → done
                                    └─ asked twice already → give best guess anyway
                                       (never loop forever)
```

**Two real examples:**

* *Clear case:* sharp photo of tomato blight + hot humid weather → vision says
"blight 90", weather agrees → combined score 92 → answer at once, 0 questions.
* *Confusing case:* pale yellow patch, could be 3 things → combined score 68 →
Q1 "Which fertilizer and how much?" → farmer answers → 78 → Q2 "How often do
you water, did it rain?" → 86 → final answer with remedy.

**Important:** today there is **no early exit on a clear photo**.
Even a 99% photo still fetches weather + soil. That is deliberate —
a clear-looking spot can still be misread without field context.
The vision score is just a hint; the final call is the combined score >= 85
(`CONFIDENCE_THRESHOLD`, 2 questions max via `MAX_FOLLOW_UP_QUESTIONS`).
Code: `runDiagnosticEngine()` + `buildDiagnosisPrompt()` in `agent.service.js`.

This is different from §7 fallbacks — those are "what if the internet/API is
down". This section is "how sure are we about the disease".

---

## 3. What tech we use

| Part | What | Why it matters |
|---|---|---|
| Web chat | React + Vite + Tailwind | Simple one-screen chat. Photo + location + text. |
| Server | Node + Express (one process) | Serves the API **and** runs the WhatsApp bot. |
| Thinking | Gemini `gemini-2.5-flash` | Sees the photo, reads weather/soil, asks questions, writes the answer. Free tier is generous (check AI Studio quotas). Always replies in strict JSON so the code can trust the shape. |
| Weather | Open-Meteo (free, no key) | Real temperature / humidity / rain for the farmer's location. |
| Soil | Gemini pretending to be a satellite | Gives believable moisture / nitrogen / pH numbers based on the real weather. Not real satellite data — just a smart guess. |
| Voice in | Deepgram Nova-3 | Turns WhatsApp voice notes into text + language. Free ~$200 credit to start. |
| Voice out | Sarvam `bulbul:v3` (speaker `shubh`) + `ffmpeg` | Turns the answer into a voice note in the farmer's language. Built for Indian languages. |
| WhatsApp | `whatsapp-web.js` | Uses your linked phone, no paid Meta API. Groups and broadcasts are ignored. |
| Safety nets | Rate limit, error handler, cleanup | Stops spam, always returns clean JSON errors, deletes old photos/audio. |
| Storage | None (memory only) | Conversations live in a `Map`. Restart = fresh start. |

---

## 4. Where the code lives

```
sc-main/
├─ ARCHITECTURE.md          ← this file (plain-English truth)
├─ docs/Flow.md             ← old pitch doc, kept for history
├─ client/src/components/chat/
│  ├─ ChatContainer.jsx     ← chat state, talks to the server
│  ├─ ChatInput.jsx         ← photo picker + location + text box
│  ├─ CaseSwitcher.jsx      ← "Case 1, Case 2, + New problem" chips
│  └─ ChatMessages.jsx      ← bubbles (Markdown text, photo, location)
└─ server/
   ├─ server.js             ← starts API + WhatsApp bot
   ├─ routes/ + controllers/← POST /api/upload (photo), POST /api/message (text)
   ├─ middlewares/         ← image-only 10MB upload, 30/min rate limit, JSON errors
   └─ services/
      ├─ agent.service.js   ← THE BRAIN: collects evidence, asks questions, decides
      ├─ session.service.js ← remembers conversations → cases
      ├─ vision.service.js  ← Layer 1: what does the photo show?
      ├─ weather.service.js ← Layer 2a: real weather for this spot
      ├─ satellite.service.js ← Layer 2b: soil guess based on that weather
      ├─ whatsapp.service.js← WhatsApp in/out (photo, location, voice)
      ├─ stt.service.js     ← voice → text (Deepgram)
      ├─ tts.service.js     ← text → voice note (Sarvam + ffmpeg)
      └─ cleanup.service.js ← deletes old photos/audio every hour
```

---

## 4. What the app can do (in plain words)

1. **Two ways in** — web photo + GPS, or WhatsApp photo / location / voice / text. Both become the same package for the brain.
2. **Photo + location are both required.** No guessing until both arrive.
3. **Photo + weather/soil are read together** (never photo alone).
4. **Asks max 2 questions** (fertilizer, watering, when it started) when unsure, then gives best guess.
5. **One chat, many cases.** Track tomato + wheat separately; re-check the same disease later with a new photo.
6. **Replies in your language** (Hindi, Gujarati, Marathi, Tamil, etc.) as text — plus voice note on WhatsApp.

---

## 5. Web and WhatsApp flows

Both doors send the same package to the brain:
`{ sessionId, text, imageUrl, coordinates, language }`.

**Web (React chat):**

1. Farmer picks a photo, optionally types a note ("spots since 3 days").
2. Browser tries GPS → if denied, tries rough IP location → if that fails, sends without location.
3. `POST /api/upload` (photo) or `POST /api/message` (text answers).
4. Bot reply appears as a bubble. "Same or new?" shows two buttons.

**WhatsApp (bot on your linked phone):**

1. Judge scans `wa.me/<bot-number>?text=hi` QR on poster → chat opens, no number typing.
2. First message → welcome guide (photo + location pin + voice note explained). "Hi" alone stops there.
3. Farmer sends photo / location pin / voice note / text — any mix.
4. Voice note → Deepgram → text (empty = "please re-record", never a fake guess).
5. Same brain runs: photo + weather/soil + questions if unsure.
6. Reply = text first, then voice note in the same language (judge mode: voice = first 2 sentences for speed).
Groups and broadcasts are ignored — only 1-to-1 chats.
Each phone number = separate session, so judges never see each other's cases.

**What the brain does with every message (`agent.service.js`):**

1. **Find the right case.** New chat → Case 1. Finished case + new photo → ask "same problem or new problem?". `same` = re-check with the new photo, `new` = fresh case. `list` / `1` / `2` switches cases.
2. **Need photo + location.** Missing one → ask for it, no guessing.
3. **Collect evidence once.** New photo → Layer 1 (photo) + Layer 2 (weather/soil) together.
4. **Decide or ask.** Score >= 85 → final advice. Score < 85 → ask 1–2 questions (fertilizer, watering, when it started). After 2 rounds → best guess.
5. **Remember per case.** Each case keeps its own last 6 messages. Reply is always in the farmer's language.

---

## 6. Cases — one chat, many crop problems

One phone number (or browser) = one conversation.
Inside it can be several cases — Case 1 = tomato spots, Case 2 = wheat yellowing.
Each case has its own photo, location, history (last 6 messages), and question count,
so one problem never leaks into another.

* New chat → Case 1.
* Still working on a case → stay on it, fill photo/location or answer the question.
* Finished case + new photo nearby → ask "same problem or new problem?".
`same` = compare new photo with old diagnosis (improving / stable / worse).
`new` = fresh case. Far-away photo or long gap = new case automatically.
* Type `list` to see cases, `1` / `2` to switch, `new` / `same` to answer.
Web has chips + Same/New buttons; WhatsApp uses the same words.

---

## 7. What happens when something fails

Rule: the bot always replies — just with less detail. It never crashes or goes silent.

**If input is missing:** no GPS → ask for location pin. No photo → ask for photo.
Empty voice note or sticker → "please send a photo / location" (no AI call).

**If the AI is unsure:** Gemini error → "try again". Bad JSON → ask a generic question.
Asked twice already → give best guess anyway (never loop forever).
Sticker / empty message → "please send a photo / location", no AI call.

**If voice fails:** no Deepgram key or bad audio → ask to re-record (no fake text).
No Sarvam key or bad language → text-only reply (never wrong-language audio).

**If the app itself struggles:** no Chrome → web still works, WhatsApp waits for QR.
Too many requests → clean `429`. Old photos/chats auto-deleted. Ctrl-C shuts down cleanly.

```
Web / WhatsApp → Express (one process) → agent.service (the brain)
  → photo check + weather + soil → Gemini score → answer (text + voice on WhatsApp)
```

That's it. Routes → controllers → services. Both doors call `processMessage()`.
Each service returns the same shape even when it fails, so the brain never crashes.

---

## 8. Settings and running locally

Only keys that change behavior:

| Setting | What happens |
|---|---|
| `GEMINI_API_KEY` (needed) | Without it: no real diagnosis, just "missing key" + safe defaults. |
| `CONFIDENCE_THRESHOLD=85` | Score needed to finish. Lower = faster but riskier. |
| `MAX_FOLLOW_UP_QUESTIONS=2` | How many times we ask the farmer before best-guessing. |
| `DEEPGRAM_API_KEY` | Without it: voice notes ask to re-record. No fake text. |
| `SARVAM_API_KEY` / `SARVAM_API_KEYS` | Without it: text-only replies. Multiple keys = spread the load. |
| `VITE_BACKEND_URL` | Where the web chat sends photos. Default `http://localhost:4000`. |
| `ffmpeg` on PATH | Needed for WhatsApp voice notes. Without it: text-only. |
| `PUPPETEER_EXECUTABLE_PATH` | **Not needed on your laptop.** Leave empty → bundled Chromium. **Only needed on headless Linux servers** → set to `/usr/bin/google-chrome-stable`. If Chrome is missing, the API still runs in WEB-ONLY mode. |
| `WHATSAPP_BOT_NUMBER` | Display-only (e.g. `919876543210`). The real login is the QR scan — you scan once with the bot phone, session saves in `.wwebjs_auth/`. This just logs "ready as +91…" so you know which SIM is linked. |
| `WHATSAPP_ALLOWED_NUMBERS` | Empty = reply to everyone. Set `91911…,91922…` to lock the bot to test phones. **Ignored when `JUDGE_MODE=true`.** |
| `JUDGE_MODE=false` | `true` = open demo for unknown judges: allowlist ignored, first message gets welcome guide, voice shortened to 2 sentences, per-number daily cap on. Use on demo day. |
| `MAX_DIAG_PER_NUMBER=20` | Max diagnoses per phone per day (only enforced in judge mode). Guards Gemini quota from spam. |

**How to set the WhatsApp number (important — there is no password login):**

1. Put the SIM you want as the bot in a real phone (that phone needs internet).
2. `npm start` → a QR prints in the terminal.
3. On that phone: WhatsApp → Settings → Linked devices → Link a device → scan the QR.
4. Done. Session persists in `.wwebjs_auth/` — restart won't ask again. To change numbers, delete `.wwebjs_auth/` and scan with the new phone.
5. Optional: set `WHATSAPP_BOT_NUMBER=919876543210` in `.env` so logs confirm the right SIM, and `WHATSAPP_ALLOWED_NUMBERS=` to your own number while testing.

**Demo day (judge uses their own phone, no pre-registration):**

1. `server/.env`: `JUDGE_MODE=true`, `WHATSAPP_ALLOWED_NUMBERS=` (empty), `MAX_DIAG_PER_NUMBER=20`.
2. `npm start` on laptop (plugged in, hotspot backup) → bot phone stays online.
3. Poster QR = `https://wa.me/919876543210?text=hi` (replace with your bot number) → judge taps, chat opens.
4. Judge sends crop photo + location pin → gets text + short voice note in <30s.
5. After demo: set `JUDGE_MODE=false` + re-add allowlist to stop quota burn.

---

## 9. What is still missing

* **Better free-model options (my take for this project):**
  * *Keep Gemini 2.5 Flash for vision + reasoning* — best free vision quality + JSON mode, and `GEMINI_MODEL` / `GEMINI_VISION_MODEL` already let you swap without code changes.
  * *Cheapest fast reasoning backup:* Groq `llama-3.3-70b-versatile` or `openai/gpt-oss-120b` (free tier ~14k req/day, very fast, but **no reliable free image input** — text only, so keep Gemini for the photo step).
  * *Free STT for Hindi/English short notes:* Groq `whisper-large-v3` (free tier, same API style) or self-hosted Whisper (fully free, needs GPU/CPU). Deepgram Nova-3 stays best for Hinglish + auto language detect while credit lasts.
  * *Free TTS for Hindi:* Gemini TTS / Edge-TTS (free, good Hindi) or self-hosted. Sarvam `bulbul:v3` stays best for natural Indian-language voice notes while credit lasts.
  * Rule of thumb: photo step must stay on a vision model (Gemini). Text-only steps (soil guess, re-phrasing) can move to Groq/Mistral free tiers to save Gemini quota.

---

## 9. What is still missing

* **No second vision model.** Only Gemini looks at the photo. The old pitch wanted ResNet + Gemini voting — not built.
* **No database.** Restart = all chats lost. One server only.
* **No login.** Anyone with the URL can use your paid API quota (only IP rate-limit protects).
* **Web has no voice.** Voice in/out is WhatsApp-only.
* **Soil is a guess, not real satellite.** Good enough for reasoning, not for science.
* **Tests cover only cases + guards** (16 offline tests). AI / voice parts need keys so they aren't tested.

```bash
cd server
cp .env.example .env   # fill GEMINI_API_KEY
npm install
npm test               # 16 tests, no keys needed
npm start              # port 4000 + WhatsApp QR (scan once)

# new terminal
cd client
cp .env.example .env
npm install
npm run dev            # http://localhost:5173
```

Server boots even with no keys (degraded answers). `ffmpeg` needed for voice notes.
Endpoints: `GET /`, `POST /api/upload` (photo), `POST /api/message` (text).