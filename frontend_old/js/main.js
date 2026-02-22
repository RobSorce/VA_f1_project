/**
 * F1 Analytics Platform - Main Application
 * Orchestrates all visualizations, carousel navigation, and time simulation
 */

// Global state
const appState = {
    currentYear: 2024,
    currentRound: null,
    sessionType: 'R', // R, Q, S, SQ, FP1, FP2, FP3
    sessionData: null,
    isLoading: false,
    visualizations: {},
    selectedDrivers: [], // For compare mode in lap times

    // Carousel state
    activeScreen: 0,
    screens: [
        { id: 'overview', label: 'Race Overview' },
        { id: 'strategy', label: 'Strategy & Timing' },
        { id: 'analytics', label: 'Analytics' }
    ],

    // Simulation state
    simulation: {
        currentLap: 1,
        maxLap: 1,
        isPlaying: false,
        playSpeed: 1,
        playIntervalId: null,
        lapData: {}, // { lap: standings[] }

        // Time-based animation state
        positionData: null, // { max_time, drivers: { [abbr]: { times[], x[], y[], teamColor } } }
        frameData: null, // { frames[], driver_colors: {}, total_laps, max_time } - rich telemetry frames
        driverColors: {}, // { driverCode: '#hexcolor' } - team colors for quick lookup
        currentTime: 0, // Current race time in seconds
        maxTime: 0, // Total race duration in seconds
        animationFrameId: null, // requestAnimationFrame ID
        lastFrameTime: null // For delta time calculation
    }
};

// ==================== Initialization ====================

document.addEventListener('DOMContentLoaded', () => {
    initializeApp();
});

async function initializeApp() {
    console.log('F1 Analytics Platform initializing...');

    // Initialize carousel
    initializeCarousel();

    // Initialize time controls
    initializeTimeControls();

    // Initialize visualizations
    initializeVisualizations();

    // Set up event listeners
    setupEventListeners();

    // Load season schedule
    await loadSeasonSchedule(appState.currentYear);

    // Check API health
    checkApiHealth();

    console.log('F1 Analytics Platform initialized');
}

// ==================== Carousel Navigation ====================

function initializeCarousel() {
    const viewport = document.getElementById('carousel-viewport');
    const prevBtn = document.getElementById('carousel-prev');
    const nextBtn = document.getElementById('carousel-next');
    const breadcrumbs = document.querySelectorAll('.breadcrumb');

    // Arrow button handlers
    prevBtn.addEventListener('click', () => goToScreen(appState.activeScreen - 1));
    nextBtn.addEventListener('click', () => goToScreen(appState.activeScreen + 1));

    // Breadcrumb handlers
    breadcrumbs.forEach((btn, index) => {
        btn.addEventListener('click', () => goToScreen(index));
    });

    // Scroll sync
    viewport.addEventListener('scroll', () => {
        const { scrollLeft, clientWidth } = viewport;
        if (!clientWidth) return;

        const index = Math.round(scrollLeft / clientWidth);
        if (index !== appState.activeScreen) {
            appState.activeScreen = index;
            updateCarouselUI();
        }
    }, { passive: true });

    // Initial UI update
    updateCarouselUI();
}

function goToScreen(index) {
    const viewport = document.getElementById('carousel-viewport');
    if (!viewport) return;

    const clamped = Math.max(0, Math.min(appState.screens.length - 1, index));
    appState.activeScreen = clamped;

    viewport.scrollTo({
        left: clamped * viewport.clientWidth,
        behavior: 'smooth'
    });

    updateCarouselUI();
}

function updateCarouselUI() {
    const prevBtn = document.getElementById('carousel-prev');
    const nextBtn = document.getElementById('carousel-next');
    const breadcrumbs = document.querySelectorAll('.breadcrumb');
    const screenLabel = document.getElementById('current-screen-label');

    // Update arrows
    prevBtn.disabled = appState.activeScreen === 0;
    nextBtn.disabled = appState.activeScreen === appState.screens.length - 1;

    // Update breadcrumbs
    breadcrumbs.forEach((btn, index) => {
        btn.classList.toggle('breadcrumb--active', index === appState.activeScreen);
        btn.setAttribute('aria-selected', index === appState.activeScreen);
    });

    // Update screen label
    if (screenLabel && appState.screens[appState.activeScreen]) {
        screenLabel.textContent = appState.screens[appState.activeScreen].label;
    }
}

// ==================== Time Simulation Controls ====================

function initializeTimeControls() {
    const slider = document.getElementById('time-slider');
    const playPauseBtn = document.getElementById('time-play-pause');
    const stepBackBtn = document.getElementById('time-step-back');
    const stepForwardBtn = document.getElementById('time-step-forward');
    const speedSelect = document.getElementById('play-speed');

    // Slider change - supports both time-based and lap-based scrubbing
    slider.addEventListener('input', (e) => {
        const value = parseInt(e.target.value);

        // If we have position data, slider represents time in seconds
        if (appState.simulation.positionData && appState.simulation.maxTime > 0) {
            appState.simulation.currentTime = value;
            updateCarPositionsAtTime(value);
            updateRaceElapsedTimeDisplay(value);

            // Estimate lap from time
            const estimatedLap = Math.min(
                Math.floor(value / 90) + 1,
                appState.simulation.maxLap
            );
            appState.simulation.currentLap = estimatedLap;
            updateLapDisplay();
        } else {
            // Fallback: slider represents lap number
            setSimulationLap(value);
        }
    });

    // Play/Pause
    playPauseBtn.addEventListener('click', togglePlayback);

    // Step buttons
    stepBackBtn.addEventListener('click', () => {
        if (appState.simulation.currentLap > 1) {
            setSimulationLap(appState.simulation.currentLap - 1);
        }
    });

    stepForwardBtn.addEventListener('click', () => {
        if (appState.simulation.currentLap < appState.simulation.maxLap) {
            setSimulationLap(appState.simulation.currentLap + 1);
        }
    });

    // Speed selector
    speedSelect.addEventListener('change', (e) => {
        appState.simulation.playSpeed = parseFloat(e.target.value);
        if (appState.simulation.isPlaying) {
            stopPlayback();
            startPlayback();
        }
    });
}

