# SC-Main — Seed Verification Add-On PRD

## 0. Document purpose

This PRD defines the product requirements for adding **Seed Verification** to the existing SC-Main crop-disease system.

This is an **add-on**, not a replacement. The existing crop-diagnosis behavior remains intact unless a requirement below explicitly says otherwise.

The implementation agent must treat this PRD together with:

1. `SC_MAIN_INTEGRATED_ARCHITECTURE.md` — technical source of truth for the integrated design.
2. `AGENT_GUIDELINES.md` — non-negotiable implementation behavior.
3. `BUILD_PROMPT.md` — execution protocol for the coding agent.

---

## 1. Product context

SC-Main already supports Web and WhatsApp conversations through one shared reasoning core, with one conversation containing multiple cases. The existing crop workflow uses photo + location, Gemini vision, live weather, simulated soil information, confidence-gated reasoning, multilingual replies, and WhatsApp voice input/output.

Seed Verification adds a second domain to the same product. It must work through **both Web and WhatsApp**, use the existing Gemini `gemini-2.5-flash` setup and existing Gemini vision capability, and reuse the existing conversation/case infrastructure.

### Critical distinction

Seed verification is **photo-first** and **does not require location**.

Crop diagnosis keeps its existing **photo + location** requirement.

The routing layer must therefore decide the domain before applying domain-specific slot requirements.

---

## 2. Product goal

Help a farmer make a safer decision about seed by combining multiple available evidence signals rather than pretending that a seed photo alone can prove authenticity.

The seed system must support three broad user situations:

- **Branded / packaged seed** — inspect the seed and packet information and cross-check available internal reference data.
- **Open / loose seed** — inspect the seed, seller information, seller claims, price, and available internal reference data.
- **Post-purchase complaint** — record evidence and complaints, aggregate patterns, and create a human-review task where policy requires it.

The system must distinguish between:

- observation,
- evidence,
- assessment,
- recommendation,
- human-reviewed enforcement action.

---

## 3. Users

### 3.1 Farmer

A farmer interacts through Web or WhatsApp using text, images, and, on WhatsApp, existing voice capabilities.

The farmer expects:

- simple questions,
- responses in their language,
- no unnecessary repetition,
- a clear explanation of why something is considered normal, unusual, or uncertain,
- practical next steps when evidence is insufficient.

### 3.2 Reviewer

A human reviewer validates flagged seed-related evidence before confirmed watchlist/report outcomes.

The reviewer interface is **not specified by the current requirements**. The backend must therefore provide a review-task model and service contract without inventing a particular admin UI.

---

## 4. Product scope

### In scope

- Seed Verification through Web and WhatsApp.
- Seed photo intake.
- Seed-domain routing inside the existing conversation/case system.
- Branded/packaged seed workflow.
- Open/loose seed workflow.
- Optional packet analysis for branded seeds.
- Packet field extraction where readable.
- Visual seed observation using existing Gemini vision capability.
- Seller, price, scheme, brand, seed and complaint reference providers behind interfaces.
- Simulated/internal provider implementations for the MVP.
- Evidence provenance.
- Deterministic seed risk assessment.
- Farmer-facing guidance.
- Human review for suspicious cases.
- Confirmed watchlist/report state after human review.
- Post-purchase complaint workflow.
- Multichannel parity: Web + WhatsApp.
- Existing WhatsApp text/image/voice behavior.
- Existing multilingual response capability.
- In-memory state for the MVP.
- Tests for seed routing, workflows, evidence, risk and failure cases.

### Explicitly out of scope unless later approved

- Real government/official API integration.
- Real official seller/licence verification.
- Real official seed-lot verification.
- Durable database persistence.
- Multi-instance horizontal scaling.
- Automatic blacklisting based solely on AI output.
- A specific reviewer UI technology.
- A new WhatsApp API provider; continue using the existing `whatsapp-web.js` channel.
- A second independent vision model; the existing architecture identifies this as future work, not part of this add-on.
- Any invented barcode/QR verification API or library that has not been selected.

---

## 5. Core product rules

### R1 — One shared product brain

Web and WhatsApp must ultimately use the same backend orchestration path. Seed Verification must not become a WhatsApp-only business implementation.

### R2 — Preserve existing crop diagnosis

The existing crop-disease workflow remains unchanged except for adding domain-aware routing before its existing slot validation.

### R3 — Seed requires a photo, not location

A seed-verification case must be able to progress without coordinates.

### R4 — No silent domain guessing when ambiguous

If the system cannot safely distinguish crop diagnosis from seed verification, ask a clarification question rather than choosing a domain silently.

### R5 — Explicit case commands remain deterministic

Existing case commands such as `new`, `same`, `list`, and case switching must remain deterministic. Seed-aware routing is added to the existing resolver rather than creating a new case manager.

