/**
 * F1 Analytics Platform - Lap Tower Visualization
 * D3.js-based real-time standings tower - F1 TV Broadcast Style
 */

class LapTowerVisualization {
    constructor(containerId) {
        this.containerId = containerId;
        this.container = document.getElementById(containerId);
        this.svg = null;
        this.width = 0;
        this.height = 0;
        this.drivers = [];
        this.standings = [];
        this.teamColors = {};
        this.currentLap = 1;
        this.totalLaps = 57;

        // F1 TV Style Layout Constants
        this.padding = { top: 60, right: 8, bottom: 8, left: 8 };
        this.rowHeight = 28;
        this.rowGap = 2;

        // Team logo URLs (using official team abbreviations)
        this.teamLogos = {
            'Red Bull Racing': 'RBR',
            'Ferrari': 'FER',
            'Mercedes': 'MER',
            'McLaren': 'MCL',
            'Aston Martin': 'AMR',
            'Alpine': 'ALP',
            'Williams': 'WIL',
            'RB': 'RB',
            'Kick Sauber': 'SAU',
            'Haas F1 Team': 'HAA'
        };

        // Team colors matching F1 2024
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

        // Clear existing content
        this.container.innerHTML = '';

        // Create main container with F1 styling
        this.container.style.cssText = `
            background: rgba(21, 21, 30, 0.95);
            border-radius: 16px;
            overflow: hidden;
            font-family: 'Titillium Web', 'Inter', sans-serif;
        `;

        const rect = this.container.getBoundingClientRect();
        this.width = rect.width || 280;
        this.height = rect.height || 600;

        // Create header with F1 logo and lap counter
        this.createHeader();

        // Create SVG for standings
        this.svgContainer = document.createElement('div');
        this.svgContainer.style.cssText = `
            flex: 1;
            overflow-y: auto;
            overflow-x: hidden;
        `;
        this.container.appendChild(this.svgContainer);

        this.svg = d3.select(this.svgContainer)
            .append('svg')
            .attr('width', this.width)
            .attr('class', 'lap-tower-svg');

        this.mainGroup = this.svg.append('g')
            .attr('class', 'tower-main');

        return this;
    }