function setSimulationLap(lap) {
    appState.simulation.currentLap = lap;

    // Update slider
    const slider = document.getElementById('time-slider');
    if (slider) slider.value = lap;

    // Update display
    updateLapDisplay();

    // Update visualizations with data for this lap
    updateVisualizationsForLap(lap);
}

function updateLapDisplay() {
    const display = document.getElementById('current-lap-display');
    if (display) {
        display.textContent = `Lap ${appState.simulation.currentLap} / ${appState.simulation.maxLap}`;
    }

    // Update race elapsed time
    updateRaceElapsedTime();
}

/**
 * Calculate and display the race elapsed time from lap 1 to current lap
 * Uses the race leader's lap times for accurate timing
 */
function updateRaceElapsedTime() {
    const timeDisplay = document.getElementById('race-elapsed-time');
    if (!timeDisplay) return;

    let totalSeconds = 0;
    const currentLap = appState.simulation.currentLap;

    if (appState.sessionData?.lap_times) {
        // Sum lap times from lap 1 to current lap for the leader (Position === 1)
        for (let lap = 1; lap <= currentLap; lap++) {
            const lapData = appState.sessionData.lap_times.find(
                l => l.LapNumber === lap && l.Position === 1
            );

            if (lapData && lapData.LapTime) {
                // LapTime might be in seconds or as LapTimeSeconds
                if (typeof lapData.LapTime === 'number') {
                    totalSeconds += lapData.LapTime;
                } else if (lapData.LapTimeSeconds) {
                    totalSeconds += lapData.LapTimeSeconds;
                }
            } else {
                // Fallback: use average lap time (~90 seconds)
                totalSeconds += 90;
            }
        }
    } else {
        // Fallback: estimate 90 seconds per lap
        totalSeconds = currentLap * 90;
    }

    // Format as HH:MM:SS
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);

    timeDisplay.textContent = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function togglePlayback() {
    if (appState.simulation.isPlaying) {
        stopPlayback();
    } else {
        startPlayback();
    }
}

