/**
 * F1 Analytics Platform - Telemetry Visualization
 * Speed, throttle, brake, gear traces for detailed analysis
 */

class TelemetryVisualization {
    constructor(containerId) {
        this.containerId = containerId;
        this.container = document.getElementById(containerId);
        this.svg = null;
        this.width = 0;
        this.height = 0;
        this.margin = { top: 10, right: 20, bottom: 30, left: 50 };
        this.data = null;
    }

    /**
     * Initialize the visualization
     */
    init() {
        this.container.innerHTML = '';

        const rect = this.container.getBoundingClientRect();
        this.width = rect.width;
        this.height = rect.height;

        this.svg = d3.select(this.container)
            .append('svg')
            .attr('width', '100%')
            .attr('height', '100%')
            .attr('viewBox', `0 0 ${this.width} ${this.height}`)
            .attr('class', 'telemetry-chart');

        // Tooltip
        this.tooltip = d3.select('body')
            .append('div')
            .attr('class', 'tooltip')
            .style('opacity', 0);

        return this;
    }

    /**
     * Update with telemetry data
     */
    update(telemetryData, driverInfo = {}) {
        if (!telemetryData || telemetryData.length === 0) {
            this.showNoDataMessage('Select a driver to view telemetry');
            return this;
        }

        this.data = telemetryData;
        this.svg.selectAll('*').remove();

        const innerWidth = this.width - this.margin.left - this.margin.right;
        const innerHeight = this.height - this.margin.top - this.margin.bottom;

        // Create groups for each trace
        const g = this.svg.append('g')
            .attr('transform', `translate(${this.margin.left}, ${this.margin.top})`);

        // X scale (distance)
        const distanceExtent = d3.extent(telemetryData, d => d.Distance);
        const xScale = d3.scaleLinear()
            .domain(distanceExtent)
            .range([0, innerWidth]);

        // Y scales
        const speedScale = d3.scaleLinear()
            .domain([0, d3.max(telemetryData, d => d.Speed) * 1.1])
            .range([innerHeight, 0]);

        const percentScale = d3.scaleLinear()
            .domain([0, 100])
            .range([innerHeight, 0]);

        // Grid
        const gridGroup = g.append('g').attr('class', 'grid');
        gridGroup.selectAll('.grid-line')
            .data(speedScale.ticks(5))
            .enter()
            .append('line')
            .attr('class', 'grid line')
            .attr('x1', 0)
            .attr('x2', innerWidth)
            .attr('y1', d => speedScale(d))
            .attr('y2', d => speedScale(d));

        // Speed trace
        const speedLine = d3.line()
            .x(d => xScale(d.Distance))
            .y(d => speedScale(d.Speed))
            .curve(d3.curveMonotoneX);

        g.append('path')
            .datum(telemetryData)
            .attr('class', 'telemetry-trace speed')
            .attr('d', speedLine);

        // Throttle area
        const throttleArea = d3.area()
            .x(d => xScale(d.Distance))
            .y0(innerHeight)
            .y1(d => percentScale(d.Throttle))
            .curve(d3.curveMonotoneX);

        g.append('path')
            .datum(telemetryData)
            .attr('class', 'telemetry-area throttle')
            .attr('d', throttleArea);

        // Brake area (inverted, from bottom)
        const brakeData = telemetryData.filter(d => d.Brake > 0);
        const brakeArea = d3.area()
            .x(d => xScale(d.Distance))
            .y0(innerHeight)
            .y1(d => innerHeight - (d.Brake * innerHeight / 100))
            .curve(d3.curveMonotoneX);

        g.append('path')
            .datum(brakeData)
            .attr('class', 'telemetry-area brake')
            .attr('d', brakeArea);

        // DRS zones
        let drsStart = null;
        telemetryData.forEach((d, i) => {
            if (d.DRS >= 10 && drsStart === null) {
                drsStart = d.Distance;
            } else if (d.DRS < 10 && drsStart !== null) {
                g.append('rect')
                    .attr('class', 'drs-bar')
                    .attr('x', xScale(drsStart))
                    .attr('y', 0)
                    .attr('width', xScale(d.Distance) - xScale(drsStart))
                    .attr('height', innerHeight);
                drsStart = null;
            }
        });

        // Gear indicators (sampled)
        const gearSamples = telemetryData.filter((d, i) => i % 50 === 0);
        g.selectAll('.gear-indicator')
            .data(gearSamples)
            .enter()
            .append('text')
            .attr('class', 'gear-indicator')
            .attr('x', d => xScale(d.Distance))
            .attr('y', d => speedScale(d.Speed) - 10)
            .text(d => d.nGear || '');

        // Axes
        const xAxis = d3.axisBottom(xScale)
            .ticks(6)
            .tickFormat(d => `${Math.round(d)}m`);

        const yAxis = d3.axisLeft(speedScale)
            .ticks(5)
            .tickFormat(d => `${d} km/h`);

        g.append('g')
            .attr('class', 'axis x-axis')
            .attr('transform', `translate(0, ${innerHeight})`)
            .call(xAxis);

        g.append('g')
            .attr('class', 'axis y-axis')
            .call(yAxis);

        // Legend
        this.addLegend(g, innerWidth);

        // Crosshair for interaction
        const crosshair = g.append('g')
            .attr('class', 'crosshair')
            .style('display', 'none');

        crosshair.append('line')
            .attr('y1', 0)
            .attr('y2', innerHeight);

        crosshair.append('circle')
            .attr('r', 4);

        // Overlay for mouse events
        g.append('rect')
            .attr('width', innerWidth)
            .attr('height', innerHeight)
            .attr('fill', 'transparent')
            .on('mousemove', (event) => {
                const [mouseX] = d3.pointer(event);
                const distance = xScale.invert(mouseX);

                // Find closest data point
                const bisect = d3.bisector(d => d.Distance).left;
                const idx = bisect(telemetryData, distance);
                const d = telemetryData[Math.min(idx, telemetryData.length - 1)];

                if (d) {
                    crosshair
                        .style('display', null)
                        .attr('transform', `translate(${xScale(d.Distance)}, 0)`);

                    crosshair.select('circle')
                        .attr('cy', speedScale(d.Speed));

                    this.tooltip
                        .style('opacity', 1)
                        .style('left', `${event.pageX + 15}px`)
                        .style('top', `${event.pageY - 10}px`)
                        .html(`
                            <div class="tooltip-row">
                                <span class="tooltip-label">Speed:</span>
                                <span class="tooltip-value">${Math.round(d.Speed)} km/h</span>
                            </div>
                            <div class="tooltip-row">
                                <span class="tooltip-label">Gear:</span>
                                <span class="tooltip-value">${d.nGear || '-'}</span>
                            </div>
                            <div class="tooltip-row">
                                <span class="tooltip-label">Throttle:</span>
                                <span class="tooltip-value">${Math.round(d.Throttle)}%</span>
                            </div>
                            <div class="tooltip-row">
                                <span class="tooltip-label">Brake:</span>
                                <span class="tooltip-value">${Math.round(d.Brake)}%</span>
                            </div>
                            <div class="tooltip-row">
                                <span class="tooltip-label">DRS:</span>
                                <span class="tooltip-value">${d.DRS >= 10 ? 'Open' : 'Closed'}</span>
                            </div>
                        `);
                }
            })
            .on('mouseleave', () => {
                crosshair.style('display', 'none');
                this.tooltip.style('opacity', 0);
            });

        return this;
    }

    /**
     * Add legend
     */
    addLegend(g, width) {
        const legend = g.append('g')
            .attr('class', 'telemetry-legend')
            .attr('transform', `translate(${width - 120}, 5)`);

        const items = [
            { label: 'Speed', color: 'var(--color-accent-primary)' },
            { label: 'Throttle', color: 'var(--color-accent-success)' },
            { label: 'Brake', color: 'var(--color-accent-warning)' }
        ];

        items.forEach((item, i) => {
            const row = legend.append('g')
                .attr('transform', `translate(0, ${i * 15})`);

            row.append('rect')
                .attr('width', 12)
                .attr('height', 3)
                .attr('fill', item.color);

            row.append('text')
                .attr('x', 16)
                .attr('y', 4)
                .attr('font-size', '10px')
                .attr('fill', 'var(--color-text-secondary)')
                .text(item.label);
        });
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
     * Destroy
     */
    destroy() {
        if (this.tooltip) this.tooltip.remove();
        if (this.container) this.container.innerHTML = '';
    }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { TelemetryVisualization };
}
