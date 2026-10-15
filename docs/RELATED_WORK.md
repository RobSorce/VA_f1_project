# Related Work

## 1. F1 Broadcast & Commercial Systems

### F1 TV Live Timing (Formula 1, 2018-present)
The official F1 timing application provides real-time leaderboard, sector times, tyre compound indicators, and gap calculations. It serves as the de facto standard for race monitoring UIs, and our Leaderboard and TimingTower components adopt its visual language (position tower, interval/gap columns, compound dots). However, F1 TV is purely informational: it does not support interactive exploration, cross-view coordination, or analytical computations triggered by user interaction. Our system extends this paradigm by making every element selectable and coordinated — clicking a driver in the leaderboard highlights them across all visualizations simultaneously.

### AWS F1 Insights (Amazon Web Services, 2019-present)
AWS provides on-screen graphics during broadcasts, including tyre performance predictions, pit window estimations, and battle forecasts. These use proprietary ML models running on historical telemetry. While visually polished, they are non-interactive overlays embedded in the broadcast — the viewer cannot select drivers, adjust parameters, or explore alternative strategies. Our LSTM prediction module and Strategy Simulator serve a similar analytical purpose but are fully interactive: the user can trigger predictions by double-clicking a driver and explore "what-if" scenarios through the Strategy Simulator panel.

## 2. Academic Work on Sports/Race Visualization

### Luo et al. — "RaceVis: Real-time Visual Analytics of Formula 1 Racing" (2022)
RaceVis proposes a multi-coordinated-view dashboard for F1 race analysis with a focus on real-time data integration. It features a track map with car positions, a strategy timeline, and a gap evolution chart. The key contribution is the coordination between views via linked highlighting. Our system shares this multi-view coordination philosophy but extends it with dimensionality reduction (PCA biplot) as a first-class analytical view, LSTM-based predictive overlays on the strategy timeline, and a lasso-triggered backend computation that re-analyzes strategy patterns on user-selected subsets — moving from information visualization into visual analytics.

### Perin et al. — "SportsXVis: A Visual Analytics Approach to Sports Exploration" (IEEE VIS, 2018)
Perin et al. present a framework for interactive visual exploration of sports data, emphasizing the importance of overview+detail, filtering, and details-on-demand (Shneiderman's mantra). They demonstrate that pre-attentive visual attributes (color, position, size) are critical for time-pressured decision-making in sports contexts. Our dashboard applies these principles directly: position encoding for the leaderboard (most salient channel for most important data), hue for tyre compounds (categorical), and lightness/saturation for pace classification in the RacePaceGrid.

### Shi et al. — "Visual Analytics for F1 Race Strategy" (2020)
Shi proposes integrating dimensionality reduction (t-SNE) with strategy timelines to identify clusters of similar race strategies across historical data. Their key insight is that projecting high-dimensional stint features into 2D reveals strategic archetypes (aggressive early-stopper, conservative one-stop, etc.) that are not visible in raw timing data. Our PCA biplot follows this approach but uses PCA instead of t-SNE for interpretability: the loading vectors on the biplot show which features drive the clustering, and the user can lasso-select clusters to trigger a backend analysis that computes Hedges' g effect sizes across strategy dimensions, each with a 95% normal-approximation interval (g +/- 1.96 SE, SE^2 = (n1 + n2) / (n1 n2) + g^2 / (2 (n1 + n2)), the large-sample standard error of Hedges and Olkin 1985; a bootstrap would be degenerate for the one- or two-row selections a click or a short lasso makes) and the value random selections of the same size and the same mix of rows reach (during a replay, rows of the race on screen at the clock and rows of finished races; `docs/PCA_METHODOLOGY.md`, section 5).

## 3. Dimensionality Reduction in Visual Analytics

### Van der Maaten & Hinton — "Visualizing Data using t-SNE" (JMLR, 2008)
The foundational paper on t-SNE establishes its strength in preserving local neighborhood structure but warns about its weaknesses: non-preservation of global distances, sensitivity to perplexity, and non-reproducibility across runs. Our system initially used t-SNE but migrated to PCA for the primary projection because: (a) PCA preserves global distances, making inter-cluster comparisons meaningful; (b) PCA axes are linear combinations of input features, enabling the biplot's loading vectors; (c) PCA is deterministic, ensuring consistency across sessions. t-SNE was later removed from the dashboard altogether: the PCA is its one projection (`docs/PCA_METHODOLOGY.md`, section 2 "Why PCA and not t-SNE").

### Wattenberg et al. — "How to Use t-SNE Effectively" (Distill, 2016)
This interactive article demonstrates that t-SNE results are highly sensitive to hyperparameters and that cluster sizes and inter-cluster distances in t-SNE plots are not meaningful. This guided our decision to use PCA as the primary DR method: in our use case (comparing race strategies), the user needs to reason about "how different are these two strategy clusters?" — a question PCA can answer but t-SNE cannot.

### Slide VA course (Santucci) — PCA requirements
The course material specifies that dimensionality reduction must be integrated into the analysis flow, not just used as a static preprocessing step. Our implementation satisfies this by making the PCA biplot interactive: lasso selection triggers a backend `analyze_selection()` call that compares the selection with the other rows feature by feature (Hedges' g with its 95% interval and a random-selection baseline), identifies common pit windows, and extracts strategy patterns. The results are displayed in the PCAAnalysisPanel as a forest plot and strategy bars, closing the visual analytics loop.

## 4. Real-Time Dashboards and Interaction Design

### Few — "Information Dashboard Design" (2006)
Stephen Few's principles for dashboard design — no scrolling, maximum data-ink ratio, consistent grid layout, pre-attentive encoding for alerts — inform our 1920x1080 no-scroll layout. The persistent sidebar (leaderboard) follows his recommendation of keeping the most important overview always visible while detail views occupy the main area.

### Norman — "The Design of Everyday Things" (1988)
Norman's action cycle (gulf of execution + gulf of evaluation) guides our interaction model. For execution: every interactive element has visible affordance (hover effects, cursor changes, keyboard hints). For evaluation: every action produces immediate visual feedback — selecting a driver highlights them across all views within one render frame (<16ms). The bidirectional coordination ensures that the user always sees the effect of their action reflected everywhere, reducing the evaluation gulf.

### Shneiderman — "The Eyes Have It" (1996)
The visual information-seeking mantra (overview first, zoom and filter, details on demand) structures our three rendering modes: Pit Wall provides the overview (timing tower + track map + race control), the Docked Layout enables zoom and filter (multiple coordinated panels), and the Overlay system provides details on demand (floating resizable panels for specific analyses).

## 5. Comparison Summary

| System | Interactive | DR | Prediction | Bidirectional Coord. | Analytics on Interaction |
|--------|-------------|-----|------------|----------------------|--------------------------|
| F1 TV Live Timing | No | No | No | N/A | No |
| AWS F1 Insights | No | No | Yes (broadcast-only) | N/A | No |
| RaceVis (Luo 2022) | Yes | No | No | Yes (linked highlight) | No |
| SportsXVis (Perin 2018) | Yes | No | No | Yes | Limited |
| Shi 2020 | Yes | t-SNE | No | Partial | Cluster analysis |
| **Our system** | **Yes** | **PCA** | **LSTM + Monte Carlo** | **Yes (6 pairs)** | **Yes (lasso→analysis, click→LSTM)** |

Our system differentiates itself by combining all five capabilities — interactive exploration, dimensionality reduction with interpretable axes, predictive modeling, bidirectional multi-view coordination, and analytics triggered by visual interaction — in a single integrated dashboard.
