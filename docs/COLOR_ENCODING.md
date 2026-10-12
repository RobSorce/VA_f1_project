# Color Encoding Documentation

## Team Colors (Categorical)

Team colors are the **official F1 team brand colors** as published by Formula 1 and used in the F1 TV broadcast graphics. They are defined in `frontend/src/utils/colors.js` and mirrored as CSS custom properties in `frontend/src/styles/tokens.css`.

**Used in**: PCA Biplot points, Leaderboard, TrackMap car markers, LapTimeChart lines, StrategyTimeline, LapDeltaChart, ChampionshipChart.

**Accessibility note**: Some team color pairs are problematic for deuteranopia (e.g., Ferrari red #E8002D vs Alpine pink #FF87BC, McLaren orange #FF8000 vs Alpine pink). This is an accepted trade-off: the colors are mandated by the sport's branding and recognized by the target user (pit wall strategists) who work with these colors daily in F1 TV, official timing screens, and team software. Renaming or recoloring teams would confuse rather than help the intended user.

**Mitigation**: Driver abbreviations (e.g., VER, NOR, HAM) are displayed alongside color swatches in the Leaderboard, LapTimeChart timing rows, and tooltip overlays. This text-based redundancy ensures identification does not rely solely on color discrimination.

## Tyre Compound Colors (Categorical)

Standard Pirelli F1 compound colors, used universally in F1 media and graphics:

| Compound | Color | Hex |
|----------|-------|-----|
| SOFT | Red | #FF3333 |
| MEDIUM | Yellow | #FFC300 |
| HARD | White | #EEEEEE |
| INTERMEDIATE | Green | #39B54A |
| WET | Blue | #00AAFF |

**Used in**: StrategyTimeline stint bars, TireDegradation scatter points and fit lines, TyreHealth bars, TyreSilhouette indicators, Leaderboard compound dots, Legend component.

These are the industry-standard colors taught to F1 viewers and analysts. The SOFT/MEDIUM/HARD sequence (red/yellow/white) provides strong perceptual differentiation across all forms of color vision.

## Quantitative Scales

### Sector Times (RacePaceGrid, SectorsPanel)
- Uses a **green-to-red** diverging scale centered on the median:
  - Faster than median: green (`--sector-green` / `#00D2BE`)
  - At median: neutral
  - Slower than median: red (`--color-accent-danger` / `#E8002D`)
- This is a standard motorsport convention (green = fastest, red = slowest) recognized by the target user.

### Tyre Health (TyreHealth)
- Linear gradient from green (100% health) through yellow to red (0% health).
- Perceptually ordered: maps directly to traffic-light intuition.

### Position Change (Leaderboard prediction arrows)
- Green arrows: predicted to gain positions
- Red arrows: predicted to lose positions
- Neutral: no change
- Standard convention in F1 timing screens.

## Lie Factor / Truncated Axes

### Charts with non-zero Y-axis origin:
- **LapTimeChart**: Y-axis shows lap times in the range ~80-120s. Starting at 0 would waste 80% of the axis on empty space. The Y-axis is labelled with actual times (m:ss.sss format), making the non-zero origin explicit.
- **TireDegradation** (post-rewrite): Y-axis shows lap times for the driver's stint range. Same justification as LapTimeChart.
- **LapDeltaChart**: Y-axis centered on 0 (delta = 0 is the baseline). No truncation issue.

### Charts with zero Y-axis origin:
- **ChampionshipChart**: Points start at 0. Correct.
- **TyreHealth**: Health percentage 0-100. Correct.

All non-zero origins use `d3.scaleLinear` with data-driven domains and visible tick labels. No misleading truncation.