### R6 — AI cannot directly enforce

Gemini may provide observations, extraction, explanations, or recommendations. It must not directly blacklist a seller, brand, or lot.

### R7 — Unknown is not verified

If a provider is unavailable, the result is `UNKNOWN`. Missing evidence must never become a positive verification result.

### R8 — Simulated data must remain labeled simulated

The MVP has no confirmed official seed/seller/scheme/price API or dataset. Simulated/internal evidence must never be worded as official government confirmation.

### R9 — Evidence must be explainable

A seed assessment must be reconstructable from its stored evidence and assessment snapshot.

### R10 — Human review before enforcement

The enforcement path is:

```text
Suspicion
  ↓
ReviewTask
  ↓
Human decision
  ├── DISMISSED
  └── CONFIRMED
        ├── WATCHLIST
        └── REPORT
```

---

## 6. Functional requirements

### FR-01 — Seed intent

The backend must recognize a seed-verification conversation as a separate domain from crop diagnosis.

### FR-02 — Seed photo

The system must require a usable seed-related image before seed analysis proceeds.

A seed workflow must not require GPS coordinates.

### FR-03 — Purchase mode

For seed verification, the system must determine whether the farmer is dealing with:

- branded/packaged seed,
- open/loose seed,
- or an unresolved mode.

When the mode is unresolved, ask the farmer instead of guessing.

### FR-04 — Branded seed

The branded workflow must be capable of collecting, where available:

- seed image,
- packet image,
- brand,
- crop,
- variety,
- lot/batch identifier,
- MRP or visible price information,
- printed dates,
- certification/label information,
- barcode/QR result if a decoding capability is actually available,
- seller details when needed,
- observed purchase price.

Unreadable or missing fields must remain unknown or trigger a targeted request for the missing critical field.

### FR-05 — Open seed

The open-seed workflow must be capable of collecting, where needed:

- seed image,
- seller/shop identity,
- seller location/details supplied by the farmer,
- claimed crop/variety,
- price,
- seller claims such as a government-scheme claim.

### FR-06 — Evidence provider layer

The system must obtain seed-domain reference information through provider interfaces. MVP providers are simulated/internal.

Provider categories include:

- seed,
- brand,
- seller,
- price,
- scheme,
- complaint/reference data.

### FR-07 — Evidence provenance

Every provider-derived evidence record must carry source/provenance metadata sufficient to tell whether it came from:

- user input,
- model output,
- simulated/internal data,
- system rule,
- or a future externally verified provider.

### FR-08 — Risk assessment

The seed risk engine must combine available evidence using deterministic, configurable rules.

The exact final weights and thresholds are **not fixed by this PRD** and must not be invented by the implementation agent.

### FR-09 — Farmer guidance

The farmer-facing output must explain the material evidence in plain language and clearly distinguish:

- normal/low-risk signals,
- warnings,
- contradictions,
- unknowns,
- and required verification steps.

### FR-10 — Complaint reporting

A farmer must be able to report a post-purchase problem against a seed/brand/seller/lot when enough identifying information is available.

Complaints must be stored separately from confirmed wrongdoing.

### FR-11 — Review queue

Suspicious cases may create a human-review task containing the assessment snapshot and evidence bundle.

### FR-12 — Confirmed outcomes

Only a human review decision can move a subject into confirmed watchlist/report state.

### FR-13 — Existing voice behavior

WhatsApp voice input/output continues to use the existing STT/TTS services. Seed business logic receives normalized text/language data and does not directly depend on WhatsApp media semantics.

### FR-14 — Multichannel parity

A seed case started on Web or WhatsApp must use the same domain logic, case model, evidence model and risk rules.

### FR-15 — Failure tolerance

A failed provider or AI call must not corrupt case state. The workflow must preserve the distinction between unavailable and verified.

---

## 7. Non-functional requirements

### NFR-01 — No cross-case leakage

Evidence and conversation history from one case must not silently become evidence for another case.

### NFR-02 — Ordering

Messages from the same conversation must be processed serially so rapid WhatsApp messages cannot interleave state mutations.

### NFR-03 — Idempotency

Repeated receipt of the same WhatsApp message must not create duplicate case updates or duplicate replies.

### NFR-04 — Bounded AI behavior

AI responses must be schema-validated. Invalid model output must not directly mutate risk or enforcement state.

### NFR-05 — Traceability

Critical workflow actions must be correlated through a correlation ID and auditable events.

### NFR-06 — Privacy

Logs must not contain unnecessary phone numbers, full media content, or secrets.

### NFR-07 — Media hygiene

Temporary media must follow the existing cleanup/TTL strategy.

### NFR-08 — MVP persistence

