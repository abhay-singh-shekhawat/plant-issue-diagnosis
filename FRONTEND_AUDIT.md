# FRONTEND_AUDIT.md — SC-Main Frontend Phase 0 (Reconnaissance Only)

> Backend is FROZEN. No backend file was modified in this phase.
> Working-tree note: `client/` showed as deleted in git status at session start; restored via `git restore client/` (no content change). No production code altered.
> Absent-doc note: brief names `ARCHITECTURE(3).md`, `ARCHITECTURE(4).md`, `SC_Main_Integrated_Architecture_Seed_Verification.md` — repo contains `Old_Architecture.md` + `SC_MAIN_INTEGRATED_ARCHITECTURE.md` instead. `BUILD_PROMPT.md` and the seed `.docx` are also absent. Mapping below uses the present files as truth.

## A. Existing frontend architecture

- Stack: React 19 + Vite 8 + Tailwind 3.4 + `react-markdown` 9 (`client/package.json`). No router, no state library, no test runner, no audio/voice library. `lucide-react` installed but UNUSED in `src/` (verified by grep).
- Entry: `client/index.html` → `src/main.jsx` (no `StrictMode` wrapper) → `src/App.jsx` (single `bg-gray-100` div) → `ChatContainer`.
- Shape: single-column chat app, `max-w-2xl` centered, header + `CaseSwitcher` + `ChatMessages` + clarification bar + `ChatInput` + loading ping (`ChatContainer.jsx:318-385`).
- State: local `useState` only (`messages`, `loading`, `conversation`, `needsClarification`, `sessionId`). No persistence except session UUID.
- Identity: per-browser UUID in `localStorage` (`sc_session_id`), memory fallback when storage blocked (`ChatContainer.jsx:6-31`).
- Backend wiring: `VITE_BACKEND_URL` (default `http://localhost:4000`), `VITE_REQUEST_TIMEOUT_MS` (default 90000) (`ChatContainer.jsx:36,45`).
- Request discipline: single-flight `AbortController` + sequence-number gate; superseded responses append bubble but never move case state (`ChatContainer.jsx:51-96`).
- Styling: Tailwind utilities inline, default config (`tailwind.config.js` = empty extend), `index.css` = 3 directives only. Title: "Crop Disease Detection" (`index.html:7`).

## B. Current frontend components

| File | Role | Key behavior (with receipts) |
|---|---|---|
| `src/App.jsx` (13 lines) | Shell | Renders `ChatContainer` only. |
| `src/main.jsx` (8 lines) | Entry | `createRoot` render, no `StrictMode`. |
| `components/chat/ChatContainer.jsx` (388 lines) | Orchestrator | `handleSendText` → `POST /api/message` JSON `{sessionId, source:'web', text}` (:116-121). `handleSendMessage` → `POST /api/upload` FormData `{image, source, sessionId, text?, coordinates?}` (:185-194), swaps optimistic blob URL for `${BACKEND_URL}${result.data.image_url}` (:218-226). `handleAction` → `POST /api/message` `{sessionId, source, action, caseId}` (:279-284). Per-case filter `!m.caseId \|\| m.caseId === activeCaseId` (:345). Renders `new_vs_same` Same/New buttons (:349-367). 429 surfaced from server body (:126-134). `diagnostic` field received but NEVER read. `domain`/`seedHints`/`messageId`/`language` NEVER sent. |
| `components/chat/ChatInput.jsx` (267 lines) | Input | Image pick + client gate (`image/*`, non-empty, ≤10 MB, mirrors multer) (:38-60). Preview blob with revoke (:26-33). ALWAYS attempts geolocation on photo send: `getCurrentPosition` (10 s, low accuracy) → `ipapi.co/json/` fallback (8 s abort) → `null` coords (:137-157). `dispatchSend(coordinates)` always fires exactly once (:101-135). Draft doubles as photo note + text follow-up (:245-253). Busy guards incl. send-guard ref (:68-99,194-206). |
| `components/chat/ChatMessages.jsx` (76 lines) | Transcript | Empty state, stable `message_id` keys, user/bot bubbles, image render, coords chip (finite numbers only), `ReactMarkdown` with explicit `urlTransform` allowlist (`http/https/mailto///#`/relative; blocks `javascript:/data:`), timestamps, autoscroll. No audio/voice rendering. No structured seed rendering. |
| `components/chat/CaseSwitcher.jsx` (53 lines) | Cases | Chips from `conversation.cases` with status dots (`completed` green, `evaluating_confidence` amber, `gathering_info` gray), busy-disabled, `+ New problem`. Reads only `caseId/label/status/activeCaseId` — all present in DTO. No case-type display. |

