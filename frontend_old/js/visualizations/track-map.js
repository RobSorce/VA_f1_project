/**
 * F1 Analytics Platform - Track Map Visualization
 * D3.js-based interactive circuit visualization with F1 broadcast style
 * Features: Sector colors, corner labels outside track, DRS zones, start/finish line
 */

class TrackMapVisualization {
    constructor(containerId) {
        this.containerId = containerId;
        this.container = document.getElementById(containerId);
        this.svg = null;
        this.g = null;
        this.zoom = null;
        this.width = 0;
        this.height = 0;
        this.trackData = null;
        this.carPositions = new Map();
        this.drivers = new Map();
        this.selectedDrivers = new Set();
        this.isAnimating = false;

        // Scales
        this.xScale = null;
        this.yScale = null;

        // Sector colors (duller/darker tones)
        this.sectorColors = {
            1: '#8B1A2F', // Dark Red - Sector 1
            2: '#8B7000', // Dark Gold - Sector 2
            3: '#1E3A8A'  // Dark Blue - Sector 3
        };

        // Default track color (when sectors are off)
        this.defaultTrackColor = '#4A5568';

        // Sector visibility state
        this.sectorsVisible = true;
        this.trackCoords = null;

        // Team colors mapping
        this.teamColors = {
            'Red Bull Racing': '#3671C6',
            'Ferrari': '#E8002D',
            'Mercedes': '#27F4D2',
            'McLaren': '#FF8000',
            'Aston Martin': '#229971',
            'Alpine': '#FF87BC',
            'Williams': '#64C4FF',
            'AlphaTauri': '#5E8FAA',
            'RB': '#6692FF',
            'Alfa Romeo': '#C92D4B',
            'Haas F1 Team': '#B6BABD',
            'Kick Sauber': '#52E252',
        };
    }

    /**
     * Initialize the visualization
     */
    init() {
        // Clear any existing content
        this.container.innerHTML = '';

        // Get container dimensions - ensure minimum size to prevent D3 errors
        const rect = this.container.getBoundingClientRect();
        this.width = Math.max(rect.width, 100);
        this.height = Math.max(rect.height, 100);

        // Create SVG
        this.svg = d3.select(this.container)
            .append('svg')
            .attr('width', '100%')
            .attr('height', '100%')
            .attr('viewBox', `0 0 ${this.width} ${this.height}`);

        // Create zoom behavior
        this.zoom = d3.zoom()
            .scaleExtent([0.5, 5])
            .on('zoom', (event) => {
                this.g.attr('transform', event.transform);
            });

        this.svg.call(this.zoom);

        // Create main group for transformations
        this.g = this.svg.append('g')
            .attr('class', 'track-group');

        // Create layers in drawing order (bottom to top)
        this.trackOutlineLayer = this.g.append('g').attr('class', 'track-outline-layer');
        this.sectorLayer = this.g.append('g').attr('class', 'sector-layer');
        this.drsLayer = this.g.append('g').attr('class', 'drs-layer');
        this.startFinishLayer = this.g.append('g').attr('class', 'sf-layer');
        this.cornersLayer = this.g.append('g').attr('class', 'corners-layer');
        this.carsLayer = this.g.append('g').attr('class', 'cars-layer');
        this.labelsLayer = this.g.append('g').attr('class', 'labels-layer');

        // Create tooltip
        this.tooltip = d3.select('body')
            .append('div')
            .attr('class', 'tooltip')
            .style('opacity', 0);

        return this;
    }

    /**
     * Load and render track data
     */
    async loadTrack(circuitInfo) {
        this.trackData = circuitInfo;

        if (!circuitInfo.track_coordinates || circuitInfo.track_coordinates.length === 0) {
            this.showNoDataMessage('No track coordinates available');
            return;
        }

        const coords = circuitInfo.track_coordinates;
        this.trackCoords = coords; // Store for toggle functionality

        // Calculate bounds
        const xExtent = d3.extent(coords, d => d.X);
        const yExtent = d3.extent(coords, d => d.Y);

        // Add padding
        const padding = 60;
        const trackWidth = xExtent[1] - xExtent[0];
        const trackHeight = yExtent[1] - yExtent[0];
        const aspectRatio = trackWidth / trackHeight;

        // Calculate scale to fit container
        const availableWidth = this.width - padding * 2;
        const availableHeight = this.height - padding * 2;
        let scale;

        if (availableWidth / availableHeight > aspectRatio) {
            scale = availableHeight / trackHeight;
        } else {
            scale = availableWidth / trackWidth;
        }

        // Create scales
        this.xScale = d3.scaleLinear()
            .domain(xExtent)
            .range([
                (this.width - trackWidth * scale) / 2,
                (this.width + trackWidth * scale) / 2
            ]);

        this.yScale = d3.scaleLinear()
            .domain(yExtent)
            .range([
                (this.height + trackHeight * scale) / 2,
                (this.height - trackHeight * scale) / 2
            ]);

        // Draw track outline (dark shadow)
        this.drawTrackOutline(coords);

        // Draw track (sectors or solid color based on toggle)
        this.drawTrack();

        // Draw Start/Finish line with flag and arrow
        this.drawStartFinish(coords);

        // Draw corners with labels outside track
        if (circuitInfo.corners && circuitInfo.corners.length > 0) {
            this.drawCorners(circuitInfo.corners, coords);
        }

        return this;
    }