Business state remains in-memory. Restart loss is an explicit MVP limitation.

### NFR-09 — Testability

All new deterministic rules must be testable without real API keys. Provider interfaces must support controlled test doubles.

---

## 8. Seed case states

Use the integrated architecture state machine. The implementation may add states only if a real requirement requires them and the change is documented before implementation.

Conceptually:

```text
NEW
 ↓
COLLECTING_INFORMATION
 ↓
NEEDS_CLARIFICATION (when required)
 ↓
ANALYSIS_PENDING
 ↓
ASSESSING
 ├── RESULT_READY
 └── FLAGGED_FOR_REVIEW
       ├── DISMISSED
       └── CONFIRMED
             ├── WATCHLIST
             └── REPORT
```

A post-purchase complaint may reopen a completed seed case as a progression/reporting interaction, while a clearly new seed purchase creates a new case.

---

## 9. Seed evidence model

The risk engine must reason over evidence categories rather than one binary fake/genuine value.

Possible categories include:

```text
VISUAL CONSISTENCY
PACKET EXTRACTION CONSISTENCY
BARCODE / QR RESULT, IF AVAILABLE
BRAND / CATALOG CONSISTENCY
SEED / VARIETY CONSISTENCY
OBSERVED PRICE VS REFERENCE
SELLER RECORD / SELLER CLAIM
SCHEME / SOURCE CONSISTENCY
COMPLAINT HISTORY / PATTERN EVIDENCE
FARMER-PROVIDED STATEMENTS
```

Each evidence signal can be:

```text
SUPPORTING
WARNING
CONTRADICTORY
UNKNOWN
```

The exact risk math is configurable and not to be invented by the agent.

---

## 10. User stories and acceptance criteria

### Story A — Farmer starts seed verification on WhatsApp

**Given** a one-to-one WhatsApp chat,
**when** the farmer sends a seed photo,
**then** the message enters the shared backend and a seed case may be created without requiring location.

### Story B — Farmer starts seed verification on Web

**Given** the Web chat,
**when** the farmer uploads a seed photo without coordinates,
**then** the seed workflow can continue.

### Story C — Existing crop diagnosis remains protected

**Given** an existing crop case,
**when** the farmer provides the crop photo,
**then** the current crop-diagnosis path still enforces its existing photo + location rule.

### Story D — Branded seed

**Given** a seed case identified as branded,
**when** packet information is needed,
**then** the workflow requests a packet image or missing critical packet data and does not invent unreadable values.

### Story E — Open seed

**Given** an open-seed case,
**when** the seller and price are supplied,
**then** the workflow checks the available provider interfaces and produces evidence without treating a clean seller record as proof of authenticity.

### Story F — Simulated provider

**Given** the price provider is simulated,
**when** price evidence is returned,
**then** the evidence and farmer-facing language must make clear that it is not official government verification.

### Story G — High-risk case

**Given** configured rules produce a high-risk assessment,
**when** the assessment is generated,
**then** a review task is created rather than directly changing a seller/brand/lot to confirmed blacklist status.

### Story H — Human dismissal

**Given** an open review task,
**when** a reviewer dismisses it,
**then** the subject is not placed into confirmed watchlist/report state.

### Story I — Duplicate WhatsApp message

**Given** the same WhatsApp message event is received twice,
**when** processing occurs,
**then** only one accepted state mutation and one response are produced.

### Story J — Provider outage

**Given** a seller or price provider is unavailable,
**when** the assessment runs,
**then** the affected signal becomes `UNKNOWN`; it must not become verified or safe by default.

---

## 11. Explicit non-requirements

The following must not be invented by the coding agent:

- official government verification,
- official seed-lot lookup,
- exact legal blacklist semantics,
- exact risk score weights,
- a reviewer UI technology,
- a new authentication system,
- database persistence,
- a new WhatsApp transport,
- a second vision model,
- a particular barcode/QR library.

When implementation requires one of these decisions, stop and ask.

---

## 12. Definition of Done

The Seed Verification add-on is considered implementation-complete only when:

1. Existing crop-diagnosis tests remain green.
2. New seed-domain unit tests are green.
3. Web and WhatsApp use the same seed workflow.
4. Seed cases do not require location.
5. Crop cases still require location according to the current implementation.
6. Branded and open workflows are separate but share the evidence/risk layer.
7. Simulated provider data is visibly labeled as simulated/internal.
8. Unknown provider results remain unknown.
9. AI output is schema-validated before use.
10. Duplicate messages do not duplicate business actions.
11. Risk assessment cannot directly enforce a blacklist.
12. Human review is required before confirmed watchlist/report state.
13. No existing crop behavior was silently changed.
14. All tests are green before the phase is considered complete.
15. The implementation agent stops and waits for explicit approval before starting the next phase.