function startPlayback() {
    const playPauseBtn = document.getElementById('time-play-pause');
    const speedSelect = document.getElementById('play-speed');
    const speedValue = speedSelect.value;

    appState.simulation.isPlaying = true;
    appState.simulation.isPlaying = true;
    playPauseBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" stroke="none">
            <rect x="6" y="4" width="4" height="16"></rect>
            <rect x="14" y="4" width="4" height="16"></rect>
        </svg>
    `;
    playPauseBtn.classList.add('playing');
    playPauseBtn.title = 'Pause';

    // Check if we have position data for continuous animation
    if (appState.simulation.positionData && Object.keys(appState.simulation.positionData.drivers || {}).length > 0) {
        // Use continuous time-based animation
        const speed = speedValue === 'realtime' ? 1 : parseFloat(speedValue);
        startContinuousAnimation(speed);
    } else {
        // Fallback to lap-based animation
        if (speedValue === 'realtime') {
            startRealtimePlayback();
        } else {
            const speed = parseFloat(speedValue);
            const baseLapTimeMs = 90000;
            const intervalMs = baseLapTimeMs / speed;

            appState.simulation.playIntervalId = setInterval(() => {
                if (appState.simulation.currentLap < appState.simulation.maxLap) {
                    setSimulationLap(appState.simulation.currentLap + 1);
                } else {
                    stopPlayback();
                }
            }, intervalMs);
        }
    }
}

/**
 * Start continuous animation using requestAnimationFrame
 * Cars move smoothly around the track based on position telemetry
 */
function startContinuousAnimation(speed) {
    appState.simulation.lastFrameTime = performance.now();

    const animate = (currentTime) => {
        if (!appState.simulation.isPlaying) return;

        // Calculate delta time
        const deltaMs = currentTime - appState.simulation.lastFrameTime;
        appState.simulation.lastFrameTime = currentTime;

        // Advance simulation time (speed multiplier affects time advancement)
        const deltaSeconds = (deltaMs / 1000) * speed;
        appState.simulation.currentTime += deltaSeconds;

        // Check if race is complete
        if (appState.simulation.currentTime >= appState.simulation.maxTime) {
            appState.simulation.currentTime = appState.simulation.maxTime;
            stopPlayback();
            return;
        }

        // Update car positions on track
        updateCarPositionsAtTime(appState.simulation.currentTime);

        // Update leaderboard in real-time from frame data (throttled to every 10 frames ~0.4s)
        if (!appState.simulation._leaderboardUpdateCounter) {
            appState.simulation._leaderboardUpdateCounter = 0;
        }
        appState.simulation._leaderboardUpdateCounter++;
        if (appState.simulation._leaderboardUpdateCounter >= 10) {
            appState.simulation._leaderboardUpdateCounter = 0;
            updateLeaderboardAtTime(appState.simulation.currentTime);
        }

        // Update race elapsed time display
        updateRaceElapsedTimeDisplay(appState.simulation.currentTime);

        // Update time slider
        const slider = document.getElementById('time-slider');
        if (slider) {
            slider.value = Math.floor(appState.simulation.currentTime);
        }

        // Update lap counter based on frame data or time estimate
        const frameData = appState.simulation.frameData;
        let currentLap = appState.simulation.currentLap;

        if (frameData && frameData.frames && frameData.frames.length > 0) {
            // Find current frame and get leader's lap
            let frameIndex = 0;
            for (let i = 0; i < frameData.frames.length; i++) {
                if (frameData.frames[i].t > appState.simulation.currentTime) break;
                frameIndex = i;
            }
            const frame = frameData.frames[frameIndex];
            if (frame && frame.drivers) {
                // Get max lap from all drivers
                const laps = Object.values(frame.drivers).map(d => d.lap);
                currentLap = Math.max(...laps, 1);
            }
        } else {
            // Fallback: estimate ~90s per lap
            currentLap = Math.min(
                Math.floor(appState.simulation.currentTime / 90) + 1,
                appState.simulation.maxLap
            );
        }

        if (currentLap !== appState.simulation.currentLap) {
            appState.simulation.currentLap = currentLap;
            updateLapDisplay();
        }

        // Schedule next frame
        appState.simulation.animationFrameId = requestAnimationFrame(animate);
    };

    // Start animation loop
    appState.simulation.animationFrameId = requestAnimationFrame(animate);
}

/**
 * Update car positions on track for a specific time in seconds
 * Interpolates between position data points
 */
function updateCarPositionsAtTime(timeSeconds) {
    const positionData = appState.simulation.positionData;
    if (!positionData || !positionData.drivers) return;

    const positions = [];

    for (const [driverAbbr, driverData] of Object.entries(positionData.drivers)) {
        const { times, x, y, teamColor } = driverData;

        if (!times || times.length === 0) continue;

        // Find the two closest time points for interpolation
        let idx = 0;
        while (idx < times.length - 1 && times[idx + 1] < timeSeconds) {
            idx++;
        }

        // Interpolate position
        let posX, posY;
        if (idx >= times.length - 1) {
            // At or past end
            posX = x[x.length - 1];
            posY = y[y.length - 1];
        } else if (times[idx] >= timeSeconds) {
            // At or before start
            posX = x[0];
            posY = y[0];
        } else {
            // Interpolate between idx and idx+1
            const t1 = times[idx];
            const t2 = times[idx + 1];
            const ratio = (timeSeconds - t1) / (t2 - t1);

            posX = x[idx] + (x[idx + 1] - x[idx]) * ratio;
            posY = y[idx] + (y[idx + 1] - y[idx]) * ratio;
        }

        // Only add if coordinates are valid numbers
        if (typeof posX === 'number' && !isNaN(posX) && isFinite(posX) &&
            typeof posY === 'number' && !isNaN(posY) && isFinite(posY)) {
            // Ensure teamColor is valid - check multiple sources
            // Priority: positionData.teamColor > frameData.driverColors > white fallback
            let color = teamColor || appState.simulation.driverColors?.[driverAbbr] || '#FFFFFF';
            if (typeof color === 'string') {
                color = color.trim();
                // Only add # if not already present
                if (color && !color.startsWith('#')) {
                    color = '#' + color;
                }
            } else {
                color = '#FFFFFF';
            }

            positions.push({
                driver: driverAbbr,
                x: posX,
                y: posY,
                teamColor: color,
                position: positions.length + 1 // Approximate position
            });
        }
    }

    // Update track map
    if (appState.visualizations.trackMap && positions.length > 0) {
        appState.visualizations.trackMap.updateCarPositions(positions);
    }
}

/**
 * Update race elapsed time display for continuous animation
 */
function updateRaceElapsedTimeDisplay(totalSeconds) {
    const timeDisplay = document.getElementById('race-elapsed-time');
    if (!timeDisplay) return;

    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);

    timeDisplay.textContent = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function startRealtimePlayback() {
    // Real-time playback using actual lap times from the data
    const advanceToNextLap = () => {
        if (!appState.simulation.isPlaying) return;

        const currentLap = appState.simulation.currentLap;
        const nextLap = currentLap + 1;

        if (nextLap > appState.simulation.maxLap) {
            stopPlayback();
            return;
        }

        let lapTimeMs = 90000;

        if (appState.sessionData?.lap_times) {
            const lapData = appState.sessionData.lap_times.find(
                l => l.LapNumber === currentLap && l.Position === 1
            );

            if (lapData && lapData.LapTime && typeof lapData.LapTime === 'number') {
                lapTimeMs = lapData.LapTime * 1000;
            }
        }

        setSimulationLap(nextLap);
        appState.simulation.playIntervalId = setTimeout(advanceToNextLap, lapTimeMs);
    };

    advanceToNextLap();
}

function stopPlayback() {
    const playPauseBtn = document.getElementById('time-play-pause');

    appState.simulation.isPlaying = false;
    appState.simulation.isPlaying = false;
    playPauseBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" stroke="none">
            <polygon points="5 3 19 12 5 21 5 3"></polygon>
        </svg>
    `;
    playPauseBtn.classList.remove('playing');
    playPauseBtn.title = 'Play';

    // Stop interval-based playback
    if (appState.simulation.playIntervalId) {
        clearInterval(appState.simulation.playIntervalId);
        clearTimeout(appState.simulation.playIntervalId);
        appState.simulation.playIntervalId = null;
    }

    // Stop animation frame-based playback
    if (appState.simulation.animationFrameId) {
        cancelAnimationFrame(appState.simulation.animationFrameId);
        appState.simulation.animationFrameId = null;
    }

    appState.simulation.lastFrameTime = null;
}

function updateVisualizationsForLap(lap) {
    const lapData = appState.simulation.lapData[lap];

    if (lapData) {
        // Update Lap Tower with standings and lap info
        if (appState.visualizations.lapTower) {
            appState.visualizations.lapTower
                .setLapInfo(lap, appState.simulation.maxLap)
                .update(lapData.standings);
        }

        // Update track map car positions
        if (appState.visualizations.trackMap && lapData.positions) {
            appState.visualizations.trackMap.updateCarPositions(lapData.positions);
        }
    }
}

// ==================== Visualization Initialization ====================

function initializeVisualizations() {
    // Track Map
    appState.visualizations.trackMap = new TrackMapVisualization('track-map-container');
    appState.visualizations.trackMap.init();

    // Lap Tower (for race sessions)
    appState.visualizations.lapTower = new LapTowerVisualization('lap-tower-container');
    appState.visualizations.lapTower.init();

    // Qualifying Viewer (for qualifying sessions - reuses lap tower container)
    appState.visualizations.qualifying = new QualifyingVisualization('lap-tower-container');
    // Don't init yet - will be shown when qualifying session is loaded

    // Lap Times
    appState.visualizations.lapTimes = new LapTimesVisualization('lap-times-container');
    appState.visualizations.lapTimes.init();

    // Tyre Strategy
    appState.visualizations.tyreStrategy = new TyreStrategyVisualization('tyre-strategy-container');
    appState.visualizations.tyreStrategy.init();

    // Telemetry
    appState.visualizations.telemetry = new TelemetryVisualization('telemetry-container');
    appState.visualizations.telemetry.init();

    // Predictions
    appState.visualizations.predictions = new PredictionsVisualization('position-probabilities');
    appState.visualizations.predictions.init();
}

