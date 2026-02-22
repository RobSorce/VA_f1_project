/**
 * F1 Analytics Platform - Lap Times Chart
 * D3.js multi-line time series visualization
 */

class LapTimesVisualization {
    constructor(containerId) {
        this.containerId = containerId;
        this.container = document.getElementById(containerId);
        this.svg = null;
        this.width = 0;
        this.height = 0;
        this.margin = { top: 20, right: 80, bottom: 40, left: 60 };
        this.data = [];
        this.drivers = new Map();
        this.hiddenDrivers = new Set();
        this.highlightedDriver = null;

        // Team colors
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
        this.container.innerHTML = '';

        const rect = this.container.getBoundingClientRect();
        this.width = rect.width;
        this.height = rect.height;

        const innerWidth = this.width - this.margin.left - this.margin.right;
        const innerHeight = this.height - this.margin.top - this.margin.bottom;

        // Create SVG
        this.svg = d3.select(this.container)
            .append('svg')
            .attr('width', '100%')
            .attr('height', '100%')
            .attr('viewBox', `0 0 ${this.width} ${this.height}`)
            .attr('class', 'lap-times-chart');

        // Create clip path
        this.svg.append('defs')
            .append('clipPath')
            .attr('id', 'clip-laptimes')
            .append('rect')
            .attr('width', innerWidth)
            .attr('height', innerHeight);

        // Main group
        this.g = this.svg.append('g')
            .attr('transform', `translate(${this.margin.left}, ${this.margin.top})`);

        // Grid group
        this.gridGroup = this.g.append('g').attr('class', 'grid');

        // Lines group (clipped)
        this.linesGroup = this.g.append('g')
            .attr('class', 'lines-group')
            .attr('clip-path', 'url(#clip-laptimes)');

        // Points group (clipped)
        this.pointsGroup = this.g.append('g')
            .attr('class', 'points-group')
            .attr('clip-path', 'url(#clip-laptimes)');

        // Axes groups
        this.xAxisGroup = this.g.append('g')
            .attr('class', 'axis x-axis')
            .attr('transform', `translate(0, ${innerHeight})`);

        this.yAxisGroup = this.g.append('g')
            .attr('class', 'axis y-axis');

        // Axis labels
        this.svg.append('text')
            .attr('class', 'axis-label')
            .attr('text-anchor', 'middle')
            .attr('x', this.margin.left + innerWidth / 2)
            .attr('y', this.height - 5)
            .attr('fill', 'var(--color-text-secondary)')
            .attr('font-size', '11px')
            .text('Lap Number');

        this.svg.append('text')
            .attr('class', 'axis-label')
            .attr('text-anchor', 'middle')
            .attr('transform', `rotate(-90)`)
            .attr('x', -(this.margin.top + innerHeight / 2))
            .attr('y', 15)
            .attr('fill', 'var(--color-text-secondary)')
            .attr('font-size', '11px')
            .text('Lap Time (s)');

        // Tooltip line (crosshair)
        this.crosshairGroup = this.g.append('g')
            .attr('class', 'crosshair')
            .style('display', 'none');

        this.crosshairGroup.append('line')
            .attr('class', 'crosshair-line')
            .attr('y1', 0)
            .attr('y2', innerHeight);

        // Tooltip
        this.tooltip = d3.select('body')
            .append('div')
            .attr('class', 'tooltip')
            .style('opacity', 0);

        // Overlay for mouse events
        this.overlay = this.g.append('rect')
            .attr('class', 'overlay')
            .attr('width', innerWidth)
            .attr('height', innerHeight)
            .attr('fill', 'transparent')
            .on('mousemove', (event) => this.handleMouseMove(event))
            .on('mouseleave', () => this.handleMouseLeave());

        return this;
    }

    /**
     * Set driver information
     */
    setDrivers(drivers) {
        drivers.forEach(driver => {
            const abbr = driver.Abbreviation || driver.DriverNumber;
            this.drivers.set(abbr, {
                ...driver,
                color: driver.TeamColor || this.teamColors[driver.TeamName] || '#FFFFFF'
            });
        });
        return this;
    }

