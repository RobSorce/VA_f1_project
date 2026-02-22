/**
 * F1 Analytics Platform - Tyre Strategy Visualization
 * Timeline showing compound usage and stint lengths per driver
 */

class TyreStrategyVisualization {
    constructor(containerId) {
        this.containerId = containerId;
        this.container = document.getElementById(containerId);
        this.data = [];
        this.drivers = new Map();
        this.totalLaps = 56;

        // Compound colors
        this.compoundColors = {
            'SOFT': '#ff4444',
            'MEDIUM': '#ffd700',
            'HARD': '#f0f0f0',
            'INTERMEDIATE': '#44cc44',
            'WET': '#4488ff',
            'UNKNOWN': '#888888'
        };
    }

    /**
     * Initialize the visualization
     */
    init() {
        this.container.innerHTML = '';
        return this;
    }

    /**
     * Set driver information
     */
    setDrivers(drivers) {
        drivers.forEach(driver => {
            this.drivers.set(driver.Abbreviation || driver.DriverNumber, driver);
        });
        return this;
    }

    /**
     * Set total race laps
     */
    setTotalLaps(laps) {
        this.totalLaps = laps;
        return this;
    }

    /**
     * Update with strategy data
     */
    update(strategyData) {
        if (!strategyData || strategyData.length === 0) {
            this.showNoDataMessage('No strategy data available');
            return this;
        }

        this.data = strategyData;
        this.container.innerHTML = '';

        // Create timeline container
        const timelineDiv = document.createElement('div');
        timelineDiv.className = 'tyre-timeline';

        // Group by driver
        const driverStrats = d3.group(strategyData, d => d.Driver);

        // Get container width for scaling
        const containerWidth = this.container.clientWidth;
        const labelWidth = 45;
        const barWidth = containerWidth - labelWidth - 20;

        // Create scale
        const lapScale = d3.scaleLinear()
            .domain([1, this.totalLaps])
            .range([0, barWidth]);

        // Sort drivers by final position or alphabetically
        const sortedDrivers = Array.from(driverStrats.keys()).sort();

        sortedDrivers.forEach((driver, index) => {
            const stints = driverStrats.get(driver) || [];

            // Create driver row
            const row = document.createElement('div');
            row.className = 'driver-timeline';
            row.style.animationDelay = `${index * 30}ms`;

            // Driver abbreviation
            const abbr = document.createElement('span');
            abbr.className = 'driver-abbr';
            const driverInfo = this.drivers.get(driver);
            if (driverInfo && driverInfo.TeamColor) {
                abbr.style.color = driverInfo.TeamColor;
            }
            abbr.textContent = driver;
            row.appendChild(abbr);

            // Stints container
            const stintsContainer = document.createElement('div');
            stintsContainer.style.cssText = `
                display: flex;
                flex: 1;
                gap: 1px;
            `;

            // Sort stints by start lap
            const sortedStints = stints.sort((a, b) => a.StartLap - b.StartLap);

            sortedStints.forEach(stint => {
                const bar = document.createElement('div');
                bar.className = `stint-bar ${stint.Compound}`;

                // Calculate width based on laps
                const stintWidth = lapScale(stint.EndLap) - lapScale(stint.StartLap);
                bar.style.width = `${Math.max(stintWidth, 15)}px`;

                // Show lap count
                bar.textContent = stint.TotalLaps;
                bar.title = `${stint.Compound}: Laps ${stint.StartLap}-${stint.EndLap} (${stint.TotalLaps} laps)`;

                // Add hover event
                bar.addEventListener('mouseenter', (e) => this.showStintTooltip(e, stint, driver));
                bar.addEventListener('mouseleave', () => this.hideTooltip());

                stintsContainer.appendChild(bar);
            });

            row.appendChild(stintsContainer);
            timelineDiv.appendChild(row);
        });

        // Add legend
        const legend = this.createLegend();

        this.container.appendChild(timelineDiv);
        this.container.appendChild(legend);

        return this;
    }

    /**
     * Create compound legend
     */
    createLegend() {
        const legend = document.createElement('div');
        legend.className = 'tyre-legend';
        legend.style.cssText = `
            display: flex;
            gap: 12px;
            padding: 8px;
            margin-top: 8px;
            justify-content: center;
            font-size: 11px;
        `;

        const compounds = ['SOFT', 'MEDIUM', 'HARD', 'INTERMEDIATE', 'WET'];

        compounds.forEach(compound => {
            const item = document.createElement('div');
            item.style.cssText = 'display: flex; align-items: center; gap: 4px;';

            const color = document.createElement('span');
            color.style.cssText = `
                width: 12px;
                height: 12px;
                border-radius: 2px;
                background-color: ${this.compoundColors[compound]};
            `;

            const label = document.createElement('span');
            label.style.color = 'var(--color-text-secondary)';
            label.textContent = compound.charAt(0) + compound.slice(1).toLowerCase();

            item.appendChild(color);
            item.appendChild(label);
            legend.appendChild(item);
        });

        return legend;
    }

    /**
     * Show stint tooltip
     */
    showStintTooltip(event, stint, driver) {
        let tooltip = document.querySelector('.tyre-tooltip');
        if (!tooltip) {
            tooltip = document.createElement('div');
            tooltip.className = 'tooltip tyre-tooltip visible';
            document.body.appendChild(tooltip);
        }

        const driverInfo = this.drivers.get(driver) || {};

        tooltip.innerHTML = `
            <div class="tooltip-title">${driver} - Stint ${stint.StintNumber}</div>
            <div class="tooltip-row">
                <span class="tooltip-label">Compound:</span>
                <span class="tooltip-value" style="color: ${this.compoundColors[stint.Compound]}">${stint.Compound}</span>
            </div>
            <div class="tooltip-row">
                <span class="tooltip-label">Laps:</span>
                <span class="tooltip-value">${stint.StartLap} → ${stint.EndLap}</span>
            </div>
            <div class="tooltip-row">
                <span class="tooltip-label">Duration:</span>
                <span class="tooltip-value">${stint.TotalLaps} laps</span>
            </div>
        `;

        tooltip.style.left = `${event.pageX + 10}px`;
        tooltip.style.top = `${event.pageY - 10}px`;
        tooltip.style.opacity = '1';
    }

    /**
     * Hide tooltip
     */
    hideTooltip() {
        const tooltip = document.querySelector('.tyre-tooltip');
        if (tooltip) {
            tooltip.style.opacity = '0';
        }
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
        const tooltip = document.querySelector('.tyre-tooltip');
        if (tooltip) tooltip.remove();
        if (this.container) this.container.innerHTML = '';
    }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { TyreStrategyVisualization };
}