function setupEventListeners() {
    // Season selector
    document.getElementById('season-select').addEventListener('change', async (e) => {
        appState.currentYear = parseInt(e.target.value);
        await loadSeasonSchedule(appState.currentYear);
    });

    // Load session button
    document.getElementById('load-session-btn').addEventListener('click', loadSession);

    // Track map controls
    document.getElementById('track-zoom-in').addEventListener('click', () => {
        appState.visualizations.trackMap.zoomIn();
    });

    document.getElementById('track-zoom-out').addEventListener('click', () => {
        appState.visualizations.trackMap.zoomOut();
    });

    document.getElementById('track-reset').addEventListener('click', () => {
        appState.visualizations.trackMap.resetZoom();
    });

    // Telemetry driver selector
    document.getElementById('telemetry-driver').addEventListener('change', async (e) => {
        if (e.target.value && appState.currentRound) {
            await loadDriverTelemetry(e.target.value);
        }
    });

    // Lap times mode selector
    const laptimesModeSelect = document.getElementById('laptimes-mode');
    if (laptimesModeSelect) {
        laptimesModeSelect.addEventListener('change', (e) => {
            updateLapTimesView(e.target.value);
        });
    }

    // Strategy simulator
    document.getElementById('run-prediction-btn').addEventListener('click', runPrediction);

    // Driver selection changed on track map
    document.getElementById('track-map-container').addEventListener('driverSelectionChanged', (e) => {
        console.log('Selected drivers:', e.detail.selectedDrivers);
        appState.selectedDrivers = e.detail.selectedDrivers || [];
        // Update lap times if in compare mode
        const mode = document.getElementById('laptimes-mode')?.value;
        if (mode === 'compare') {
            updateLapTimesView('compare');
        }
    });

    // Session type selector in header
    const sessionTypeSelect = document.getElementById('session-type-select');
    if (sessionTypeSelect) {
        sessionTypeSelect.addEventListener('change', (e) => {
            appState.sessionType = e.target.value;
            updateSessionTypePill();
        });
    }

    // Session menu button toggle
    const sessionMenuBtn = document.getElementById('session-menu-btn');
    const sessionMenuModal = document.getElementById('session-menu-modal');
    const closeSessionMenu = document.getElementById('close-session-menu');

    if (sessionMenuBtn && sessionMenuModal) {
        sessionMenuBtn.addEventListener('click', () => {
            sessionMenuModal.style.display = 'flex';
            syncMenuWithHeader();
        });

        closeSessionMenu?.addEventListener('click', () => {
            sessionMenuModal.style.display = 'none';
        });

        // Close modal on backdrop click
        sessionMenuModal.addEventListener('click', (e) => {
            if (e.target === sessionMenuModal) {
                sessionMenuModal.style.display = 'none';
            }
        });

        // Close modal on Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && sessionMenuModal.style.display !== 'none') {
                sessionMenuModal.style.display = 'none';
            }
        });
    }

    // Session type buttons in modal
    document.querySelectorAll('.session-type-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const sessionType = btn.dataset.session;
            appState.sessionType = sessionType;

            // Update UI
            document.querySelectorAll('.session-type-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            // Sync with header dropdown
            const headerSelect = document.getElementById('session-type-select');
            if (headerSelect) headerSelect.value = sessionType;

            // Update session type pill
            updateSessionTypePill();

            // Get round from modal or header
            const menuRound = document.getElementById('menu-round-select')?.value;
            const menuSeason = document.getElementById('menu-season-select')?.value;

            if (menuRound && menuSeason) {
                // Update header selectors
                document.getElementById('season-select').value = menuSeason;
                document.getElementById('round-select').value = menuRound;
                appState.currentYear = parseInt(menuSeason);
                appState.currentRound = parseInt(menuRound);

                // Close modal and load session
                document.getElementById('session-menu-modal').style.display = 'none';
                await loadSession();
            } else if (appState.currentRound) {
                // Close modal and load with existing round
                document.getElementById('session-menu-modal').style.display = 'none';
                await loadSession();
            }
        });
    });

    // Sync menu season dropdown with schedule
    const menuSeasonSelect = document.getElementById('menu-season-select');
    if (menuSeasonSelect) {
        menuSeasonSelect.addEventListener('change', async (e) => {
            await loadMenuSchedule(parseInt(e.target.value));
        });
    }
}

/**
 * Update lap times view based on selected mode
 */
function updateLapTimesView(mode) {
    if (!appState.sessionData?.lap_times || !appState.visualizations.lapTimes) return;

    const allLapTimes = appState.sessionData.lap_times;
    let filteredTimes = allLapTimes;

    switch (mode) {
        case 'top5':
            // Get top 5 drivers based on final position
            const topDrivers = [...new Set(allLapTimes.filter(l => l.Position <= 5).map(l => l.Driver))].slice(0, 5);
            filteredTimes = allLapTimes.filter(l => topDrivers.includes(l.Driver));
            break;

        case 'compare':
            // Use selected drivers from track map
            if (appState.selectedDrivers && appState.selectedDrivers.length > 0) {
                filteredTimes = allLapTimes.filter(l => appState.selectedDrivers.includes(l.Driver));
            } else {
                // Default to top 3 if none selected
                const defaultTop = [...new Set(allLapTimes.filter(l => l.Position <= 3).map(l => l.Driver))];
                filteredTimes = allLapTimes.filter(l => defaultTop.includes(l.Driver));
            }
            break;

        case 'all':
        default:
            // Show all but limit to top 10 for readability
            const topTenDrivers = [...new Set(allLapTimes.filter(l => l.Position <= 10).map(l => l.Driver))];
            filteredTimes = allLapTimes.filter(l => topTenDrivers.includes(l.Driver));
            break;
    }

    const drivers = appState.sessionData.driver_info || [];
    appState.visualizations.lapTimes
        .setDrivers(drivers)
        .update(filteredTimes);
}

