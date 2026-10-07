export const getWeatherData = async (lat, lon) => {
    try {
        // Live temperature / humidity / rain for this exact spot (free, no key).
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,precipitation`;
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error(`Weather API failed with status: ${response.status}`);
        }
        
        const data = await response.json();
        
        return {
            temperature_c: data.current.temperature_2m,
            humidity_percent: data.current.relative_humidity_2m,
            rainfall_latest_mm: data.current.precipitation
        };
    } catch (error) {
        // Weather down → average day so the brain can still answer.
        return { temperature_c: 28, humidity_percent: 60, rainfall_latest_mm: 0 };
    }
};