    /**
     * Update chart with lap times data
     */
    update(lapTimes) {
        if (!lapTimes || lapTimes.length === 0) {
            this.showNoDataMessage('No lap time data available');
            return this;
        }

        this.data = lapTimes;

        const innerWidth = this.width - this.margin.left - this.margin.right;
        const innerHeight = this.height - this.margin.top - this.margin.bottom;

        // Group data by driver
        const driverLaps = d3.group(lapTimes, d => d.Driver);

        // Calculate extent
        const lapExtent = d3.extent(lapTimes, d => d.LapNumber);
        const timeExtent = d3.extent(lapTimes.filter(d => d.LapTimeSeconds > 0), d => d.LapTimeSeconds);

        // Add some padding to y-axis
        const timePadding = (timeExtent[1] - timeExtent[0]) * 0.1;

        // Create scales
        this.xScale = d3.scaleLinear()
            .domain(lapExtent)
            .range([0, innerWidth]);

        this.yScale = d3.scaleLinear()
            .domain([timeExtent[0] - timePadding, timeExtent[1] + timePadding])
            .range([innerHeight, 0]);

        // Create axes
        const xAxis = d3.axisBottom(this.xScale)
            .ticks(Math.min(10, lapExtent[1]))
            .tickFormat(d => d);

        const yAxis = d3.axisLeft(this.yScale)
            .ticks(6)
            .tickFormat(d => this.formatLapTime(d));

        // Update axes
        this.xAxisGroup.transition().duration(500).call(xAxis);
        this.yAxisGroup.transition().duration(500).call(yAxis);

        // Update grid
        this.gridGroup.selectAll('line').remove();

        this.gridGroup.selectAll('.grid-line-h')
            .data(this.yScale.ticks(6))
            .enter()
            .append('line')
            .attr('class', 'grid line')
            .attr('x1', 0)
            .attr('x2', innerWidth)
            .attr('y1', d => this.yScale(d))
            .attr('y2', d => this.yScale(d));

        // Line generator
        const line = d3.line()
            .defined(d => d.LapTimeSeconds > 0)
            .x(d => this.xScale(d.LapNumber))
            .y(d => this.yScale(d.LapTimeSeconds))
            .curve(d3.curveMonotoneX);

        // Update lines
        const lines = this.linesGroup.selectAll('.lap-line')
            .data(Array.from(driverLaps.entries()), d => d[0]);

        lines.exit().remove();

        const linesEnter = lines.enter()
            .append('path')
            .attr('class', 'lap-line');

        lines.merge(linesEnter)
            .attr('stroke', d => {
                const driverInfo = this.drivers.get(d[0]);
                return driverInfo ? driverInfo.color : '#FFFFFF';
            })
            .classed('dimmed', d => this.hiddenDrivers.has(d[0]))
            .classed('highlighted', d => this.highlightedDriver === d[0])
            .transition()
            .duration(500)
            .attr('d', d => line(d[1].sort((a, b) => a.LapNumber - b.LapNumber)));

        // Add hover effect to lines
        this.linesGroup.selectAll('.lap-line')
            .on('mouseenter', (event, d) => this.highlightDriver(d[0]))
            .on('mouseleave', () => this.highlightDriver(null));

        // Find fastest lap and pit stops
        const fastestLap = lapTimes.reduce((fastest, lap) =>
            lap.LapTimeSeconds > 0 && lap.LapTimeSeconds < fastest.LapTimeSeconds ? lap : fastest
            , { LapTimeSeconds: Infinity });

        // Mark pit stops
        const pitStops = lapTimes.filter(d => d.PitOutTimeSeconds || d.PitInTimeSeconds);

        // Mark special points
        const specialPoints = [
            ...pitStops.map(d => ({ ...d, type: 'pit-stop' })),
            { ...fastestLap, type: 'fastest' }
        ].filter(d => d.LapTimeSeconds > 0);

        const points = this.pointsGroup.selectAll('.lap-point')
            .data(specialPoints, d => `${d.Driver}-${d.LapNumber}-${d.type}`);

        points.exit().remove();

        points.enter()
            .append('circle')
            .attr('class', d => `lap-point ${d.type}`)
            .merge(points)
            .attr('cx', d => this.xScale(d.LapNumber))
            .attr('cy', d => this.yScale(d.LapTimeSeconds))
            .attr('r', d => d.type === 'fastest' ? 5 : 4)
            .attr('fill', d => {
                const driverInfo = this.drivers.get(d.Driver);
                return driverInfo ? driverInfo.color : '#FFFFFF';
            });

        // Update legend
        this.updateLegend(driverLaps);

        return this;
    }