// ==================== Session Menu Helpers ====================

/**
 * Sync modal menu selectors with the header selectors
 */
function syncMenuWithHeader() {
    const headerSeason = document.getElementById('season-select')?.value;
    const headerRound = document.getElementById('round-select')?.value;
    const headerSessionType = document.getElementById('session-type-select')?.value;

    // Sync season
    const menuSeason = document.getElementById('menu-season-select');
    if (menuSeason && headerSeason) {
        menuSeason.value = headerSeason;
        loadMenuSchedule(parseInt(headerSeason));
    }

    // Sync round (after schedule loads)
    setTimeout(() => {
        const menuRound = document.getElementById('menu-round-select');
        if (menuRound && headerRound) {
            menuRound.value = headerRound;
        }
    }, 100);

    // Highlight current session type button
    document.querySelectorAll('.session-type-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.session === appState.sessionType);
    });
}

/**
 * Load schedule into the menu round selector
 */
async function loadMenuSchedule(year) {
    try {
        const data = await apiClient.getSchedule(year);
        const menuRoundSelect = document.getElementById('menu-round-select');
        if (!menuRoundSelect) return;

        menuRoundSelect.innerHTML = '<option value="">Select Grand Prix</option>';

        if (data.events) {
            data.events.forEach(event => {
                const option = document.createElement('option');
                option.value = event.RoundNumber;
                option.textContent = `R${event.RoundNumber}: ${event.EventName}`;
                menuRoundSelect.appendChild(option);
            });
        }
    } catch (error) {
        console.error('Failed to load menu schedule:', error);
    }
}

/**
 * Update the session type pill in the header
 */
function updateSessionTypePill() {
    const pill = document.getElementById('live-status');
    if (pill) {
        pill.textContent = getSessionTypeName(appState.sessionType);
    }
}

/**
 * Get friendly name for session type code
 */
function getSessionTypeName(code) {
    const names = {
        'R': 'RACE',
        'Q': 'QUALIFYING',
        'S': 'SPRINT',
        'SQ': 'SPRINT QUALI',
        'FP1': 'FP1',
        'FP2': 'FP2',
        'FP3': 'FP3'
    };
    return names[code] || code;
}

// ==================== Data Loading ====================

async function loadSeasonSchedule(year) {
    setLoadingState(true, 'Loading schedule...');

    try {
        const data = await apiClient.getSchedule(year);
        const roundSelect = document.getElementById('round-select');

        roundSelect.innerHTML = '<option value="">Select Grand Prix</option>';

        if (data.events) {
            data.events.forEach(event => {
                const option = document.createElement('option');
                option.value = event.RoundNumber;
                option.textContent = `R${event.RoundNumber}: ${event.EventName}`;
                roundSelect.appendChild(option);
            });
        }

        setLoadingState(false);
    } catch (error) {
        console.error('Failed to load schedule:', error);
        showError('Failed to load season schedule. Is the backend running?');
        setLoadingState(false);
    }
}

async function loadSession() {
    const roundNum = document.getElementById('round-select').value;
    const sessionTypeSelect = document.getElementById('session-type-select');

    if (!roundNum) {
        showError('Please select a Grand Prix');
        return;
    }

    appState.currentRound = parseInt(roundNum);

    // Get session type from selector or use stored value
    if (sessionTypeSelect) {
        appState.sessionType = sessionTypeSelect.value;
    }

    // Update the session type pill
    updateSessionTypePill();

    setLoadingState(true, `Loading ${getSessionTypeName(appState.sessionType)} data...`);

    // Reset all visualizations and state before loading new data
    resetSessionData();

    try {
        // Load session data with selected session type
        const sessionData = await apiClient.getSession(appState.currentYear, appState.currentRound, appState.sessionType);
        appState.sessionData = sessionData;

        // Get drivers
        const driversData = await apiClient.getDrivers(appState.currentYear, appState.currentRound);
        const drivers = driversData.drivers || [];

        // Update driver selectors
        updateDriverSelectors(drivers);

        // Process lap data for simulation
        processLapDataForSimulation(sessionData, drivers);

        // Update visualizations IMMEDIATELY to show track map and initial state
        // This provides instant visual feedback while telemetry loads
        await updateVisualizations(sessionData, drivers);

        // Update weather display
        updateWeatherDisplay(sessionData.weather_data);

        // Update footer
        updateSessionInfo(sessionData);

        // Enable time slider
        enableTimeControls();

        setLoadingState(false);
        updateLastUpdated();

        // Load position telemetry in background (non-blocking)
        loadPositionData().catch(err => console.warn('Position data load failed:', err));

        // Load race frames in background (non-blocking)
        loadRaceFrames().catch(err => console.warn('Frame data load failed:', err));

    } catch (error) {
        console.error('Failed to load session:', error);
        showError('Failed to load session data. Please try again.');
        setLoadingState(false);
    }
}

/**
 * Load position telemetry data for continuous track animation
 */
async function loadPositionData() {
    try {
        // apiClient.baseUrl already includes /api, so we just append the endpoint path
        const response = await fetch(
            `${apiClient.baseUrl}/positions/${appState.currentYear}/${appState.currentRound}`
        );

        if (!response.ok) {
            console.warn('Failed to load position data, using lap-based animation');
            return;
        }

        const positionData = await response.json();
        appState.simulation.positionData = positionData;
        appState.simulation.maxTime = positionData.max_time || 0;

        // Update time slider to use time-based instead of lap-based
        const slider = document.getElementById('time-slider');
        if (slider && positionData.max_time > 0) {
            slider.max = Math.floor(positionData.max_time);
            slider.value = 0;
        }

        console.log(`Loaded position data: ${Object.keys(positionData.drivers || {}).length} drivers, max time: ${positionData.max_time?.toFixed(0)}s`);
    } catch (error) {
        console.warn('Position data not available, using lap-based animation:', error);
    }
}

