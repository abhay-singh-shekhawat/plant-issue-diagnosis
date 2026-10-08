# SC-Main — Integrated Architecture: Crop Diagnosis + Seed Verification

## 0. Integration verdict

**Integrated architecture rating: 9.1 / 10.**

This is an **add-on architecture**, not a replacement of the current SC-Main system. The current `processMessage()` entry point, existing Web/WhatsApp adapters, existing conversation/case model, Gemini `gemini-2.5-flash`, existing vision/STT/TTS services, in-memory persistence, and current crop-diagnosis workflow remain the baseline. Seed Verification is inserted as a new intent-driven workflow beside Crop Diagnosis.

The integration deliberately resolves one direct conflict in the current implementation: the current crop-diagnosis path requires both photo and coordinates. That rule remains for **crop diagnosis only**. A **seed-verification case requires a photo but does not require location**.

## 1. Source-of-truth hierarchy

### Existing project architecture

`ARCHITECTURE(4).md` is the detailed implementation architecture: Node/Express single process, React/Web + WhatsApp using `whatsapp-web.js`, `agent.service.js` as the shared orchestrator, `session.service.js` for conversation/case state, existing Gemini vision, Open-Meteo, simulated soil, Deepgram, Sarvam, and in-memory state.

`ARCHITECTURE(3).md` is the shorter plain-English companion and describes the same core model: one brain, two doors, many cases, confidence-gated crop diagnosis, and degrade-never-break behavior.

### New seed architecture

`Seed_Verification_WhatsApp_Backend_Architecture(1).docx` supplies the seed-domain architecture: branded/open workflows, evidence provenance, simulated providers, deterministic risk engine, human review, and seed-specific reliability rules.

### Explicit user decisions for the integration

| Decision | Integrated rule |
|---|---|
| Channels | Seed Verification is available through **both Web and WhatsApp**. |
| Seed location | **No location required.** Seed workflow is photo-first; location is not a gate and is not required for seed assessment. |
| AI | Reuse the existing **Gemini `gemini-2.5-flash`** setup and existing Gemini vision capability. |
| Case routing | Keep the existing resolver and add **seed-aware rules** to it. |
| Data providers | No official provider/API is assumed. Seed reference intelligence remains simulated/internal for MVP. |
| Enforcement | Suspicion → human review → confirmed watchlist/report. No automatic blacklist. |

## 2. What must NOT change

1. `processMessage()` remains the shared orchestration entry point for Web and WhatsApp.
2. WhatsApp remains a channel adapter; it does not receive seed business logic.
3. Existing crop diagnosis keeps its current photo + location gate.
4. Existing crop weather/soil/diagnosis pipeline stays intact.
5. `session.service.js` remains the owner of conversation/case state; do not introduce a second independent case manager.
6. Existing `stt.service.js` and `tts.service.js` remain shared channel capabilities.
7. In-memory persistence remains the MVP persistence choice.
8. Existing one-process deployment shape remains the baseline.
9. Existing graceful fallback behavior remains the baseline for crop diagnosis and is extended to seed providers.

## 3. Integrated high-level architecture

```text
                         FARMER
                    /               \
                   /                 \
                WEB                 WHATSAPP
                 │                      │
                 ▼                      ▼
       existing HTTP adapter     existing whatsapp.service
                 │                      │
                 └──────────┬───────────┘
                            ▼
                   existing processMessage()
                            │
                   +--------▼---------+
                   | conversation     |
                   | lock + routing   |
                   +--------┬---------+
                            │
                            ▼
                existing session.service
                 resolveTargetCase()
                            │
                            ▼
                    seed-aware intent
                       routing layer
                     /              \
                    /                \
                   ▼                  ▼
          CROP DIAGNOSIS       SEED DOMAIN
             existing          /          \
             workflow       verify      complaint
               │              │
               │         +----▼----------------------+
               │         | branded / open workflow   |
               │         +-------------+-------------+
               │                       │
               │              packet / seller / price
               │              / scheme / complaint
               │                       │
               └──────────────┬────────┘
                              ▼
                      evidence + provenance
                              │
                              ▼
                       seed risk engine
                              │
                 +------------+------------+
                 │                         │
              LOW/MEDIUM               HIGH/FLAG
                 │                         │
           farmer guidance            human review
                                           │
                                 confirmed / dismissed
                                      /          \
                                 watchlist      report
```

