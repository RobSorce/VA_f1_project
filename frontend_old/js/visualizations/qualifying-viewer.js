/**
 * F1 Analytics Platform - Qualifying Viewer Visualization
 * D3.js-based qualifying session viewer with Q1/Q2/Q3 segments
 */

class QualifyingVisualization {
    constructor(containerId) {
        this.containerId = containerId;
        this.container = document.getElementById(containerId);
        this.svg = null;
        this.width = 0;
        this.height = 0;

        // State
        this.currentSegment = 'Q3'; // Q1, Q2, Q3
        this.qualifyingData = null;
        this.selectedDriver = null;
        this.drivers = [];

        // Layout
        this.padding = { top: 60, right: 16, bottom: 16, left: 16 };
        this.rowHeight = 32;
        this.rowGap = 2;

        // Team colors
        this.teamColors = {};
        this.defaultTeamColors = {
            'VER': '#3671C6', 'PER': '#3671C6',
            'LEC': '#E8002D', 'SAI': '#E8002D', 'BEA': '#E8002D',
            'HAM': '#27F4D2', 'RUS': '#27F4D2',
            'NOR': '#FF8000', 'PIA': '#FF8000',
            'ALO': '#229971', 'STR': '#229971',
            'GAS': '#FF87BC', 'OCO': '#FF87BC', 'DOO': '#FF87BC',
            'ALB': '#64C4FF', 'SAR': '#64C4FF', 'COL': '#64C4FF',
            'TSU': '#6692FF', 'RIC': '#6692FF', 'LAW': '#6692FF',
            'BOT': '#52E252', 'ZHO': '#52E252',
            'MAG': '#B6BABD', 'HUL': '#B6BABD', 'BEA': '#B6BABD'
        };
    }

    init() {
        if (!this.container) {
            console.error(`Container ${this.containerId} not found`);
            return this;
        }

        // Clear existing
        this.container.innerHTML = '';

        // Style container
        this.container.style.cssText = `
            background: rgba(21, 21, 30, 0.95);
            border-radius: 16px;
            overflow: hidden;
            font-family: 'Titillium Web', 'Inter', sans-serif;
            display: flex;
            flex-direction: column;
        `;

        const rect = this.container.getBoundingClientRect();
        this.width = rect.width || 320;
        this.height = rect.height || 600;

        // Create header with segment selector
        this.createHeader();

        // Create content area
        this.contentArea = document.createElement('div');
        this.contentArea.style.cssText = `
            flex: 1;
            overflow-y: auto;
            overflow-x: hidden;
        `;
        this.container.appendChild(this.contentArea);

        // Create SVG
        this.svg = d3.select(this.contentArea)
            .append('svg')
            .attr('width', this.width)
            .attr('class', 'qualifying-svg');

        this.mainGroup = this.svg.append('g')
            .attr('class', 'qualifying-main');

        return this;
    }