    /**
     * Draw track - either with sectors or solid color
     */
    drawTrack() {
        // Clear existing sector layer
        this.sectorLayer.selectAll('*').remove();

        if (this.sectorsVisible) {
            this.drawSectoredTrack(this.trackCoords);
        } else {
            this.drawSolidTrack(this.trackCoords);
        }
    }

    /**
     * Draw solid track (when sectors are off)
     */
    drawSolidTrack(coords) {
        const line = d3.line()
            .x(d => this.xScale(d.X))
            .y(d => this.yScale(d.Y))
            .curve(d3.curveCatmullRom.alpha(0.5));

        this.sectorLayer.append('path')
            .attr('class', 'track-solid')
            .attr('d', line(coords))
            .attr('fill', 'none')
            .attr('stroke', this.defaultTrackColor)
            .attr('stroke-width', 18)
            .attr('stroke-linecap', 'butt')
            .attr('stroke-linejoin', 'miter');
    }

    /**
     * Toggle sector visibility
     */
    toggleSectors(visible) {
        this.sectorsVisible = visible;
        if (this.trackCoords) {
            this.drawTrack();
        }
    }

    /**
     * Draw track outline (shadow effect)
     */
    drawTrackOutline(coords) {
        const line = d3.line()
            .x(d => this.xScale(d.X))
            .y(d => this.yScale(d.Y))
            .curve(d3.curveCatmullRom.alpha(0.5));

        // Dark outline for depth
        this.trackOutlineLayer.append('path')
            .attr('class', 'track-outline')
            .attr('d', line(coords))
            .attr('fill', 'none')
            .attr('stroke', 'rgba(0, 0, 0, 0.6)')
            .attr('stroke-width', 26)
            .attr('stroke-linecap', 'butt')
            .attr('stroke-linejoin', 'miter');

        // Lighter outline edge
        this.trackOutlineLayer.append('path')
            .attr('class', 'track-outline-edge')
            .attr('d', line(coords))
            .attr('fill', 'none')
            .attr('stroke', 'rgba(60, 60, 80, 0.8)')
            .attr('stroke-width', 24)
            .attr('stroke-linecap', 'butt')
            .attr('stroke-linejoin', 'miter');

        // Draw track edges (inner/outer white lines)
        this.drawTrackEdges(coords);
    }

    /**
     * Compute track inner and outer edges using tangent vectors.
     * Adopts the f1-race-replay pattern for realistic track rendering.
     * @param {Array} coords - Track coordinates with X, Y
     * @param {number} trackWidth - Track width in coordinate units (default 200)
     * @returns {Object} - {innerEdge, outerEdge} arrays
     */
    computeTrackEdges(coords, trackWidth = 200) {
        const n = coords.length;
        if (n < 3) return { innerEdge: [], outerEdge: [] };

        const innerEdge = [];
        const outerEdge = [];

        for (let i = 0; i < n; i++) {
            const prev = coords[(i - 1 + n) % n];
            const curr = coords[i];
            const next = coords[(i + 1) % n];

            // Compute tangent vector (direction)
            const dx = next.X - prev.X;
            const dy = next.Y - prev.Y;
            const len = Math.sqrt(dx * dx + dy * dy);

            if (len < 0.001) {
                // Avoid division by zero
                innerEdge.push({ X: curr.X, Y: curr.Y });
                outerEdge.push({ X: curr.X, Y: curr.Y });
                continue;
            }

            // Normalize tangent
            const tx = dx / len;
            const ty = dy / len;

            // Normal (perpendicular) vector
            const nx = -ty;
            const ny = tx;

            // Inner and outer edge points
            const halfWidth = trackWidth / 2;
            innerEdge.push({
                X: curr.X - nx * halfWidth,
                Y: curr.Y - ny * halfWidth
            });
            outerEdge.push({
                X: curr.X + nx * halfWidth,
                Y: curr.Y + ny * halfWidth
            });
        }

        return { innerEdge, outerEdge };
    }

