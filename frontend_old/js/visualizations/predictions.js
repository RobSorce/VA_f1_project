/**
 * F1 Analytics Platform - Predictions Visualization
 * Win probabilities, position distribution, strategy recommendations
 */

class PredictionsVisualization {
    constructor(containerId) {
        this.containerId = containerId;
        this.container = document.getElementById(containerId);
        this.svg = null;
        this.width = 0;
        this.height = 0;
        this.margin = { top: 10, right: 20, bottom: 25, left: 30 };
    }

    /**
     * Initialize
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
            .attr('class', 'probability-bar-chart');

        return this;
    }

    /**
     * Update position probabilities chart
     */
    updatePositionProbabilities(probabilities) {
        if (!probabilities || Object.keys(probabilities).length === 0) {
            return this;
        }

        this.svg.selectAll('*').remove();

        const innerWidth = this.width - this.margin.left - this.margin.right;
        const innerHeight = this.height - this.margin.top - this.margin.bottom;

        const g = this.svg.append('g')
            .attr('transform', `translate(${this.margin.left}, ${this.margin.top})`);

        // Convert probabilities object to array
        const data = Object.entries(probabilities)
            .map(([pos, prob]) => ({ position: parseInt(pos), probability: prob }))
            .filter(d => d.probability > 0.01)
            .sort((a, b) => a.position - b.position)
            .slice(0, 10); // Show top 10 positions

        // Scales
        const xScale = d3.scaleBand()
            .domain(data.map(d => d.position))
            .range([0, innerWidth])
            .padding(0.2);

        const yScale = d3.scaleLinear()
            .domain([0, d3.max(data, d => d.probability) * 1.1])
            .range([innerHeight, 0]);

        // Color scale based on position
        const colorScale = d3.scaleLinear()
            .domain([1, 10])
            .range(['#00d26a', '#e10600']);

        // Grid
        g.selectAll('.grid-line')
            .data(yScale.ticks(4))
            .enter()
            .append('line')
            .attr('class', 'grid line')
            .attr('x1', 0)
            .attr('x2', innerWidth)
            .attr('y1', d => yScale(d))
            .attr('y2', d => yScale(d));

        // Bars
        g.selectAll('.bar')
            .data(data)
            .enter()
            .append('rect')
            .attr('class', 'bar')
            .attr('x', d => xScale(d.position))
            .attr('width', xScale.bandwidth())
            .attr('y', innerHeight)
            .attr('height', 0)
            .attr('fill', d => colorScale(d.position))
            .attr('rx', 2)
            .transition()
            .duration(500)
            .delay((d, i) => i * 50)
            .attr('y', d => yScale(d.probability))
            .attr('height', d => innerHeight - yScale(d.probability));

        // Bar labels
        g.selectAll('.bar-label')
            .data(data)
            .enter()
            .append('text')
            .attr('class', 'bar-label')
            .attr('text-anchor', 'middle')
            .attr('x', d => xScale(d.position) + xScale.bandwidth() / 2)
            .attr('y', d => yScale(d.probability) - 4)
            .text(d => `${Math.round(d.probability * 100)}%`)
            .style('opacity', 0)
            .transition()
            .duration(500)
            .delay((d, i) => i * 50 + 200)
            .style('opacity', 1);

        // X axis
        g.append('g')
            .attr('class', 'axis x-axis')
            .attr('transform', `translate(0, ${innerHeight})`)
            .call(d3.axisBottom(xScale).tickFormat(d => `P${d}`));

        return this;
    }

    /**
     * Update win meter in the predictions panel
     */
    static updateWinMeter(driver, probability) {
        const winnerEl = document.getElementById('pred-winner');
        const confEl = document.getElementById('pred-winner-conf');
        const barEl = document.getElementById('pred-winner-bar');

        if (winnerEl) winnerEl.textContent = driver || '--';
        if (confEl) confEl.textContent = probability ? `${Math.round(probability * 100)}%` : '--%';
        if (barEl) barEl.style.width = probability ? `${probability * 100}%` : '0%';
    }

    /**
     * Update podium predictions
     */
    static updatePodiumPredictions(podiumData) {
        const container = document.getElementById('podium-predictions');
        if (!container || !podiumData) return;

        container.innerHTML = podiumData.slice(0, 3).map((item, idx) => `
            <div class="podium-item">
                <span class="position">P${idx + 1}</span>
                <span class="driver">${item.driver || '--'}</span>
                <span class="probability">${item.probability ? Math.round(item.probability * 100) + '%' : '--%'}</span>
            </div>
        `).join('');
    }

    /**
     * Update prediction results in strategy simulator
     */
    static updatePredictionResults(results) {
        const container = document.getElementById('prediction-results');
        if (!container || !results) return;

        container.innerHTML = `
            <div class="prediction-result-card">
                <div class="prediction-position">P${results.predicted_position}</div>
                <div class="prediction-confidence">
                    <span>Confidence:</span>
                    <span class="confidence-value">${Math.round(results.confidence * 100)}%</span>
                </div>
                <div class="prediction-recommendation" style="margin-top: 8px; font-size: 12px; color: var(--color-text-secondary);">
                    ${results.recommendation}
                </div>
            </div>
            ${results.alternative_strategies ? `
                <div style="margin-top: 12px;">
                    <h4 style="font-size: 11px; color: var(--color-text-muted); margin-bottom: 8px;">ALTERNATIVES</h4>
                    ${results.alternative_strategies.map(alt => `
                        <div class="prediction-result-card" style="padding: 8px; font-size: 12px;">
                            <div style="display: flex; justify-content: space-between;">
                                <span>${alt.strategy}</span>
                                <span>P${alt.predicted_position} (${Math.round(alt.confidence * 100)}%)</span>
                            </div>
                        </div>
                    `).join('')}
                </div>
            ` : ''}
        `;
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
        if (this.container) this.container.innerHTML = '';
    }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PredictionsVisualization };
}
