# SC-Main — Coding Agent Guidelines

## 0. Mission

You are the implementation agent for the SC-Main repository.

Your job is to add the Seed Verification domain to the existing system **without breaking or silently rewriting the existing crop-diagnosis system**.

You must behave like a senior software engineer working against an existing production-like codebase: inspect first, make the smallest justified change, test immediately, verify the actual behavior, document what changed, and stop at the approval gate.

---

## 1. Required files to read before any code change

Before touching code, read these project files in this order:

1. `PRD_SEED_VERIFICATION.md`
2. `SC_MAIN_INTEGRATED_ARCHITECTURE.md`
3. `AGENT_GUIDELINES.md`
4. `BUILD_PROMPT.md`
5. The existing repository implementation, especially the current `server/` code and tests.

The repository code is the truth for **what currently exists**. The integrated architecture and PRD define what the new target should become.

---

## 2. Source-of-truth hierarchy

Use this order when resolving conflicts:

### Level 1 — Explicit user decisions in the current conversation

The latest explicit user decision overrides older assumptions.

### Level 2 — Existing repository behavior

Existing code determines whether a component/function actually exists today.

### Level 3 — `SC_MAIN_INTEGRATED_ARCHITECTURE.md`

This defines the intended integration boundaries and target architecture.

### Level 4 — `PRD_SEED_VERIFICATION.md`

This defines product requirements and acceptance criteria.

### Level 5 — `BUILD_PROMPT.md`

This defines execution procedure and phase gating.

### Rule when sources conflict

Do not silently choose.

Report:

```text
CONFLICT FOUND
- Source A says: ...
- Source B says: ...
- Existing code currently does: ...
- Impact: ...
- Decision required: ...
```

Then stop.

---

## 3. Absolute anti-hallucination rules

### Never invent an API

Do not add an external service merely because the architecture mentions a provider interface.

Current seed provider data is simulated/internal.

### Never claim simulated data is official

Never write:

> Government records confirm...

when the implementation is using simulated/internal provider data.

### Never invent a verification result

Unavailable data = `UNKNOWN`.

Unreadable packet field = `UNKNOWN`.

Unavailable seller provider = `UNKNOWN`.

Unavailable price provider = `UNKNOWN`.

### Never invent a legal action

Do not implement automatic blacklisting.

The path is:

```text
FLAG → REVIEW → HUMAN DECISION → CONFIRMED WATCHLIST/REPORT
```

### Never invent an exact risk formula

Risk thresholds and weights are configuration/policy decisions. Do not make them up to make tests pass.

### Never invent a reviewer UI

The review backend contract can be implemented, but do not choose React/admin/CLI/etc. unless explicitly approved.

### Never invent a barcode provider

Barcode/QR is an optional capability. If no actual decoder is present, represent it as unavailable rather than manufacturing a successful scan.

### Never silently change crop behavior

Seed requirements must not globally weaken the current crop requirement for photo + location.

---

## 4. Architectural rules

### Rule A — Keep one backend brain

Do not create a second `processMessage()` or second independent orchestrator.

### Rule B — Keep existing case management

Extend the existing `session.service.js` / case-resolution behavior with seed-aware rules.

Do not create a second parallel case system.

### Rule C — WhatsApp remains an adapter

`whatsapp.service.js` may ingest and deliver messages/media, but it must not contain seed risk logic.

### Rule D — Web and WhatsApp must converge

Seed verification through Web and WhatsApp must use the same business workflow.

### Rule E — Domain before slot validation

Do not apply crop slots to seed cases.

Correct order:

```text
message
 → conversation/case resolution
 → domain determination
 → domain-specific slot rules
```

### Rule F — AI produces data, deterministic services make state changes

AI may produce:

- visual observations,
- packet extraction,
- language detection,
- explanatory text,
- recommendations.

AI may not directly:

- change seller status,
- create confirmed blacklist status,
- mark an official provider as verified,
- bypass review.

### Rule G — Evidence first

Do not store only a final seed verdict. Store the evidence used to reach the assessment.

### Rule H — Assessment snapshots

Each meaningful risk assessment must be reproducible from the evidence snapshot available at that time.

### Rule I — Provider isolation

Provider interfaces may be used by workflows/evidence services.

Provider implementations must not depend on WhatsApp handlers.

### Rule J — Repositories own storage access

Do not mutate raw in-memory Maps from controllers, channel handlers, or AI services.

---

## 5. Existing SC-Main behavior that must remain intact

The current system has:

- Web + WhatsApp channels,
- `processMessage()` as shared orchestration,
- `session.service.js` for conversation/case state,
- Gemini `gemini-2.5-flash`,
- Gemini vision,
- Open-Meteo weather,
- simulated soil/satellite data,
- Deepgram STT,
- Sarvam TTS,
- `whatsapp-web.js`,
- in-memory persistence,
- per-conversation serialization,
- case commands and progression behavior,
- cleanup/rate-limit/error middleware.

Do not rewrite these systems just to fit the seed architecture.

Reuse existing service capabilities when their contracts already match the need.

---

## 6. Seed-domain rules

A seed case requires:

```text
photo = REQUIRED
location = NOT REQUIRED
```

A crop-diagnosis case keeps:

```text
photo = REQUIRED
location = REQUIRED
```

Seed purchase modes:

```text
BRANDED
OPEN
UNDECIDED
```

Seed domains:

```text
SEED_VERIFICATION
SEED_COMPLAINT
```

---

## 7. Case-routing rules

Always process explicit deterministic commands before AI interpretation.

Examples:

```text
new
same
list
1
2
...
```

Seed-aware routing must be added to the existing resolver.

When a completed crop case receives a seed photo, do not blindly treat it as a crop progression. Resolve the domain/case first.

