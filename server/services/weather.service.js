const FALLBACK_WEATHER = { temperature_c: 28, humidity_percent: 60, rainfall_latest_mm: 0, source: 'fallback' };

export const getWeatherData = async (lat, lon) => {
    // Invalid coords can never produce "live-looking" data — fail closed to a
    // flagged fallback before any network call.
    const latNum = Number(lat);
    const lonNum = Number(lon);
    if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) {
        return { ...FALLBACK_WEATHER };
    }
    try {
        // Live temperature / humidity / rain for this exact spot (free, no key).
        // Hard timeout: a hung Open-Meteo call would otherwise hold the
        // per-conversation lock forever and block the farmer's later messages.
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${latNum}&longitude=${lonNum}&current=temperature_2m,relative_humidity_2m,precipitation`;
        const response = await fetch(url, { signal: AbortSignal.timeout(15000) });

        if (!response.ok) {
            throw new Error(`Weather API failed with status: ${response.status}`);
        }

        const data = await response.json();

        const temperature_c = Number(data.current?.temperature_2m);
        const humidity_percent = Number(data.current?.relative_humidity_2m);
        const rainfall_latest_mm = Number(data.current?.precipitation);
        if (!Number.isFinite(temperature_c) || !Number.isFinite(humidity_percent) || !Number.isFinite(rainfall_latest_mm)) {
            throw new Error('Weather API returned non-numeric payload');
        }

        return { temperature_c, humidity_percent, rainfall_latest_mm, source: 'live' };
    } catch (error) {
        // Weather down → average day so the brain can still answer, but flagged
        // so the prompt never presents it as a measured value.
        return { ...FALLBACK_WEATHER };
    }
};