## 4. Core integration rule: route before crop slot validation

The existing implementation has a strong crop-specific gate: a case does not proceed until both `image_url` and coordinates are available. The seed add-on must not inherit that rule globally.

The integrated routing sequence is:

```text
Inbound message
    ↓
Normalize / deduplicate / correlate
    ↓
Resolve conversation + target case
    ↓
Determine domain
    ├── CROP_DIAGNOSIS
    │      ↓
    │   require image + coordinates
    │      ↓
    │   existing weather + soil + Gemini diagnosis loop
    │
    └── SEED_VERIFICATION
           ↓
        require photo only
           ↓
        seed workflow
```

If the domain cannot be determined safely, the system asks a clarification question rather than silently choosing the wrong workflow.

## 5. Intent and domain routing

### Deterministic-first routing

1. Explicit case commands (`new`, `same`, `list`, case number) continue to be handled deterministically.
2. If the active case is a seed case and the farmer continues with seed-related input, keep that case.
3. Explicit seed cues or a seed-verification entry action route to Seed Verification.
4. Existing crop cases continue through the current Crop Diagnosis path.
5. If a new conversation contains an image but no clear domain signal, ask whether the farmer wants **crop diagnosis** or **seed verification**. Do not infer silently from the image alone.
6. Once a case has a domain, subsequent messages are interpreted within that domain unless the farmer explicitly starts or selects another case.

### Case types

```text
CROP_DIAGNOSIS
SEED_VERIFICATION
SEED_COMPLAINT
```

`SEED_VERIFICATION` additionally tracks:

```text
purchaseMode = BRANDED | OPEN | UNDECIDED
```

## 6. Existing Crop Diagnosis path — unchanged

The current crop path remains:

```text
photo + location
      ↓
Gemini vision
      +
Open-Meteo weather
      +
Gemini-simulated soil
      ↓
Gemini agronomist reasoning
      ↓
confidence gate
      ↓
up to 2 follow-up rounds
      ↓
final diagnosis + remedy
```

The existing `vision.service.js`, `weather.service.js`, `satellite.service.js`, and crop-oriented prompts remain in this path.

No seed evidence is injected into crop diagnosis automatically. A new seed case starts with its own evidence context.

## 7. Seed Verification path — new domain

### 7.1 Seed intake

**Mandatory initial artifact: photo. No location required.**

```text
photo
  ↓
seed-domain intent
  ↓
visual seed observation
  ↓
ask: branded/packaged or open/loose?
```

If the incoming photo is already a clear packet photo, it can also serve as the packet image. If the image is only loose seed, the branded workflow later asks for the packet image when packet verification is needed.

### 7.2 Reuse existing Gemini vision

The existing Gemini vision capability is reused, but the output must be interpreted as observations, not proof of authenticity.

```text
Seed image
   ↓
existing Gemini vision capability
   ↓
visual observations
   + image quality
   + confidence
   + anomalies / consistency notes
```

The crop-disease interpretation output must not be reused as if it were a seed-authenticity decision.

### 7.3 Branded / packaged workflow

```text
Seed photo
   ↓
BRANDED
   ↓
Packet image available?
   ├── yes → analyze packet
   └── no  → ask for packet photo
              ↓
      packet extraction
              ↓
 brand / crop / variety / lot / MRP / dates /
 certification text / barcode-or-QR result where available
              ↓
       request missing transaction details as needed
              ↓
      simulated brand / price / seller / scheme data
              ↓
           evidence layer
              ↓
          risk assessment
```

**Important:** barcode/QR decoding is modeled as an optional provider capability. No specific decoding library or external verification API is assumed by this architecture. If unavailable or undecodable, the evidence is `UNKNOWN` and the workflow continues using the remaining evidence.

