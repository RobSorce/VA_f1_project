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

**Used in**: StrategyTimeline stint bars, TireDegradation scatter points and fit lines, TyreHealth stint curves and stint bar, TyreSilhouette indicators, Leaderboard compound dots, Legend component.

These are the industry-standard colors taught to F1 viewers and analysts. They are always drawn with the compound letter (S / M / H / I / W, black or white by contrast): SOFT and INTERMEDIATE are only CIEDE2000 5.7 apart under deuteranopia (`notes/experiments/phase9/cvd_check.txt`), so the letter, not the colour, tells them apart.

## Pit and pit window (every view)

One colour per meaning, in every view (V2):

| Meaning | Color | Hex | Where |
|---------|-------|-----|-------|
| Pit (a car in the pit lane, a pit in / out lap) | Pink | #F472B6 | `STATUS_COLORS.pit` / `--status-pit`, always with its letter P (in) / O (out) or the text PIT: Timing Tower, Race Pace Grid, Lap Times sheet, Pit Wall sector panel, and the Circle of Doom pit-lane arc (dashed, at full strength: 6.90:1 on the panel, `notes/experiments/phase9/repair2_contrast.txt`). The old #00BFFF pit-lane colour, which the palette did not hold, is gone. |
| Pit window (the laps where a stop pays) | Purple | #A855F7 | `UI_COLORS.pitWindow` / `--color-pit-window`, 4.62:1 on the panel (`cvd_check.txt`, "Single accents"): the Circle of Doom band, rejoin diamond and uncertainty arc, the Position Tracker's undercut band (it used the diverging blue) and its "PIT WINDOW" label (text in #B56FF8; a CSS fill in the diverging blue overrode it until repair 3), the Tyre Degradation "next pit window" range (text in the lighter #B56FF8, `UI_COLORS.pitWindowText`; it used the predicted orange). |

In the Circle of Doom the pit-window line of the legend line under the circle (`.cod-status__focus`) is text, drawn in the lighter timing purple #C084FC (`STATUS_COLORS.overallBest`) for text contrast; the circle shows no lap-time bests, and cars keep their team colours, none of which is purple.

| Mark | Color | Hex | Notes |
|------|-------|-----|-------|
| Ring around a car selected in another view (e.g. a Track Map click) | Selection blue | `var(--color-brush)` #8AB4F8 | The selection colour of every view: the Track Map's selected-car stroke (`.car-marker.selected`) and the Circle of Doom ring (`.cod-select-ring`), so a selection reads the same in both views. |

## Quantitative Scales