    createHeader() {
        const header = document.createElement('div');
        header.className = 'lap-tower-header';
        header.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 12px 16px;
            background: linear-gradient(135deg, #e10600 0%, #b80500 100%);
            border-bottom: 2px solid rgba(255,255,255,0.1);
        `;

        // F1 Logo and RACE text
        header.innerHTML = `
            <div style="display: flex; align-items: center; gap: 8px;">
                <svg viewBox="0 0 80 20" style="height: 18px; fill: white;">
                    <path d="M5.5,0 L0,20 L10,20 L12.5,10 L25,10 L27.5,0 L5.5,0 Z M15,0 L12.5,10 L17.5,10 L20,0 L15,0 Z"/>
                    <path d="M30,0 L35,0 L42.5,12.5 L45,0 L50,0 L45,20 L40,20 L32.5,7.5 L30,20 L25,20 L30,0 Z" transform="translate(20,0)"/>
                </svg>
                <span style="font-size: 18px; font-weight: 900; letter-spacing: 0.1em; color: white;">RACE</span>
            </div>
            <div class="lap-counter" style="display: flex; align-items: baseline; gap: 4px;">
                <span style="font-size: 11px; color: rgba(255,255,255,0.7); text-transform: uppercase;">LAP</span>
                <span class="current-lap" style="font-size: 20px; font-weight: 700; color: white;">${this.currentLap}</span>
                <span style="font-size: 14px; color: rgba(255,255,255,0.7);">/${this.totalLaps}</span>
            </div>
        `;

        this.container.appendChild(header);
        this.headerElement = header;
    }

    setDrivers(drivers) {
        this.drivers = drivers || [];

        // Build team color map from driver data
        this.teamColors = {};
        this.drivers.forEach(d => {
            if (d.Abbreviation && d.TeamColor) {
                this.teamColors[d.Abbreviation] = `#${d.TeamColor}`;
            }
        });

        return this;
    }

    setLapInfo(currentLap, totalLaps) {
        this.currentLap = currentLap;
        this.totalLaps = totalLaps;

        // Update header lap counter
        if (this.headerElement) {
            const currentLapEl = this.headerElement.querySelector('.current-lap');
            if (currentLapEl) {
                currentLapEl.textContent = currentLap;
            }
            const totalEl = this.headerElement.querySelector('.lap-counter span:last-child');
            if (totalEl) {
                totalEl.textContent = `/${totalLaps}`;
            }
        }

        return this;
    }

    update(standings) {
        if (!this.svg || !this.mainGroup) {
            this.init();
        }

        if (!standings || standings.length === 0) {
            this.showNoDataMessage('No standings data available');
            return this;
        }

        this.standings = standings;

        // Clear previous content
        this.mainGroup.selectAll('*').remove();

        const contentWidth = this.width - this.padding.left - this.padding.right;
        const totalHeight = standings.length * (this.rowHeight + this.rowGap) + this.padding.top;

        this.svg.attr('height', Math.max(totalHeight, 400));

        // Create rows for each driver - F1 TV Style
        const rows = this.mainGroup.selectAll('g.driver-row')
            .data(standings, d => d.code || d.driver)
            .join('g')
            .attr('class', 'driver-row')
            .attr('transform', (d, i) => `translate(${this.padding.left}, ${i * (this.rowHeight + this.rowGap)})`);

        // Row background - semi-transparent dark
        rows.append('rect')
            .attr('x', 0)
            .attr('y', 0)
            .attr('width', contentWidth)
            .attr('height', this.rowHeight)
            .attr('rx', 4)
            .attr('fill', (d, i) => i % 2 === 0 ? 'rgba(26, 31, 51, 0.8)' : 'rgba(21, 21, 30, 0.8)')
            .attr('class', 'row-bg');

        // Position number
        rows.append('text')
            .attr('x', 16)
            .attr('y', this.rowHeight / 2 + 5)
            .attr('text-anchor', 'middle')
            .attr('fill', '#fff')
            .attr('font-size', '13px')
            .attr('font-weight', '600')
            .text(d => d.position);

        // Team color indicator (small colored bar before number box)
        rows.append('rect')
            .attr('x', 30)
            .attr('y', 4)
            .attr('width', 3)
            .attr('height', this.rowHeight - 8)
            .attr('rx', 1)
            .attr('fill', d => this.getTeamColor(d.code || d.driver));

        // Driver number box with team color background
        rows.append('rect')
            .attr('x', 36)
            .attr('y', 4)
            .attr('width', 28)
            .attr('height', this.rowHeight - 8)
            .attr('rx', 3)
            .attr('fill', d => this.getTeamColor(d.code || d.driver));

        // Driver number inside box
        rows.append('text')
            .attr('x', 50)
            .attr('y', this.rowHeight / 2 + 4)
            .attr('text-anchor', 'middle')
            .attr('fill', d => this.getContrastColor(this.getTeamColor(d.code || d.driver)))
            .attr('font-size', '12px')
            .attr('font-weight', '700')
            .text(d => d.number || this.getDriverNumber(d.code));

        // Driver code (3 letters)
        rows.append('text')
            .attr('x', 72)
            .attr('y', this.rowHeight / 2 + 4)
            .attr('fill', '#fff')
            .attr('font-size', '14px')
            .attr('font-weight', '700')
            .attr('letter-spacing', '0.02em')
            .text(d => d.code || d.driver);

        // Interval/Gap - right aligned
        rows.append('text')
            .attr('x', contentWidth - 50)
            .attr('y', this.rowHeight / 2 + 4)
            .attr('text-anchor', 'end')
            .attr('fill', d => this.getIntervalColor(d))
            .attr('font-size', '12px')
            .attr('font-family', "'JetBrains Mono', monospace")
            .text(d => this.formatInterval(d));

        // Tyre compound indicator (small circle)
        if (standings[0]?.tyre || standings[0]?.compound) {
            rows.append('circle')
                .attr('cx', contentWidth - 20)
                .attr('cy', this.rowHeight / 2)
                .attr('r', 6)
                .attr('fill', d => this.getTyreColor(d.tyre || d.compound))
                .attr('stroke', 'rgba(255,255,255,0.3)')
                .attr('stroke-width', 1);
        }

        // Hover effects
        rows.style('cursor', 'pointer')
            .on('mouseenter', function (event, d) {
                d3.select(this).select('.row-bg')
                    .transition()
                    .duration(100)
                    .attr('fill', 'rgba(76, 201, 240, 0.2)');
            })
            .on('mouseleave', function (event, d) {
                const index = standings.indexOf(d);
                d3.select(this).select('.row-bg')
                    .transition()
                    .duration(100)
                    .attr('fill', index % 2 === 0 ? 'rgba(26, 31, 51, 0.8)' : 'rgba(21, 21, 30, 0.8)');
            });

        return this;
    }

    formatInterval(d) {
        if (d.position === 1) return '';
        if (d.gap === 'LEADER' || !d.interval) return '';
        if (d.interval === 'IN PIT' || d.status === 'PIT') return 'IN PIT';
        if (d.interval === 'OUT' || d.status === 'OUT') return 'OUT';

        const interval = d.interval || d.gap;
        if (typeof interval === 'string') return interval;
        return `+${interval.toFixed(3)}`;
    }

    getIntervalColor(d) {
        if (d.interval === 'IN PIT' || d.status === 'PIT') return '#00bfff';
        if (d.interval === 'OUT' || d.status === 'OUT') return '#ff4444';
        if (d.position === 1) return '#00ff00';
        return '#a0a0a8';
    }

    getDriverNumber(code) {
        const numbers = {
            'VER': '1', 'PER': '11',
            'LEC': '16', 'SAI': '55',
            'HAM': '44', 'RUS': '63',
            'NOR': '4', 'PIA': '81',
            'ALO': '14', 'STR': '18',
            'GAS': '10', 'OCO': '31',
            'ALB': '23', 'SAR': '2',
            'TSU': '22', 'RIC': '3',
            'BOT': '77', 'ZHO': '24',
            'MAG': '20', 'HUL': '27'
        };
        return numbers[code] || '';
    }

    getTeamColor(driverCode) {
        if (this.teamColors[driverCode]) {
            return this.teamColors[driverCode];
        }
        return this.defaultTeamColors[driverCode] || '#666666';
    }

    getContrastColor(hexColor) {
        // Convert hex to RGB
        const hex = hexColor.replace('#', '');
        const r = parseInt(hex.substr(0, 2), 16);
        const g = parseInt(hex.substr(2, 2), 16);
        const b = parseInt(hex.substr(4, 2), 16);

        // Calculate luminance
        const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

        return luminance > 0.5 ? '#000000' : '#ffffff';
    }

    getTyreColor(compound) {
        const colors = {
            'SOFT': '#ff0000',
            'S': '#ff0000',
            'MEDIUM': '#ffd700',
            'M': '#ffd700',
            'HARD': '#ffffff',
            'H': '#ffffff',
            'INTERMEDIATE': '#00cc00',
            'I': '#00cc00',
            'WET': '#0088ff',
            'W': '#0088ff'
        };
        return colors[String(compound).toUpperCase()] || '#666666';
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
    module.exports = { LapTowerVisualization };
}
