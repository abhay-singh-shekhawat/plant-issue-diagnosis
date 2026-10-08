# BUG_AUDIT — evidence-based inventory

Conventions: Severity CRITICAL/HIGH/MEDIUM/LOW/INFO. Confidence
CONFIRMED (read the code) / LIKELY (strong reasoning, repro pending) /
NEEDS VALIDATION (unverified) / NOT A BUG / INTENTIONAL (deliberate design)
/ PARTIAL (partly fixed, remainder accepted).
Status: FIXED (with test) / OPEN / ACCEPTED (limitation, documented) /
NEEDS MANUAL (needs live env).

Last synced: 2026-10-08 post-R3. Suite: **202/202 green**.
History: original audit 2026-10-08 (38 items) → P0 fixed 8 → P1-A/B/C/D/E +
closeout fixed 15 more, dismissed 2 → R1 fixed AUD-007 (27th) → R2 fixed
AUD-017 (28th) → R3 fixed AUD-016 (29th; canonical language boundary +
crash fix).
Prior version backed up at `D:/TEMP/BUG_AUDIT.pre-closeout.bak` (history preserved).

## Summary table

| ID | Sev | Conf | Area | Root cause | Impact | Status |
|----|-----|------|------|-----------|--------|--------|
| AUD-001 | HIGH | CONFIRMED | api/auth | No auth on `/api/*`; rate limit only gate (`server.js:48-49`) | Anyone burns Gemini quota | ACCEPTED — public demo by design; boundary = isolation + rate limit + judge caps (tested) |
| AUD-002 | HIGH | CONFIRMED | session | Shared guest buckets: `getConversation(id \|\| 'anonymous')` (`session.service.js:103-104`); client fallback constant `web_guest_user` (`ChatContainer.jsx:21`) | Cross-user case/history leak | FIXED — requireConversationId + controllers 400 + per-tab UUID (tested + live smoke) |
| AUD-003 | MEDIUM | CONFIRMED | rate-limit | `rateLimit` mounted at app AND router (`server.js:48-49`, `upload.routes.js:10`, `message.routes.js:8`) | Counts 2×, limit halved | FIXED — single app-level gate (guards.test.js) |
| AUD-004 | MEDIUM | CONFIRMED | config | `Number(env \|\| default)` unvalidated (`rateLimit.middleware.js:11`, `session.service.js:29-30`, `agent.service.js:18-19`) | `NaN` disables guards silently | FIXED — envNum() + 6 call-sites (guards.test.js) |
| AUD-005 | HIGH | CONFIRMED | data/geo | Coords never validated (`upload.controller.js:30-37`); weather interpolates raw lat/lon, falls back to plausible 28/60/0 with no flag (`weather.service.js:1-21`); soil NaN → nitrogen falls through to `'High'` (`satellite.service.js:38-44`) | Misdiagnosis on real-looking fake data | FIXED — normalizeCoordinates + source flags + finiteOr (tested + live smoke) |
| AUD-006 | HIGH | CONFIRMED | prompt | Diagnosis prompts omit `source` fields (only `source` ref in agent is param line 72) | LLM states fallback guesses as observed fact | FIXED — source lines in both prompts (tested) |
| AUD-007 | MEDIUM | CONFIRMED | upload | Mimetype-only gate + unconstrained ext + no content check | Spoofed bytes hosted under `/user_img_web` | FIXED (R1) — `file-validate.js`: ext allowlist (jpg/png/webp/gif) + MIME allowlist pre-gate + magic-byte detection + ext/MIME/signature consistency; controller 400 + orphan delete (upload-validation.test.js 13/13 + live EXE-attack smoke 400/0-files) |
| AUD-008 | MEDIUM | CONFIRMED | whatsapp | `candidate.endsWith(norm)` (`whatsapp.service.js:169`, read ll.165-171) | Wrong numbers admitted to allowlist | FIXED — exact + 91-strip (tested + repro) |
| AUD-009 | MEDIUM | CONFIRMED | stt | No axios timeout; catch swallows all, zero log (`stt.service.js:40-69`, full read) | Hung Deepgram blocks handler; 401 vs network blind | FIXED — 30s timeout + classified log (stt-reliability 9/9) |
| AUD-010 | MEDIUM | CONFIRMED | tts | Unverified WAV concat + silent partial drop | Corrupt audio / dropped steps | FIXED — describeWavFormat verify-all + all-or-nothing null (real-ffmpeg E2E test) |
| AUD-011 | MEDIUM | CONFIRMED | cleanup | `TTL_MS` frozen at import (`cleanup.service.js:17`, full read); `MEDIA_TTL_HOURS=0` wipes everything | Data wipe on misconfig; TTL change needs restart | FIXED — per-sweep resolve + fail-safe disable + grace (lifecycle 8/8) |
| AUD-012 | MEDIUM | CONFIRMED | boot | `try/catch` around promise without await (`server.js:71-75`, full read) | Async WA failure escapes as unhandled rejection | OPEN — mitigated: internal .catch -> WEB-ONLY (smoke log); outer try/catch sync-only, harmless (P3) |
| AUD-013 | MEDIUM | CONFIRMED | state | Process-local Maps: conversations, locks, hits (`session.service.js:22,169`, `rateLimit.middleware.js:5`) | Lost on restart; diverge across instances (documented limitation) | ACCEPTED — needs Redis + deploy decision (P2) |
| AUD-014 | MEDIUM | CONFIRMED | agent-state | State mutated pre-verdict (`agent.service.js:111,126-138,255`, read); error path returns without history push (`:279-304` vs `:267-269`) | Partial state; failure turns vanish from transcript | FIXED — pushHistory all sites + failure-turn push (agent-state 8/8) |
| AUD-015 | MEDIUM | CONFIRMED | agent-state | Unbounded history; `contents[-1]` deref | Memory growth; crash loop | FIXED — 50-cap + buildChatContents + empty-window fallback |
| AUD-016 | MEDIUM | CONFIRMED | prompt-inject | Raw `language` stored verbatim (incl. non-string → TypeError crash in `buildGatheringNudge`) | Crash + prompt injection of arbitrary code | FIXED (R3) — `server/language.js` canonical set (11 codes from STRINGS/nudges/TTS evidence) + `coerceLanguage` boundary in agent store; STT output normalized; WA reply-lang coerced; session default unified to `hi` (language-boundary.test.js 14/14) |
| AUD-017 | MEDIUM | CONFIRMED | web-cases | Single shared message array, append-only, no case scoping | Cases mix in one list | FIXED (R2) — bubbles stamped with caseId; render filters to activeCaseId (unstamped always render). Server DTO already minimal, pinned by tests. No contract change needed (case-contract.test.js 10/10) |
| AUD-018 | MEDIUM | CONFIRMED | web-race | Fresh `AbortController` per call, no cancel (`ChatContainer.jsx:66,143,208`); `resetInput` fires before upload settles (`ChatInput.jsx:46-53,111-120`); same/new buttons lack busy guard (`ChatContainer.jsx:272-288`); parent passes `disabled={false}` (`:294`) | Last-response-wins; double image submit; double case actions | FIXED — single-flight + seq gate + busy guards (live repro NEEDS MANUAL) |
| AUD-019 | MEDIUM | CONFIRMED | web-location | Silent IP fallback, `ipapi.co` fetch no timeout/`ok` check (`ChatInput.jsx:56-85`, full read) | Wrong-location diagnosis without consent; `isLocating` stuck risk | FIXED — 8s timeout + ok/finite checks (consent UI P2) |
| AUD-020 | LOW | CONFIRMED | web-text | `handleSendText` optimistic bubble, error path appends bot error but never rolls back user msg (`ChatContainer.jsx:56-111`, full read) | Failed text looks sent | OPEN — upload path rolls back; text-fail rollback missing (P2 trivial) |
| AUD-021 | LOW | CONFIRMED | web-state | No mount fetch; `useState` only (`ChatContainer.jsx:30-35`; `App.jsx`) | Refresh wipes transcript (consistent with memory-only backend) | ACCEPTED — memory-only by design |
| AUD-022 | LOW | CONFIRMED | web-render | `key={index}` (`ChatMessages.jsx:27`) + filter-rollback of optimistic msg | Bubble/timestamp mis-association after failure | FIXED — key={message_id} |
| AUD-023 | LOW | CONFIRMED | web-upload | `handleFileChange` takes `files[0]` unchecked (`ChatInput.jsx:31-38`); only `accept="image/*"` hint | Bad pick builds optimistic bubble, fails late | FIXED — client type/size/empty gate |
| AUD-024 | LOW | NOT A BUG | web-xss | Bare ReactMarkdown (checked: defaultUrlTransform + safeProtocol already strips) | javascript: URLs | DISMISSED — pinned explicit urlTransform anyway (defense in depth) |
| AUD-025 | MEDIUM | CONFIRMED | whatsapp-quota | `[0]` order-dependence; quota incremented before greeting early-return | Double-dip + quota burn | FIXED — selectSenderDigits() + welcome-before-quota (tested) |
| AUD-026 | LOW | CONFIRMED | whatsapp-media | `split('/')[1]` TypeError on slash-less type | Generic-error reply | FIXED — safeExt() (tested) |
| AUD-027 | LOW | CONFIRMED | whatsapp-voice | Voice+TTS-null silent text wall | Confusion | FIXED — bilingual downgrade notice |
| AUD-028 | LOW | CONFIRMED | whatsapp-conn | Fixed 5s unbounded reconnect | Flap spam | FIXED — reconnectDelayMs 5s doubling, 2min cap, stop after 6 (tested) |
| AUD-029 | LOW | CONFIRMED | stt-params | Duplicate `detect_language=true` + `language=hi` (`stt.service.js:46-47`, full read) | Hint conflict (comment claims override; unverified) | FIXED — single param (asserted) |
| AUD-030 | LOW | CONFIRMED | tts-exec | Shell exec() interpolated paths | Quoting/injection | FIXED — execFile argv + 60s timeout (real-ffmpeg test) |
| AUD-031 | LOW | CONFIRMED | tts-lang | Silent Hindi fallback | Wrong-language voice | FIXED — loud warn + fallback (tested ja->hi) |
| AUD-032 | LOW | LIKELY | cleanup-race | Sweep can unlink mid-send, no in-flight guard | Voice/photo 404 at send | MITIGATED — 60s grace covers realistic sends; true refcount open (P2) |
| AUD-033 | MEDIUM | CONFIRMED | resilience | Lock no timeout; weather fetch no abort | Session wedge | FIXED — 120s lock watchdog + 15s weather abort (soak NEEDS MANUAL) |
| AUD-034 | LOW | CONFIRMED | rate-limit | No trust-proxy | Shared bucket behind proxy | FIXED — TRUST_PROXY_HOPS opt-in, default 0 fail-closed (Redis P2) |
| AUD-035 | MEDIUM | CONFIRMED | cases | Photos dropped with switch/list commands orphaned on disk | Disk leak | FIXED — deleteParkedFile() (root-clamped) on 3 drop paths; overwrite claim disproven, §1 always intercepts (tested) |
| AUD-036 | LOW | PARTIAL | api-contract | Unknown caseId false ack + Date.now() ids | Misleading ack | PARTIAL — ack fixed to case-list (tested); id collision accepted LOW debt (display-only) |
| AUD-037 | LOW | CONFIRMED | web-upload | Success path derefs `result.data.image_url` unguarded (`ChatContainer.jsx:161`, full read; `{}` on bad JSON at `:154`) | Crash on ok-with-empty-shape | FIXED — image_url guard |
| INFO-001 | INFO | CONFIRMED | docs | `docs/Flow.md` describes ResNet + historical weather — not built | Stale pitch misleads contributors | OPEN |

