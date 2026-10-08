# QA_PLAN — matrix + commands

**STATUS 2026-10-08 post-R3: full matrix below was executed. Suite
202/202, client lint+build green, live smokes 7/7 (P0 4/4 + R1 3/3). Remaining
manual items are marked NEEDS MANUAL.**

## Commands (project's own)
```bash
cd server && npm ci && npm test              # node --test, 202 tests / 15 files
cd client && npm ci && npm run lint && npm run build
PORT=4002 node server.js                     # manual smoke: GET /, POST /api/upload, POST /api/message
```

## Functional matrix
| Area | Happy | Invalid | Missing | Boundary | Repeat |
|------|-------|---------|---------|----------|--------|
| Upload | jpg+coords → diagnosis | coords `lat:"abc"` → 400 (P0) | no photo → nudge; no coords → nudge | 10 MB edge; empty file | double-click → single case (P2) |
| Message | text answer advances loop | overlong text trimmed 2000 | empty/sticker → nudge, no LLM | 40-char command limit | same action twice |
| Cases | switch/new/same flow | unknown caseId | no cases → listEmpty | 5-case cap | rapid switch |
| Confidence | ≥85 final | <85 question ×2 → best guess | no key → missing-key msg | score exactly 85 | — |
| WhatsApp | photo+pin → text+voice | unsupported mimetype | no key → text-only; empty STT → re-record ask | quota 20/day (judge) | "hi" → welcome only, no quota burn (verify AUD-025) |
| Cleanup | old files swept | TTL=0 → skip+warn (P1) | dirs missing → no-op | TTL change without restart | — |

## State / auth / deps
- Fresh / existing / stale (TTL) / repeated-op per case flow.
- anon vs web-UUID vs phone JID; allowlist on/off; judge mode.
- Gemini down / weather down / Deepgram down / Sarvam down / ffmpeg missing /
  Chrome missing → degraded-but-replying check each.
- Concurrent same-session messages → serialized (lock); concurrent different
  sessions → parallel.

## Regression gates per fix
Each P-item: focused test + `npm test` + manual smoke of upload/message/case-switch.
No fix lands with suite redder than baseline.

## NEEDS VALIDATION verifications — all classified (0 remain)
- AUD-024 → NOT A BUG (defaultUrlTransform + safeProtocol verified; explicit urlTransform pinned).
- AUD-025/026/027/028/030/031 → CONFIRMED + FIXED (selectSenderDigits/quota order, safeExt, voice notice, backoff, execFile, lang warn).
- AUD-032 → LIKELY/MITIGATED (60 s grace; refcount P2 R10).
- AUD-036 → PARTIAL (ack fixed; id collision accepted LOW debt).
- AUD-035 parked-overwrite claim → disproven (unreachable); real drop-path orphans FIXED.

## Still NEEDS MANUAL (no harness/keys here)
- Live WhatsApp session (voice in/out, quota, welcome) — needs Chromium + linked phone.
- Live double-click/double-send browser repro — needs browser harness.
- Lock-120 s / weather-15 s soak under hung downstream — needs fault injection.
- Gemini-dependent transitions (confident/question/completed) — needs key + quota budget.