/**
 * Load race frame data for rich telemetry animation and real-time leaderboard
 */
async function loadRaceFrames() {
    try {
        const response = await fetch(
            `${apiClient.baseUrl}/frames/${appState.currentYear}/${appState.currentRound}`
        );

        if (!response.ok) {
            console.warn('Failed to load race frames, leaderboard may not update during playback');
            return;
        }

        const frameData = await response.json();
        appState.simulation.frameData = frameData;

        // Store driver colors for quick lookup
        if (frameData.driver_colors) {
            appState.simulation.driverColors = frameData.driver_colors;
        }

        console.log(`Loaded frame data: ${frameData.frames?.length || 0} frames, ${Object.keys(frameData.driver_colors || {}).length} drivers`);
    } catch (error) {
        console.warn('Race frames not available:', error);
    }
}

/**
 * Update leaderboard (Lap Tower) based on current race time using frame data
 * Derives real-time standings from frame data at the current timestamp
 */
function updateLeaderboardAtTime(timeSeconds) {
    const frameData = appState.simulation.frameData;
    if (!frameData || !frameData.frames || frameData.frames.length === 0) {
        return; // No frame data available, skip leaderboard update
    }

    // Find the frame closest to the current time
    let frameIndex = 0;
    for (let i = 0; i < frameData.frames.length; i++) {
        if (frameData.frames[i].t > timeSeconds) {
            break;
        }
        frameIndex = i;
    }

    const frame = frameData.frames[frameIndex];
    if (!frame || !frame.drivers) return;

    // Build standings array from frame data
    // Sort drivers by lap number (descending) and track progress
    const driverEntries = Object.entries(frame.drivers);

    // Create standings with all telemetry data
    const standings = driverEntries.map(([code, data]) => {
        const tyreCompounds = { 0: 'UNKNOWN', 1: 'SOFT', 2: 'MEDIUM', 3: 'HARD', 4: 'INTER', 5: 'WET' };
        return {
            code: code,
            driver: code,
            lap: data.lap,
            x: data.x,
            y: data.y,
            speed: data.speed,
            gear: data.gear,
            drs: data.drs,
            throttle: data.throttle,
            brake: data.brake,
            tyre: tyreCompounds[data.tyre] || 'UNKNOWN',
            compound: tyreCompounds[data.tyre] || 'UNKNOWN',
            tyreLife: data.tyre_life,
            tyre_life: data.tyre_life,
            teamColor: appState.simulation.driverColors[code] || '#FFFFFF'
        };
    });

    // Sort by lap (descending) to approximate race position
    // In a real race, leading drivers have completed more laps
    standings.sort((a, b) => {
        if (b.lap !== a.lap) return b.lap - a.lap;
        // If same lap, maintain current order (approximate by track position could be added)
        return 0;
    });

    // Assign positions and calculate intervals
    let leaderTime = null;
    let prevDriverData = null;

    standings.forEach((driver, index) => {
        driver.position = index + 1;
        driver.number = getDriverNumber(driver.code);

        if (index === 0) {
            driver.interval = 'LEADER';
            driver.gapToLeader = 0;
            leaderTime = timeSeconds;
        } else {
            // Estimate gap based on lap difference (rough approximation)
            const lapDiff = standings[0].lap - driver.lap;
            if (lapDiff > 0) {
                driver.interval = `+${lapDiff} LAP${lapDiff > 1 ? 'S' : ''}`;
                driver.gapToLeader = lapDiff * 90; // Approximate lap time
            } else {
                // Same lap - show small random interval for now (will be improved with actual timing data)
                const estimatedGap = (index * 1.5) + (Math.random() * 0.5);
                driver.interval = estimatedGap;
                driver.gapToLeader = estimatedGap;
            }
        }
    });

    // Update the lap tower visualization
    if (appState.visualizations.lapTower) {
        // Get current lap from leader
        const currentLap = standings[0]?.lap || appState.simulation.currentLap;
        appState.visualizations.lapTower
            .setLapInfo(currentLap, appState.simulation.maxLap)
            .update(standings);
    }
}

/**
 * Helper function to get driver number from code
 */
function getDriverNumber(code) {
    const numbers = {
        'VER': '1', 'PER': '11',
        'LEC': '16', 'SAI': '55', 'BEA': '38',
        'HAM': '44', 'RUS': '63',
        'NOR': '4', 'PIA': '81',
        'ALO': '14', 'STR': '18',
        'GAS': '10', 'OCO': '31', 'DOO': '61',
        'ALB': '23', 'SAR': '2', 'COL': '43',
        'TSU': '22', 'RIC': '3', 'LAW': '40',
        'BOT': '77', 'ZHO': '24',
        'MAG': '20', 'HUL': '27'
    };
    return numbers[code] || '';
}

/**
 * Reset all session data and visualizations before loading new session
 */