    /**
     * Draw track inner and outer edge lines (white track limits)
     * @param {Array} coords - Track coordinates
     */
    drawTrackEdges(coords) {
        // Compute track edges
        const { innerEdge, outerEdge } = this.computeTrackEdges(coords, 180);

        const line = d3.line()
            .x(d => this.xScale(d.X))
            .y(d => this.yScale(d.Y))
            .curve(d3.curveCatmullRom.alpha(0.5));

        // Draw inner edge (white line)
        this.trackOutlineLayer.append('path')
            .attr('class', 'track-edge track-edge-inner')
            .attr('d', line(innerEdge))
            .attr('fill', 'none')
            .attr('stroke', 'rgba(255, 255, 255, 0.4)')
            .attr('stroke-width', 1.5)
            .attr('stroke-linecap', 'round')
            .attr('stroke-linejoin', 'round');

        // Draw outer edge (white line)
        this.trackOutlineLayer.append('path')
            .attr('class', 'track-edge track-edge-outer')
            .attr('d', line(outerEdge))
            .attr('fill', 'none')
            .attr('stroke', 'rgba(255, 255, 255, 0.4)')
            .attr('stroke-width', 1.5)
            .attr('stroke-linecap', 'round')
            .attr('stroke-linejoin', 'round');

        // Store edges for later use
        this.innerEdge = innerEdge;
        this.outerEdge = outerEdge;
    }

    /**
     * Draw track with sector colors (S1=Red, S2=Yellow, S3=Blue)
     */
    drawSectoredTrack(coords) {
        const totalPoints = coords.length;
        const sectorSize = Math.floor(totalPoints / 3);

        const sectors = [
            { points: coords.slice(0, sectorSize), color: this.sectorColors[1] },
            { points: coords.slice(sectorSize, sectorSize * 2), color: this.sectorColors[2] },
            { points: coords.slice(sectorSize * 2), color: this.sectorColors[3] }
        ];

        const line = d3.line()
            .x(d => this.xScale(d.X))
            .y(d => this.yScale(d.Y))
            .curve(d3.curveCatmullRom.alpha(0.5));

        sectors.forEach((sector, index) => {
            // Add overlap point for smooth connection
            if (index > 0) {
                sector.points.unshift(sectors[index - 1].points[sectors[index - 1].points.length - 1]);
            }
            // Connect last sector back to first
            if (index === 2 && coords.length > 0) {
                sector.points.push(coords[0]);
            }

            this.sectorLayer.append('path')
                .attr('class', `sector sector-${index + 1}`)
                .attr('d', line(sector.points))
                .attr('fill', 'none')
                .attr('stroke', sector.color)
                .attr('stroke-width', 18)
                .attr('stroke-linecap', 'butt')
                .attr('stroke-linejoin', 'miter');
        });
    }

