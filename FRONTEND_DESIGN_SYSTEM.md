# FRONTEND_DESIGN_SYSTEM.md — SC-Main Phase 1 Foundation

> Scope: design language + minimum foundation only. No full workflows, no voice transport, no fake seed data.
> Backend FROZEN. GSAP logged for build phase and wired minimally here for motivated motion only.

## 0. Design read

Reading this as: farmer-facing conversational workspace for a trust-first agricultural audience, with a premium editorial/scientific language, leaning toward Tailwind utilities + self-hosted type + GSAP for motivated motion.

Dials: `DESIGN_VARIANCE 6 / MOTION_INTENSITY 4 / DENSITY 3`.

## 1. Typography

Pairing (self-hosted, no Google Fonts link in production):

- Display/latin: `Space Grotesk` (`@fontsource/space-grotesk`) — weights 500/600/700. Tight tracking for headers.
- Body/multilingual: `Mukta` (`@fontsource/mukta`) — weights 400/500/600/700. Devanagari + Latin parity for Hindi/English bilingual replies.
- Numbers/coords: `IBM Plex Mono` (`@fontsource/ibm-plex-mono`) — weight 400/500. All lat/lon, prices, counts.

Hierarchy:

- App title: 17px/600 Space Grotesk, tracking -0.01em.
- Section label: 11px/600 uppercase tracking 0.14em mono.
- Message body: 14px/400 Mukta, leading 1.65, max 65ch.
- Meta/timestamp: 10-11px mono, muted.
- No serif. No Inter default. Italic only in same family with `leading-[1.1]` + `pb-1` clearance when descenders present.

## 2. Color

One accent locked: field green.

- `--sc-paper`: #FAF7F0 (field paper)
- `--sc-surface`: #FFFFFF
- `--sc-ink`: #1D211B (green-tinted off-black, no pure black)
- `--sc-muted`: #5C665C
- `--sc-line`: #E3DED2 (hairline, warm)
- `--sc-accent`: #245C3A (field green, single accent)
- `--sc-accent-ink`: #FFFFFF (text on accent, 7.9:1 light)
- `--sc-warn`: #8A5A1E (amber soil, status only)
- `--sc-danger`: #A83A2E (status only)
- `--sc-mist`: #EFF0E8 (muted fill)

Rules: no purple/blue gradients, no neon, no glassmorphism, no black shadows. Dark mode via `dark:` variant tokens (paper -> #141712, surface -> #1C201A, ink -> #EDEEE6, accent -> #5FAE77 at 7.1:1 on dark ink). Whole page one theme, locked at root.

## 3. Spacing

4px base. Chat column `max-w-2xl` mobile, `max-w-3xl` desktop. Page gutters `px-4 md:px-6`. Section rhythm `py-16 md:py-24` for future marketing surfaces; chat uses tight `p-4` bubbles with `space-y-4`. No math-width flex hacks, grid for multi-col.

## 4. Radius (shape lock)

Documented rule, applied everywhere:

- Buttons: full pill (`rounded-full`)
- Chips/case switcher: full pill
- Surfaces/cards: 14px (`rounded-[14px]`)
- Inputs/photo preview: 10px (`rounded-[10px]`)
- No mixing without reason.

## 5. Borders

Hairline `1px var(--sc-line)` separates groups. Cards use border, not shadow, as primary elevation. Dividers: single `border-t` or `border-b`, never both on every row.

## 6. Shadows

Tinted to background hue, restrained:

- `sc-sm`: `0 1px 2px rgb(29 33 27 / 0.06)`
- `sc-md`: `0 8px 24px rgb(29 33 27 / 0.08)`
- No pure-black drop shadows on light.

## 7. Iconography

`lucide-react` retained (already installed, reuse before rebuild). One family only. `strokeWidth 1.5` globally. No hand-rolled SVG paths. No emojis in chrome (message content from backend preserved as-is).

## 8. Motion principles (GSAP, motivated only)

GSAP `^3.15` installed via npm (vendored `gsap-public/` acknowledged as reference copy, npm package is the build source). Allowed:

- Message ingress: opacity + translateY 8px, 220ms, stagger 40ms.
- Upload progress/preview: opacity scale 0.98 to 1.
- Recording pulse (future voice): opacity loop, collapses to static under reduced motion.
- Assessment reveal (future): single height/opacity expand.

Bans: no scroll-hijack in chat, no marquee, no perpetual loops on informational sections, no `window scroll` listeners. All GSAP in `gsap.context()` with `revert()` cleanup. `prefers-reduced-motion: reduce` disables to instant.

## 9. Responsive

- `<768px`: single column, full-width input bar, 44px min targets, camera capture priority, voice button first-class when transport lands.
- `768-1024px`: column centered, case rail horizontal scroll.
- `>1024px`: `max-w-3xl` chat + optional side rail slot (cases/assessment) prepared, chat stays primary. No dashboard charts.
- Viewport: `min-h-[100dvh]`, never `h-screen`. z-index scale: header 10, input sticky 10, overlay 50.

## 10. Image treatment

Evidence photos: `rounded-[10px] border border-line object-cover`, no overlay pills/tags, caption below only when real. Empty state uses real `hero.png` slot only if farmer-relevant; no fake screenshots, no div mockups.

## 11. Accessibility

|- WCAG AA 4.5:1 body, 3:1 large. Accent/white 7.9:1 light, accent/dark-ink 7.1:1 dark, both verified by script.
- Visible `focus-visible` 2px accent ring on all interactives.
- `aria-live="polite"` on message list, `role="log"`.
- Mic/photo buttons labeled, recording timer announced (future).
- Keyboard: Enter send, Shift+Enter newline. Reduced-motion and reduced-transparency fallbacks (solid fill).
- Form: label above, helper in markup, error below, no placeholder-as-label.

## 12. Components (Phase 1 implemented)

|- `AppShell`: paper backdrop, centered column, field-journal header slot, message region, sticky input slot. Wired in `App.jsx` only behind `?ds=1` preview; default route renders `ChatContainer` untouched.
|- `ScButton`: pill, accent/surface variants, active `scale-[0.98]`, disabled states, contrast-checked.
|- `ScInput`: bordered 10px input with label-above/error-below, stable `useId`, accent focus ring.
|- `StatusDot`: semantic dot + text label (dot never alone).
|- `Reveal`: GSAP ingress wrapper with reduced-motion fallback.
|- Existing `ChatContainer/ChatInput/ChatMessages/CaseSwitcher` logic untouched; visual skin migrates to tokens in Phase 2.
|- `VoiceTransport` (`src/voice/VoiceTransport.js`): interface stub only, every method rejects with `VOICE_TRANSPORT_UNAVAILABLE`. No endpoint, no audio code, no fake success. Previewed as a disabled mic in `?ds=1`.

## 13. Seed data gap (contract limitation, no workaround)

DTO (`serializeConversation`) strips `seedContext`, evidence, assessments, risk level. Therefore unimplemented until backend approves a read contract:

- Branded/open slot ledger UI
- Evidence provenance list
- Assessment risk panel (currently markdown text only)
- Review-task decision UI (no HTTP surface exists)
- Barcode/QR result view (capability unavailable, evidence UNKNOWN)
- `/api/upload` drops `seedHints` (message route only)

Frontend renders assessment/review text as received. No parsing into fake structured verdicts.

## 14. Pre-flight deltas

Zero em-dashes shipped in new chrome. One accent. Shape lock documented. No purple/blue gradient. No glass. No three-equal-cards. No version labels. No scroll cues. Real images only or labeled slots.