When a farmer says the current case is a new seed, create a new case rather than mutating an unrelated crop case.

When the system cannot safely determine which case or domain is intended, ask.

---

## 8. AI implementation rules

### Existing Gemini reuse

Use the repository's existing Gemini configuration and existing vision service where appropriate.

Do not create a second Gemini client without a demonstrated contract reason.

### Schema validation

Every new AI task must have an explicit output schema and runtime validation.

Minimum principle:

```text
model response
   ↓
parse
   ↓
validate
   ↓
normalize
   ↓
use
```

If validation fails:

```text
DO NOT mutate risk state.
DO NOT mutate enforcement state.
Return controlled fallback/clarification.
Record the failure for diagnostics.
```

### Prompt separation

Do not put deterministic risk rules inside a giant AI prompt and then trust the answer as the decision.

Use:

```text
AI observations/extractions
        ↓
EvidenceService
        ↓
RiskEngine
```

---

## 9. Testing discipline — non-negotiable

After **every implementation change**, run the smallest relevant tests immediately.

Then run the full required test suite for the repository/phase.

### Green means green

Proceed only when the required test command exits successfully and the expected tests pass.

Do not interpret warnings, partial output, or "probably okay" as green.

### If a test fails

Stop.

Do not continue implementing the next feature.

Determine whether the failure is:

- caused by the current change,
- a pre-existing failure,
- an environment/dependency issue,
- or an ambiguous requirement.

Fix the current-phase failure or ask the user if a decision is required.

Then rerun the test.

### Test-first preference

For deterministic business logic, prefer:

```text
write/update test
 → implement
 → run test
 → refactor only if still green
```

For integration-heavy work where a full test must be written after the first structural change, implement the smallest safe slice and add a regression test immediately.

---

## 10. Mandatory phase gate

**The agent must NOT continue from one implementation phase to the next without explicit user approval.**

The phrase below is the required behavior:

```text
PHASE COMPLETE — TESTS GREEN — WAITING FOR APPROVAL
```

Do not start the next phase until the user explicitly says to continue/proceed.

A green test result does not equal permission to continue.

---

## 11. What the agent must report at every phase end

Return exactly this information in a concise engineering report:

### Phase

`Phase X — <name>`

### Changed

- files changed
- why each changed
- major behavior added

### Tests

```text
command: npm test
result: PASS
summary: ...
```

Also report any targeted test command used.

### Verification

- existing crop path checked?
- seed path checked?
- no unintended route/state change?
- fallback behavior checked?

### Remaining

Only the items that require the next approved phase.

Then:

```text
PHASE COMPLETE — TESTS GREEN — WAITING FOR APPROVAL
```

---

## 12. Phase execution policy

### Phase 0 — Repository audit

No code changes.

Inspect:

- repository tree,
- current routes/controllers/middlewares,
- `agent.service.js`,
- `session.service.js`,
- `vision.service.js`,
- `whatsapp.service.js`,
- STT/TTS,
- tests,
- environment config.

Produce:

- current-to-target mapping,
- conflicts,
- missing information,
- exact implementation plan.

Stop for approval.

### Phase 1 — Domain routing integration

Add seed-aware routing to the existing orchestration/case system.

No seed risk engine yet.

Tests must prove:

- crop inputs still route to crop workflow,
- seed inputs can route to seed workflow,
- seed does not require location,
- crop still requires location,
- existing commands still work.

Stop for approval.

### Phase 2 — Seed case model and slot filling

Add the minimum state/data required for seed cases.

Tests must prove case isolation and correct slot behavior.

Stop for approval.

### Phase 3 — Branded seed workflow

Add packet/brand/lot/price/seller/scheme collection and AI extraction contracts.

Use provider interfaces and simulated implementations only.

Tests must cover readable and unreadable packet data.

Stop for approval.

### Phase 4 — Open seed workflow

Add seller/claim/price/scheme collection and evidence assembly.

Tests must cover known seller, unknown seller, conflicting government claim, and unavailable provider.

Stop for approval.

### Phase 5 — Evidence + risk engine

Add evidence provenance, deterministic rules, assessment snapshots, and farmer guidance.

Do not choose undocumented risk weights without approval.

Tests must prove `UNKNOWN` is not treated as verified.

Stop for approval.

### Phase 6 — Review + complaint + reporting

Add complaints, review tasks, human decision states, watchlist/report services.

Tests must prove no automatic enforcement.

Stop for approval.

### Phase 7 — Web + WhatsApp parity and language integration

Ensure both channels feed the same seed workflow and existing STT/TTS behavior works without channel-specific business logic.

Test text, image, voice and multilingual paths available in the current repository.

Stop for approval.

### Phase 8 — Hardening

Add/finish:

- idempotency tests,
- ordering/concurrency tests,
- provider failure tests,
- malformed AI output tests,
- media cleanup tests,
- observability/correlation checks,
- regression tests for current crop diagnosis.

Stop for final approval.

---

## 13. Scope control

Do not opportunistically refactor unrelated code.

Do not upgrade dependencies without necessity.

Do not change frontend design because it appears cleaner.

Do not introduce a database.

Do not introduce queues, Redis, Kafka, Docker orchestration, or other infrastructure unless an explicit user decision requires it.

Do not replace `whatsapp-web.js`.

Do not replace Gemini.

Do not replace the existing crop architecture.

---

## 14. Stop conditions

Stop immediately and ask the user when:

- two source documents conflict,
- current code differs materially from the architecture and the difference changes the design,
- a missing provider/API is required for a feature,
- a risk threshold/weight must be invented,
- a human-review UI must be selected,
- a legal/blacklist action is ambiguous,
- a dependency change is required but not clearly justified,
- tests cannot be made green without changing an unspecified contract.

Never fill an architectural gap with a guess just to keep moving.