    /**
     * Draw Start/Finish - simple white line with checkered flag icon and direction arrow
     */
    drawStartFinish(coords) {
        if (!coords || coords.length < 2) return;

        // Use first point as start/finish
        const p1 = coords[0];
        const p2 = coords[Math.min(10, coords.length - 1)];

        const x1 = this.xScale(p1.X);
        const y1 = this.yScale(p1.Y);
        const x2 = this.xScale(p2.X);
        const y2 = this.yScale(p2.Y);

        // Calculate perpendicular vector (for line across track)
        const dx = x2 - x1;
        const dy = y2 - y1;
        const len = Math.sqrt(dx * dx + dy * dy);
        const perpX = -dy / len;
        const perpY = dx / len;

        // Direction vector (along track)
        const dirX = dx / len;
        const dirY = dy / len;

        const lineSize = 18; // Line half-length

        // Simple white line across track
        this.startFinishLayer.append('line')
            .attr('class', 'sf-line')
            .attr('x1', x1 - perpX * lineSize)
            .attr('y1', y1 - perpY * lineSize)
            .attr('x2', x1 + perpX * lineSize)
            .attr('y2', y1 + perpY * lineSize)
            .attr('stroke', '#FFFFFF')
            .attr('stroke-width', 3);

        // Position for checkered flag icon (outside track)
        const flagOffset = lineSize + 25;
        const flagX = x1 - perpX * flagOffset;
        const flagY = y1 - perpY * flagOffset;

        // Draw checkered flag icon (4x4 pattern)
        const flagSize = 12;
        const cellSize = flagSize / 4;
        for (let row = 0; row < 4; row++) {
            for (let col = 0; col < 4; col++) {
                const isBlack = (row + col) % 2 === 0;
                this.labelsLayer.append('rect')
                    .attr('class', 'checkered-flag-cell')
                    .attr('x', flagX - flagSize / 2 + col * cellSize)
                    .attr('y', flagY - flagSize / 2 + row * cellSize)
                    .attr('width', cellSize)
                    .attr('height', cellSize)
                    .attr('fill', isBlack ? '#000000' : '#FFFFFF');
            }
        }

        // Draw direction arrow next to the flag
        const arrowOffset = flagOffset + 20;
        const arrowX = x1 - perpX * arrowOffset;
        const arrowY = y1 - perpY * arrowOffset;
        const arrowSize = 8;

        // Arrow pointing in track direction
        const arrowPath = `M ${arrowX + dirX * arrowSize} ${arrowY + dirY * arrowSize} 
            L ${arrowX - dirX * arrowSize * 0.5 - perpX * arrowSize * 0.6} ${arrowY - dirY * arrowSize * 0.5 - perpY * arrowSize * 0.6}
            L ${arrowX - dirX * arrowSize * 0.5 + perpX * arrowSize * 0.6} ${arrowY - dirY * arrowSize * 0.5 + perpY * arrowSize * 0.6} Z`;

        this.labelsLayer.append('path')
            .attr('class', 'sf-arrow')
            .attr('d', arrowPath)
            .attr('fill', '#FFFFFF')
            .attr('opacity', 0.9);
    }

    /**
     * Draw corners with labels positioned outside the track
     */
    drawCorners(corners, trackCoords) {
        corners.forEach((corner, idx) => {
            const cx = this.xScale(corner.X);
            const cy = this.yScale(corner.Y);

            // Find nearest track point to calculate outward direction
            let nearestIdx = 0;
            let minDist = Infinity;
            trackCoords.forEach((tc, i) => {
                const d = Math.hypot(tc.X - corner.X, tc.Y - corner.Y);
                if (d < minDist) {
                    minDist = d;
                    nearestIdx = i;
                }
            });

            // Calculate track direction at this point
            const prevIdx = Math.max(0, nearestIdx - 5);
            const nextIdx = Math.min(trackCoords.length - 1, nearestIdx + 5);
            const tp = trackCoords[prevIdx];
            const tn = trackCoords[nextIdx];

            const tdx = this.xScale(tn.X) - this.xScale(tp.X);
            const tdy = this.yScale(tn.Y) - this.yScale(tp.Y);
            const tlen = Math.sqrt(tdx * tdx + tdy * tdy) || 1;

            // Outward perpendicular (rotate 90 degrees)
            let outX = -tdy / tlen;
            let outY = tdx / tlen;

            // Position label outside track
            const labelDistance = 35;
            const labelX = cx + outX * labelDistance;
            const labelY = cy + outY * labelDistance;

            // Corner number label
            const cornerNum = corner.Number ? corner.Number.toString().padStart(2, '0') : '';

            // Label background circle
            this.cornersLayer.append('circle')
                .attr('class', 'corner-bg')
                .attr('cx', labelX)
                .attr('cy', labelY)
                .attr('r', 10)
                .attr('fill', 'rgba(20, 24, 40, 0.9)')
                .attr('stroke', 'rgba(255, 255, 255, 0.3)')
                .attr('stroke-width', 1);

            // Corner number text
            this.cornersLayer.append('text')
                .attr('class', 'corner-label')
                .attr('x', labelX)
                .attr('y', labelY)
                .attr('text-anchor', 'middle')
                .attr('dominant-baseline', 'central')
                .attr('fill', '#AAAAAA')
                .attr('font-size', '9px')
                .attr('font-weight', '700')
                .attr('font-family', "'Titillium Web', sans-serif")
                .text(cornerNum);

            // Subtle connector line from track to label
            this.cornersLayer.append('line')
                .attr('class', 'corner-connector')
                .attr('x1', cx)
                .attr('y1', cy)
                .attr('x2', labelX - outX * 10)
                .attr('y2', labelY - outY * 10)
                .attr('stroke', 'rgba(255, 255, 255, 0.15)')
                .attr('stroke-width', 1);
        });
    }

