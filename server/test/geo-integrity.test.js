/**
 * P0-A regression: invalid coordinates must never flow into weather URLs,
 * soil math, or the LLM prompt as real data (AUD-005), and fallback/estimate
 * sources must be attributed truthfully in prompts (AUD-006).
 * Offline only — no API keys, no network beyond the stubbed fallback paths.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeCoordinates, resolveTargetCase } from '../services/session.service.js';
import { getWeatherData } from '../services/weather.service.js';
import { getMockSatelliteData } from '../services/satellite.service.js';
import { buildDiagnosisPrompt, buildProgressionPrompt } from '../services/agent.service.js';

// --- normalizeCoordinates: the central gate ----------------------------------
test('AUD-005: normalizeCoordinates accepts valid finite in-range values', () => {
    assert.deepEqual(normalizeCoordinates({ lat: 26.9, lon: 75.8 }), { lat: 26.9, lon: 75.8 });
    // Numeric strings coerce (multipart/form-data JSON round-trips).
    assert.deepEqual(normalizeCoordinates({ lat: '26.9', lon: '75.8' }), { lat: 26.9, lon: 75.8 });
    // Boundary values are valid geography.
    assert.deepEqual(normalizeCoordinates({ lat: -90, lon: -180 }), { lat: -90, lon: -180 });
    assert.deepEqual(normalizeCoordinates({ lat: 90, lon: 180 }), { lat: 90, lon: 180 });
});

test('AUD-005: normalizeCoordinates rejects the lat:"abc" repro and equivalents', () => {
    assert.equal(normalizeCoordinates({ lat: 'abc', lon: 'xyz' }), null);
    assert.equal(normalizeCoordinates({ lat: 'abc', lon: 75.8 }), null);
    assert.equal(normalizeCoordinates({ lat: NaN, lon: 75.8 }), null);
    assert.equal(normalizeCoordinates({ lat: Infinity, lon: 75.8 }), null);
    assert.equal(normalizeCoordinates({ lat: 26.9, lon: undefined }), null);
    assert.equal(normalizeCoordinates(null), null);
    assert.equal(normalizeCoordinates(undefined), null);
    assert.equal(normalizeCoordinates('26.9,75.8'), null, 'string form, not object');
    assert.equal(normalizeCoordinates([26.9, 75.8]), null, 'array form, not object');
    assert.equal(normalizeCoordinates({}), null, 'missing fields');
    assert.equal(normalizeCoordinates({ lat: 91, lon: 75.8 }), null, 'lat out of range');
    assert.equal(normalizeCoordinates({ lat: 26.9, lon: 181 }), null, 'lon out of range');
});

// --- weather: fail closed, never live-looking --------------------------------
test('AUD-005: getWeatherData fails closed on invalid coords with flagged fallback', async () => {
    const w = await getWeatherData('abc', 'xyz');
    assert.equal(w.source, 'fallback');
    assert.equal(typeof w.temperature_c, 'number');
    assert.equal(typeof w.humidity_percent, 'number');
    assert.equal(typeof w.rainfall_latest_mm, 'number');
});

test('AUD-005: getWeatherData coerces valid numeric inputs without throwing', async () => {
    // May hit live API or fall back (network down) — either way the shape must
    // carry a source flag and finite numbers.
    const w = await getWeatherData(26.9, 75.8);
    assert.ok(w.source === 'live' || w.source === 'fallback');
    assert.ok(Number.isFinite(w.temperature_c));
    assert.ok(Number.isFinite(w.humidity_percent));
    assert.ok(Number.isFinite(w.rainfall_latest_mm));
});

// --- satellite: NaN can never leak -------------------------------------------
test('AUD-005: satellite math never yields null/NaN, even on garbage inputs', async () => {
    for (const bad of [
        ['abc', 'xyz'],
        [NaN, NaN],
        [undefined, undefined],
        [null, null]
    ]) {
        const s = await getMockSatelliteData(bad[0], bad[1], {
            temperature_c: 28, humidity_percent: 60, rainfall_latest_mm: 0, source: 'fallback'
        });
        assert.ok(Number.isFinite(s.soil_moisture_percent), `moisture finite for ${bad}`);
        assert.ok(['Low', 'Moderate', 'High'].includes(s.nitrogen_level), `nitrogen band for ${bad}`);
        assert.ok(Number.isFinite(s.soil_ph), `pH finite for ${bad}`);
        assert.ok(Number.isFinite(s.ndvi_index), `NDVI finite for ${bad}`);
        assert.equal(s.source, 'estimated');
    }
});

test('AUD-005: satellite survives a fallback-weather payload without NaN', async () => {
    const s = await getMockSatelliteData(26.9, 75.8, {
        temperature_c: 28, humidity_percent: 60, rainfall_latest_mm: 0, source: 'fallback'
    });
    assert.ok(Number.isFinite(s.soil_moisture_percent));
    assert.ok(Number.isFinite(s.soil_ph));
    assert.ok(Number.isFinite(s.ndvi_index));
});

// --- resolver: invalid coords become "missing" --------------------------------
test('AUD-005: resolveTargetCase treats invalid coords as missing slot', () => {
    const r = resolveTargetCase({
        conversationId: 't-badcoords',
        imageUrl: '/a.jpg',
        coordinates: { lat: 'abc', lon: 'xyz' }
    });
    assert.equal(r.case.coordinates, null, 'garbage coords must not be stored');
});

// --- prompts: source attribution ----------------------------------------------
const fakeCase = (overrides = {}) => ({
    label: 'Case 1',
    photos: [{ url: '/a.jpg', at: 1 }],
    question_count: 0,
    diagnostic_data: {
        visual_diagnosis: {
            suspected_disease: 'Early blight',
            visual_cues: 'brown spots',
            confidence: 70,
            differential: ['Bacterial spot'],
            source: 'gemini-vision'
        },
        geo_spatial_data: {
            weather: { temperature_c: 27, humidity_percent: 40, rainfall_latest_mm: 0, source: 'live' },
            soil_satellite_mock: { soil_moisture_percent: 45, source: 'estimated' }
        },
        ...overrides
    }
});

test('AUD-006: diagnosis prompt marks live sources without fallback warnings', () => {
    const p = buildDiagnosisPrompt(fakeCase(), {});
    assert.ok(p.includes('source: live'), 'weather source shown');
    assert.ok(p.includes('source: estimated'), 'soil estimate disclosed');
    assert.ok(!p.includes('NOT a measurement'), 'no fallback warning on live data');
});

test('AUD-006: diagnosis prompt warns when vision+weather are fallbacks', () => {
    const kase = fakeCase({
        visual_diagnosis: {
            suspected_disease: 'Unidentified leaf damage (visual model unavailable)',
            visual_cues: 'No automated visual analysis was possible for this image.',
            confidence: 0, differential: [], source: 'fallback'
        },
        geo_spatial_data: {
            weather: { temperature_c: 28, humidity_percent: 60, rainfall_latest_mm: 0, source: 'fallback' },
            soil_satellite_mock: { soil_moisture_percent: 45, source: 'estimated' }
        }
    });
    const p = buildDiagnosisPrompt(kase, {});
    assert.ok(p.includes('do NOT describe photo details as observed fact'));
    assert.ok(p.includes('NOT a measurement'));
    assert.ok(p.includes('never present as measured data'));
});

test('AUD-006: progression prompt carries the same attribution', () => {
    const kase = fakeCase();
    kase.last_diagnosis = 'Early blight, stable.';
    const p = buildProgressionPrompt(kase, {});
    assert.ok(p.includes('source: live'));
    assert.ok(p.includes('estimate, NOT measured'));
});