### 7.4 Open / loose workflow

```text
Seed photo
   ↓
OPEN
   ↓
collect seller details and claimed seed information as needed
   ↓
collect offered price as needed
   ↓
check simulated seller / price / scheme / seed records
   ↓
compare seller claims with available reference evidence
   ↓
evidence layer
   ↓
risk assessment
```

**No seller location is required for the current MVP.** If later required, it should be added as an explicit future slot, not silently assumed.

## 8. Post-purchase complaint workflow

A farmer can report a seed problem after purchase without creating an unrelated crop diagnosis case.

```text
complaint message / photo
        ↓
resolve existing seed case when explicit
        ↓
otherwise create SEED_COMPLAINT case
        ↓
identify subject: brand / seller / lot / seed
        ↓
store farmer evidence
        ↓
aggregate with prior reports
        ↓
configured review trigger
        ↓
ReviewTask
        ↓
human decision
```

The system may flag a pattern; it must not declare wrongdoing solely because complaints accumulate.

## 9. Seed evidence model

Seed evidence is append-oriented and must retain provenance.

```text
Evidence
├── evidenceId
├── caseId
├── type
├── value
├── sourceType
├── provider
├── providerVersion?
├── confidence?
├── verificationLevel
├── capturedAt
├── derivedFromMediaIds[]
└── derivedFromMessageIds[]
```

Allowed source categories from the seed architecture:

```text
MODEL
SIMULATED
USER_INPUT
SYSTEM_RULE
```

Verification levels:

```text
UNVERIFIED
SIMULATED
EXTERNALLY_VERIFIED
```

For the current MVP, simulated price, seller, scheme and catalog data must remain labeled as simulated/internal.

## 10. Seed risk engine

The risk engine is separate from Gemini reasoning.

```text
visual consistency
packet consistency
barcode/QR evidence (if available)
observed price vs reference
seller record / seller claim
scheme/source consistency
complaint history / pattern evidence
farmer statements
          ↓
EvidenceService
          ↓
configured deterministic rules
          ↓
LOW / MEDIUM / HIGH
          ↓
Assessment snapshot
```

Each signal can be:

```text
SUPPORTING | WARNING | CONTRADICTORY | UNKNOWN
```

Rules:

- Unknown remains unknown.
- Low price is a warning signal, not proof of fake seed.
- Clean seller history is not proof of genuine seed.
- Model confidence is not the same as authenticity confidence.
- Risk thresholds and weights belong in configuration, not prompts.
- The assessment stores the evidence used so the result can be explained.

## 11. Human review and enforcement

```text
RiskEngine
    ↓
FLAGGED_FOR_REVIEW
    ↓
ReviewTask
    ├── evidence bundle
    ├── assessment snapshot
    ├── subject/history
    └── farmer reports
          ↓
       reviewer
       /      \
DISMISSED    CONFIRMED
               ↓
       WATCHLIST / REPORT
```

There is **no automatic blacklist** from an AI prediction.

The existing app remains able to provide a farmer-facing warning before human review, but a confirmed seller/brand/lot enforcement state is created only by the review workflow.

## 12. Conversation + case model integration

The existing conversation model stays in place:

```text
Conversation
  ├── activeCaseId
  └── cases[]
```

Existing crop fields remain. Seed fields are additive:

```text
Case
├── caseId
├── conversationId
├── caseType
├── state
├── label
├── coordinates?          // required for crop; not required for seed
├── photos[]
├── history[]
├── questionCount
├── createdAt
├── updatedAt
├── followUpOf?
│
└── seedContext?          // only for seed cases
    ├── purchaseMode?
    ├── seedSubject?
    ├── packetData?
    ├── sellerRef?
    ├── brandRef?
    ├── observedPrice?
    ├── evidenceIds[]
    ├── assessmentIds[]
    ├── complaintIds[]
    └── reviewId?
```

### Seed-aware resolver rules