## C. Real backend contract (from code, not docs)

Transport (`server/server.js`, routes, controllers):

- `GET /` → `{message:'Server is running'}` (`server.js:63`).
- `POST /api/message` (`message.routes.js:9` → `message.controller.js:9-52`).
  - Req JSON: `sessionId*` (400 if blank), `source`, `text` (sliced 2000), `action`, `caseId`, `language`, `domain` (canonical + `SEED`/`CROP`/`COMPLAINT` aliases), `messageId`, `seedHints[]`.
  - Res 200: `{success, ai_response, diagnostic, conversation (DTO), needsClarification}`.
  - Err: `500 {error:'Failed to process message'}`; `429 {error:'Too many requests…'}` (rate limiter, `rateLimit.middleware.js`).
- `POST /api/upload` (`upload.routes.js:12`, multer `single('image')` → `upload.controller.js:14-122`).
  - Multipart: `image*` + `source`, `sessionId*` (400 if blank), `text` (≤2000), `coordinates` (JSON string), `action`, `caseId`, `domain`, `messageId`, `language`. NOTE: `seedHints` NOT forwarded on this route (controller destructures no `seedHints`, `upload.controller.js:77-88`).
  - File gate: multer MIME allowlist (`jpeg/png/webp/gif`) + 10 MB + 1 file (`multer.middleware.js:46-55`); byte-level magic + ext/MIME/signature agreement (`file-validate.js:109-141`).
  - Coords: `normalizeCoordinates`, lat −90..90 / lon −180..180, else 400 (`upload.controller.js:58-62`).
  - Res 200: `{success, data:{message_id, sender, type:'image', image_url (RELATIVE `/user_img_web/…`), coordinates, timestamp}, message, ai_response, diagnostic, conversation, needsClarification}`.
  - Orphan rule: multer-saved file deleted on every early 400/500/dedupe (`deleteOrphanUpload`).
- Static: `/user_img_web`, `/user_img_whatsapp` only (`server.js:53-54`). `user_audio_whatsapp/` is NOT served.
- CORS: allowlist env (`CORS_ORIGINS`, default `https://sc.sawinest.xyz,http://localhost:5173`), methods `GET,POST` only (`server.js:36-48`).
- Rate limit: fixed-window 60 s, default 30 req/min per IP, applied on `/api` (`server.js:60-61`).
- Errors: JSON 404 + terminal handler mapping multer errors to 400 JSON (`error.middleware.js`).
- NO other web endpoints: no `/api/voice`, no seed-only API, no review/admin API, no audio-download API.

Semantics (`agent.service.js`, `session.service.js`, `intent.router.js`):

