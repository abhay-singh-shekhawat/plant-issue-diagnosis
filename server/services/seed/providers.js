/**
 * providers.js — Phase 3: seed reference-provider interfaces + simulated MVP.
 *
 * There are NO confirmed official seed/seller/scheme/price APIs or datasets,
 * so every implementation here is simulated/internal and EVERY result carries
 * `provenance: 'SIMULATED'`. Farmer-facing copy must keep that label and must
 * never be worded as official government confirmation (PRD R8).
 *
 * Uniform result shape:
 *   { status: 'ok' | 'unavailable', provenance: 'SIMULATED',
 *     provider: 'simulated-<name>', providerVersion: 'sim-v1',
 *     data: <provider-specific> | null, error: <code> | null }
 *
 * `unavailable` (outage toggle or missing input) must ALWAYS become evidence
 * UNKNOWN downstream — never verified, never safe (PRD R7).
 * Pure-ish: only the availability flags are module state (test-toggled).
 */

export const SIMULATED_VERSION = 'sim-v1';

const flags = { brand: true, price: true, seller: true, scheme: true, seed: true, complaint: true };

/** Test/ops hook: simulate a provider outage. Unknown names are ignored. */
export const setProviderAvailability = (patch = {}) => {
    for (const [k, v] of Object.entries(patch)) {
        if (k in flags) flags[k] = v !== false;
    }
};

/** Restore all simulated providers to available. */
export const resetProviderAvailability = () => {
    for (const k of Object.keys(flags)) flags[k] = true;
};

const down = (name) => ({
    status: 'unavailable',
    provenance: 'SIMULATED',
    provider: `simulated-${name}`,
    providerVersion: SIMULATED_VERSION,
    data: null,
    error: 'provider-unavailable',
});

const ok = (name, data) => ({
    status: 'ok',
    provenance: 'SIMULATED',
    provider: `simulated-${name}`,
    providerVersion: SIMULATED_VERSION,
    data,
    error: null,
});

/**
 * Hardening wrapper (Phase 8): a provider that THROWS (buggy double, future
 * real provider, network blowup) degrades to `unavailable` exactly like an
 * outage — the workflow keeps running and the evidence stays UNKNOWN.
 * Never throws for function inputs.
 */
export const safeProviderCall = async (name, fn) => {
    try {
        return await fn();
    } catch {
        return down(name);
    }
};

// ---------------------------------------------------------------------------
// Sample catalogs — tiny, fictional, INTERNAL. Unknown inputs resolve to
// `{ known: false }` (evidence UNKNOWN), never to invented confirmations.
// ---------------------------------------------------------------------------

const norm = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');

const SAMPLE_BRANDS = {
    'annapurna seeds': {
        crops: {
            paddy: { varieties: ['swarna', 'ir64'], lotPattern: '^[A-Z]{2}\\d{6}$', refMrp: { swarna: 650, default: 600 } },
            wheat: { varieties: ['hd2967'], lotPattern: '^[A-Z]{2}\\d{6}$', refMrp: { hd2967: 580, default: 550 } },
        },
    },
    'kisan agro': {
        crops: {
            cotton: { varieties: ['bunny bt'], lotPattern: '^[A-Z]{3}\\d{5}$', refMrp: { 'bunny bt': 770, default: 730 } },
        },
    },
};

const SAMPLE_SELLERS = {
    'ramesh beej bhandar': { licensedSample: true, pastReports: 0, areaSample: 'Sample Tehsil' },
    'kisan agro kendra': { licensedSample: true, pastReports: 1, areaSample: 'Sample Tehsil' },
};

const SAMPLE_SCHEMES = [
    { name: 'sample seed subsidy scheme', coversCrops: ['paddy', 'wheat'] },
    { name: 'sample millet minikit scheme', coversCrops: ['bajra', 'jowar'] },
];

/**
 * Brand/catalog lookup. Unknown brand => { known: false } (NOT a contradiction:
 * absence from a sample list proves nothing about the seed).
 */
export const brandLookup = async ({ brand, crop, variety } = {}) => {
    if (!flags.brand) return down('brand');
    const entry = SAMPLE_BRANDS[norm(brand)];
    if (!entry) return ok('brand', { known: false });
    const cropEntry = entry.crops[norm(crop)] || null;
    const v = norm(variety);
    return ok('brand', {
        known: true,
        cropKnown: !!cropEntry,
        varietyMatch: cropEntry && v ? cropEntry.varieties.includes(v) : null,
        lotPattern: cropEntry ? cropEntry.lotPattern : null,
        refMrp: cropEntry ? (cropEntry.refMrp[v] ?? cropEntry.refMrp.default) : null,
    });
};

/** Reference price from the sample catalog. Unknown => { known: false }. */
export const priceReference = async ({ crop, variety, brand } = {}) => {
    if (!flags.price) return down('price');
    // Prefer the brand catalog when the brand is known; else generic sample MRP.
    const b = await brandLookup({ brand, crop, variety });
    if (b.status === 'ok' && b.data?.known && Number.isFinite(Number(b.data.refMrp))) {
        return ok('price', { known: true, refMrp: Number(b.data.refMrp), basis: 'sample-brand-catalog' });
    }
    return ok('price', { known: false, refMrp: null, basis: null });
};

/** Seller record lookup. Unknown seller => { known: false }, never adverse. */
export const sellerLookup = async ({ name } = {}) => {
    if (!flags.seller) return down('seller');
    const record = SAMPLE_SELLERS[norm(name)];
    if (!record) return ok('seller', { known: false });
    return ok('seller', { known: true, record });
};

/**
 * Scheme/source consistency. A claim naming a sample scheme that does not
 * cover the crop => contradictory SIGNAL (still not a verdict — Phase 5 owns
 * verdicts). Unknown scheme => unknown.
 */
export const schemeCheck = async ({ claim, crop } = {}) => {
    if (!flags.scheme) return down('scheme');
    const c = norm(claim);
    if (!c) return ok('scheme', { known: false, consistent: null });
    const scheme = SAMPLE_SCHEMES.find((s) => c.includes(s.name) || s.name.includes(c));
    if (!scheme) return ok('scheme', { known: false, consistent: null });
    const covers = scheme.coversCrops.includes(norm(crop));
    return ok('scheme', { known: true, scheme: scheme.name, consistent: covers });
};

/** Seed/variety catalog probe (used by branded + open flows). */
export const seedLookup = async ({ crop, variety } = {}) => {
    if (!flags.seed) return down('seed');
    for (const [, entry] of Object.entries(SAMPLE_BRANDS)) {
        const cropEntry = entry.crops[norm(crop)];
        if (cropEntry && cropEntry.varieties.includes(norm(variety))) {
            return ok('seed', { known: true });
        }
    }
    return ok('seed', { known: false });
};

/**
 * Provisional observed-vs-reference price bands (shared by branded + open).
 * NOT approved risk policy — Phase 5 confirms or replaces these thresholds.
 * ratio = observed / reference: 0.8–1.2 consistent, <0.7 well-below (warning),
 * anything else inconclusive. Returns a SIGNAL string.
 */
export const priceSignalForRatio = (ratio) => {
    if (!Number.isFinite(ratio) || ratio <= 0) return 'UNKNOWN';
    if (ratio >= 0.8 && ratio <= 1.2) return 'SUPPORTING';
    if (ratio < 0.7) return 'WARNING';
    return 'UNKNOWN';
};

export const simulatedProviders = {
    brandLookup,
    priceReference,
    sellerLookup,
    schemeCheck,
    seedLookup,
};