    /**
     * Draw DRS zones on the track
     * @param {Object} drsData - DRS zone data from API
     * @param {Array} coords - Track coordinates for reference
     */
    drawDRSZones(drsData, coords) {
        // Clear existing DRS zones
        this.drsLayer.selectAll('*').remove();

        if (!drsData || !drsData.zones || drsData.zones.length === 0) {
            return;
        }

        const circuitLength = drsData.circuit_length || this.estimateTrackLength(coords);
        if (!circuitLength || !coords || coords.length === 0) {
            return;
        }

        const line = d3.line()
            .x(d => this.xScale(d.X))
            .y(d => this.yScale(d.Y))
            .curve(d3.curveCatmullRom.alpha(0.5));

        drsData.zones.forEach((zone, index) => {
            // Calculate the portion of track for this DRS zone
            const activationStart = zone.activation_start / circuitLength;
            const activationEnd = zone.activation_end / circuitLength;
            const detectionPoint = zone.detection_distance / circuitLength;

            // Get the track segment for activation zone
            const startIdx = Math.floor(activationStart * coords.length);
            const endIdx = Math.floor(activationEnd * coords.length);
            const detectionIdx = Math.floor(detectionPoint * coords.length);

            // Extract zone points
            let zonePoints = [];
            if (startIdx < endIdx) {
                zonePoints = coords.slice(startIdx, endIdx + 1);
            } else {
                // Zone wraps around
                zonePoints = [...coords.slice(startIdx), ...coords.slice(0, endIdx + 1)];
            }

            if (zonePoints.length > 1) {
                // Draw DRS activation zone as green overlay
                this.drsLayer.append('path')
                    .attr('class', `drs-zone drs-zone-${index + 1}`)
                    .attr('d', line(zonePoints))
                    .attr('fill', 'none')
                    .attr('stroke', '#00FF00')
                    .attr('stroke-width', 22)
                    .attr('stroke-opacity', 0.4)
                    .attr('stroke-linecap', 'round');

                // Inner green line for better visibility
                this.drsLayer.append('path')
                    .attr('class', `drs-zone-inner drs-zone-${index + 1}`)
                    .attr('d', line(zonePoints))
                    .attr('fill', 'none')
                    .attr('stroke', '#00FF88')
                    .attr('stroke-width', 4)
                    .attr('stroke-opacity', 0.8)
                    .attr('stroke-linecap', 'round');
            }

            // Draw DRS detection point marker
            if (detectionIdx >= 0 && detectionIdx < coords.length) {
                const dp = coords[detectionIdx];
                const dpX = this.xScale(dp.X);
                const dpY = this.yScale(dp.Y);

                // Detection point marker (small diamond)
                this.drsLayer.append('rect')
                    .attr('class', 'drs-detection')
                    .attr('x', dpX - 5)
                    .attr('y', dpY - 5)
                    .attr('width', 10)
                    .attr('height', 10)
                    .attr('fill', '#FFFF00')
                    .attr('transform', `rotate(45, ${dpX}, ${dpY})`)
                    .attr('stroke', '#000')
                    .attr('stroke-width', 1);
            }
        });

        // Add DRS legend
        this.addDRSLegend();
    }

    /**
     * Add DRS legend to the map
     */
    addDRSLegend() {
        const legendX = 20;
        const legendY = this.height - 50;

        const legend = this.labelsLayer.append('g')
            .attr('class', 'drs-legend');

        // DRS zone indicator
        legend.append('line')
            .attr('x1', legendX)
            .attr('y1', legendY)
            .attr('x2', legendX + 30)
            .attr('y2', legendY)
            .attr('stroke', '#00FF88')
            .attr('stroke-width', 4);

        legend.append('text')
            .attr('x', legendX + 40)
            .attr('y', legendY + 4)
            .attr('fill', '#AAAAAA')
            .attr('font-size', '10px')
            .text('DRS Zone');

        // Detection point indicator
        legend.append('rect')
            .attr('x', legendX + 2)
            .attr('y', legendY + 15)
            .attr('width', 8)
            .attr('height', 8)
            .attr('fill', '#FFFF00')
            .attr('transform', `rotate(45, ${legendX + 6}, ${legendY + 19})`);

        legend.append('text')
            .attr('x', legendX + 40)
            .attr('y', legendY + 22)
            .attr('fill', '#AAAAAA')
            .attr('font-size', '10px')
            .text('Detection');
    }

    /**
     * Estimate track length from coordinates
     */
    estimateTrackLength(coords) {
        if (!coords || coords.length < 2) return 0;

        let length = 0;
        for (let i = 1; i < coords.length; i++) {
            const dx = coords[i].X - coords[i - 1].X;
            const dy = coords[i].Y - coords[i - 1].Y;
            length += Math.sqrt(dx * dx + dy * dy);
        }
        return length;
    }

