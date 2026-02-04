/**
 * F1 Analytics Platform - API Client
 * Handles all communication with the backend API
 */

const API_BASE_URL = 'http://localhost:8000/api';

class F1ApiClient {
    constructor(baseUrl = API_BASE_URL) {
        this.baseUrl = baseUrl;
    }

    /**
     * Generic fetch wrapper with error handling
     */
    async request(endpoint, options = {}) {
        const url = `${this.baseUrl}${endpoint}`;

        try {
            const response = await fetch(url, {
                headers: {
                    'Content-Type': 'application/json',
                    ...options.headers
                },
                ...options
            });

            if (!response.ok) {
                throw new Error(`API Error: ${response.status} ${response.statusText}`);
            }

            return await response.json();
        } catch (error) {
            console.error(`API Request failed: ${endpoint}`, error);
            throw error;
        }
    }

    /**
     * GET request helper
     */
    async get(endpoint) {
        return this.request(endpoint, { method: 'GET' });
    }

    /**
     * POST request helper
     */
    async post(endpoint, data) {
        return this.request(endpoint, {
            method: 'POST',
            body: JSON.stringify(data)
        });
    }

    // ==================== Session & Schedule ====================

    /**
     * Get available seasons
     */
    async getSeasons() {
        return this.get('/seasons');
    }

    /**
     * Get race schedule for a season
     */
    async getSchedule(year) {
        return this.get(`/schedule/${year}`);
    }

    /**
     * Get comprehensive session data
     */
    async getSession(year, roundNum, sessionType = 'R') {
        return this.get(`/session/${year}/${roundNum}?session_type=${sessionType}`);
    }

    // ==================== Race Data ====================

    /**
     * Get lap times for a session
     */
    async getLapTimes(year, roundNum, driver = null) {
        let endpoint = `/laptimes/${year}/${roundNum}`;
        if (driver) {
            endpoint += `?driver=${driver}`;
        }
        return this.get(endpoint);
    }

    /**
     * Get telemetry data for a driver
     */
    async getTelemetry(year, roundNum, driver, lap = null) {
        let endpoint = `/telemetry/${year}/${roundNum}/${driver}`;
        if (lap) {
            endpoint += `?lap=${lap}`;
        }
        return this.get(endpoint);
    }

    /**
     * Get circuit information
     */
    async getCircuit(year, roundNum) {
        return this.get(`/circuit/${year}/${roundNum}`);
    }

    /**
     * Get tyre strategy data
     */
    async getStrategy(year, roundNum) {
        return this.get(`/strategy/${year}/${roundNum}`);
    }

    /**
     * Get driver information
     */
    async getDrivers(year, roundNum) {
        return this.get(`/drivers/${year}/${roundNum}`);
    }

    /**
     * Get race results
     */
    async getResults(year, roundNum) {
        return this.get(`/results/${year}/${roundNum}`);
    }

    /**
     * Get weather data
     */
    async getWeather(year, roundNum) {
        return this.get(`/weather/${year}/${roundNum}`);
    }

    // ==================== Predictions ====================

    /**
     * Get race outcome prediction
     */
    async predictRaceOutcome(params) {
        return this.post('/predict/race_outcome', {
            current_lap: params.currentLap,
            current_position: params.currentPosition,
            tyre_compound: params.tyreCompound,
            tyre_age: params.tyreAge,
            gap_ahead: params.gapAhead,
            gap_behind: params.gapBehind,
            planned_pit_lap: params.plannedPitLap,
            next_compound: params.nextCompound,
            weather: params.weather || 'DRY',
            track_temp: params.trackTemp || 35
        });
    }

    /**
     * Get tyre degradation prediction
     */
    async predictTyreDegradation(compound, tyreAge, trackTemp) {
        return this.post('/predict/tyre_degradation', {
            compound,
            tyre_age: tyreAge,
            track_temp: trackTemp
        });
    }

    /**
     * Get pit window prediction
     */
    async predictPitWindow(params) {
        return this.post('/predict/pit_window', {
            current_lap: params.currentLap,
            current_position: params.currentPosition,
            tyre_age: params.tyreAge,
            gap_ahead: params.gapAhead,
            gap_behind: params.gapBehind
        });
    }

    // ==================== Health Check ====================

    /**
     * Check API health status
     */
    async healthCheck() {
        return this.get('/health');
    }
}

// Export singleton instance
const apiClient = new F1ApiClient();

// Also export class for testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { F1ApiClient, apiClient };
}
