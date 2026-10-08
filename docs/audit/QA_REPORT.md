# QA_REPORT — baseline (pre-fix) + P0 post-fix results

## Baseline (pre-fix, 2026-10-08)
| Command | Result |
|---------|--------|
| `cd server && npm test` (no node_modules) | ❌ 3/3 files fail: `ERR_MODULE_NOT_FOUND: whatsapp-web.js`. |
| `npm ci` (server + client, cache `D:/TEMP/npm-cache`) | ✅ both installed. `package.json`/lockfiles untouched (timestamps 01:36 preserved); only `node_modules/` added. |
| Post-install `npm test` | ✅ 105 pass / 0 fail (actual count — "16 tests" claim in ARCHITECTURE.md was wrong). |

## Post-fix validation (P0-A + P0-B + P0-C)
| Command | Result |
|---------|--------|
| `node --test test/geo-integrity.test.js` (P0-A) | ✅ 10/10 |
| `node --test test/session-isolation.test.js test/geo-integrity.test.js` (P0-B) | ✅ 18/18 |
| `node --test test/guards.test.js` (P0-C) | ✅ 5/5 |
| Full `npm test` | ✅ **128/128** (105 baseline + 23 new) |
| `cd client && npm run build` | ✅ built in 9.10 s (ChatContainer.jsx change compiles) |

## Adversarial retests (repro before → verify after)
- `getWeatherData('abc','xyz')` → before: `{28,60,0}` no flag; after: same
  numbers **with `source:'fallback'`**, no network call. Satellite on garbage →
  before: `moisture:null, nitrogen:'High'`; after: all finite + `source:'estimated'`.
- `isSenderAllowed(['998426078507'],['8426078507'])` → before `true`; after `false`.
  Legit 91-prefix / bare / LID-candidate forms still `true`.
- Two guests on `'web_guest_user'` → before: same conversation, shared photos;
  after: bucket abolished (`getConversation` throws, controllers 400).
- `RATE_LIMIT_PER_MINUTE=abc` → before: limiter dead; after: 30 enforced + warn.
- Upload with `lat:"abc"` → 400 + orphan file deleted (code path read-verified;
  live-multipart test not run — needs running server).
- `MEDIA_TTL_HOURS=0` (AUD-011) → NOT fixed (P1, out of P0 scope). NOT tested
  on real data.

## Coverage verdict
TG-001..004 still stand (STT/TTS/cleanup/handler-chain untested) — P0 added
controller-boundary + geo + guard tests only. No existing test was rewritten.

## P0 live-smoke verification (2026-10-08, port 4001, WEB-ONLY mode)
Server launched detached (`D:/TEMP/hermes-smoke-server.log`), real multipart
uploads against the running API:
- Invalid coords `{"lat":"abc","lon":"xyz"}` → **400**
  `Invalid coordinates: lat must be -90..90, lon -180..180 (finite numbers)`;
  `user_img_web/` file count 0 → 0 (**no orphan**). ✅
- Valid coords `{26.9,75.8}` → **200**, case created, Gemini live-called
  (blank-fixture photo → "appears to be blank" reply, `diagnostic:null`). ✅
- No coords → **200** + location-pin nudge (slot flow intact). ✅
- No sessionId → **400** `sessionId is required`, no orphan. ✅
- Smoke files cleaned (`user_img_web/` back to 0); server stopped post-test.
- WhatsApp handler paths still need a live session (Chrome missing in this env).

## Unresolved / environmental (pre-closeout snapshot — see Closeout below)
- WhatsApp handler paths need a live WA session (Chrome missing in this env).
- NEEDS VALIDATION items (AUD-024..028, 030..032, 036) still pending.
- No git repo — change review was manual file-by-file (15 files, list in report).
- `client/dist/` created by build verification; untracked, harmless.

## R1 verification (2026-10-08, AUD-007 upload hardening)
| Command | Result |
|---------|--------|
| `node --test test/upload-validation.test.js` | ✅ **13/13** (valid ×6, wrong-ext, wrong-MIME, mismatch ×2, renamed-EXE, malformed ×2, empty, sparse-oversize, rejection-cleanup ×2, downstream-cleanup) |
| Live smoke port 4002: EXE-bytes as `evil.jpg` + spoofed `image/jpeg` | ✅ **400** `not a valid image`, `user_img_web/` 0 files (attack blocked, no orphan) |
| Live smoke: real 1px PNG + valid session/coords | ✅ **200**, case created, Gemini live reply |
| Live smoke: `package.json` as `image/jpeg` | ✅ **400** `Only JPG, PNG, WebP or GIF` (ext gate), file count unchanged |
| `cd server && npm test` (full, after ALL R1 edits) | ✅ **178/178** (105 baseline + 73 new) |
| `cd client && npm run lint` | ✅ clean (R1 touched server only) |
| `cd client && npm run build` | ✅ 686 ms, 179 modules |
| Smoke cleanup | ✅ server stopped, `user_img_web/` back to 0, fixtures removed from `D:/TEMP` |