Timing colours of slower times: one ordered scale, one set of bands (`TIMING_BANDS` and `timingBandColor` of `utils/colors.js`, V2). Against the reference time (the driver's personal best in the Timing Tower and the Pit Wall sector panel, the driver's median lap in the Race Pace Grid): normal within 0.3 s (sector) / 0.5 s (lap), yellow beyond, orange beyond 1.0 s / 2.0 s; never yellow, then white, then orange (the tower's old < 0.5 s yellow / 0.5-1.5 s white / > 1.5 s orange). Each legend names its reference (`notes/experiments/phase9/repair2_timing_bands.txt`).

Pace grid: blue (> 0.3 s under the driver's median), white, yellow (+0.5 s), orange (+2 s), ordered and distinguishable without a cue (cvd_check.txt: 14.5 deuteranopia). Diverging pair everywhere: better #5DA5E8 blue / worse #F0883E orange (CIEDE2000 >= 47.2 under every vision type), always with the sign or ▲/▼. Tyre health zones: CRITICAL < 30 % orange tint, WORN < 60 % yellow tint, named on the chart. Leaderboard arrows: ▲ blue gained, ▼ orange lost.

### Position Change (Leaderboard arrows)
- Blue ▲: places gained
- Orange ▼: places lost
- Neutral: no change

## Teammates

Teammates: second driver in teammateTint (CIEDE2000 >= 11.0 under every vision type) and dashed 6,3 where drawn as a line; legend pair swatch. A third driver of a team (a reserve of the championship) gets a second tint, a mix of 10 to 60 % toward white or black that keeps the team hue, at least CIEDE2000 10.1 from the team colour and the first tint under every vision type, and the dash-dot 8,3,2,3 (never dotted: a dotted line is a projection) (`cvd_check.txt`, "Third driver of a team"; `notes/experiments/phase9/repair3/third_tint_hue.txt`: with mixes up to 90 % most third tints were near-white or near-black, two teams' third drivers CIEDE2000 0.7 apart). The rule holds in every team-coloured view and the command bar's driver dots (they read `getDriverColor`, not the raw FastF1 team colour). The Championship chart and standings list more drivers than a session: they give every driver of the loaded session exactly his session style and the other drivers of a team the places left (`championshipStyles`, `sessionTeammate`), so a driver looks the same in every view (`notes/experiments/phase9/repair3/v3_cross_view_rerun.txt`: 0 differences with Monza or China 2024 loaded). The standings bars carry the teammate dash as a line along the bar in its contrast text colour, and have a legend of the teams and patterns.

Mid-season team changes (decision D11, phase 9c): the session views colour a driver by his team in the session on screen (its driver_info). The Championship chart and standings colour him by his team at the latest round of the season (the `team` of the championship entry), so a driver who changed team (2025: Lawson Red Bull Racing → Racing Bulls, Tsunoda the other way) can differ between the two. The championship tooltip says so: it lists the earlier team and why the colour is the latest team's (`teamChangeNote`, `championshipTooltip` in `utils/views/championshipChart.js`), e.g. "Red Bull Racing → Racing Bulls from R3" when the rounds of the change are known, else "Red Bull Racing (R1, session on screen) → Racing Bulls (R24)".

One deliberate exception: the PCA biplot's "team" colour mode colours each point by its team (`utils/views/pcaBiplot.js`), so teammates share a colour there on purpose; the mode answers "where do the teams sit", the driver code is in each point's tooltip, and the "driver" mode applies the teammate rule.

## Team colours as marks and badges

Team colours as marks go through markColor (>= 3:1); badge text is contrastText (smallest 4.69:1).

All numbers in the three sections above are from `notes/experiments/phase9/cvd_check.txt`.

## Strategy views (Race Prediction, Simulator, Race Analysis, Undercut, Sector Delta, Race Control, Strategy Engineer)

- Better / worse (sector deltas, gaps, places gained, verdicts, pace trend): the diverging pair of utils/colors.js, blue #5DA5E8 / orange #F0883E, always with the sign (+ / −) or ▲ / ▼.
- Severity (risks, alerts, insights, battle urgency, scenario risk): orange / yellow / grey with the glyph !! / ! / i and the word.
- Monte Carlo battle badges: white / yellow / grey with ●● / ● / ○.
- Race Control categories: FIA flag colours plus a different glyph per category (F, D, S, C, P, ⚖, ·) and the label; flags always with their label.
- Tyre compounds: FIA colours, always with the letter (S / M / H / I / W) in black or white by contrast.

Contrast and colour-vision distances: notes/experiments/phase9/d3ports/lane_marks_check.txt (RESULT: PASS).

## Focus + context (de-emphasised items)

Rule (decision D7, phase 9c): focus + context de-emphasis is allowed, with floors. When a selection, a focus or a hover leaves other items as context, the text of a context item keeps at least 3:1 against its background and its marks (lines, bars, dots, badges) at least 2:1. A context item is de-emphasised by mixing its colour toward the background it is drawn on, never by an opacity on text: `contextColor(color, surface)` in `utils/colors.js` mixes up to 50 % toward the surface (75 %, `CONTEXT_MIX_LINES`, in the charts of a line per driver) and stops at the floor (2:1 for a mark, `contextText` 3:1 for text), and always returns an opaque colour. Disabled controls are exempt (WCAG 2.1). Where a view swaps the category colour of a context text for the muted text colour `TEXT_COLORS.muted` #A3A7B7 (7.63:1 on the panel) or the secondary #C9CCD6 at full opacity, it stays above both floors: the Race Pace Grid's context headers (secondary text on a 25 % team tint, 6.05:1 for the worst team) and cells, the Circle of Doom's ring labels, the Championship standings' names, the Track Map labels of retired cars (`notes/experiments/phase9/repair2_contrast.txt`).

Context marks and text drawn with `contextColor` / `contextText`: the Circle of Doom leader lines of de-emphasised cars (2.01:1 on the panel; at opacity 0.3 they read 1.25:1), the context bars of the Championship standings (>= 2:1 for every team; at opacity 0.2 they read 1.1-1.6:1) and the teammate dash inside them (>= 2:1 on the bar), the team bar and the tyre badge of the Lap Times forecast rows (the badge letter in contrastText, >= 4.5:1; at opacity 0.5 it read 1.8-2.7:1). Phase 9c repair (verifier r1 found these still faded by opacity): the Championship chart's context lines, dots and end labels (labels 1.48-2.22:1 at fill-opacity 0.3, lines 1.08:1 at 0.15); the Position Tracker's context lines, end labels and compound badges (the badge letter 1.13:1 in a group at opacity 0.12; the letter is now contrastText of the mixed badge); the Strategy Timeline's unselected stint bars (opacity 0.2 / 0.15 / 0.12 with a black label, 1.27-2.03:1; now the compound colour mixed toward the panel, its label black or white by contrast with the bar drawn, `utils/views/strategyTimeline.js`); the Lap Delta lines of the drivers not hovered (1.19:1 at 0.25; their hatched areas are left out while another line is hovered); the Telemetry traces of the drivers not hovered and the ghost laps (1.08:1 at 0.15; their throttle / brake areas left out); the Track Map dots of context cars (1.80:1 at 0.55); the team bars of context rows in the Sectors panel (1.36:1 at 0.35) and of context cards in the Consistency panel (1.94:1 at 0.6); the PCA biplot points outside a selection (CSS opacity 0.15). Phase 9c repair r2 (verifier r2): the Race Situation map's context drivers (outside a lasso or click selection): their codes (opacity 0.3, 2.13-2.81:1; now `contextText` of white, drawn as a style because the stylesheet's `.situation-label` fill won over the attribute), dots and tyre badges (opacity 0.3 / 0.25, 1.27-2.22:1; now `contextColor`, >= 2:1) and the badge letters (1.16-1.33:1; now `contrastText` of the mixed badge); a context driver's trail, drawn at 3-8 % opacity (about 1.05:1), is no longer drawn. The Telemetry trace lines lost the CSS `opacity: 0.55` of their classes, which beat the drawn opacity: a context trace mixed to 2:1 was shown at 1.32-1.42:1, a ghost lap at 1.41:1. The Position Tracker's context end labels are computed on the brush tint (`brushTintOver`), the lightest background under them: 3.00-3.08:1 inside a brushed range, 3.24-3.32:1 outside it (2.78-2.85:1 inside a range before; `notes/experiments/phase9c/repair_r2/posbrush_labels.txt`). A low-data Consistency card is told by its LOW DATA chip only: its `saturate(0.6)` filter took a context team bar from 2.01:1 to about 1.5:1. A hover or a click brings any of them back at full strength; "Clear All Selections" (command bar) clears the selection. `__tests__/fade.context.test.jsx` checks the floors and lists every opacity left in these views with its reason (a tooltip, a trail, a toggled-off layer, never a context item); `__tests__/fade.views.test.jsx` mounts the Championship chart, the Position Tracker and the Strategy Timeline with a focus and a selection and reads every drawn colour back.

Retired drivers are never faded either: 'RET' / ✕ / OUT and the retired grey (7.63:1), with the retired bar on the row's left edge in the Leaderboard and the Lap Times sheet, ✕ in the Pit Wall Timing Tower's status column. The Track Map leaves a retired car off the track in a replay or a live feed; where its marker is drawn, its dot is the retired grey at full opacity (`.car-marker--retired`; at opacity 0.2 it read 1.13-1.62:1) and its label the muted text colour.

## One colour, one meaning in the chrome and the tower

- Track Map sectors are drawn in `SECTOR_COLORS` (pink, yellow, sky blue, as their S1-S3 legend and toggles), at full opacity; a CSS rule `.sector-N { stroke }` used to override them with dark crimson, olive and navy (1.44-2.48:1 on the panel).
- Weather-bar flag chips use the `--flag-*` tokens (tested equal to `FLAG_COLORS`), always with their label.
- An "on" toggle and a checked item use the selection blue `--color-brush`, not the INTERMEDIATE compound green.
- In the Leaderboard orange (the diverging "worse") means places lost (▼) and the top level of the overtake badge (⇅ and its %); a row in a battle has a neutral highlight and the ⚔ glyph, not an orange tint.

## Legend rows per view

Each view's legend names every encoding it draws. Rows of the legends built by a helper (printed by `npx vite-node ../notes/experiments/phase9/repair3/legend_rows.mjs` from `frontend/`, output `legend_rows.txt`):

| View | Encodings | Legend rows |
|------|-----------|-------------|
| Lap Times sheet | timing colours with glyphs, running lap, forecast, diverging delta | ◆ Overall best, ● Personal best, PIT Pit lap, Lap running, L Forecast, − Faster, + Slower (`timingSheetLegend`) |
| Lap Times forecast chart | laps run, forecast (dashed), held-out error band, forecast origin | Laps run, Forecast, ± held-out MAE, Forecast origin (`forecastChartLegend`) |
| Timing Tower | timing bands with glyphs, pit, running, retired | Session best, PB, +0.3/0.5 s off PB, +1/2 s off, pit in / out, running, retired (`timingTowerLegend`) |
| Race Pace Grid | lap cell classes with glyphs, pit, running | Session best, Personal best, Fast, Normal, Slow, Very slow, Pit in, Pit out, Lap running (`paceLegend`) |
| Sectors panel | timing colours (live), gap bars on a seconds scale (best) | live: Session best, Personal best, Other sector, Sector running; best: Session best (its time), Bar: gap to the session best (s) (`sectorsBestLegend`) |
| Pit Wall sector panel | timing bands, running, delta vs PB | Session best, PB, > 0.3 s off PB, > 1 s off, Running, − vs PB, + > 1 s (`pitWallLegend`) |
| Lap Delta | driver lines (teammate dashed), hatched areas, the base driver's zero line | the base driver (a double grey zero line, two 1.5 px rails 4 px apart, labelled "base: XXX": no driver line is double, a Haas or Cadillac grey included), each driver, + behind, − ahead (`lapDeltaLegend`) |
| Championship chart | team-coloured lines, round dots, teammate dash, third-driver dash-dot, predicted total | Points so far, Round, Teammate, Third driver (when drawn), Predicted total, Last round run (`championshipLegend`) |
| Championship standings | team-coloured bars, teammate patterns | one row per team (pair swatch), Teammate (dashed in the bar), Third driver (when drawn) (`championshipStandingsLegend`) |
| Race Situation map | team-coloured dots, teammate tint | one row per team (pair swatch) (`teamPairLegend`) |
| Leaderboard | ▲ / ▼ places vs grid, compound letters, pit, overtake badge levels, battle | vs grid, lost, S M H, pit, ⇅ <30 %, ⇅ >=30 %, ⇅ >=60 %, ⚔ battle (`Leaderboard.jsx` TOWER_LEGEND) |
| Race Prediction | share of runs, P5-P95, P label, now, limits, gained / lost, podium gold | share of runs per position, P5-P95, P label (median), now, podium / points limit, ▲ places gained, ▼ places lost, gold P / pod: a podium (`RacePredictionPanel.jsx`, drawLegend) |
| Track Map | sectors, channel overlay | S1 S2 S3; the channel ramp of the overlay shown (`TrackMap.jsx`, channelLegend) |

The other views draw their legend from items in the component (`legendItems` of the Position Tracker, the Strategy Timeline, the tyre views; the Circle of Doom's `cod-legend`; the PCA biplot's colour and shape legends); `frontend/src/__tests__/views.palette.test.js` ("every view has a legend of its encodings") fails when a view loses its legend call.

## Delta areas (Lap Delta, telemetry GAP)

The areas between a driver's delta line and the zero line are hatched: a 14 % tint of the diverging colour crossed by hatch lines of the colour itself, rising for behind (orange, +), falling for ahead (blue, −) (`utils/views/deltaHatch.js`; the legend swatch is the same hatch). The hatch lines read 6.22-7.22:1 on the raised surface and the panel; a plain tint at the 22 % used before read 1.44-1.47:1, and 3:1 would need an alpha of 0.56-0.62, a fill that would sit under the team-coloured lines (`notes/experiments/phase9/repair2_contrast.txt`, `repair2_area_alpha.txt`). The sign is also in the axis ticks and the end labels.

## Animations

No animation lowers a text below 4.5:1 or a status mark below 3:1 at its lowest opacity: the Timing Tower's PIT text blinks down to 0.85 (4.86:1; it went down to 0.5, 2.55:1, the INFO line of the same output), the battle glyph ⚔ no longer pulses (secondary text at full opacity), the header status dot to 0.5 (3.23:1); the shortcut hints have no faded state (they show for 5 s, then hide whole) (`notes/experiments/phase9/repair2_contrast.txt`). The position-change flash of the tower rows uses the diverging pair (blue gained, orange lost), never green / red.

## Lie Factor / Truncated Axes

### Charts with non-zero Y-axis origin:
- **LapTimeChart** (the forecast mini-chart under the timing sheet): Y-axis shows lap times in the range ~80-120s. Starting at 0 would waste 80% of the axis on empty space. The Y-axis is labelled with actual times (m:ss.sss format), making the non-zero origin explicit.
- **TireDegradation** (post-rewrite): Y-axis shows lap times for the driver's stint range. Same justification as LapTimeChart.
- **LapDeltaChart**: Y-axis centered on 0 (delta = 0 is the baseline). No truncation issue.

### Charts with zero Y-axis origin:
- **ChampionshipChart**: Points start at 0. Correct.
- **TyreHealth**: Health percentage 0-100. Correct.

All non-zero origins use `d3.scaleLinear` with data-driven domains and visible tick labels. No misleading truncation.