- Existing explicit `new`, `same`, `list`, and case-number behavior remains.
- An active incomplete seed case stays active until its current workflow is completed or the farmer explicitly changes case.
- A completed seed verification case followed by another seed photo is **not** routed by the crop 5 km / 14-day heuristic. Ask `same seed or new seed?` unless the farmer explicitly identifies the case.
- A post-purchase complaint can reopen a completed seed case as progression when the farmer explicitly references it; otherwise create a complaint case.
- Crop cases continue using the existing crop-specific routing and progression rules.

## 13. Message contract integration

The existing channel-to-agent payload remains compatible:

```text
{
  sessionId,
  source,
  text?,
  imageUrl?,
  coordinates?,
  language?,
  action?,
  caseId?
}
```

Seed adds internal semantic fields after normalization/routing rather than forcing channel changes:

```text
{
  ...existingFields,
  domain?: CROP_DIAGNOSIS | SEED_VERIFICATION | SEED_COMPLAINT,
  messageId?,
  correlationId?,
  seedHints?
}
```

`messageId` and `correlationId` are new reliability metadata. `coordinates` remains optional at the transport level; the case workflow decides whether coordinates are required.

## 14. WhatsApp integration without replacing the existing adapter

The existing `whatsapp.service.js` remains responsible for:

- receiving text/image/location/audio
- downloading media
- STT invocation
- calling the shared `processMessage()` path
- sending text
- calling TTS
- sending voice
- WhatsApp lifecycle/reconnect behavior

The seed add-on does **not** put seed logic into `whatsapp.service.js`.

A thin gateway/idempotency layer may wrap the existing entry point:

```text
whatsapp.service
      ↓
message gateway
  validate / dedupe / correlate
      ↓
processMessage()
```

The gateway is additive; `processMessage()` remains the public orchestration boundary.

## 15. Web integration

The existing Web upload/message endpoints remain the transport entry points.

The important semantic change is inside the shared orchestrator:

```text
POST /api/upload
      ↓
agent.processMessage()
      ↓
if crop case → coordinates required
if seed case → coordinates not required
```

No separate seed backend or seed-only Web API is introduced.

## 16. Existing vs modified vs new components

| Component | Status | Integration action |
|---|---|---|
| `server.js` | KEEP | Same one-process startup; seed services initialized with server. |
| `upload.routes.js` | KEEP | Same endpoint; no separate seed endpoint needed. |
| `message.routes.js` | KEEP | Same text/case-command endpoint. |
| `upload.controller.js` | KEEP | Continues accepting image + optional metadata. |
| `message.controller.js` | KEEP | Continues typed text/case actions. |
| `whatsapp.service.js` | KEEP + thin reliability hook | Keep media/lifecycle/delivery responsibilities; do not add seed rules. |
| `agent.service.js` | MODIFY | Remains orchestrator; dispatch to crop or seed workflow after domain/case routing. |
| `session.service.js` | MODIFY | Extend case model + `resolveTargetCase()` with seed-aware rules. |
| `vision.service.js` | MODIFY/WRAP | Reuse Gemini vision; expose seed observation mode without changing crop semantics. |
| `weather.service.js` | CROP ONLY | No role in seed verification. |
| `satellite.service.js` | CROP ONLY | No role in seed verification. |
| `stt.service.js` | KEEP | Shared WhatsApp voice input. |
| `tts.service.js` | KEEP | Shared WhatsApp voice output. |
| `cleanup.service.js` | MODIFY | Include seed media/review artifacts where applicable. |
| `intent.router.js` | NEW | Domain/intent classification and safe ambiguity handling. |
| `message.gateway.js` | NEW | Normalize, dedupe, correlation metadata. |
| `idempotency.service.js` | NEW | Prevent duplicate processing by message ID. |
| `seed/` workflows | NEW | Branded, open, complaint orchestration. |
| `seed/evidence.service.js` | NEW | Evidence normalization/provenance. |
| `seed/risk.engine.js` | NEW | Deterministic seed risk assessment. |
| `seed/review.service.js` | NEW | Review tasks and decisions. |
| `seed/report.service.js` | NEW | Report state after confirmed review. |
| `seed/watchlist.service.js` | NEW | Watchlist state after confirmed review. |
| `seed/providers/*` | NEW | Provider interfaces + simulated implementations. |
| `seed/memory/repositories/*` | NEW | In-memory seed-domain state behind service boundaries. |
| crop diagnosis logic | KEEP | No seed evidence injected by default. |