- Shared `processMessage()`; per-conversation lock; `messageId` dedupe replays first reply (`agent.service.js:140-155,495-496`).
- Routing resolves domain BEFORE slot validation (Rule E): `explicit domain > complaint cue > seed cue > crop cue > both→AMBIGUOUS→ask > none→legacy default` (`intent.router.js:74-101`; `session.service.js:317-320`).
- Case types: `CROP_DIAGNOSIS`, `SEED_VERIFICATION` (+`purchaseMode` BRANDED/OPEN/UNDECIDED), `SEED_COMPLAINT` (`session.service.js:150-171`; `seed-slot.service.js`).
- Crop: needs image + coords; gathering nudges multilingual; Gemini confidence loop (threshold 85, ≤2 follow-ups).
- Seed: needs photo ONLY (`agent.service.js:203-204`). Photo-less → bilingual "send seed photo, no location needed". Mode UNDECIDED → ask branded/open (ambiguous→re-ask). BRANDED → `runBrandedStep` (packet ask / `same packet` confirm cue / typed slots `price:/seller:/scheme:` / simulated brand-price-seller-scheme evidence / assessment section). OPEN → `runOpenStep` (typed `seller/price/crop:/variety:/scheme:` slots / simulated checks / assessment). COMPLAINT → record-only bilingual receipt, never a verdict. HIGH assessment appends `human-review task … is open` line (`agent.service.js:264-270`).
- `conversation` DTO (`session.service.js:264-277`): `{conversationId, activeCaseId, language, cases:[{caseId, label, status, photoCount, hasCoordinates, createdAt, updatedAt}]}`. Strips history, coord values, `diagnostic_data`, `seedContext`, evidence, assessments.
- `needsClarification`: `{type:'new_vs_same'}` (photo on completed case; seed variant asks same/new seed) or `{type:'domain'}` (crop-vs-seed question, carried in `directResponse` text).
- `diagnostic` (=`diagnostic_data` `{visual_diagnosis, geo_spatial_data, raw_data}`) is non-null ONLY on the final crop turn (`agent.service.js:444`).
- Language: inbound via `language` param or Deepgram detection; `coerceLanguage`, default `hi`; 11 canonical codes (`language.js`). TTS map covers same set + `od` alias.
- Voice (WhatsApp-only): STT Deepgram nova-3 + lang-detect, fail→empty→ask re-record (`stt.service.js`); TTS Sarvam `bulbul:v3` chunked ≤400 chars, all-or-nothing, WAV-stitch + ffmpeg OGG/Opus (`tts.service.js`); `whatsapp.service.js:553-660` (voice-in→transcribe→`processMessage`→voice-note reply only; text-in→text + voice note; TTS-down→explicit text notice).

## D. Existing functionality (must preserve)

- Photo + auto-location crop upload with optimistic preview, server-URL swap, failure rollback, timeout/abort messaging.
- Text follow-ups + Same/New buttons + case switch/new/list over `/api/message`.
- Per-case transcript filtering with caseId stamping; race-safe single-flight sends.
- Client MIME/size pre-gate matching multer; blob-URL hygiene; 429 surfacing; markdown replies with link sanitization; multilingual text replies; in-memory multi-case conversations with TTL/LRU sweep.

## E. Seed Verification frontend requirements

SUPPORTED NOW (no backend change):
- Seed photo upload photo-only over `POST /api/upload` — coords optional at transport; backend seed gate proceeds without location.
- Text follow-ups (`branded`/`open`, `same`/`new`, slot markers) over `POST /api/message`.
- `new_vs_same` clarification already renders (seed wording arrives as text).
- Bilingual seed replies + assessment text section render as markdown today.

SUPPORTED THROUGH EXISTING CONTRACT (frontend-only work, Phase 1+):
- Explicit `domain:'SEED_VERIFICATION'` (+ `seedHints`) on `/api/message` and `domain` on `/api/upload` — backend accepts; frontend sends neither today.
- Full branded/open/complaint slot collection via typed markers (`price:`, `seller`, `scheme:`, `crop:`, `variety:`, `same packet`) — works over existing fields if frontend prompts for them.
- Assessment/review-task text lines render without backend change.
- Case switching across mixed crop/seed cases (DTO already carries all cases).

REQUIRES FUTURE BACKEND BRIDGE (report only, do NOT build):
- Web voice transport: no STT/TTS endpoint, no audio serving, no client voice code. Frontend abstraction to prepare (mic/record/stop/cancel/playback/voice bubble/processing/audio-player/voice-text parity) behind a transport interface with NO invented URL/format.
- Structured seed data for Web: DTO strips `seedContext`/evidence/assessments/risk level — rich seed UI needs a new approved read contract.
- Reviewer decision API/UI: `review.service.js` is backend-internal Maps; no HTTP surface, no UI specified (per PRD out-of-scope).
- Barcode/QR decode: `getBarcodeCapability` capability-unavailable → evidence UNKNOWN; nothing for frontend to call.
- `seedHints` on `/api/upload`: controller drops it (message route only).

UNKNOWN / REQUIRES CONFIRMATION:
- Where the deployed Web gets `VITE_BACKEND_URL` / timeout (no `.env` in `client/`).
- Whether auto-geolocation on EVERY photo (incl. future seed photos) is acceptable UX/privacy, or seed mode must skip geo entirely.
- `ipapi.co` availability/CORS reliance for the fallback path.
- Review-policy display wording for Web (risk level text currently only inside reply markdown).