    /**
     * Format lap time as minutes:seconds.milliseconds
     */
    formatLapTime(seconds) {
        if (!seconds || seconds <= 0) return '--:--.---';
        const mins = Math.floor(seconds / 60);
        const secs = (seconds % 60).toFixed(3);
        return `${mins}:${secs.padStart(6, '0')}`;
    }

    /**
     * Update legend
     */
    updateLegend(driverLaps) {
        const legendContainer = this.container.parentElement.querySelector('.chart-legend');
        if (!legendContainer) return;

        legendContainer.innerHTML = '';

        const sortedDrivers = Array.from(driverLaps.keys()).sort();

        sortedDrivers.forEach(driver => {
            const driverInfo = this.drivers.get(driver) || {};
            const item = document.createElement('div');
            item.className = `legend-item ${this.hiddenDrivers.has(driver) ? 'hidden' : ''}`;
            item.innerHTML = `
                <span class="legend-color" style="background-color: ${driverInfo.color || '#FFF'}"></span>
                <span class="legend-label">${driver}</span>
            `;
            item.addEventListener('click', () => this.toggleDriver(driver));
            legendContainer.appendChild(item);
        });
    }

    /**
     * Toggle driver visibility
     */
    toggleDriver(driver) {
        if (this.hiddenDrivers.has(driver)) {
            this.hiddenDrivers.delete(driver);
        } else {
            this.hiddenDrivers.add(driver);
        }
        this.update(this.data);
    }

    /**
     * Highlight a specific driver
     */
    highlightDriver(driver) {
        this.highlightedDriver = driver;

        this.linesGroup.selectAll('.lap-line')
            .classed('highlighted', d => driver && d[0] === driver)
            .classed('dimmed', d => driver && d[0] !== driver && !this.hiddenDrivers.has(d[0]));
    }

    /**
     * Handle mouse move for crosshair
     */
    handleMouseMove(event) {
        const [mouseX] = d3.pointer(event);
        const lap = Math.round(this.xScale.invert(mouseX));

        // Show crosshair
        this.crosshairGroup
            .style('display', null)
            .attr('transform', `translate(${this.xScale(lap)}, 0)`);

        // Find lap data for tooltip
        const lapData = this.data.filter(d => d.LapNumber === lap && d.LapTimeSeconds > 0);

        if (lapData.length > 0) {
            const sortedLapData = lapData.sort((a, b) => a.LapTimeSeconds - b.LapTimeSeconds);

            this.tooltip
                .style('opacity', 1)
                .style('left', `${event.pageX + 15}px`)
                .style('top', `${event.pageY}px`)
                .html(`
                    <div class="tooltip-title">Lap ${lap}</div>
                    ${sortedLapData.slice(0, 5).map(d => {
                    const driverInfo = this.drivers.get(d.Driver) || {};
                    return `
                            <div class="tooltip-row">
                                <span class="tooltip-label" style="color: ${driverInfo.color || '#FFF'}">${d.Driver}</span>
                                <span class="tooltip-value">${this.formatLapTime(d.LapTimeSeconds)}</span>
                            </div>
                        `;
                }).join('')}
                `);
        }
    }

    /**
     * Handle mouse leave
     */
    handleMouseLeave() {
        this.crosshairGroup.style('display', 'none');
        this.tooltip.style('opacity', 0);
        this.highlightDriver(null);
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
        if (this.tooltip) this.tooltip.remove();
        if (this.container) this.container.innerHTML = '';
    }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { LapTimesVisualization };
}