## 17. Integrated backend file structure

This structure **extends the current repository** rather than replacing it with the seed document's standalone folder layout.

```text
sc-main/
├─ ARCHITECTURE.md
├─ docs/Flow.md
├─ client/
│  └─ existing React chat files
└─ server/
   ├─ server.js
   ├─ routes/
   │  ├─ upload.routes.js
   │  └─ message.routes.js
   ├─ controllers/
   │  ├─ upload.controller.js
   │  └─ message.controller.js
   ├─ middlewares/
   │  ├─ multer.middleware.js
   │  ├─ rateLimit.middleware.js
   │  └─ error.middleware.js
   └─ services/
      ├─ agent.service.js              # MODIFY: shared orchestrator
      ├─ session.service.js            # MODIFY: seed-aware cases
      ├─ vision.service.js             # MODIFY/WRAP: crop + seed modes
      ├─ weather.service.js            # EXISTING CROP ONLY
      ├─ satellite.service.js          # EXISTING CROP ONLY
      ├─ whatsapp.service.js            # EXISTING CHANNEL ADAPTER
      ├─ stt.service.js                # EXISTING
      ├─ tts.service.js                # EXISTING
      ├─ cleanup.service.js            # MODIFY
      ├─ message.gateway.js             # NEW
      ├─ idempotency.service.js        # NEW
      ├─ intent.router.js              # NEW
      │
      └─ seed/                         # NEW DOMAIN
         ├─ seed.workflow.js
         ├─ branded-seed.workflow.js
         ├─ open-seed.workflow.js
         ├─ complaint.workflow.js
         ├─ seed-slot.service.js
         ├─ packet-extractor.service.js
         ├─ seed-evidence.service.js
         ├─ seed-provenance.js
         ├─ risk.engine.js
         ├─ risk.rules.js
         ├─ assessment.service.js
         ├─ review.service.js
         ├─ review.queue.js
         ├─ report.service.js
         ├─ watchlist.service.js
         ├─ providers/
         │  ├─ seed.provider.js
         │  ├─ brand.provider.js
         │  ├─ seller.provider.js
         │  ├─ price.provider.js
         │  ├─ scheme.provider.js
         │  └─ complaint.provider.js
         └─ simulated/
            ├─ seed.simulated.js
            ├─ brand.simulated.js
            ├─ seller.simulated.js
            ├─ price.simulated.js
            ├─ scheme.simulated.js
            └─ complaint.simulated.js
```

## 18. Dependency rules

```text
channels → gateway only

gateway → agent/orchestration

session → case state / routing

agent → crop workflow OR seed workflow

seed workflows → seed evidence / providers / AI

risk engine → evidence only

review service → risk snapshot + evidence

providers → no channel dependencies

crop services → unchanged and isolated from seed provider logic

store/repositories → no provider fetching

routes/controllers/channel handlers → never mutate raw Maps directly
```

The most important rule is **no second brain**: the existing `agent.service.js` remains the shared orchestration boundary.

## 19. Failure and fallback rules

| Failure | Seed behavior |
|---|---|
| Duplicate WhatsApp message | Ignore after first accepted message ID. |
| Rapid messages | Existing per-conversation lock keeps ordering. |
| Seed image missing | Ask for seed photo. |
| Image unreadable | Ask for clearer image; no authenticity claim. |
| Packet extraction partial | Keep readable fields; ask only for missing critical information. |
| Barcode/QR unavailable | Evidence = UNKNOWN; continue other checks. |
| Simulated provider unavailable | Evidence = UNKNOWN; do not claim verified. |
| Gemini seed vision unavailable | Return UNKNOWN visual evidence and ask for clearer photo or another evidence path. |
| Gemini reasoning malformed | Reject schema; do not mutate risk state; use safe fallback. |
| Risk engine unavailable | Do not invent result; return pending/limited guidance. |
| Review unavailable | Keep review pending; never auto-confirm. |
| Server restart | In-memory cases/reports/reviews are lost, exactly as in current MVP. |