function resetSessionData() {
    // Stop any ongoing playback
    stopPlayback();

    // Clear simulation state
    appState.simulation.currentLap = 1;
    appState.simulation.maxLap = 1;
    appState.simulation.lapData = {};

    // Clear time-based animation state
    appState.simulation.positionData = null;
    appState.simulation.frameData = null;
    appState.simulation.driverColors = {};
    appState.simulation.currentTime = 0;
    appState.simulation.maxTime = 0;
    appState.simulation.animationFrameId = null;
    appState.simulation.lastFrameTime = null;

    // Reset time slider
    const slider = document.getElementById('time-slider');
    if (slider) {
        slider.value = 1;
        slider.max = 1;
        slider.disabled = true;
    }

    // Reset lap display
    const display = document.getElementById('current-lap-display');
    if (display) {
        display.textContent = 'Lap 1 / --';
    }

    // Reset race time display
    const raceTimeDisplay = document.getElementById('race-elapsed-time');
    if (raceTimeDisplay) {
        raceTimeDisplay.textContent = '00:00:00';
    }

    // Reset weather display
    document.getElementById('track-temp').textContent = '--°C';
    document.getElementById('air-temp').textContent = '--°C';
    document.getElementById('humidity').textContent = '--%';
    document.getElementById('wind-speed').textContent = '-- km/h';

    // Clear old session data
    appState.sessionData = null;

    // Reinitialize all visualizations to clear their data
    if (appState.visualizations.trackMap) {
        appState.visualizations.trackMap.destroy();
        appState.visualizations.trackMap.init();
    }

    if (appState.visualizations.lapTower) {
        appState.visualizations.lapTower.destroy();
        appState.visualizations.lapTower.init();
    }

    if (appState.visualizations.lapTimes) {
        appState.visualizations.lapTimes.destroy();
        appState.visualizations.lapTimes.init();
    }

    if (appState.visualizations.tyreStrategy) {
        appState.visualizations.tyreStrategy.destroy();
        appState.visualizations.tyreStrategy.init();
    }

    if (appState.visualizations.telemetry) {
        appState.visualizations.telemetry.destroy();
        appState.visualizations.telemetry.init();
    }

    if (appState.visualizations.predictions) {
        appState.visualizations.predictions.destroy();
        appState.visualizations.predictions.init();
    }

    console.log('Session data and visualizations reset');
}

function processLapDataForSimulation(sessionData, drivers) {
    if (!sessionData.lap_times || sessionData.lap_times.length === 0) return;

    const lapTimes = sessionData.lap_times;
    const maxLap = Math.max(...lapTimes.map(l => l.LapNumber));

    appState.simulation.maxLap = maxLap;
    appState.simulation.lapData = {};

    // Build driver info lookup
    const driverInfo = {};
    drivers.forEach(d => {
        driverInfo[d.Abbreviation] = d;
    });

    // Group lap data by lap number
    for (let lap = 1; lap <= maxLap; lap++) {
        const lapEntries = lapTimes.filter(l => l.LapNumber === lap);

        // Sort by position (if available) or by lap time
        const sorted = lapEntries.sort((a, b) => {
            if (a.Position && b.Position) return a.Position - b.Position;
            return 0;
        });

        // Build standings for this lap
        const standings = sorted.map((entry, index) => {
            const driver = driverInfo[entry.Driver] || {};
            const position = entry.Position || index + 1;

            // Calculate gap to leader
            let gap = 'LEADER';
            let interval = '---';

            if (index > 0) {
                const leaderTime = sorted[0].Time;
                const prevTime = sorted[index - 1].Time;
                const currentTime = entry.Time;

                if (leaderTime && currentTime) {
                    const gapSeconds = (currentTime - leaderTime);
                    gap = gapSeconds > 0 ? `+${gapSeconds.toFixed(3)}s` : `+${(index * 1.5).toFixed(1)}s`;
                } else {
                    gap = `+${(index * 1.5).toFixed(1)}s`;
                }

                if (prevTime && currentTime) {
                    const intervalSeconds = (currentTime - prevTime);
                    interval = intervalSeconds > 0 ? `+${intervalSeconds.toFixed(3)}` : `+${(0.5 + Math.random()).toFixed(1)}`;
                } else {
                    interval = `+${(0.5 + Math.random() * 2).toFixed(1)}`;
                }
            }

            return {
                position: position,
                code: entry.Driver,
                driver: entry.Driver,
                gap: gap,
                interval: interval,
                tyre: entry.Compound || 'M',
                compound: entry.Compound || 'MEDIUM',
                pitStops: entry.PitOutTime ? 1 : 0
            };
        });

        // Build car positions for track map
        const positions = sorted.map((entry, index) => {
            const driver = driverInfo[entry.Driver] || {};
            const trackCoords = sessionData.circuit_info?.track_coordinates;

            // Distribute cars along track based on position
            let x = 0, y = 0;
            if (trackCoords && trackCoords.length > 0) {
                const trackProgress = 1 - (index / sorted.length);
                const coordIndex = Math.floor(trackProgress * (trackCoords.length - 1));
                const coord = trackCoords[coordIndex] || trackCoords[0];
                x = coord.X || 0;
                y = coord.Y || 0;
            }

            return {
                driver: entry.Driver,
                position: entry.Position || index + 1,
                x: x,
                y: y,
                speed: 280 - index * 5,
                teamColor: driver.TeamColor ? `#${driver.TeamColor}` : '#666666'
            };
        });

        appState.simulation.lapData[lap] = { standings, positions };
    }

    // Set initial lap
    appState.simulation.currentLap = 1;
}

function enableTimeControls() {
    const slider = document.getElementById('time-slider');
    slider.disabled = false;
    slider.max = appState.simulation.maxLap;
    slider.value = 1;

    updateLapDisplay();

    // Show initial data
    setSimulationLap(1);
}

async function updateVisualizations(sessionData, drivers) {
    // Track Map
    if (sessionData.circuit_info) {
        appState.visualizations.trackMap
            .setDrivers(drivers)
            .loadTrack(sessionData.circuit_info);
    }

    // Determine if qualifying session
    const isQualifying = appState.sessionType === 'Q' || appState.sessionType === 'SQ';

    // Lap Tower (Race) or Qualifying Viewer
    if (isQualifying) {
        // Show Qualifying Viewer instead of Lap Tower
        if (appState.visualizations.qualifying) {
            appState.visualizations.qualifying
                .init()
                .setDrivers(drivers)
                .update(sessionData.lap_times || []);
        }
    } else {
        // Show standard Lap Tower for races
        if (appState.simulation.lapData[1]) {
            appState.visualizations.lapTower
                .setDrivers(drivers)
                .update(appState.simulation.lapData[1].standings);
        }
    }

    // Lap Times
    if (sessionData.lap_times) {
        appState.visualizations.lapTimes
            .setDrivers(drivers)
            .update(sessionData.lap_times);
    }

    // Tyre Strategy
    if (sessionData.tyre_strategy) {
        const maxLap = appState.simulation.maxLap;
        appState.visualizations.tyreStrategy
            .setDrivers(drivers)
            .setTotalLaps(maxLap)
            .update(sessionData.tyre_strategy);
    }
}