    createHeader() {
        const header = document.createElement('div');
        header.className = 'qualifying-header';
        header.style.cssText = `
            padding: 16px;
            background: linear-gradient(135deg, #7b2cbf 0%, #5a189a 100%);
            border-bottom: 2px solid rgba(255,255,255,0.1);
        `;

        header.innerHTML = `
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <svg viewBox="0 0 80 20" style="height: 18px; fill: white;">
                        <path d="M5.5,0 L0,20 L10,20 L12.5,10 L25,10 L27.5,0 L5.5,0 Z M15,0 L12.5,10 L17.5,10 L20,0 L15,0 Z"/>
                        <path d="M30,0 L35,0 L42.5,12.5 L45,0 L50,0 L45,20 L40,20 L32.5,7.5 L30,20 L25,20 L30,0 Z" transform="translate(20,0)"/>
                    </svg>
                    <span style="font-size: 18px; font-weight: 900; letter-spacing: 0.1em; color: white;">QUALIFYING</span>
                </div>
            </div>
            <div class="segment-selector" style="display: flex; gap: 8px;">
                <button class="segment-btn ${this.currentSegment === 'Q1' ? 'active' : ''}" data-segment="Q1">Q1</button>
                <button class="segment-btn ${this.currentSegment === 'Q2' ? 'active' : ''}" data-segment="Q2">Q2</button>
                <button class="segment-btn ${this.currentSegment === 'Q3' ? 'active' : ''}" data-segment="Q3">Q3</button>
            </div>
        `;

        // Style segment buttons
        const style = document.createElement('style');
        style.textContent = `
            .segment-btn {
                flex: 1;
                padding: 8px 16px;
                background: rgba(255,255,255,0.1);
                border: 2px solid rgba(255,255,255,0.2);
                border-radius: 8px;
                color: white;
                font-size: 14px;
                font-weight: 700;
                cursor: pointer;
                transition: all 0.2s;
            }
            .segment-btn:hover {
                background: rgba(255,255,255,0.2);
                border-color: rgba(255,255,255,0.4);
            }
            .segment-btn.active {
                background: rgba(255,255,255,0.25);
                border-color: white;
                box-shadow: 0 0 12px rgba(255,255,255,0.3);
            }
            .segment-btn.eliminated {
                color: #ff6b6b;
                border-color: #ff6b6b;
            }
        `;
        document.head.appendChild(style);

        // Segment button handlers
        header.querySelectorAll('.segment-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.currentSegment = btn.dataset.segment;
                header.querySelectorAll('.segment-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.updateDisplay();
            });
        });

        this.container.appendChild(header);
        this.headerElement = header;
    }

    setDrivers(drivers) {
        this.drivers = drivers || [];
        this.teamColors = {};
        this.drivers.forEach(d => {
            if (d.Abbreviation && d.TeamColor) {
                this.teamColors[d.Abbreviation] = `#${d.TeamColor}`;
            }
        });
        return this;
    }

    setQualifyingData(data) {
        this.qualifyingData = data;
        return this;
    }

    update(lapTimes) {
        if (!lapTimes || lapTimes.length === 0) {
            this.showNoDataMessage('No qualifying data available');
            return this;
        }

        // Process lap times into qualifying format
        this.processQualifyingData(lapTimes);
        this.updateDisplay();
        return this;
    }

    processQualifyingData(lapTimes) {
        // Group lap times by driver and find best lap per segment
        const driverBestLaps = {};

        lapTimes.forEach(lap => {
            const driver = lap.Driver;
            const lapTime = lap.LapTimeSeconds || lap.LapTime;

            if (!driverBestLaps[driver]) {
                driverBestLaps[driver] = {
                    driver: driver,
                    bestLap: null,
                    sector1: lap.Sector1Time,
                    sector2: lap.Sector2Time,
                    sector3: lap.Sector3Time,
                    position: lap.Position || 0
                };
            }

            if (lapTime && (!driverBestLaps[driver].bestLap || lapTime < driverBestLaps[driver].bestLap)) {
                driverBestLaps[driver].bestLap = lapTime;
                driverBestLaps[driver].sector1 = lap.Sector1Time;
                driverBestLaps[driver].sector2 = lap.Sector2Time;
                driverBestLaps[driver].sector3 = lap.Sector3Time;
                driverBestLaps[driver].position = lap.Position || 0;
            }
        });

        // Convert to array and sort by best lap time
        this.qualifyingData = Object.values(driverBestLaps)
            .filter(d => d.bestLap)
            .sort((a, b) => a.bestLap - b.bestLap);

        // Assign positions and calculate gaps
        if (this.qualifyingData.length > 0) {
            const poleTime = this.qualifyingData[0].bestLap;
            this.qualifyingData.forEach((d, i) => {
                d.position = i + 1;
                d.gap = i === 0 ? 0 : d.bestLap - poleTime;
            });
        }
    }

    updateDisplay() {
        if (!this.svg || !this.mainGroup) {
            this.init();
        }

        if (!this.qualifyingData || this.qualifyingData.length === 0) {
            this.showNoDataMessage('No data for selected segment');
            return;
        }

        // Filter data based on segment
        let displayData = [...this.qualifyingData];
        const segmentCutoffs = { 'Q1': 20, 'Q2': 15, 'Q3': 10 };
        const cutoff = segmentCutoffs[this.currentSegment];

        if (this.currentSegment === 'Q3') {
            displayData = displayData.slice(0, 10);
        } else if (this.currentSegment === 'Q2') {
            displayData = displayData.slice(0, 15);
        }

        // Mark eliminated drivers
        displayData.forEach((d, i) => {
            d.eliminated = false;
            if (this.currentSegment === 'Q1' && d.position > 15) d.eliminated = true;
            if (this.currentSegment === 'Q2' && d.position > 10) d.eliminated = true;
        });

        this.mainGroup.selectAll('*').remove();

        const contentWidth = this.width - this.padding.left - this.padding.right;
        const totalHeight = displayData.length * (this.rowHeight + this.rowGap) + 20;

        this.svg.attr('height', Math.max(totalHeight, 400));

        // Create rows
        const rows = this.mainGroup.selectAll('g.quali-row')
            .data(displayData, d => d.driver)
            .join('g')
            .attr('class', 'quali-row')
            .attr('transform', (d, i) => `translate(${this.padding.left}, ${i * (this.rowHeight + this.rowGap) + 10})`);

        // Row background
        rows.append('rect')
            .attr('x', 0)
            .attr('y', 0)
            .attr('width', contentWidth)
            .attr('height', this.rowHeight)
            .attr('rx', 4)
            .attr('fill', (d, i) => {
                if (d.eliminated) return 'rgba(255, 100, 100, 0.15)';
                if (d.position === 1) return 'rgba(147, 51, 234, 0.3)';
                return i % 2 === 0 ? 'rgba(26, 31, 51, 0.8)' : 'rgba(21, 21, 30, 0.8)';
            })
            .attr('class', 'row-bg');

        // Position number
        rows.append('text')
            .attr('x', 18)
            .attr('y', this.rowHeight / 2 + 5)
            .attr('text-anchor', 'middle')
            .attr('fill', d => d.position === 1 ? '#9333ea' : '#fff')
            .attr('font-size', '14px')
            .attr('font-weight', '700')
            .text(d => d.position);

        // Team color bar
        rows.append('rect')
            .attr('x', 32)
            .attr('y', 4)
            .attr('width', 3)
            .attr('height', this.rowHeight - 8)
            .attr('rx', 1)
            .attr('fill', d => this.getTeamColor(d.driver));

        // Driver code
        rows.append('text')
            .attr('x', 42)
            .attr('y', this.rowHeight / 2 + 5)
            .attr('fill', d => d.eliminated ? '#ff6b6b' : '#fff')
            .attr('font-size', '14px')
            .attr('font-weight', '700')
            .attr('letter-spacing', '0.02em')
            .text(d => d.driver);

        // Lap time
        rows.append('text')
            .attr('x', 100)
            .attr('y', this.rowHeight / 2 + 5)
            .attr('fill', d => d.position === 1 ? '#9333ea' : '#fff')
            .attr('font-size', '13px')
            .attr('font-family', "'JetBrains Mono', monospace")
            .attr('font-weight', d => d.position === 1 ? '700' : '400')
            .text(d => this.formatLapTime(d.bestLap));

        // Gap to pole
        rows.append('text')
            .attr('x', contentWidth - 10)
            .attr('y', this.rowHeight / 2 + 5)
            .attr('text-anchor', 'end')
            .attr('fill', d => d.position === 1 ? '#9333ea' : '#a0a0a8')
            .attr('font-size', '12px')
            .attr('font-family', "'JetBrains Mono', monospace")
            .text(d => d.position === 1 ? 'POLE' : `+${d.gap.toFixed(3)}`);

        // Sector times (small, below main info)
        if (displayData[0]?.sector1) {
            rows.append('text')
                .attr('x', 42)
                .attr('y', this.rowHeight - 3)
                .attr('fill', 'rgba(255,255,255,0.4)')
                .attr('font-size', '9px')
                .attr('font-family', "'JetBrains Mono', monospace")
                .text(d => {
                    const s1 = d.sector1 ? d.sector1.toFixed(3) : '--';
                    const s2 = d.sector2 ? d.sector2.toFixed(3) : '--';
                    const s3 = d.sector3 ? d.sector3.toFixed(3) : '--';
                    return `S1: ${s1}  S2: ${s2}  S3: ${s3}`;
                });
        }

        // Hover effects
        const self = this;
        rows.style('cursor', 'pointer')
            .on('mouseenter', function (event, d) {
                d3.select(this).select('.row-bg')
                    .transition()
                    .duration(100)
                    .attr('fill', 'rgba(147, 51, 234, 0.3)');
            })
            .on('mouseleave', function (event, d) {
                const i = displayData.indexOf(d);
                d3.select(this).select('.row-bg')
                    .transition()
                    .duration(100)
                    .attr('fill', d.eliminated ? 'rgba(255, 100, 100, 0.15)' :
                        d.position === 1 ? 'rgba(147, 51, 234, 0.3)' :
                            i % 2 === 0 ? 'rgba(26, 31, 51, 0.8)' : 'rgba(21, 21, 30, 0.8)');
            })
            .on('click', function (event, d) {
                self.selectedDriver = d.driver;
                self.dispatchDriverSelected(d);
            });
    }

    formatLapTime(seconds) {
        if (!seconds) return '--:--.---';
        const mins = Math.floor(seconds / 60);
        const secs = (seconds % 60).toFixed(3);
        return `${mins}:${secs.padStart(6, '0')}`;
    }

    getTeamColor(driverCode) {
        return this.teamColors[driverCode] || this.defaultTeamColors[driverCode] || '#666666';
    }

    dispatchDriverSelected(driver) {
        const event = new CustomEvent('driverSelected', {
            detail: { driver: driver.driver, lapTime: driver.bestLap, position: driver.position }
        });
        this.container.dispatchEvent(event);
    }

    showNoDataMessage(message = 'No data available') {
        if (!this.svg || !this.mainGroup) return;

        this.mainGroup.selectAll('*').remove();
        this.mainGroup.append('text')
            .attr('x', this.width / 2)
            .attr('y', 100)
            .attr('text-anchor', 'middle')
            .attr('fill', '#6b6b78')
            .attr('font-size', '14px')
            .text(message);
    }

    destroy() {
        if (this.container) {
            this.container.innerHTML = '';
        }
        this.svg = null;
    }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { QualifyingVisualization };
}
