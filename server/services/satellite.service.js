/**
 * satellite.service.js
 * --------------------
 * Derives realistic soil/satellite estimates from live weather data using
 * deterministic formulas. No Gemini call is made here — this saves precious
 * free-tier quota for the vision and agent steps that actually need an LLM.
 *
 * Formulas are agronomically sensible approximations:
 *   - Soil moisture rises with humidity and recent rainfall, falls with heat.
 *   - Nitrogen depletes faster in wet/warm conditions (leaching + uptake).
 *   - pH drifts acidic under heavy rainfall, alkaline in dry/hot conditions.
 *   - NDVI (vegetation health proxy) correlates with moisture and temperature.
 */

const clamp = (val, min, max) => Math.max(min, Math.min(max, val));

// Seeded pseudo-random for lat/lon so the same location always gives the
// same "satellite" reading within a single run, without an API call.
const locationSeed = (lat, lon) => {
    const x = Math.sin(lat * 127.1 + lon * 311.7) * 43758.5453123;
    return x - Math.floor(x); // 0..1
};

const finiteOr = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
};

export const getMockSatelliteData = async (lat, lon, weatherData) => {
    const { temperature_c = 25, humidity_percent = 60, rainfall_latest_mm = 0 } = weatherData || {};
    // Every input coerced: NaN/undefined can never leak into soil math (previously
    // NaN moisture serialized as null and NaN nitrogen fell through to 'High').
    const temp = finiteOr(temperature_c, 25);
    const humidity = finiteOr(humidity_percent, 60);
    const rainfall = finiteOr(rainfall_latest_mm, 0);
    const latNum = Number(lat);
    const lonNum = Number(lon);
    const seed = (Number.isFinite(latNum) && Number.isFinite(lonNum))
        ? locationSeed(latNum, lonNum)
        : 0.5;

    // --- Soil moisture (20–90 %) ---
    // Base from humidity, boosted by rainfall, reduced by heat.
    const moistureBase = humidity * 0.55
        + Math.min(rainfall * 1.2, 25)
        - Math.max(temp - 30, 0) * 0.8
        + seed * 8;          // ±4 % location variation
    const soil_moisture_percent = Math.round(clamp(moistureBase, 20, 90));

    // --- Nitrogen level (Low / Moderate / High) ---
    // Wet + warm = leaching → Low; dry + cool = accumulation → High
    const nitrogenScore = 50
        - (soil_moisture_percent - 50) * 0.4
        - Math.max(temp - 28, 0) * 0.5
        + seed * 20 - 10;
    const nitrogen_level =
        nitrogenScore < 35 ? 'Low' :
        nitrogenScore < 65 ? 'Moderate' : 'High';

    // --- Soil pH (5.5–8.0) ---
    // More rainfall → more acidic; dry/hot → more alkaline
    const phBase = 6.8
        - Math.min(rainfall * 0.03, 0.8)
        + Math.max(temp - 32, 0) * 0.04
        + (seed - 0.5) * 0.6;
    const soil_ph = Math.round(clamp(phBase, 5.5, 8.0) * 10) / 10;

    // --- NDVI index (0.1–0.9) ---
    // Healthy crops: moderate temp (20–30 °C), moderate moisture
    const ndviBase = 0.45
        + (soil_moisture_percent - 40) * 0.004
        - Math.abs(temp - 25) * 0.005
        + (seed - 0.5) * 0.15;
    const ndvi_index = Math.round(clamp(ndviBase, 0.1, 0.9) * 100) / 100;

    // Always an estimate derived from weather — never presented as measured.
    return { soil_moisture_percent, nitrogen_level, soil_ph, ndvi_index, source: 'estimated' };
};
