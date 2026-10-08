/**
 * R3 regression: canonical language boundary (AUD-016).
 *
 * Supported set from evidence — session STRINGS (en, hi), gathering nudges
 * (hi gu mr ta te kn ml pa bn en), agent langInstruction
 * (hi gu mr ta te kn ml pa bn en), TTS map (+or/od):
 *   en hi gu mr ta te kn ml pa bn or   (od → or alias)
 * Default: hi (matches the agent's pre-existing `|| 'hi'` chain).
 *
 * Semantics (from the actual system, not invented):
 *   - valid input → canonical code, stored + used everywhere;
 *   - invalid input on an ESTABLISHED session → keep prior valid language
 *     (never clobber, never 400 a live conversation);
 *   - invalid input with no prior → DEFAULT_LANGUAGE;
 *   - providers (STT hint, Sarvam voice) only ever see canonical codes.
 * Fully offline — no provider calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    SUPPORTED_LANGUAGES,
    DEFAULT_LANGUAGE,
    normalizeLanguage,
    coerceLanguage
} from '../language.js';
import { processMessage } from '../services/agent.service.js';
import { getConversation } from '../services/session.service.js';

// --- 1-3. valid canonical / alias / casing -----------------------------------------
test('R3-valid: every canonical code round-trips', () => {
    assert.deepEqual([...SUPPORTED_LANGUAGES].sort(), ['bn', 'en', 'gu', 'hi', 'kn', 'ml', 'mr', 'or', 'pa', 'ta', 'te']);
    for (const code of SUPPORTED_LANGUAGES) {
        assert.equal(normalizeLanguage(code), code, code);
    }
    assert.equal(DEFAULT_LANGUAGE, 'hi');
});

test('R3-alias: legacy/alias spellings canonicalize', () => {
    assert.equal(normalizeLanguage('od'), 'or', 'TTS-side alias');
    assert.equal(normalizeLanguage('OD'), 'or', 'alias + case');
    assert.equal(normalizeLanguage('pan'), 'pa');
    assert.equal(normalizeLanguage('ben'), 'bn');
});

test('R3-casing: uppercase/mixed-case + regional variants normalize', () => {
    assert.equal(normalizeLanguage('GU'), 'gu');
    assert.equal(normalizeLanguage('Gu'), 'gu');
    assert.equal(normalizeLanguage('  ta  '), 'ta', 'surrounding whitespace');
    assert.equal(normalizeLanguage('hi-Latn'), 'hi', 'script variant stripped');
    assert.equal(normalizeLanguage('hi-Deva'), 'hi');
    assert.equal(normalizeLanguage('gu-Gujr'), 'gu');
    assert.equal(normalizeLanguage('en_US'), 'en', 'underscore variant');
});

// --- 4-10. invalid classes ------------------------------------------------------------
test('R3-invalid: unsupported/random/empty/null/missing/wrong-type/malformed → null', () => {
    assert.equal(normalizeLanguage('xx'), null, 'unsupported code');
    assert.equal(normalizeLanguage('ja'), null, 'provider-novel code (ex STT misdetect)');
    assert.equal(normalizeLanguage('xx-evil"; DROP'), null, 'injection-shaped string');
    assert.equal(normalizeLanguage('hello world'), null, 'prose is not a language');
    assert.equal(normalizeLanguage(''), null, 'empty string');
    assert.equal(normalizeLanguage('   '), null, 'blank string');
    assert.equal(normalizeLanguage(null), null);
    assert.equal(normalizeLanguage(undefined), null);
    assert.equal(normalizeLanguage(12345), null, 'wrong type: number');
    assert.equal(normalizeLanguage({}), null, 'wrong type: object');
    assert.equal(normalizeLanguage(['hi']), null, 'wrong type: array');
    assert.equal(normalizeLanguage('h1'), null, 'malformed: digit');
    assert.equal(normalizeLanguage('hindi'), null, 'malformed: full name, not code');
    assert.equal(normalizeLanguage('e'), null, 'malformed: single char');
});

// --- 11-14. boundary + persistence semantics -----------------------------------------------
test('R3-coerce: valid input wins regardless of current', () => {
    assert.equal(coerceLanguage('GU', 'en'), 'gu');
    assert.equal(coerceLanguage('hi-Latn', 'ta'), 'hi');
});

test('R3-coerce: invalid input keeps prior valid language (established session)', () => {
    assert.equal(coerceLanguage('xx', 'ta'), 'ta', 'never clobber good state');
    assert.equal(coerceLanguage(12345, 'gu'), 'gu');
    assert.equal(coerceLanguage('', 'mr'), 'mr');
    assert.equal(coerceLanguage(null, 'bn'), 'bn');
});

test('R3-coerce: invalid input with no prior → DEFAULT_LANGUAGE', () => {
    assert.equal(coerceLanguage('xx', null), 'hi');
    assert.equal(coerceLanguage(null, null), 'hi');
    assert.equal(coerceLanguage(12345, 'also-bad'), 'hi', 'bad current also falls back');
});

test('R3-coerce: never throws, never returns non-canonical', () => {
    for (const v of ['xx', '', null, undefined, 0, false, {}, [], 'hi-Latn', 'GU']) {
        const out = coerceLanguage(v, 'xx');
        assert.ok(SUPPORTED_LANGUAGES.includes(out), `${JSON.stringify(v)} → ${out}`);
    }
});

// --- 15-16. integration: agent boundary ----------------------------------------------------------
test('R3-agent: arbitrary language string is normalized, not stored verbatim', async () => {
    const r = await processMessage({ sessionId: 't-r3-arb', source: 'web', text: 'hi', language: 'xx-evil' });
    assert.equal(getConversation('t-r3-arb').language, 'hi', 'invalid → default on new session');
    assert.ok(typeof r.text === 'string' && r.text.length > 0);
});

test('R3-agent: uppercase + regional variants canonicalize on store', async () => {
    await processMessage({ sessionId: 't-r3-upper2', source: 'web', text: 'hi', language: 'GU' });
    assert.equal(getConversation('t-r3-upper2').language, 'gu');
    await processMessage({ sessionId: 't-r3-region2', source: 'web', text: 'hi', language: 'hi-Latn' });
    assert.equal(getConversation('t-r3-region2').language, 'hi');
});

test('R3-agent: non-string language no longer crashes the gathering path', async () => {
    // Pre-fix: buildGatheringNudge `(lang||'').split` threw TypeError on 12345.
    const r = await processMessage({ sessionId: 't-r3-num', source: 'web', text: 'hi', language: 12345 });
    assert.equal(getConversation('t-r3-num').language, 'hi');
    assert.ok(typeof r.text === 'string' && r.text.length > 0);
});

test('R3-agent: invalid language on established session preserves prior', async () => {
    await processMessage({ sessionId: 't-r3-keep', source: 'web', text: 'hi', language: 'ta' });
    assert.equal(getConversation('t-r3-keep').language, 'ta');
    await processMessage({ sessionId: 't-r3-keep', source: 'web', text: 'hi', language: 'xx' });
    assert.equal(getConversation('t-r3-keep').language, 'ta', 'good language survives bad input');
});

test('R3-agent: missing language leaves session default untouched', async () => {
    await processMessage({ sessionId: 't-r3-missing', source: 'web', text: 'hi' });
    assert.equal(getConversation('t-r3-missing').language, 'hi', 'creation default');
});

// --- 17-20. provider-facing safety (offline: normalization guarantees) ------------------------------
test('R3-provider: every STT-plausible raw code maps to canonical-or-default', () => {
    // Deepgram detected_language values seen in code/comments + adversarial set.
    const raw = ['hi', 'hi-Latn', 'gu-Deva', 'ja', 'cmn', 'en-US', '', null, 42];
    for (const v of raw) {
        const out = normalizeLanguage(v) || DEFAULT_LANGUAGE;
        assert.ok(SUPPORTED_LANGUAGES.includes(out), `${JSON.stringify(v)} → ${out}`);
    }
});