## 20. Language and voice integration

The existing multilingual behavior remains shared across both domains.

```text
WhatsApp text / voice
        ↓
existing STT + language detection when voice
        ↓
normalized semantic message
        ↓
crop or seed workflow
        ↓
farmer-language response
        ↓
existing TTS on WhatsApp
```

Seed-specific wording must not hard-code a single language. The current project already mirrors the farmer's language in the reasoning layer; the seed response layer follows the same contract.

The architecture does **not** claim full production support for every Indian language unless the current STT/TTS providers actually support that language. Unsupported TTS continues to fall back to text, as in the current system.

## 21. Testing required before merge

### Regression tests — existing crop behavior

- crop photo + coordinates still follows current diagnosis path
- crop photo without coordinates still requests location
- existing `same` / `new` / `list` / case switching remains unchanged
- progression of crop case still uses current rules

### Seed tests

- new seed photo starts seed flow without location
- seed photo with no domain signal asks clarification rather than entering crop flow silently
- branded seed asks for packet only when needed
- open seed does not require location
- packet extraction partial result requests only missing critical field
- seller/price/scheme simulated evidence is labeled `SIMULATED`
- missing provider produces `UNKNOWN`, not verified
- low price + valid simulated scheme is not automatically marked fake
- suspicious seller creates review task, not automatic blacklist
- reviewer dismissal prevents watchlist/report state
- reviewer confirmation can create watchlist/report state
- three seeds in one conversation remain independent cases
- duplicate WhatsApp event causes one state update and one response
- server restart does not fabricate previous case continuity

## 22. Implementation order

### Phase 1 — safe integration foundation

Add `message.gateway.js`, `idempotency.service.js`, and seed-aware routing hooks while keeping `processMessage()` and the existing case store intact.

### Phase 2 — seed case model

Extend `session.service.js` case records with `caseType` and `seedContext`; implement seed-aware resolution without touching crop routing behavior.

### Phase 3 — seed intake + branded/open workflows

Add `seed.workflow.js`, `branded-seed.workflow.js`, `open-seed.workflow.js`, packet extraction, and seed slot filling.

### Phase 4 — evidence + simulated providers

Add seed evidence/provenance and provider interfaces with simulated implementations only.

### Phase 5 — deterministic risk + assessment

Add risk rules, assessment snapshots, and explainable farmer-facing results.

### Phase 6 — complaint + review

Add complaint aggregation, review queue, reviewer decisions, watchlist and report states.

### Phase 7 — hardening

Add scenario tests, provider mocks, observability, media cleanup coverage and abuse-limit coverage.

## 23. Explicitly NOT assumed

The following are intentionally left unspecified because the supplied requirements do not establish them:

- no real government seed API or government live dataset
- no official seller/lot verification API
- no specific barcode/QR decoding library
- no new database
- no reviewer web UI or CLI
- no final risk weights/thresholds
- no automatic legal enforcement
- no automatic blacklist
- no second independent vision model
- no claim that simulated seed data is government-verified

## 24. Final integrated verdict

**9.1 / 10 for the current MVP architecture.**

The architecture is strong because it adds the seed domain without duplicating the existing backend brain or case model. The key integration boundary is `processMessage()` plus the existing `session.service.js` resolver. Crop diagnosis keeps its current location-dependent workflow; seed verification becomes a new photo-first domain with no location gate. The seed domain gets its own evidence, simulated providers, risk assessment and human-review path while reusing the existing Gemini, WhatsApp, Web, STT and TTS infrastructure.

The remaining gap to a production-grade 10/10 is outside the currently confirmed requirements: durable persistence, real official provider contracts, reviewer interface, calibrated risk policy, and production deployment/security requirements.