    /**
     * Update track status overlay (yellow flags, SC zones)
     * @param {String} status - Track status: 'green', 'yellow', 'sc', 'vsc', 'red'
     * @param {Number} sector - Optional sector number (1-3) for localized flags
     */
    updateTrackStatus(status, sector = null) {
        // Clear existing status overlay
        this.drsLayer.selectAll('.track-status-overlay').remove();

        const statusColors = {
            'green': null, // No overlay for green
            'yellow': 'rgba(255, 200, 0, 0.3)',
            'sc': 'rgba(255, 165, 0, 0.4)',
            'vsc': 'rgba(255, 165, 0, 0.3)',
            'red': 'rgba(255, 0, 0, 0.4)'
        };

        const color = statusColors[status.toLowerCase()];
        if (!color || !this.trackCoords) return;

        const line = d3.line()
            .x(d => this.xScale(d.X))
            .y(d => this.yScale(d.Y))
            .curve(d3.curveCatmullRom.alpha(0.5));

        let coords = this.trackCoords;

        // If sector specified, only highlight that sector
        if (sector !== null && sector >= 1 && sector <= 3) {
            const sectorSize = Math.floor(coords.length / 3);
            const sectorStart = (sector - 1) * sectorSize;
            const sectorEnd = sector === 3 ? coords.length : sector * sectorSize;
            coords = coords.slice(sectorStart, sectorEnd);
        }

        // Draw status overlay
        this.drsLayer.append('path')
            .attr('class', 'track-status-overlay')
            .attr('d', line(coords))
            .attr('fill', 'none')
            .attr('stroke', color)
            .attr('stroke-width', 30)
            .attr('stroke-linecap', 'round');

        // Add status indicator
        this.showStatusIndicator(status);
    }

    /**
     * Show status indicator (SC/VSC/Red flag icon)
     */
    showStatusIndicator(status) {
        // Remove existing indicator
        this.labelsLayer.selectAll('.status-indicator').remove();

        if (status.toLowerCase() === 'green') return;

        const indicatorX = this.width - 80;
        const indicatorY = 30;

        const indicator = this.labelsLayer.append('g')
            .attr('class', 'status-indicator');

        const statusInfo = {
            'sc': { text: 'SAFETY CAR', color: '#FF8C00' },
            'vsc': { text: 'VSC', color: '#FFB84D' },
            'yellow': { text: 'YELLOW FLAG', color: '#FFD700' },
            'red': { text: 'RED FLAG', color: '#FF0000' }
        };

        const info = statusInfo[status.toLowerCase()];
        if (!info) return;

        // Background
        indicator.append('rect')
            .attr('x', indicatorX - 10)
            .attr('y', indicatorY - 12)
            .attr('width', 90)
            .attr('height', 24)
            .attr('rx', 4)
            .attr('fill', info.color)
            .attr('fill-opacity', 0.9);

        // Text
        indicator.append('text')
            .attr('x', indicatorX + 35)
            .attr('y', indicatorY + 4)
            .attr('text-anchor', 'middle')
            .attr('fill', '#000')
            .attr('font-size', '11px')
            .attr('font-weight', '700')
            .text(info.text);

        // Animate flashing for SC/VSC
        if (status.toLowerCase() === 'sc' || status.toLowerCase() === 'vsc') {
            indicator.select('rect')
                .attr('class', 'blink-animation');
        }
    }

    /**
     * Clear track status overlay
     */
    clearTrackStatus() {
        this.drsLayer.selectAll('.track-status-overlay').remove();
        this.labelsLayer.selectAll('.status-indicator').remove();
    }

    /**
     * Set driver information for colors and names
     */
    setDrivers(drivers) {
        drivers.forEach(driver => {
            this.drivers.set(driver.Abbreviation || driver.DriverNumber, {
                ...driver,
                color: driver.TeamColor || this.teamColors[driver.TeamName] || '#FFFFFF'
            });
        });
        return this;
    }

