# Related Work

## 1. F1 Official Live Timing (formula1.com/timing)

The official F1 live timing system provides real-time race data including sector times, gaps, tyre information, and driver positions. Our dashboard extends this by adding predictive analytics (LSTM), historical comparison via t-SNE, and AI-assisted strategy recommendations. The F1 TV broadcast graphics style serves as our primary visual design reference.

## 2. AWS F1 Insights

Amazon Web Services provides real-time analytics for F1 broadcasts, including tire performance predictions, pit window analysis, and car performance scores. These use proprietary ML models on live telemetry. Our project achieves similar functionality using open-source tools (FastF1, TensorFlow) and adds interactive exploration capabilities (lasso selection, bidirectional coordination) not available in broadcast overlays.

## 3. McLaren Applied Technologies — ATLAS

McLaren's Advanced Telemetry Linked Acquisition System (ATLAS) is the industry-standard telemetry analysis tool used by F1 teams. It focuses on detailed engineering data (suspension, aero, engine). Our dashboard targets a higher-level strategic view with emphasis on visual analytics and pattern discovery rather than raw engineering telemetry.

## 4. Sportradar F1 Data Analytics

Sportradar provides commercial F1 data feeds and analytics for betting and media. Their system focuses on probabilistic outcomes. Our project differs by providing interactive visual analytics with user-driven exploration (t-SNE lasso, brush selection) rather than pre-computed statistics.

## 5. Academic: "Visual Analytics for Formula 1 Race Strategy" (van Wijk et al.)

Academic research in sports visual analytics has explored multi-dimensional data visualization for race strategy. Van Wijk's work on visual analytics principles — overview first, zoom and filter, details on demand — directly informs our tabbed dashboard design and the bidirectional coordination between views.

## 6. Academic: t-SNE for Sports Analytics (Gudmundsson & Horton, 2017)

The use of dimensionality reduction techniques like t-SNE for exploring athlete performance spaces has been demonstrated in team sports analytics. We apply this approach to F1 by embedding driver-race performance vectors into 2D space, enabling visual clustering and interactive selection for strategy pattern discovery.