R1 self-review note: the first `IMAGE_FORMATS` draft used AND-semantics across
all signatures (would have rejected every GIF); caught on re-read before any
test ran and reworked to variants (OR-of-AND). The first R1-8 test contained
dead stub code; replaced with a real sparse-file check before green.

## R2 verification (2026-10-08, AUD-017 per-case transcript contract)
Contract traced before code: both controllers return exactly
`{ai_response, diagnostic, conversation, needsClarification}` with
`conversation = serializeConversation(...)` (identity/display fields only —
no history, no diagnostic_data, no coord values, no photo URLs; verified by
grep + read + JSON-stringify assertions). Client consumes `conversation.cases`
(`caseId/label/status`), `activeCaseId`, `ai_response`, `needsClarification`;
`diagnostic` is currently unconsumed (kept — harmless, future use). The mixing
symptom lived purely client-side (shared append-only `messages`). No contract
change was needed — a dedicated DTO already existed.

Fix: `caseId` stamping on user-text, user-image, and bot bubbles +
render-side filter to `activeCaseId` with unstamped-always-render fallback
(nothing can vanish: legacy/optimistic bubbles have no stamp).
| Command | Result |
|---------|--------|
| `node --test test/case-contract.test.js` | ✅ **10/10** (exact field sets, multi/empty cases, transcript/photo/coords/internal non-leakage, isolation, required-fields, filter predicate) |
| self-review note | first R2-7 draft false-failed on its own fixture id (`t-r2-internal` contains the needle `internal`); DTO proven clean by direct dump; fixture renamed, comment left in test |
| `cd server && npm test` (full, after ALL R2 edits) | ✅ **188/188** (105 baseline + 83 new) |
| `cd client && npm run lint` | ✅ clean |
| `cd client && npm run build` | ✅ 711 ms, 179 modules |

## R3 verification (2026-10-08, AUD-016 canonical language boundary)
Failure reproduced BEFORE fix (offline `processMessage` runs):
- `'xx-evil'` → stored verbatim into `conversation.language` → interpolated raw into the Gemini system instruction (prompt-injection shaped input reaches the model);
- `'GU'` / `'hi-Latn'` → stored verbatim (case/variant-sensitive downstream misses);
- `12345` (number) → **TypeError crash** in `buildGatheringNudge` (`(lang||'').split is not a function`) — confirmed stack trace.

Supported set from evidence (not invented): session STRINGS (en, hi) ∪
gathering nudges (hi gu mr ta te kn ml pa bn en) ∪ agent langInstruction
(same 10) ∪ TTS map (+or/od) → 11 canonical codes, `od`→`or` alias, default `hi`.
Semantics: valid → canonical; invalid on established session → keep prior (no
400 on live conversations); invalid with no prior → `hi`. Providers only ever
see canonical codes.
| Command | Result |
|---------|--------|
| `node --test test/language-boundary.test.js` | ✅ **14/14** (all 11 codes, aliases, casing/variants, 14 invalid classes, coerce keep-prior/default/never-throw, 5 agent-integration incl. crash repro, provider-safety sweep) |
| `cd server && npm test` (full, after ALL R3 edits) | ✅ **202/202** (105 baseline + 97 new) |
| `cd client && npm run lint` | ✅ clean (R3 server-only) |
| `cd client && npm run build` | ✅ 694 ms, 179 modules |

## Closeout verification (2026-10-08, after ALL source edits)
| Command | Result |
|---------|--------|
| `cd server && npm test` | ✅ **202/202** (105 baseline + 97 new; ~120 s wall — real-ffmpeg + live-weather tests dominate, all genuine) |
| `cd client && npm run lint` | ✅ clean |
| `cd client && npm run build` | ✅ 694 ms, 179 modules |
| Trust-proxy default check | ✅ unset/garbage `TRUST_PROXY_HOURS` → 0 hops (fail-closed; XFF spoof can't dodge limiter) |
| Diff review (no git — manual) | ✅ no debug code, no secret leakage (only `apiKey` variable refs + ``Token ${...}`` interpolation), `package.json`/lockfiles untouched (01:36), no dep changes |

No source file changed after the 165 run except docs — the closeout fixes
(AUD-034 trust-proxy, AUD-035 drop-path orphans, AUD-036 ack) are inside the 165
(lifecycle.test.js 8/8 incl. 2 new closeout tests).

### Uncertainty dispositions (closeout)
- AUD-032 → MITIGATED (60 s grace covers realistic sends); true in-flight refcount P2.
- `message_id` Date.now collision → LOW accepted debt (single display-only field; worst case duplicated React key on same-ms double upload).
- STT `maxBodyLength: 25 MB` confirmed present (`stt.service.js:64`) — sane for voice notes; NOT A BUG.
- Live WA session + live double-click repro → NEEDS MANUAL (no Chromium / browser harness here).
- Lock 120 s + weather 15 s → code-verified, soak NEEDS MANUAL.
- AUD-024 → NOT A BUG (defaultUrlTransform + safeProtocol verified in installed tree); AUD-035 overwrite claim → disproven (unreachable path).
