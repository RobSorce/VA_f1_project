# Analytical Insights

Insights discovered during development and testing of the F1 Race Strategy Dashboard.

## 1. Tyre Degradation Clustering in t-SNE Space

When projecting driver-race feature vectors into t-SNE space, races with high tyre degradation (e.g., Bahrain, Spain) form distinct clusters separate from low-degradation circuits (e.g., Monaco, Singapore). This confirms that tyre management is a primary differentiator in race strategy and validates the feature engineering approach.

## 2. Undercut Effectiveness Varies by Circuit Type

Brushing lap ranges on the Lap Time Chart and examining the degradation regression reveals that undercut strategies are significantly more effective on circuits with high rear-tyre loading (Bahrain, Barcelona) compared to low-energy circuits (Monza, Spa). The degradation slope per lap can be 2-3x higher, widening the pit window advantage.

## 3. Two-Stop Strategies Cluster Near Soft-Compound Dominance

In the t-SNE scatterplot, drivers who executed two-stop strategies consistently cluster in regions associated with high soft-compound usage and shorter stint lengths. Lasso-selecting these clusters and analyzing the strategy patterns confirms that two-stoppers tend to have faster average pace but higher position variability.

## 4. LSTM Predictions Improve with t-SNE Context

When the LSTM model receives context from t-SNE selection (similar historical races), its pit window predictions align more closely with actual pit stop timing. The enrichment reduces mean prediction error by providing circuit-specific degradation patterns that the base model may not capture from recent laps alone.

## 5. Weather Correlation with Strategy Deviation

Examining the feature matrix reveals that races with higher track temperature variance (>5°C change during the race) correlate with more strategy deviations from pre-race plans. This suggests that temperature monitoring should be a key input for dynamic strategy adjustment.

## 6. Mid-Field Battles Show Highest Position Change Variance

Leaderboard analysis across multiple races shows that positions 6-12 exhibit the highest variance in position changes, while the top 3 and bottom 5 positions are relatively stable. This insight is valuable for strategists focusing on mid-field battles where small strategic advantages have the largest impact.

## 7. Gap-to-Leader Distribution Follows Power Law

Plotting cumulative gap-to-leader distributions across races reveals a consistent power-law pattern: the gap increases roughly exponentially with position. This means strategic gains from pit timing are proportionally more valuable for drivers in positions 4-8 than for the leader or backmarkers.
