/**
 * F1 Analytics Platform - Track Map Visualization
 * D3.js-based interactive circuit visualization with car positions
 * Inspired by f1-race-replay repository
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

        // Get container dimensions
        const rect = this.container.getBoundingClientRect();
        this.width = rect.width;
        this.height = rect.height;

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

        // Create layers
        this.trackLayer = this.g.append('g').attr('class', 'track-layer');
        this.drsLayer = this.g.append('g').attr('class', 'drs-layer');
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

        // Calculate bounds
        const xExtent = d3.extent(coords, d => d.X);
        const yExtent = d3.extent(coords, d => d.Y);

        // Add padding
        const padding = 50;
        const trackWidth = xExtent[1] - xExtent[0];
        const trackHeight = yExtent[1] - yExtent[0];
        const aspectRatio = trackWidth / trackHeight;

        // Calculate scale to fit container
        let scaleX, scaleY, scale;
        const availableWidth = this.width - padding * 2;
        const availableHeight = this.height - padding * 2;

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

        // Create track path
        const line = d3.line()
            .x(d => this.xScale(d.X))
            .y(d => this.yScale(d.Y))
            .curve(d3.curveCatmullRom.alpha(0.5));

        // Draw track outline (shadow)
        this.trackLayer.append('path')
            .attr('class', 'track-outline')
            .attr('d', line(coords));

        // Draw track surface
        this.trackLayer.append('path')
            .attr('class', 'track-surface')
            .attr('d', line(coords));

        // Draw centerline
        this.trackLayer.append('path')
            .attr('class', 'track-centerline')
            .attr('d', line(coords));

        // Start/finish line removed per user request

        // Draw corners if available
        if (circuitInfo.corners && circuitInfo.corners.length > 0) {
            this.drawCorners(circuitInfo.corners);
        }

        return this;
    }

    /**
     * Draw corner markers
     */
    drawCorners(corners) {
        const cornerGroups = this.cornersLayer.selectAll('.corner-group')
            .data(corners)
            .enter()
            .append('g')
            .attr('class', 'corner-group')
            .attr('transform', d => {
                const x = this.xScale(d.X);
                const y = this.yScale(d.Y);
                return `translate(${x}, ${y})`;
            });

        cornerGroups.append('circle')
            .attr('class', 'corner-marker')
            .attr('r', 10);

        cornerGroups.append('text')
            .attr('class', 'corner-label')
            .text(d => d.Number || d.Letter || '');
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
        // positions should be: [{ driver: 'VER', x: 100, y: 200, position: 1, teamColor: '#3671C6', ... }, ...]

        const carData = positions.map(p => ({
            ...p,
            cx: this.xScale ? this.xScale(p.x || p.X) : p.x,
            cy: this.yScale ? this.yScale(p.y || p.Y) : p.y,
            driverInfo: this.drivers.get(p.driver) || {},
            // Use teamColor from position data, fallback to driver info
            color: p.teamColor || (this.drivers.get(p.driver)?.color) || '#FFFFFF'
        }));

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
            .style('opacity', 0);

        // Glow effect for leader
        carsEnter.append('circle')
            .attr('class', 'car-glow')
            .attr('r', 14)
            .attr('fill', 'none')
            .attr('stroke', d => d.color)
            .attr('stroke-width', 2)
            .attr('opacity', d => d.position === 1 ? 0.6 : 0);

        // Main car dot
        carsEnter.append('circle')
            .attr('class', 'car-dot')
            .attr('r', 8)
            .attr('fill', d => d.color);

        // Driver abbreviation label
        carsEnter.append('text')
            .attr('class', 'car-label')
            .attr('x', 12)
            .attr('dy', '0.35em')
            .attr('fill', '#fff')
            .attr('font-size', '10px')
            .attr('font-weight', '600')
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
            .ease(d3.easeQuadOut)
            .attr('transform', d => `translate(${d.cx}, ${d.cy})`);

        // Update car dot colors
        mergedCars.select('.car-dot')
            .transition()
            .duration(100)
            .attr('fill', d => d.color);

        // Update glow for leader
        mergedCars.select('.car-glow')
            .transition()
            .duration(100)
            .attr('stroke', d => d.color)
            .attr('opacity', d => d.position === 1 ? 0.6 : 0);

        // Setup interactions
        this.carsLayer.selectAll('.car-marker')
            .on('mouseenter', (event, d) => this.showCarTooltip(event, d))
            .on('mouseleave', () => this.hideTooltip())
            .on('click', (event, d) => this.toggleDriverSelection(d.driver));

        return this;
    }

    /**
     * Show tooltip for car
     */
    showCarTooltip(event, d) {
        const info = d.driverInfo;

        this.tooltip
            .style('opacity', 1)
            .style('left', `${event.pageX + 10}px`)
            .style('top', `${event.pageY - 10}px`)
            .html(`
                <div class="tooltip-title" style="color: ${info.color || '#FFF'}">${d.driver}</div>
                <div class="tooltip-row">
                    <span class="tooltip-label">Position:</span>
                    <span class="tooltip-value">P${d.position || '-'}</span>
                </div>
                <div class="tooltip-row">
                    <span class="tooltip-label">Speed:</span>
                    <span class="tooltip-value">${d.speed ? Math.round(d.speed) + ' km/h' : '-'}</span>
                </div>
                <div class="tooltip-row">
                    <span class="tooltip-label">Gap:</span>
                    <span class="tooltip-value">${d.gap || '-'}</span>
                </div>
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