## Test gaps — current state (202 tests, all import production fns in new files)
- TG-001: CLOSED for STT/TTS/cleanup/upload-validation/contract/language (`stt-reliability` 9, `tts-reliability` 8, `lifecycle` 8, `upload-validation` 13, `case-contract` 10, `language-boundary` 14). Handler chain + voice-branching still dark — needs WA session mocks (P2).
- TG-002: PARTIAL — new tests import production fns. Old re-implemented-logic tests remain (rewrite = P3 churn, low value).
- TG-003: OPEN — full handler chain untested (needs live WA/Chromium).
- TG-004: OPEN — duplication remains (dedupe = P3 churn).

## Detailed evidence (HIGH, CONFIRMED only)
- AUD-001: `server.js:48-49` mounts both routers under `rateLimit` with no auth
  middleware anywhere; controllers accept arbitrary `sessionId`.
- AUD-002: `session.service.js:103-104` `conversationId || 'anonymous'`;
  `message.controller.js:12` + `upload.controller.js:22` default `web_guest_user`;
  `ChatContainer.jsx:21` fallback constant on `localStorage` block.
- AUD-005: `upload.controller.js:30-37` parses coords, no shape/range check;
  `weather.service.js:4` interpolates raw values; `:20` plausible fallback, no flag;
  `satellite.service.js:26` `locationSeed(NaN)` → NaN; `:38-44` NaN score → `'High'`.
- AUD-006: `agent.service.js` prompt builders interpolate cues/temperature/moisture
  but never `source`; verified `source` appears only as inbound param (line 72).
  Post-fix: both diagnosis prompts carry Visual/Weather/Soil source lines (tested).

## Detailed evidence (HIGH, fixed — post states)
- AUD-002: repro `resolveTargetCase({conversationId:'web_guest_user',...})` x2 → same object, shared photos (pre-fix, executed). Post: throws + controllers 400 (tested + live smoke 4/4).
- AUD-005: `getWeatherData('abc','xyz')` → `{28,60,0}` no flag; satellite → `moisture:null, nitrogen:'High'` (pre-fix, executed). Post: flagged fallback, all finite (tested + live smoke 400 + 0 orphans).