async function loadDriverTelemetry(driver) {
    if (!appState.currentRound) return;

    try {
        const data = await apiClient.getTelemetry(
            appState.currentYear,
            appState.currentRound,
            driver
        );

        if (data.telemetry) {
            appState.visualizations.telemetry.update(data.telemetry);
        }
    } catch (error) {
        console.error('Failed to load telemetry:', error);
        appState.visualizations.telemetry.showNoDataMessage('Failed to load telemetry');
    }
}

async function runPrediction() {
    const params = {
        currentLap: parseInt(document.getElementById('sim-current-lap').value),
        currentPosition: parseInt(document.getElementById('sim-current-pos').value),
        tyreCompound: document.getElementById('sim-tyre-compound').value,
        tyreAge: parseInt(document.getElementById('sim-tyre-age').value),
        gapAhead: parseFloat(document.getElementById('sim-gap-ahead').value),
        gapBehind: parseFloat(document.getElementById('sim-gap-behind').value)
    };

    try {
        const result = await apiClient.predictRaceOutcome(params);

        // Update prediction results
        PredictionsVisualization.updatePredictionResults(result);

        // Update position probabilities chart
        if (result.position_probabilities) {
            appState.visualizations.predictions.updatePositionProbabilities(result.position_probabilities);
        }

        // Update win meter
        PredictionsVisualization.updateWinMeter('VER', 0.42);

        // Update podium predictions
        PredictionsVisualization.updatePodiumPredictions([
            { driver: 'VER', probability: 0.42 },
            { driver: 'NOR', probability: 0.28 },
            { driver: 'LEC', probability: 0.18 }
        ]);

    } catch (error) {
        console.error('Prediction failed:', error);
        showError('Prediction failed. Is the backend running?');
    }
}

// ==================== UI Updates ====================

function updateDriverSelectors(drivers) {
    const telemetrySelect = document.getElementById('telemetry-driver');
    const strategySelect = document.getElementById('strategy-driver-filter');

    [telemetrySelect, strategySelect].forEach(select => {
        if (!select) return;

        // Keep first option
        const firstOption = select.options[0];
        select.innerHTML = '';
        select.appendChild(firstOption);

        drivers.forEach(driver => {
            const option = document.createElement('option');
            option.value = driver.Abbreviation;
            option.textContent = `${driver.Abbreviation} - ${driver.TeamName || ''}`;
            select.appendChild(option);
        });
    });
}

function updateWeatherDisplay(weatherData) {
    if (!weatherData || weatherData.length === 0) return;

    // Use latest weather reading
    const latest = weatherData[weatherData.length - 1];

    if (latest.TrackTemp !== undefined) {
        document.getElementById('track-temp').textContent = `${Math.round(latest.TrackTemp)}°C`;
    }
    if (latest.AirTemp !== undefined) {
        document.getElementById('air-temp').textContent = `${Math.round(latest.AirTemp)}°C`;
    }
    if (latest.Humidity !== undefined) {
        document.getElementById('humidity').textContent = `${Math.round(latest.Humidity)}%`;
    }
    if (latest.WindSpeed !== undefined) {
        document.getElementById('wind-speed').textContent = `${Math.round(latest.WindSpeed)} km/h`;
    }
}

function updateSessionInfo(sessionData) {
    // Lap display is now managed by time controls
    updateLapDisplay();
}

function updateLastUpdated() {
    const el = document.getElementById('last-updated');
    if (el) {
        const now = new Date();
        el.textContent = `Last updated: ${now.toLocaleTimeString()}`;
    }
}

function setLoadingState(isLoading, message = 'Loading...') {
    appState.isLoading = isLoading;

    const status = document.getElementById('connection-status');
    if (status) {
        status.classList.toggle('loading', isLoading);
        status.querySelector('.status-text').textContent = isLoading ? message : 'Ready';
    }
}

function showError(message) {
    console.error(message);

    const status = document.getElementById('connection-status');
    if (status) {
        status.classList.add('error');
        status.querySelector('.status-text').textContent = 'Error';

        setTimeout(() => {
            status.classList.remove('error');
            status.querySelector('.status-text').textContent = 'Ready';
        }, 3000);
    }
}

async function checkApiHealth() {
    try {
        await apiClient.healthCheck();
        console.log('API health check: OK');
    } catch (error) {
        console.warn('API health check failed:', error);
        showError('Backend API not available');
    }
}

// ==================== Window Resize ====================

let resizeTimeout;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
        // Check if we're in qualifying or race mode
        const isQualifying = appState.sessionType === 'Q' || appState.sessionType === 'SQ';

        // Reinitialize visualizations on resize (but not both lap tower and qualifying)
        Object.entries(appState.visualizations).forEach(([name, viz]) => {
            if (viz && viz.init) {
                // Skip qualifying init if we're in race mode (they share container)
                if (name === 'qualifying' && !isQualifying) return;
                // Skip lap tower init if we're in qualifying mode
                if (name === 'lapTower' && isQualifying) return;

                viz.init();
            }
        });

        // Re-update with current data
        if (appState.sessionData) {
            const drivers = appState.sessionData.driver_info || [];
            updateVisualizations(appState.sessionData, drivers);
        }
    }, 250);
});

// ==================== Keyboard Shortcuts ====================

document.addEventListener('keydown', (e) => {
    // Arrow keys for carousel navigation
    if (e.key === 'ArrowLeft' && !e.target.matches('input, select')) {
        goToScreen(appState.activeScreen - 1);
    } else if (e.key === 'ArrowRight' && !e.target.matches('input, select')) {
        goToScreen(appState.activeScreen + 1);
    }

    // Space for play/pause
    if (e.key === ' ' && !e.target.matches('input, select, button')) {
        e.preventDefault();
        togglePlayback();
    }
});