    /**
     * Update car positions on the track
     */
    updateCarPositions(positions) {
        // Validation: Need scales and data
        if (!this.xScale || !this.yScale || !positions || positions.length === 0) {
            return this;
        }

        const carData = positions.map(p => ({
            ...p,
            cx: this.xScale(p.x || p.X),
            cy: this.yScale(p.y || p.Y),
            driverInfo: this.drivers.get(p.driver) || {},
            // Use teamColor from position data, fallback to driver info
            color: p.teamColor || (this.drivers.get(p.driver)?.color) || '#FFFFFF'
        }))
            // Filter out entries with invalid coordinates
            .filter(d => {
                const validCx = typeof d.cx === 'number' && !isNaN(d.cx) && isFinite(d.cx);
                const validCy = typeof d.cy === 'number' && !isNaN(d.cy) && isFinite(d.cy);
                return validCx && validCy;
            });

        // Sort data so leader is drawn last (on top)
        carData.sort((a, b) => b.position - a.position);

        // Join data
        const cars = this.carsLayer.selectAll('.car-marker')
            .data(carData, d => d.driver);

        // Exit
        cars.exit()
            .transition()
            .duration(200)
            .style('opacity', 0)
            .remove();

        // Enter
        const carsEnter = cars.enter()
            .append('g')
            .attr('class', 'car-marker')
            .attr('transform', d => `translate(${d.cx}, ${d.cy})`)
            .style('opacity', 0)
            .style('cursor', 'pointer');

        // Glow effect for all cars (subtle)
        carsEnter.append('circle')
            .attr('class', 'car-glow')
            .attr('r', 12)
            .attr('fill', d => d.color)
            .attr('fill-opacity', 0.2)
            .attr('stroke', 'none');

        // Main car dot
        carsEnter.append('circle')
            .attr('class', 'car-dot')
            .attr('r', 6)
            .attr('fill', d => d.color)
            .attr('stroke', '#000')
            .attr('stroke-width', 1.5);

        // Driver abbreviation label
        carsEnter.append('text')
            .attr('class', 'car-label')
            .attr('x', 10)
            .attr('dy', '0.35em')
            .attr('fill', '#fff')
            .attr('font-size', '10px')
            .attr('font-weight', '700')
            .style('text-shadow', '0 1px 3px rgba(0,0,0,0.8)')
            .text(d => d.driver);

        carsEnter.transition()
            .duration(200)
            .style('opacity', 1);

        // Update all
        const mergedCars = cars.merge(carsEnter);

        mergedCars
            .classed('leader', d => d.position === 1)
            .classed('selected', d => this.selectedDrivers.has(d.driver))
            .classed('retired', d => d.retired)
            .transition()
            .duration(250)
            .ease(d3.easeLinear)
            .attr('transform', d => `translate(${d.cx}, ${d.cy})`);

        // Update car dot colors
        mergedCars.select('.car-dot')
            .transition()
            .duration(100)
            .attr('fill', d => d.color);

        // Update glow
        mergedCars.select('.car-glow')
            .transition()
            .duration(100)
            .attr('fill', d => d.color)
            .attr('r', d => d.position === 1 ? 16 : 12)
            .attr('fill-opacity', d => d.position === 1 ? 0.4 : 0.2);

        // Setup interactions
        this.carsLayer.selectAll('.car-marker')
            .on('mouseenter', (event, d) => this.showCarTooltip(event, d))
            .on('mouseleave', () => this.hideTooltip())
            .on('click', (event, d) => this.toggleDriverSelection(d.driver));

        return this;
    }

