# Color Encoding

Every semantic colour of the dashboard is defined once, in `frontend/src/utils/colors.js`; the stylesheets read the same values from the dark-theme tokens of `frontend/src/styles/tokens.css` (`:root`). Views import these constants and hold no hex of their own for a meaning. Every hex written below is a literal of one of those two files: `node scripts/color_doc_check.mjs` (from `frontend/`) lists where each one is defined and fails on any other (`docs/evidence/color_doc_hex.txt`). Colours that are computed (a teammate tint, a mark lifted to its contrast floor, a de-emphasised mix) are described by their rule, with the script output that prints their values.

The app always runs the dark theme (the store's `setTheme` sets `data-theme="dark"`); the light-theme tokens of `tokens.css` are kept but cannot be chosen from the UI.

## 1. The two rules

### Contrast (WCAG 2.1 AA)

- Text >= 4.5:1 (SC 1.4.3); marks (lines, dots, bars, symbols) and the boundary of a control >= 3:1 (SC 1.4.11), against the dark surfaces they are drawn on: page #0f0f1e, panel #131326 (`--color-bg-panel` over the page), raised #1a1f33 (headers, cards, chart backgrounds), elevated #242938 (tooltips, hovered rows) (`SURFACES`).
- `contrastRatio` is the WCAG ratio after alpha compositing; `markColor` lifts a team or category colour toward white just enough to reach 3:1 on its surface, `textColor` to 4.5:1; `contrastText` gives the text of a badge filled with a colour (black or white, whichever is higher); `tintedChip` puts a 15 % tint behind a label and lifts the label to 4.5:1 on that tint.
- A de-emphasised (context) item keeps at least 3:1 for its text and 2:1 for its marks (`CONTEXT_FLOOR`, decision D7, section 10), and is never faded by an opacity on its text.
- Checked by `frontend/scripts/cvd_check.mjs` (`docs/evidence/cvd_check.txt`: every palette, the neutral text, the marks and badges, the tinted chips; RESULT: PASS), `frontend/scripts/audit/contrast_pairs.mjs` (`contrast_pairs.txt`: 0 of 37 pairs under their threshold) and `frontend/scripts/audit/lane_marks_check.mjs` (`lane_marks_check.txt`, the strategy views; RESULT: PASS).

### Colour vision (colour-blind safe)

- Each palette is simulated under protanopia, deuteranopia and tritanopia (Machado, Oliveira and Fernandes 2009, severity 1.0, `CVD_MATRICES`) and its closest pair is measured in CIEDE2000 (Sharma, Wu and Dalal 2005, `deltaE2000`).
- A palette whose closest pair is at least 10 under all four vision types (`CVD_MIN_DELTA_E`) stands on colour alone ("PASS"); any other palette is always drawn with a redundant cue, a letter, glyph, sign, word or dash, so colour is never the only cue ("PASS WITH CUE").
- No meaning is carried by a red / green pair: better / worse is blue / orange (section 6), throttle / brake is sky blue / orange (section 9). A green / red pair is still defined in the chrome tokens (`--rh-gain`, `--rh-loss`) but no rule uses it.

Closest pair of each palette over the four vision types (`docs/evidence/cvd_check.txt`; the Race Control categories, `docs/evidence/lane_marks_check.txt`):

| Palette (colors.js) | Closest pair | CIEDE2000 | Verdict | Cue drawn with it |
|---|---|---|---|---|
| `DIVERGING` better / worse | better / worse | 47.2 | PASS | sign + / − or ▲ / ▼ |
| `STATUS_COLORS` timing | overall best / pit (protanopia) | 11.9 | PASS | ◆ ● P / O / PIT |
| Pace scale (fast, normal, slower, much slower) | slower / much slower (deuteranopia) | 14.5 | PASS | ordered scale, the time in the cell |
| `TYRE_COLORS` | SOFT / INTERMEDIATE (deuteranopia) | 5.7 | PASS WITH CUE | letter S M H I W |
| `FLAG_COLORS` | yellow / safety car (deuteranopia) | 7.3 | PASS WITH CUE | the label (GREEN, SAFETY CAR, ...) |
| Race Control categories (`RaceControlPanel.jsx`) | Car Event / Other (deuteranopia) | 4.8 | PASS WITH CUE | glyph F D S C P ⚖ · and the label |
| `CHANNEL_COLORS` | speed / brake (deuteranopia) | 11.5 | PASS | channel name |
| `SERIES_COLORS` | series 2 / series 3 (tritanopia) | 11.1 | PASS | lap number |
| `SECTOR_COLORS` | S1 / S3 (protanopia) | 14.1 | PASS | S1 / S2 / S3 |
| `OUTCOME_COLORS` (PCA) | points / no points (deuteranopia) | 24.6 | PASS | ordered by lightness |
| `MEDAL_COLORS` | P1 / P2 (tritanopia) | 19.0 | PASS | the position number |
| `TEAM_COLORS` | Alpine / Haas (deuteranopia) | 1.0 | PASS WITH CUE | driver code, teammate dash |
| Teammate tints vs their team colour | McLaren (deuteranopia) | 11.0 | PASS | plus the dash 6,3 |
| Third-driver tints vs the team's two | Alpine (deuteranopia) | 10.1 | PASS | plus the dash-dot 8,3,2,3 |

## 2. Surfaces and neutral text

| Use | colors.js | Hex | Token | Contrast (`cvd_check.txt`) |
|---|---|---|---|---|
| Primary text | `TEXT_COLORS.primary` | #FFFFFF | `--color-text-primary` | 14.49:1 on the elevated surface |
| Secondary text, running time | `TEXT_COLORS.secondary`, `STATUS_COLORS.running` | #C9CCD6 | `--color-text-secondary` | 9.03:1 on the elevated surface |
| Muted text, retired, neutral delta | `TEXT_COLORS.muted`, `STATUS_COLORS.retired`, `DIVERGING.neutral` | #A3A7B7 | `--color-text-muted`, `--status-retired` | 6.05:1 on the elevated surface, 7.63:1 on the panel, 5.10:1 on a hovered row |

Grid lines, axis domains and separators (`GRID_COLORS`, white at 6 %, 30 % and 45 %) carry no data and have no contrast floor; a text field's boundary is white at 45 % (`UI_COLORS.controlBorder`, >= 3:1 on every dark surface).

## 3. Team colours and drivers

The team colours (`TEAM_COLORS`, mirrored as `--team-*` tokens) are the teams' 2024 colours; Racing Bulls (RB renamed for 2025) shares the RB colour, and Audi and Cadillac carry FastF1's TeamColor of the cached 2026 sessions. A team name without a key is drawn #888888 (`UNKNOWN_TEAM_COLOR`).

| Team | Hex | | Team | Hex |
|---|---|---|---|---|
| Red Bull Racing | #3671C6 | | Williams | #64C4FF |
| Ferrari | #E8002D | | RB / Racing Bulls | #6692FF |
| Mercedes | #27F4D2 | | AlphaTauri | #5E8FAA |
| McLaren | #FF8000 | | Haas F1 Team | #B6BABD |
| Aston Martin | #229971 | | Kick Sauber | #52E252 |
| Alpine | #FF87BC | | Alfa Romeo | #C92D4B |
| Audi | #F50537 | | Cadillac | #909090 |

- **The colours are kept, with cues.** The 2024 grid's closest pair is Alpine / Haas, CIEDE2000 1.0 under deuteranopia (Mercedes / Kick Sauber 7.2 under tritanopia; `cvd_check.txt`, "TEAM_COLORS 2024 grid"). The brand colours are what the intended user reads on every timing screen, so they are not replaced; instead the driver code is drawn next to every team-coloured mark or inside every badge, and teammates differ by tint and dash (below).
- **As marks and badges.** A team colour drawn as a mark goes through `markColor` (>= 3:1): on the page, the panel and the raised surface no team colour needs lifting; on the elevated surface Red Bull Racing and Alfa Romeo are lifted (smallest mark contrast after the rule 3.08:1). Badge text is `contrastText` of the fill (smallest 4.69:1, `cvd_check.txt`, "Badge text").
- **Teammates (V3).** The drivers of a team are ordered by car number, then code (`setSessionDriverColors`, from the session's `driver_info`). The first is drawn in the team colour, solid; the second in the teammate tint (`teammateTint`: a dark or mid team colour mixed 45 % toward white, a light one 38 % toward black) and, where drawn as a line, dashed 6,3 (`TEAMMATE_DASHES`); legends show each team as a pair swatch. The two are at least CIEDE2000 11.0 apart under every vision type. A third driver of a team (a reserve in the championship) gets a second tint, the mix toward white or black of 10 to 60 % that is farthest from the other two marks under the worst vision type (at least 10.1), and the dash-dot 8,3,2,3; never dotted, since a dotted line is a projection (the championship's predicted total, `PREDICTION_DASH` 1,4). With mixes up to 90 % most third tints were near-white or near-black and two teams' third drivers came within CIEDE2000 0.7 of each other (`docs/evidence/third_tint_hue.txt`). The tints of every team are printed in `cvd_check.txt` ("Teammates", "Third driver of a team"). The rule holds in every team-coloured view and in the command bar's driver dots (they read `getDriverColor`, not FastF1's raw team colour).
- **Championship chart and standings.** They list more drivers than a session. A driver of the loaded session who drives for the same team in the championship keeps exactly his session style (`championshipStyles`, `sessionTeammate`); the other drivers of a team take the places left. The standings bars carry the teammate dash as a line along the bar in its contrast text colour, and have a legend of the teams and patterns.
- **Mid-season team changes (decision D11).** The session views colour a driver by his team in the session on screen; the championship colours him by his team at the latest round of the season (the `team` of the championship entry). A driver who changed team is then drawn differently in the two: with Monza, China or Imola 2024 or Monza 2025 loaded 0 session drivers differ, with Australia 2025 loaded 2 (Lawson and Tsunoda, who swapped Red Bull Racing and Racing Bulls, take each other's teammate tint; `docs/evidence/cross_view_styles.txt`). The championship tooltip says so (`teamChangeNote`, `championshipTooltip` in `utils/views/championshipChart.js`), e.g. "Red Bull Racing → Racing Bulls from R3" when the rounds of the change are known.
- **One deliberate exception.** The PCA biplot's "team" colour mode colours each point by its team (`utils/views/pcaBiplot.js`), so teammates share a colour there on purpose: the mode answers "where do the teams sit"; the driver code is in each point's tooltip.

## 4. Tyre compounds

| Compound | Hex | Letter | Token |
|---|---|---|---|
| SOFT | #FF3333 | S | `--tyre-soft` |
| MEDIUM | #FFC300 | M | `--tyre-medium` |
| HARD | #EEEEEE | H | `--tyre-hard` |
| INTERMEDIATE | #39B54A | I | `--tyre-intermediate` |
| WET | #00AAFF | W | `--tyre-wet` |
| unknown | #888888 | ? | |

The FIA / Pirelli compound colours (`TYRE_COLORS`). They are always drawn with the compound letter (`TYRE_LABELS`, black or white by `contrastText`): SOFT and INTERMEDIATE are only CIEDE2000 5.7 apart under deuteranopia (`cvd_check.txt`), so the letter, not the colour, tells them apart. Used in the Strategy Timeline stints, the tyre views (Tyre Degradation, Tyre Health, Pace Retention, the tyre silhouette), the tyre badges of the tower, the Leaderboard, the Lap Times sheet and the Race Situation map, and the Position Tracker's compound lines.

## 5. Timing status and timing bands

| Status | colors.js | Hex | Token | Cue |
|---|---|---|---|---|
| Overall (session) best | `STATUS_COLORS.overallBest` | #C084FC | `--sector-purple` | ◆ |
| Personal best | `STATUS_COLORS.personalBest` | #34D399 | `--sector-green` | ● |
| Slower | `STATUS_COLORS.slower` | #FDE047 | `--sector-yellow` | band legend |
| Much slower | `STATUS_COLORS.muchSlower` = `DIVERGING.worse` | #F0883E | `--color-worse` | band legend |
| Fast (pace grid) | `STATUS_COLORS.fast` = `DIVERGING.better` | #5DA5E8 | `--color-better` | band legend |
| Normal | `STATUS_COLORS.normal` | #E5E7EB | | |
| Pit lap / car in the pit lane | `STATUS_COLORS.pit` | #F472B6 | `--status-pit` | P (in), O (out), PIT |
| Retired | `STATUS_COLORS.retired` | #A3A7B7 | `--status-retired` | RET / ✕ / OUT |
| Forecast | `STATUS_COLORS.predicted` | #F5A623 | `--status-predicted` | L, dashed |

The F1 timing convention (purple overall best, green personal best, yellow no improvement) is kept, lightened to text contrast; the timing green and purple always come with their glyph (`STATUS_GLYPHS`, `timingGlyph`).

One ordered scale and one set of bands for every view that colours a time against a reference (`TIMING_BANDS`, `timingBandColor`, V2): against the driver's personal best in the Timing Tower and the Pit Wall sector panel, against the driver's median lap in the Race Pace Grid. Normal within 0.3 s (sector) / 0.5 s (lap), yellow beyond, orange beyond 1.0 s (sector) / 2.0 s (lap), never back to white; the pace grid also marks blue a lap more than 0.3 s under its median; a best is a time within 0.010 s of it. Each legend names its reference (`docs/evidence/timing_bands.txt`: the tower, the Pit Wall panel and the pace grid read the same bands, RESULT: PASS).

## 6. Better / worse (the diverging pair)

`DIVERGING`: better #5DA5E8 (blue), worse #F0883E (orange), neutral the muted text; tokens `--color-better`, `--color-worse`. CIEDE2000 >= 47.2 under every vision type and >= 5.53:1 on every surface (`cvd_check.txt`). Always drawn with the sign of the value (`signedDelta`, a true minus sign) or a ▲ / ▼ glyph (`deltaColor`; "better" = faster, places gained, closing in). Where it is used: sector and lap deltas, gaps, places gained or lost (Leaderboard ▲ blue gained, ▼ orange lost; the tower's position-change flash), the verdicts of the Strategy Simulator and the Undercut Calculator, the bars of the Sector Delta waterfall and the effect bars of the analysis panels.

What the sign means is the view's, and each legend states it: in the Undercut sweep + is "focus ahead" (blue), in the Focus Driver widget + is "the rival behind" (blue), in the Lap Delta chart and the telemetry GAP + is "behind the base" (orange). The colour always says better or worse for the driver in focus; the sign alone reads differently in different views.

## 7. Pit, pit window, selection and forecast (one colour, one meaning in every view)

| Meaning | colors.js | Hex | Token | Where |
|---|---|---|---|---|
| Pit: a car in the pit lane, a pit in / out lap | `STATUS_COLORS.pit` | #F472B6 | `--status-pit` | Always with P / O or PIT: Timing Tower, Race Pace Grid, Lap Times sheet, Pit Wall sector panel, Leaderboard, the Circle of Doom's pit-lane arc (dashed, at full strength: 6.90:1 on the panel, `contrast_pairs.txt`). The Strategy Timeline marks a stop with a white ◆ and a car in the pit lane with a white ◇ (`TEXT_COLORS.primary`, its legend rows "Pit stop" / "In pit lane"). |
| Pit window: the laps where a stop pays | `UI_COLORS.pitWindow` | #A855F7 | `--color-pit-window` | 4.62:1 on the panel (`cvd_check.txt`, "Single accents"): the Circle of Doom band, rejoin diamond, uncertainty arc and rejoin label; the Position Tracker's pit-window band and its "PIT WINDOW" label; the Tyre Degradation "next pit window" range. As text: #B56FF8 (`UI_COLORS.pitWindowText`, `--color-pit-window-text`). |
| Selection (a car or driver selected in another view), brushed range, "on" toggles | `UI_COLORS.brush` | #8AB4F8 | `--color-brush` | 8.67:1 on the panel: the Track Map's selected-car stroke (`.car-marker.selected`), the Circle of Doom ring (`.cod-select-ring`), the brushed lap range (at 16 %, `UI_COLORS.brushFill`), checked items and active toggles. |
| Forecast / predicted | `STATUS_COLORS.predicted` | #F5A623 | `--status-predicted` | The forecast rows of the Lap Times sheet (with the letter L, its pit-probability chip), the Championship's predicted totals (toggle and chips), the radio toast's chip. The forecast chart under the sheet draws the driver's own colour, the forecast dashed. |

In the Circle of Doom the pit-window line of the status text under the circle (`.cod-status__focus`) is drawn in the timing purple #C084FC (`--sector-purple`) for text contrast; the circle shows no lap-time bests, and cars keep their team colours.

The F1 brand red #E10600 (`UI_COLORS.accent`, `--color-f1-red`; #FF6B63 as text, `--color-f1-red-text`) is chrome, never a data encoding.

## 8. Flags, race control, severity and Monte Carlo levels

- Flags and track status (`FLAG_COLORS`, `TRACK_STATUS_STYLES`, tokens `--flag-*`): green #34D399 (the emerald of personal best, so green and red flags differ under deuteranopia), yellow #FACC15, safety car / VSC #F59E0B, red #F87171, blue #60A5FA, chequered #FFFFFF. Always with their label (GREEN, YELLOW FLAG, SAFETY CAR, VSC, RED FLAG): yellow / safety car are 7.3 apart under deuteranopia and safety car / red 9.0 under tritanopia (`cvd_check.txt`).
- Race Control categories (`CATEGORY_META` in `RaceControlPanel.jsx`): Flag, DRS, Safety Car and Penalty / Stewards in the FIA flag colours (yellow, blue, safety car, red), Car Event in the series pink #CC79A7 (`SERIES_COLORS[2]`) and Other in the muted grey #A3A7B7, which are not flag colours; each with a different glyph (F, D, S, C, P, ⚖, ·) and the label; closest pair Car Event / Other 4.8 (deuteranopia; `lane_marks_check.txt`).
- Severity of risks, alerts, insights and battle urgency (`strategyMarks.js` `SEVERITY`): high = orange #F0883E with !!, medium = yellow #FDE047 with !, low = secondary #C9CCD6 with i, each with its word; closest pair 14.5 (deuteranopia; `lane_marks_check.txt`).
- Monte Carlo battle badges (`levelMark`): two badges white #FFFFFF ●●, one yellow #FDE047 ●, none muted #A3A7B7 ○; closest pair 18.1 (tritanopia). The gold P label of a podium (`PODIUM_COLOR`) is the same yellow.
- Tinted chips (a flag, a status, a severity behind its label) keep the label at >= 4.5:1 on the tint (`tintedChip`; the brand red is lifted from 3.11 to 4.62:1, `cvd_check.txt`, "Tinted chips").

## 9. Telemetry, comparison series, sectors, track and the PCA classes

- Telemetry channels (`CHANNEL_COLORS`, Okabe and Ito 2008): speed #F0E442, throttle #56B4E9 (`--channel-throttle`), brake #E69F00 (`--channel-brake`), sky blue / orange instead of green / red; closest pair 11.5. On the Track Map overlay each channel is a ramp whose low end stays at >= 3:1 on the panel: throttle and brake start at #5C6677 (`CHANNEL_RAMP_LOW`, 3.15:1), speed is cividis from t = 0.37 (`SPEED_RAMP_START`, 3.07:1) (`contrast_pairs.txt`, `docs/evidence/ramp_ends.txt`).
- Up to four comparison series of one chart, laps of a driver (`SERIES_COLORS`): #56B4E9, #E69F00, #CC79A7, #F0E442, each >= 4.73:1 on the elevated surface; closest pair 11.1.
- Track sectors (`SECTOR_COLORS`): S1 #CC79A7, S2 #F0E442, S3 #56B4E9, always labelled S1 / S2 / S3, drawn at full opacity; closest pair 14.1.
- Track Map surface and overlays with no category of their own (`TRACK_COLORS`): the track #4A5568, the DRS zones with white #FFFFFF edges and the label DRS (`--track-drs`; seasons before 2026), the DRS detection points #C9CCD6, the north arrow #FF6B63.
- Finishing classes of the PCA biplot (`OUTCOME_COLORS`, brighter = better): podium #fdea45 and no points #61636f are cividis at t = 1 and 0.37 (3.07:1 on the panel, the lowest t at 3:1); points #13b1ce is a cyan at the lightness of cividis' middle class (CIE LCh hue 220, chroma 40). Cividis' own middle class, a khaki of chroma 23, read almost as grey next to the no-points grey on the biplot's small marks. The cyan keeps chroma 40 (21 under protanopia, 29 under deuteranopia, 42 under tritanopia, against 24, 23 and 10 for the khaki), stays 19.0 CIEDE2000 from the selection blue and cannot be taken for the bronze of the P3 badges (`docs/evidence/pca_outcome_palette.txt`). Ordered by lightness, so it stands on colour alone: closest pair 24.6, points / no points under deuteranopia (`docs/evidence/cvd_check.txt`). Against the khaki it moves further from the podium under every vision type and from no points under normal vision and tritanopia, but comes closer to no points under protanopia and deuteranopia (27.0 and 24.6 against 31.8 and 32.9; `docs/evidence/pca_outcome_palette.txt`). A row whose result is not known yet at the replay clock is drawn as an outline only.
- Podium medals of the final classification (`MEDAL_COLORS`): #FFD700, #C0C0C0, #CD7F32, the position number on them in black (>= 6.6:1).

## 10. Focus + context (de-emphasised items)

Rule (decision D7): focus + context de-emphasis is allowed, with floors. When a selection, a focus or a hover leaves other items as context, the text of a context item keeps at least 3:1 against its background and its marks (lines, bars, dots, badges) at least 2:1. A context item is de-emphasised by mixing its colour toward the background it is drawn on, never by an opacity on text: `contextColor(color, surface)` in `utils/colors.js` mixes up to 50 % toward the surface (75 %, `CONTEXT_MIX_LINES`, in the charts of a line per driver) and stops at the floor (2:1 for a mark, `contextText` 3:1 for text), and always returns an opaque colour. Disabled controls are exempt (WCAG 2.1). Where a view swaps the category colour of a context text for the muted text colour #A3A7B7 (7.63:1 on the panel) or the secondary #C9CCD6 at full opacity, it stays above both floors: the Race Pace Grid's context headers (secondary text on a 25 % team tint, 6.05:1 for the worst team) and cells, the Circle of Doom's ring labels, the Championship standings' names, the Track Map labels of retired cars (`docs/evidence/contrast_pairs.txt`).

Context marks and text drawn with `contextColor` / `contextText`: the Circle of Doom leader lines of de-emphasised cars (2.01:1 on the panel; at opacity 0.3 they read 1.25:1; `docs/evidence/focus_context_contrast.txt`), the context bars of the Championship standings (>= 2:1 for every team, 2.00:1 for the worst) and the teammate dash inside them, the team bar and the tyre badge of the Lap Times forecast rows (the badge letter in `contrastText`), the Championship chart's context lines, dots and end labels, the Position Tracker's context lines, end labels and compound badges, the Strategy Timeline's unselected stint bars (the compound colour mixed toward the panel, its label black or white by contrast with the bar drawn, `utils/views/strategyTimeline.js`), the Lap Delta lines of the drivers not hovered (their hatched areas are left out while another line is hovered), the Telemetry traces of the drivers not hovered and the ghost laps (their throttle / brake areas left out), the Track Map dots of context cars, the team bars of context rows in the Sectors panel and of context cards in the Consistency panel, the PCA biplot points outside a selection, and the Race Situation map's context drivers (their codes in `contextText`, their dots and tyre badges in `contextColor`, the badge letters in `contrastText` of the mixed badge; a context driver's trail is not drawn). The Position Tracker's context end labels are computed on the brush tint (`brushTintOver`), the lightest background under them: 3.00-3.08:1 inside a brushed range, 3.24-3.32:1 outside it (2.78-2.85:1 inside a range before; `docs/evidence/posbrush_labels.txt`). A low-data Consistency card is told by its LOW DATA chip only. A hover or a click brings any of them back at full strength; "Clear All Selections" (command bar) clears the selection. `frontend/src/__tests__/fade.context.test.jsx` checks the floors and lists every opacity left in these views with its reason (a tooltip, a trail, a toggled-off layer, the lapped cars of the Circle of Doom, which have their own legend row; never a context item); `frontend/src/__tests__/fade.views.test.jsx` mounts the Championship chart, the Position Tracker and the Strategy Timeline with a focus and a selection and reads every drawn colour back.

Retired drivers are never faded either: 'RET' / ✕ / OUT and the retired grey #A3A7B7 (7.63:1), with the retired bar on the row's left edge in the Leaderboard and the Lap Times sheet, ✕ in the Pit Wall Timing Tower's status column. The Track Map leaves a retired car off the track in a replay or a live feed; where its marker is drawn, its dot is the retired grey at full opacity (`.car-marker--retired`) and its label the muted text colour.

## 11. One colour, one meaning in the chrome and the tower

- Track Map sectors are drawn in `SECTOR_COLORS` (section 9), at full opacity.
- Weather-bar flag chips use the `--flag-*` tokens (tested equal to `FLAG_COLORS`), always with their label.
- An "on" toggle and a checked item use the selection blue `--color-brush`, not the INTERMEDIATE compound green.
- In the Leaderboard orange (the diverging "worse") means places lost (▼) and the top level of the overtake badge (⇅ and its %); a row in a battle has a neutral highlight and the ⚔ glyph, not an orange tint.

## 12. Legend rows per view

Each view's legend names every encoding it draws. Rows of the legends built by a helper (printed by `npx vite-node scripts/audit/legend_rows.mjs` from `frontend/`, output `docs/evidence/legend_rows.txt`):

| View | Encodings | Legend rows |
|------|-----------|-------------|
| Lap Times sheet | timing colours with glyphs, running lap, forecast, diverging delta | ◆ Overall best, ● Personal best, PIT Pit lap, Lap running, L Forecast, − Faster, + Slower (`timingSheetLegend`) |
| Lap Times forecast chart | laps run, forecast (dashed), held-out error band, forecast origin | Laps run, Forecast, ± held-out MAE, Forecast origin (`forecastChartLegend`) |
| Timing Tower | timing bands with glyphs, pit, running, retired | Session best, PB, +0.3/0.5 s off PB, +1/2 s off, pit in / out, running, retired (`timingTowerLegend`) |
| Race Pace Grid | lap cell classes with glyphs, pit, running | Session best, Personal best, Fast, Normal, Slow, Very slow, Pit in, Pit out, Lap running (`paceLegend`) |
| Sectors panel | timing colours (live), gap bars on a seconds scale (best) | live: Session best, Personal best, Other sector, Sector running; best: Session best (its time), Bar: gap to the session best (s) (`sectorsLegend`) |
| Pit Wall sector panel | timing bands, running, delta vs PB | Session best, PB, > 0.3 s off PB, > 1 s off, Running, − vs PB, + > 1 s (`pitWallLegend`) |
| Lap Delta | driver lines (teammate dashed), hatched areas, the base driver's zero line | the base driver (a double grey zero line, two 1.5 px rails 4 px apart, labelled "base: XXX": no driver line is double), each driver, + behind, − ahead (`lapDeltaLegend`) |
| Championship chart | team-coloured lines, round dots, teammate dash, third-driver dash-dot, predicted total | Points so far, Round, Teammate, Third driver (when drawn), Predicted total, Last round run (`championshipLegend`) |
| Championship standings | team-coloured bars, teammate patterns | one row per team (pair swatch), Teammate (dashed in the bar), Third driver (when drawn) (`championshipStandingsLegend`) |
| Race Situation map | team-coloured dots, teammate tint | one row per team (pair swatch) (`teamPairLegend`) |
| Leaderboard | ▲ / ▼ places vs grid, compound letters, pit, overtake badge levels, battle | vs grid, lost, S M H, pit, ⇅ <30 %, ⇅ >=30 %, ⇅ >=60 %, ⚔ battle (`Leaderboard.jsx` TOWER_LEGEND) |
| Race Prediction | share of runs, P5-P95, P label, now, limits, gained / lost, podium gold | share of runs per position, P5-P95, P label (median), now, podium / points limit, ▲ places gained, ▼ places lost, gold P / pod: a podium (`RacePredictionPanel.jsx`, drawLegend) |
| Track Map | sectors, DRS zones, channel overlay | S1 S2 S3; DRS zone (seasons with DRS, while the zones are shown); the channel ramp of the overlay shown (`TrackMap.jsx`, mapKeyItems, channelLegend) |

The other views draw their legend from items in the component (`legendItems` of the Position Tracker, the Strategy Timeline, the tyre views; the Circle of Doom's `cod-legend`; the PCA biplot's colour and shape legends); `frontend/src/__tests__/views.palette.test.js` ("every view has a legend of its encodings") fails when a view loses its legend call.

## 13. Delta areas (Lap Delta, telemetry GAP)

The areas between a driver's delta line and the zero line are hatched: a 14 % tint of the diverging colour crossed by hatch lines of the colour itself, rising for behind (orange, +), falling for ahead (blue, −) (`utils/views/deltaHatch.js`; the legend swatch is the same hatch). The hatch lines read 6.22-7.22:1 on the raised surface and the panel; a plain tint at the 22 % used before read 1.44-1.48:1, and 3:1 would need an alpha of 0.56-0.62, a fill that would sit under the team-coloured lines (`docs/evidence/contrast_pairs.txt`, `docs/evidence/area_alpha.txt`). The sign is also in the axis ticks and the end labels.

## 14. Animations

No animation lowers a text below 4.5:1 or a status mark below 3:1 at its lowest opacity: the Timing Tower's PIT text blinks down to 0.85 (4.86:1; it went down to 0.5, 2.55:1, the INFO line of the same output), the battle glyph ⚔ no longer pulses (secondary text at full opacity), the header status dot pulses down to 0.5 (3.23:1); the shortcut hints have no faded state (they show for 5 s, then hide whole) (`docs/evidence/contrast_pairs.txt`). The flag banners and chip (Leaderboard, Pit Wall Timing Tower, session bar) and the winner banners (Leaderboard, Track Map) are static: a pulse down to 0.8 took the RED FLAG label to 3.93-4.37:1, one down to 0.9 a winner's name to 3.73:1. The live dots keep full opacity while their glow pulses (at 0.6 a dot read 1.93:1 on the panel), and the live progress bar is static (2.02:1 at 0.7). Every endless animation of the stylesheets and of the components' inline styles is listed with its contrast at the lowest keyframe in `frontend/src/__tests__/pulse.contrast.test.js`. The position-change flash of the tower rows uses the diverging pair (blue gained, orange lost), never green / red.

## 15. Lie factor / truncated axes

Charts with a non-zero y origin, each with labelled ticks (`d3.scaleLinear` on the data's domain):

- **Lap Times forecast chart** (under the timing sheet): lap times in seconds over the range of the laps shown; an axis from 0 would leave the laps in a thin strip at the top.
- **Tyre Degradation**: lap times of the driver's stints, for the same reason.
- **Lap Delta**: the domain always contains 0 (the base driver's line), padded around the deltas drawn, so the zero line is on the chart.

Charts with a zero origin: the Championship chart (points from 0) and Tyre Health (estimated tyre life 0-100 %).
