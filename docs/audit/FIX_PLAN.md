# FIX_PLAN — prioritized, smallest-safe-change order

Rule: fix upstream root causes before downstream symptoms. No refactors bundled.

**STATUS 2026-10-08 post-R3: P0 + P1 + closeout + R1 + R2 + R3 DONE (29 fixed, 2
dismissed, suite 202/202, client lint+build green). Remaining below is P2/P3.**
Items marked ~~struck~~ are complete; open items R4..R10 (R1/R2/R3 done).

## P0 — correctness / data integrity (do first)
1. AUD-005 coords + fallback honesty
   - Files: `upload.controller.js`, `weather.service.js`, `satellite.service.js`,
     `agent.service.js` (prompt builders).
   - Change: validate `{lat,lon}` finite + ranges on upload (400 otherwise);
     add `source:'live'|'fallback'` to weather return; guard satellite NaN inputs
     (fall back to neutral + flag); interpolate `source` fields into prompts.
   - Tests: upload 400 on `lat:"abc"`; weather fallback carries flag; satellite
     NaN → neutral + flagged; prompt contains source markers.
   - Risk: LOW. Rollback: revert validation commit.
2. AUD-006 fallback honesty in prompts (same change as above, same tests).
3. AUD-002 guest isolation
   - Files: `message.controller.js`, `upload.controller.js`, `ChatContainer.jsx`.
   - Change: server 400s missing `sessionId`; client generates in-memory UUID
     when `localStorage` blocked (no shared constant).
   - Tests: missing sessionId → 400; two blocked-storage clients get distinct ids.
   - Risk: LOW (WhatsApp JID path untouched).

## P1 — quota protection / reliability
4. AUD-003 double rateLimit — remove router-level `rateLimit`, keep app-level.
   Validate: 30 rapid hits → 30 pass, 31st 429 (not ~15th).
5. AUD-004 env numeric validation — `num(env, default, min, max)` helper;
   invalid → default + warn. Validate: `RATE_LIMIT_PER_MINUTE=abc` → 30 + warn.
6. AUD-008 allowlist exact match — drop `endsWith`, keep `===` + 91-strip.
   Validate: `isSenderAllowed(['998426078507'],['8426078507'])` → false.
7. AUD-009 STT timeout + logging — axios `timeout: 15000`; log status code class,
   still return empty (no fake text). Validate: timeout test with mock.
8. AUD-011 cleanup TTL — read env per sweep; `<=0` → skip + warn (never wipe-all).
9. AUD-012 boot — `initializeWhatsAppClient().catch(...)` → WEB-ONLY log.
10. AUD-001 auth decision — PRODUCT call: accept open demo (document + CORS +
    judge-mode caps) or add optional `API_TOKEN` gate (default open, env-closed).
    Do NOT silently add mandatory auth before demo.

## P2 — state / UX races
11. AUD-014/015 agent state — snapshot-then-mutate or rollback on throw; push
    failure turn to history; cap `history` length (e.g. 50) alongside window slice.
12. AUD-018 web races — single in-flight ref + `AbortController` cancel; busy-guard
    same/new/switch buttons + `disabled={loading}` wiring; `isSendingRef` released
    after settle, not after fire.
13. AUD-017 case transcripts — filter `messages` by active `caseId` or clear on
    switch/new (needs server `caseId` per message — small contract add).
14. AUD-019 location — IP fallback only with explicit user consent chip; add
    fetch timeout + `response.ok`; `isLocating` always cleared in `finally`.
15. AUD-010 TTS — verify WAV fmt/size before concat; on partial-chunk failure
    insert "[audio part missing]" marker or return text-only + notice.
16. AUD-007 upload — extension allowlist (`.jpg/.jpeg/.png/.webp`) + multer
    `fileFilter` re-check ext; consider `POST /user_img_web` auth or random
    unguessable names only (already random — document).

## P3 — hardening / debt
~~17. AUD-016 language allowlist~~ — still OPEN, moved to R3 below.
~~18. AUD-033 lock timeout + weather abort~~ — DONE (120 s watchdog + 15 s abort).
~~19. AUD-034 trust proxy~~ — DONE (`TRUST_PROXY_HOPS`, default 0). Redis note → R6.
~~20. AUD-020/022/023/037 web small fixes~~ — DONE except AUD-020 text-fail rollback → R4.
~~21. INFO-001~~ — still OPEN → R9.
~~22. TG-001..004~~ — TG-001 closed for STT/TTS/cleanup; TG-002 partial; TG-003/004 → R7/R8.

## Remaining work (P2/P3) — renumbered
- ~~R1. AUD-007 upload hardening~~ — DONE 2026-10-08: `server/file-validate.js` (ext+MIME allowlists, magic-byte variants, consistency check) + controller 400 + orphan delete; 13 tests + live EXE-attack smoke (400, 0 files) + legit PNG 200.
- ~~R2. AUD-017 per-case transcript filter~~ — DONE 2026-10-08: contract traced end-to-end — server DTO was already minimal (no change needed). Client fix: caseId stamping on all bubbles + render filter (unstamped always render). 10 contract tests; lint+build green.
- ~~R3. AUD-016 language allowlist~~ — DONE 2026-10-08: `server/language.js` canonical set (11 codes from STRINGS/nudges/TTS evidence) + `normalizeLanguage`/`coerceLanguage`; agent-store boundary (keep-prior-on-invalid, no 400 on live sessions); STT output normalized; WA reply-lang coerced; session default `en`→`hi` unified. Also fixed a REAL crash (non-string language → TypeError in gathering nudge). 14 tests; 202/202 green.
- R4. AUD-020 text-fail optimistic-bubble rollback (upload path already rolls back).
- R5. AUD-019 consent UI for IP-location fallback (server/client already hardened).
- R6. AUD-013/AUD-034 Redis + multi-instance (needs deploy decision, not code-only).
- R7. TG-003 handler-chain tests (needs WA session mocks / Chromium).
- R8. TG-002/TG-004 test dedupe (P3 churn, low value — do last).
- R9. INFO-001 `docs/Flow.md` superseded banner; `ARCHITECTURE.md` test-count correction (16 → 165).
- R10. AUD-032 true in-flight refcount for sweep; AUD-012 outer try/catch tidy.

## Dependencies
- R2 needs the P0 session semantics (done). R6 needs a deploy decision first.
- All NEEDS VALIDATION items are now classified (0 remain).

## Rollback
Each P-item = one commit, one revert. No migrations, no schema, no dep changes.
No `package.json`/lockfile was ever modified; only `node_modules/` added via `npm ci`.