    /**
     * Show tooltip for car with comprehensive telemetry data
     * Enhanced with gear, DRS, throttle, brake, tyre info (f1-race-replay style)
     */
    showCarTooltip(event, d) {
        const info = d.driverInfo;

        // Format gap display
        const formatGap = (gap) => {
            if (!gap && gap !== 0) return '-';
            if (typeof gap === 'string') return gap;
            if (gap === 0) return 'LEADER';
            return gap > 0 ? `+${gap.toFixed(3)}s` : `${gap.toFixed(3)}s`;
        };

        // Format DRS status
        const getDrsStatus = (drs) => {
            if (drs === undefined || drs === null) return '-';
            if (drs === 1 || drs === true) return '<span style="color: #00FF00">OPEN</span>';
            if (drs > 10) return '<span style="color: #00FF00">OPEN</span>'; // DRS value encoding
            return '<span style="color: #888">OFF</span>';
        };

        // Format throttle/brake bars
        const formatPedalBar = (value, color) => {
            const pct = Math.min(100, Math.max(0, value || 0));
            return `<div style="width: 60px; height: 6px; background: #333; border-radius: 3px; overflow: hidden;">
                <div style="width: ${pct}%; height: 100%; background: ${color};"></div>
            </div>`;
        };

        // Tyre compound color
        const tyreColors = {
            'SOFT': '#FF0000', 'S': '#FF0000',
            'MEDIUM': '#FFD700', 'M': '#FFD700',
            'HARD': '#FFFFFF', 'H': '#FFFFFF',
            'INTERMEDIATE': '#00CC00', 'I': '#00CC00',
            'WET': '#0088FF', 'W': '#0088FF'
        };
        const tyreColor = tyreColors[d.tyre?.toUpperCase()] || tyreColors[d.compound?.toUpperCase()] || '#888';

        this.tooltip
            .style('opacity', 1)
            .style('left', `${event.pageX + 15}px`)
            .style('top', `${event.pageY - 10}px`)
            .html(`
                <div class="tooltip-title" style="color: ${d.color || '#FFF'}; border-bottom: 2px solid ${d.color || '#FFF'}; padding-bottom: 4px; margin-bottom: 6px;">
                    ${d.driver} <span style="color: #888; font-weight: 400; font-size: 10px;">${info.FullName || ''}</span>
                </div>
                <div class="tooltip-row">
                    <span class="tooltip-label">Position:</span>
                    <span class="tooltip-value" style="color: ${d.position === 1 ? '#FFD700' : '#FFF'}">P${d.position || '-'}</span>
                </div>
                <div class="tooltip-row">
                    <span class="tooltip-label">Gap:</span>
                    <span class="tooltip-value" style="color: #00FF00">${formatGap(d.gap)}</span>
                </div>
                <div class="tooltip-row">
                    <span class="tooltip-label">Speed:</span>
                    <span class="tooltip-value">${d.speed ? Math.round(d.speed) + ' km/h' : '-'}</span>
                </div>
                <div class="tooltip-row">
                    <span class="tooltip-label">Gear:</span>
                    <span class="tooltip-value" style="font-size: 14px; font-weight: 700;">${d.gear !== undefined ? d.gear : '-'}</span>
                </div>
                <div class="tooltip-row">
                    <span class="tooltip-label">DRS:</span>
                    <span class="tooltip-value">${getDrsStatus(d.drs)}</span>
                </div>
                <div class="tooltip-row" style="align-items: center;">
                    <span class="tooltip-label">Throttle:</span>
                    ${formatPedalBar(d.throttle, '#00FF00')}
                </div>
                <div class="tooltip-row" style="align-items: center;">
                    <span class="tooltip-label">Brake:</span>
                    ${formatPedalBar(d.brake, '#FF0000')}
                </div>
                ${d.tyre || d.compound ? `
                    <div class="tooltip-row" style="margin-top: 4px; padding-top: 4px; border-top: 1px solid #333;">
                        <span class="tooltip-label">Tyre:</span>
                        <span class="tooltip-value" style="display: flex; align-items: center; gap: 4px;">
                            <span style="width: 8px; height: 8px; border-radius: 50%; background: ${tyreColor};"></span>
                            ${(d.tyre || d.compound || '').toUpperCase()}${d.tyreAge ? ` (${d.tyreAge} laps)` : ''}
                        </span>
                    </div>
                ` : ''}
            `);
    }

    /**
     * Hide tooltip
     */
    hideTooltip() {
        this.tooltip.style('opacity', 0);
    }

    /**
     * Toggle driver selection
     */
    toggleDriverSelection(driver) {
        if (this.selectedDrivers.has(driver)) {
            this.selectedDrivers.delete(driver);
        } else {
            this.selectedDrivers.add(driver);
        }

        this.carsLayer.selectAll('.car-marker')
            .classed('selected', d => this.selectedDrivers.has(d.driver));

        // Dispatch custom event
        this.container.dispatchEvent(new CustomEvent('driverSelectionChanged', {
            detail: { selectedDrivers: Array.from(this.selectedDrivers) }
        }));
    }

    /**
     * Zoom controls
     */
    zoomIn() {
        this.svg.transition().call(this.zoom.scaleBy, 1.5);
    }

    zoomOut() {
        this.svg.transition().call(this.zoom.scaleBy, 0.67);
    }

    resetZoom() {
        this.svg.transition().call(this.zoom.transform, d3.zoomIdentity);
    }

    /**
     * Show no data message
     */
    showNoDataMessage(message) {
        this.container.innerHTML = `
            <div class="loading-placeholder">
                <span>${message}</span>
            </div>
        `;
    }

    /**
     * Destroy visualization
     */
    destroy() {
        if (this.tooltip) {
            this.tooltip.remove();
        }
        if (this.container) {
            this.container.innerHTML = '';
        }
    }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { TrackMapVisualization };
}
