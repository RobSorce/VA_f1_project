# V13 browser pass after Phase 9 (2026-10-16, browser, Monza 2024 R16, lap 1 and lap 51)

Method: JS audit in the page (page scroll, clipped overflow-hidden boxes, scroll areas, text < 10 px incl. SVG CTM scale, WCAG contrast on DOM backgrounds), Pit Wall + every dock view, at 1536x750, 1366x768, 1920x1080. Findings are measured, not visual.

Good: no page scroll at any viewport; Pit Wall fits at 1536x750 (20-row tower, pace grid pages L1-11 of 53); no small text and no contrast failure in the Pit Wall at first load; stint labels 13:1 on their bars.

Real problems:
1. Sidebar race tower (app-sidebar > panel 'RACE' > .tower-body, Leaderboard): fixed 440 px body, content 554 px → P16-P20 + retired rows hidden (GAS, BOT, ZHO, HUL, TSU at lap 51) at EVERY viewport (1366x768, 1536x750, 1920x1080), overflow hidden, no scroll, no pager. The legend chips take three lines above the rows.
2. SVG charts keep the viewBox computed at first render: after a window resize (e.g. moving the browser from the 2048 px screen to the 1536 px one, or a dock split change) the Track Map is drawn at scale 0.6 → corner labels 6.5 px, DRS label 6 px (30 text elements < 10 px). Same pattern reported by the Phase 9 verifier for ChampionshipChart, ChampionshipStandings, LapDeltaChart, PCABiplot, TireDegradation. At 1366x768 even on first load: DRS 8.9 px, corner labels 9.8 px.
3. Dock at 1536x750: content 1439 px in a 1400 px bar → the first (Pit Wall) and the last (Settings) buttons are partly cut. Contradicts "Settings always visible" (dockCapacity measurement).
4. Pit Wall main row: inner DIV clips 9 px (246 in 237) at 1536x750 (minor).
5. Weather bar event text truncated 15-22 px at 1366x768 (minor; ellipsis?).
6. Lap Times: timing-sheet__body scrolls (justified), header spans truncated (check ellipsis + title).

## Re-check after Phase 9c (cb2d66c), same method
- 2048x1100 and 1536x750, Pit Wall + all 8 dock views at lap 51: no page scroll, no clipped boxes, no unjustified scroll, no text < 10 px, no contrast failure (only a disabled button, exempt); sidebar tower 20/20 rows; dock nothing cut (after a resize the dock can be cut for ~2 s until it re-measures).
- G1 (HIGH, the primary target screen): Pit Wall Track Map at 1536x750 — panel 387x263, `.panel-controls` 181 px tall, map container `.viz-container` 354x34 px → the map is practically invisible. The controls must collapse (compact toolbar / popover) so the map keeps most of the panel.
- G2: Track Map viewBox does not follow its container: after resizing 1536→2048 the container is 607x220 but the viewBox stays "0 0 354 34" (content bbox y −56..84, drawn outside). Resize must update on width AND height changes.
- G3: Circle of Doom plot fixed at 356x134 inside a 609x266 main area at 2048x1100 → the circle does not grow on larger screens.
- G4 (minor): dock re-measures only after a re-render; for ~2 s after a window resize Pit Wall/Settings are cut.
