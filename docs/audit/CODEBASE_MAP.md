# CODEBASE_MAP — plant-issue-diagnosis-main (SC-Main)

Source of truth: `ARCHITECTURE.md` (claims verified against code where noted).
Last synced: 2026-10-08 post-R3. No git repo. Deps installed via
`npm ci` (both packages; lockfiles untouched). Suite 202/202; client lint+build green.
Language: `server/language.js` canonical set (11 codes) → agent-store boundary
(keep-prior, default hi) → STT normalize → WA coerce → Sarvam map.
Upload door: multer MIME pre-gate → `file-validate.js` (ext+MIME+magic-byte
consistency) → controller 400 + orphan delete. Formats: JPG/PNG/WebP/GIF only.
Case contract: `serializeConversation` DTO (identity/display only) → both
controllers → client `CaseSwitcher`/`ChatContainer`; bubbles carry `caseId`,
render filters to `activeCaseId` (unstamped always render).

## 1. Stack
- Client: React 19 + Vite + Tailwind (`client/src/components/chat/` only UI).
- Server: Node ESM + Express 5 (`server/server.js`), multer uploads, in-memory Maps.
- AI: Gemini (`gemini-2.5-flash` family; code default `gemini-3.5-flash-lite`) via
  `agent.service.js` + `vision.service.js` + `gemini-retry.js`.
- Field context: Open-Meteo (no key) + deterministic soil formulas (`satellite.service.js`).
- WhatsApp: `whatsapp-web.js` on linked phone; Deepgram STT, Sarvam TTS + ffmpeg.
- Storage: none. Conversations in `session.service.js` `Map`; media on disk swept hourly.

## 2. Entry points
- `server.js` → `app.use('/api', rateLimit, uploadRoutes)` + `messageRoutes`;
  static `/user_img_web`, `/user_img_whatsapp`; WhatsApp client init (fire-and-forget).
- `POST /api/upload` (multer `image` field, 10 MB, mimetype gate) →
  `upload.controller.js` → `agent.processMessage()`.
- `POST /api/message` (text/action/caseId/language) → `message.controller.js` →
  same `processMessage()`.
- WhatsApp `message` event → media/location/voice extraction → same `processMessage()`
  → text + voice-note reply. Web React → same two endpoints.

## 3. Brain (`agent.service.js`)
`processMessage` → `withConversationLock(sessionId)` → `session.resolveTargetCase`
→ slot check (photo + coords) → `runDiagnosticEngine` (vision + weather + soil,
sequential awaits, not parallel) → Gemini chat with JSON contract →
score >= `CONFIDENCE_THRESHOLD` (85) or `MAX_FOLLOW_UP_QUESTIONS` (2) exhausted →
final advice / follow-up question. Per-case last-6 history window.

## 4. Cases (`session.service.js`)
One conversation (phone JID / browser UUID) → up to 5 cases. New photo on completed
case → `pendingClarification` ("same or new?"). Distance (>5 km) / 14-day gap auto-news.
`list`/`1`/`2`/`same`/`new` commands. TTL 48 h sweep, max 5000 conversations.

## 5. Verified vs documented
- ✅ One brain + two doors (`processMessage` shared) — confirmed in both controllers.
- ✅ Photo+location required, max 2 questions, per-case history — confirmed in agent code.
- ✅ Rate limit is now a single app-level gate (double-mount fixed, AUD-003).
- ✅ "16 offline tests" claim is wrong — actual suite is 165 tests across 12 files.
- ⚠️ `docs/Flow.md` (old pitch) still describes ResNet + historical weather —
  NOT built. Only `ARCHITECTURE.md` is truth; Flow.md is stale (INFO-001, P3).
- ⚠️ "Conversations live in a Map, restart = fresh" — confirmed (AUD-013 accepted).

## 6. Failure posture (verified, post-fix)
Evidence collectors still degrade but now carry source flags: weather returns
`source:'live'|'fallback'`; soil returns `source:'estimated'`; both diagnosis
prompts interpolate source lines with fallback warnings. Vision keeps its
confidence-0 fallback + `source:'fallback'`. Bot never goes silent; degraded
accuracy is now disclosed to the model instead of presented as measured.

## 7. Trust boundaries (post-fix)
- `/api/*`: intentionally public demo; CORS allowlist + IP rate limit
  (single gate) + judge-mode caps. No shared buckets: blank `sessionId` → 400.
- Uploads: multer mimetype gate (spoofable — ext/magic-byte check still P2) +
  crypto-random names → unauthenticated static.
- `language` body string flows raw into `conversation.language` → system
  instruction (allowlist still P2, language-only harm).
- WhatsApp allowlist: exact match (+91-strip). Rate limit: `TRUST_PROXY_HOPS`
  opt-in (default 0, fail-closed); single-instance Maps accepted.