## F. Voice gap

- WhatsApp NOW: Deepgram STT in (`whatsapp.service.js:566-578`), Sarvam TTS out (`:605-660`), language-coerced voice, explicit downgrade notices, `JUDGE_MODE` short-voice trim. Nothing to change.
- Web NOW: zero — no mic button, no `MediaRecorder`, no duration/stop/cancel/playback UI, no voice bubble, no audio player, no upload/send path for audio, no `VITE_` voice config, no dependency.
- Bridge contract (for the later approved task): `VoiceTransport` interface (`startRecording/stopRecording/cancel/playback/sendVoice/onState`) + `VoiceMessageBubble` + `ResponseAudioPlayer` + processing state, all wired to a REAL endpoint only when backend approves it. No URL, format, or fake success invented in this phase.

## G. Frontend architecture recommendation (from existing repo, not invented)

- Keep the `App → ChatContainer → (CaseSwitcher, ChatMessages, ChatInput)` shape; grow by composition: `ModeSelector` (crop/seed entry, sets explicit `domain`), `SeedSlotPrompts` (branded/open/complaint typed-slot helpers that compose plain-text markers), `VoiceControls` (behind `VoiceTransport` stub), `AssessmentBlock` (renders the markdown assessment section distinctly once backend exposes structure — text-first until then).
- Keep `processMessage()` convergence: no seed-only fetch layer; both modes use the two existing endpoints with `domain` added.
- Keep single-flight + seq-gate + caseId stamping; extend stamping to voice/seed bubbles.
- Keep DTO-driven `CaseSwitcher`; add a case-type badge from `caseType` ONLY if a future DTO exposes it (do not infer type client-side as state).
- Mode-aware `ChatInput`: crop mode keeps geo attempt; seed mode MUST skip geo (photo-only per R3) — this is the single most important Phase-1 behavior fix.

## H. Component migration plan

| Component | Verdict | Reason |
|---|---|---|
| `App.jsx` / `main.jsx` / `index.html` shell | KEEP (title → MODIFY in Phase 1) | Shell is fine; "Crop Disease Detection" title/branding is crop-only and must widen when seed ships. |
| `ChatContainer.jsx` | MODIFY | Add `domain` state, send `domain/messageId/language` on both endpoints, handle `{type:'domain'}` clarification UI, keep race/case logic untouched. |
| `ChatInput.jsx` | MODIFY | Mode-aware location (skip geo in seed mode), seed slot shortcut chips composing marker text, voice button behind transport stub. Keep validation/busy guards. |
| `ChatMessages.jsx` | MODIFY | Add voice-bubble + audio-player + assessment-block rendering when contracts exist; keep markdown sanitizer as-is. |
| `CaseSwitcher.jsx` | KEEP (+ badge later) | Works on DTO fields; case-type badge only after DTO carries it. |
| Tailwind default theme / gray-blue chat skin | REPLACE (redesign phase) | Functional but generic; redesign must hit premium-editorial-scientific-agricultural bar without touching request logic. |
| Mode selector, seed slot helpers, voice controls/transport, assessment panel | NEW (Phase 1+) | No existing implementation; voice transport stays stubbed until backend bridge approved. |
| `lucide-react` | REPLACE (use or remove) | Installed, unused — either adopt for icon system in redesign or drop to cut bundle. |

## I. Responsive strategy

- Current `max-w-2xl` column is inherently mobile-safe; preserve thumb-reach input bar, full-width tappable chips/buttons (≥44 px), preview + mic within one viewport.
- Mobile-first: camera capture (`accept="image/*"` + capture on seed/crop photo buttons), geo-permission fallback copy, voice as first-class input on small screens, assessment text collapsible.
- Tablet/desktop: same conversation column widened (max `2xl–4xl`), optional side rail for cases/assessment later — chat stays the primary surface, no dashboard charts.
- Accessibility: labeled mic/photo buttons, recording timer announced, keyboard-send parity, contrast-safe status dots + text labels, reduced-motion respect for ping/typing states.

## J. Design-system requirements (principles only, no implementation)

- Restrained agricultural-scientific editorial voice: soil/leaf/lab tones, one accent, generous whitespace, hairline borders over shadows; no purple/blue gradients, no glassmorphism, no neon, no fake-AI chrome.
- Typography with justification (no default Inter/Poppins dump); Devanagari + Latin parity for bilingual replies; tabular numerals for coords/prices.
- Real-function components only: photo evidence, slot state, assessment ledger, review notice — every visual maps to a backend truth (UNKNOWN stays visibly unknown).
- Motion budget: message ingress, recording pulse, upload progress — all skippable via `prefers-reduced-motion`.

## K. Risks / conflicts

1. Location globally coupled: `ChatInput` geo-attempts every photo; a seed user is location-prompted despite R3 photo-only. (Phase-1 fix, frontend-only.)
2. No `domain` sent: seed photo on an active crop case attaches as crop progression; mixed-cue first photo gets the `domain` question as raw text with no dedicated UI.
3. `diagnostic` ignored by frontend — final crop evidence never displayed (also means no accidental seed misuse, but a display gap).
4. Seed structured data stripped from DTO — rich seed UI impossible without a new approved read contract; text-parsing replies client-side would violate honesty rules.
5. `/api/upload` drops `seedHints` — seed hinting only works on the message route until backend aligns (REPORTED, not fixed).
6. No web voice path end-to-end; `user_audio_*` unserved; CORS `GET,POST`-only constrains future audio fetch design.
7. In-memory state: restart loses cases; 48-h TTL + 5000-conv LRU cap; per-browser UUID breaks multi-device continuity.
8. Third-party web deps in critical path: `ipapi.co` fallback, `VITE_BACKEND_URL` undeployed default `localhost:4000`.
9. Doc-name drift: brief's `ARCHITECTURE(3)/(4).md`, `SC_Main_…_Seed_Verification.md`, `BUILD_PROMPT.md`, seed `.docx` absent — used present-file equivalents.

## L. Questions / blockers

1. Confirm the absent-doc mapping (Q: does `Old_Architecture.md` = `ARCHITECTURE(3).md`, and is there a newer `ARCHITECTURE(4).md`/seed-`.docx` to reconcile?).
2. Approve seed-mode geo-skip + explicit `domain` send as the Phase-1 approach (no backend change).
3. Approve voice-transport stub-behind-interface approach (no invented endpoint) for Phase 1, real bridge later.
4. Approve text-first assessment rendering until a structured seed-read contract is specified.
5. Confirm `VITE_BACKEND_URL` / timeout values for the deployed Web target.
6. Confirm whether reviewer UI/API is in scope for any frontend phase (PRD says UI technology unapproved).

## Tests (evidence-gated, Phase 0)

- Backend: `node --test` in `server/` → exit 1. **297 passed, 7 failed (unique; 15 `✖` lines = 7 failures + 7-line recap + header).** Full log: `D:/TEMP/hermes-phase0-tests.log`. All seed-domain suites green; failures are pre-existing crop/session/contract mismatches — REPORTED, not fixed (backend frozen):
  1. `test/language-boundary.test.js:128` R3-agent missing-language default — `null !== 'hi'`.
  2. `test/whatsapp-workflow.test.js:340` parseCommand "new" — deep-equal mismatch.
  3. `test/whatsapp-workflow.test.js:348` parseCommand "same" — deep-equal mismatch.
  4. `test/whatsapp-workflow.test.js:355` parseCommand "list" — deep-equal mismatch.
  5. `test/whatsapp-workflow.test.js:402` lifecycle same-photo dedupe — `2 !== 1` (double-attach).
  6. `test/whatsapp-workflow.test.js:749` serializeConversation null input — `TypeError: reading 'conversationId'`.
  7. `test/whatsapp-workflow.test.js:771` setCaseLabel truncate — `80 !== 60` (code `MAX_LABEL_LENGTH=120`, test expects 60).
- Frontend: no tests present — no `test` script in `client/package.json`, no `*.test.*`/`*.spec.*` under `client/src`. `vite build`/lint NOT run (not required by Phase 0; no green to claim).
