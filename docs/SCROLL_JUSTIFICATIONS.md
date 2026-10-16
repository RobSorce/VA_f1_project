# Scrollable areas: inventory and justifications

The dashboard is a fixed-viewport application: the page never scrolls, at any
window size. A view adapts to the box its panel gives it: charts read their
container size; most tables and lists fit their rows to the height and page
the rest (the Timing Tower, the Leaderboard, the Sectors panel, the Race Pace
Grid, the Consistency cards, the strategy views); the Driver Comparison lays
its sections and the Strategy Timeline its driver rows in columns, then pages,
that fit the pane. The areas that keep an internal scroll are listed below,
each with the design constraint that justifies it. Five of them are in data
views: the Lap Times timing sheet scrolls by default whenever its pane is lower
than the field (10 of the 16 preset and viewport cases); the Timing Tower body
scrolls in one state the user opens; the assistant's chat log (the Strategy
Engineer's Radio tab and the floating assistant) and the Pit Wall's quick
answer scroll only a conversation or an answer longer than their box; and an
expanded Consistency card scrolls its details only in a floating window near
its minimum size. Every other scroll area is in a window, menu or popover the
user opens, or in the start screen.

## The page never scrolls

- `html, body { overflow: hidden }` (`frontend/src/styles/base.css`) and the shell
  `.app-container` is exactly `100vh` with `overflow: hidden`
  (`frontend/src/styles/dashboard.css`); its body takes what the chrome rows
  (weather bar, timeline, dock) leave, with `min-height: 0`.
- An earlier rule, `@media (max-width: 1440px), (max-height: 900px)`, switched the
  app to page scroll on every window lower than 900 px. It let the Pit Wall grow
  to its lap table: a 1896 px page at 1536 x 750
  (`docs/evidence/browser_audit_2026-10-14.md`). It was removed on
  2026-10-15; the chrome rows now shrink with the viewport height instead.
- Checked at 1536 x 750, 1366 x 768, 1920 x 1080 and 2048 x 1100 by
  `node frontend/scripts/audit/layout_fit.mjs` (output:
  `docs/evidence/layout_fit.txt`) and by
  `frontend/src/__tests__/layout.viewport.test.js`.
- Panel content does not scroll unless it is listed below: `.panel-content`,
  `.viz-container` and the analytics containers are `overflow: hidden !important`
  (`dashboard.css`, "Global No-Scroll Policy").
- Zoom and pan: only the Track Map has d3.zoom (`TrackMap.jsx`). The Strategy
  Timeline and the PCA biplot have no zoom or pan.

## How the list is checked

`node frontend/scripts/audit/overflow_inventory.mjs` lists every
`overflow`, `overflow-x` or `overflow-y` set to `auto`, `scroll` or `overlay`, in
the CSS and in the inline styles of the components (React style objects, D3
`.style('overflow', …)`), and fails on any area whose key is not in the
"Inventory key" column below (output:
`docs/evidence/overflow_inventory.txt`: 23 scroll areas, 23 justified).
`frontend/src/__tests__/layout.scroll.test.js` runs the same check with the
test suite. Keys: `<css file> <selector>` for CSS, `<file>:<enclosing style
object or component>#<n>` for inline styles.

## Data views (scroll inside their own panel)

| Area | Inventory key | Direction | Design constraint |
|------|---------------|-----------|-------------------|
| Timing Tower rows (Pit Wall) | `TimingTower.jsx:bodyStyle#1` | Vertical | The rows fit the tower's body (`utils/views/chartBox.js` fitRows): 24 px each while the 20 rows fit, down to 18 px (360 px for 20 rows). `docs/evidence/layout_fit.txt`, at the four target viewports: with no focus driver the 20 rows show at 24 px; with a focus driver the cards under the tower open by default from 900 px of window height (`PitWallLayout.jsx` SHORT_VIEWPORT), and the 20 rows still show at 24 px at 1920 x 1080 and 2048 x 1100; below 900 px the cards open collapsed to their header lines and the 20 rows show at 22 px (1536 x 750) and 23 px (1366 x 768). The body scrolls in one case only: when the user opens the cards ("Details") on a window lower than 900 px, 13 (1536 x 750) or 14 (1366 x 768) of the 20 rows show at 18 px and the others scroll; "Less" gives the rows back. |
| Lap Times timing sheet | `dashboard.css .timing-sheet__body`, `LapTimeChart.jsx:LapTimeChart#1` | Vertical | The sheet lists the whole field, one row per driver (20 in a race, 16 px at the very least: 320 px), and with a focus driver's forecast a header line, one row per forecast lap (5) and the 90 px forecast chart below it. Its pane in the Strategy, Pace and Prediction presets is 199 to 372 px high, so after the panel header, the column header and the lap-range bar at most 6 (Strategy), 8 (Prediction) and 12 (Pace) of the 20 rows show at 1536 x 750 (7 / 8 / 12 at 1366 x 768, 13 / 16 / all at 1920 x 1080, 14 / 17 / all at 2048 x 1100) and the body scrolls: in 10 of the 16 preset and viewport cases. The whole field fits in the Tyres preset at every target viewport (`node frontend/scripts/audit/laptimes_sheet_fit.mjs`, output `docs/evidence/laptimes_sheet_fit.txt`, an upper bound on the rows shown). Horizontally it never scrolls and never cuts a column: the columns are fitted to the rows' box down to floors that keep every value whole (`utils/views/timingSheetFit.js`); every column is on screen in every preset pane at the four viewports, and only a floating window near its 420 px minimum gives up whole columns, named in a "+N" header cell (`node frontend/scripts/audit/panel_fit.mjs`, `docs/evidence/panel_fit.txt`; `frontend/src/__tests__/laptimes.fit.test.jsx`). |
| Strategy assistant chat log | `visualizations.css .chat-messages`, `GeminiFloatingButton.jsx:GeminiFloatingButton#1` | Vertical | A conversation grows without bound; the newest message stays in view (chat convention) (the Strategy Engineer's Radio tab and the floating assistant). |
| AI Strategist quick answer (Pit Wall side column) | `GeminiQuickQuery.jsx:answerTextStyle#1` | Vertical | The answer to a question typed in the Ask box is free text of any length. It opens as a card laid over the side column above the Ask box (the column is 263 px high at 1536 x 750, `layout_fit.txt`), so it never pushes the Ask box or Race Control out of their cell; it closes with ×, and only an answer longer than the card scrolls inside it. |
| Consistency expanded card (floating overlay near its minimum size only) | `dashboard.css .consistency-card__details` | Vertical | An expanded card (the focus driver's, a chevron, "Expand all") is at most as tall as the cards' area (`ConsistencyPanel.jsx` maxHeight); its details (Performance, Consistency, Tyres) scroll under its header only when the card is taller than that. In every preset pane at the four target viewports the expanded card fits a page and nothing scrolls; in a floating overlay at its 420 x 320 minimum (content about 418 x 280) the area is 166-174 px and an expanded card 202-273 px (narrow layout), so the details scroll (`node frontend/scripts/audit/panel_fit.mjs`, `docs/evidence/panel_fit.txt`). |

## Overlays, menus and popovers (opened by the user, above the dashboard)

| Area | Inventory key | Direction | Design constraint |
|------|---------------|-----------|-------------------|
| Floating overlay window | `dashboard.css .overlay-panel__content` | Both | A window the user moves and resizes (minimum 420 x 320 px, `OverlayPanel.jsx`); content larger than the size the user chose scrolls inside the window. The overlay layer keeps clear of the weather bar, the timeline and the dock (tokens `--overlay-inset-*`). |
| Settings | `dashboard.css .settings-tab` | Vertical | An accordion whose height depends on the sections the user opens; the Dock section lists every view of the dock registry, one row each. |
| Help overlay text | `dashboard.css .help-overlay__body` | Vertical | Reading text of each chart's help, of variable length, in a panel capped at `min(720px, 86vh)`. |
| Dock right-click menu | `dashboard.css .dock-ctx-menu` | Vertical | Capped at 320 px (`DockContextMenu.jsx` MENU_MAX_HEIGHT) and anchored above the clicked dock item; scrolls only when its items need more. |
| Dock overflow (⋯) popover | `dashboard.css .dock-overflow-popover__body` | Vertical | The dock items that do not fit on the dock row (`utils/dockCapacity.js`); their number depends on the user's dock and the window width. |
| Dock customise popover | `dashboard.css .dock-customize-popover__body` | Vertical | The full view registry with a toggle per view, grouped by category. |
| Dock layouts popover | `dashboard.css .layout-dock-popover` | Vertical | The layout presets and every view in a multi-column list that fits the popover; capped at `min(720 px, window height - 80 px)` (`LayoutDockPopover.jsx`), the scroll is the fallback for a registry taller than that. |
| Layout builder | `dashboard.css .layout-builder` | Vertical | Pane shapes and one view picker per slot, capped to the room under its anchor. |
| Session menu | `components.css .session-menu`, `components.css .session-menu__race-list`, `components.css .session-menu__mock-list` | Vertical | The season calendar (one row per round) and the list of cached sessions for the mock replay; their length depends on the season. |
| Command bar results | `CommandBar.css .sb-dropdown` | Vertical | Search results of variable length, capped at 400 px; keyboard-driven (the arrow keys keep the selected row in view). |
| Command palette results | `CommandPalette.css .cp-results` | Vertical | The full command list when the query is empty, capped at `calc(80vh - 56px)`; keyboard-driven. |
| Shortcut cheatsheet | `ShortcutCheatsheet.css .cs-body` | Vertical | Three balanced columns in which a section may continue in the next column (a row never splits, a title never ends a column; modal up to 92 vh, rows 2 px padding). The 45 shortcut rows need at most 492 px of column at 1536 x 750 and 493 px at 1366 x 768 against 604 and 620 px of room, an upper-bound estimate (`node frontend/scripts/audit/cheatsheet_fit.mjs`, output `docs/evidence/cheatsheet_fit.txt`), so no target window shows a scrollbar. The scroll is the fallback for windows narrower than 900 px (two, then one column) or lower than the target windows. |

## Start screen (before a session is loaded, not the dashboard)

| Area | Inventory key | Direction | Design constraint |
|------|---------------|-----------|-------------------|
| Session selector screen | `dashboard.css .session-screen` | Vertical | Fallback for windows shorter than the start screen's three cards; below 1000 px of height the cards anchor to the top with tighter spacing. |
| Driver selection grid | `dashboard.css .driver-grid__list` | Vertical | Two columns of driver toggles; scrolls only when the start screen card is shorter than the field. |

## Areas that must not scroll

| Area | How it fits |
|------|-------------|
| Page and shell | `html`, `body`, `.app-container`, `.app-body` `overflow: hidden`; shell `100vh`. |
| Pit Wall grid | Rows `44px / 1fr / 35vh`, columns `480px / 1fr`; every cell has `overflow: hidden` and `min-height: 0`, so a cell never grows to its content (`PitWallLayout.jsx`; `layout_fit.txt`). |
| Docked panes | Each pane is a share of its split; the tab bar shrinks its tabs (ellipsis, full name in the tooltip) and the "+" picker is a grid of every view (`DockedLayout.jsx`). |
| Dock | Never scrolls: the measured buttons that do not fit move into the ⋯ popover (`BottomTabBar.jsx`, `utils/dockCapacity.js`). The measure counts everything on the bar: the buttons, a gap between every two children, the bar's padding and border, the divider with its margins and the fixed group (Layouts, ⌘K, Settings), `dockRow`; it runs again when the web fonts finish loading, and after every render the row is checked and one more item goes to the popover while it is wider than the bar. Measured once with the fallback font's labels, the default dock is 1292 px wide at 1536 x 750 and 1490 px with the Formula1 labels, wider than the 1400 px bar (`node frontend/scripts/audit/dock_fit.mjs`, `docs/evidence/dock_fit.txt`). With the real CSS and font widths the default dock keeps 8 of its 10 items (+ ⋯) at 1536 x 750, 9 at 1366 x 768, all 10 at 1920 x 1080 and 2048 x 1100 (`frontend/src/__tests__/dock.fit.test.jsx`). |
| Weather bar | One row; up to 1440 px wide the event name says "GP" for "Grand Prix", a name still too long ends in an ellipsis with the full name in its title; weather pills that do not fit are hidden whole, never cut. |
| Timeline legend | One row that wraps on a narrow window (`.timeline-player__legend`). |
| Leaderboard rows (Analyse sidebar) | Every row is a share of the tower body (`calc(100% / n)`) moved by `translateY(k x 100 %)` of its own height (`Leaderboard.jsx`, `utils/views/leaderboard.js` towerRowStyle / towerBodyStyle); the body takes the room the sidebar's flex column leaves it, at most 28 px a row, so the rows fit without a measure and a resize starts no transition. The measure only decides to page (`chartBox.js` fitRows, 18 px floor; pageOf, a ▲ ▼ pager line). Below 900 px of window height the legend opens from a "?" key as a card over the rows; the focus driver's cards (`SidebarFocusCards.jsx`) stay collapsed to their header lines under 1200 px, "Details" laying them over the sidebar. At the four target viewports the 20 rows show on one page in every state: 24 / 21 / 18 px at 1536 x 750 (no focus driver / focus driver / focus driver with a flag banner and the forecast footer), 25 / 22 / 19 px at 1366 x 768, 28 px at 1920 x 1080 and 2048 x 1100 (`node frontend/scripts/audit/panel_fit.mjs`, `docs/evidence/panel_fit.txt`; `frontend/src/__tests__/leaderboard.fit.test.jsx`). |
| Sectors panel (Live, Best, Top Speeds) | No scroll and no cut row (`SectorsPanel.jsx`, `utils/views/sectorsPanel.js` sectorsRowFit / sectorsColumnsFit): the rows take the measured body, 26 px down to 18 px, else they are paged (the same page of ranks in every column, a ▲ ▼ pager line under them); the ranked columns (Best: 3 sectors, drawn by `SectorsBestTab.jsx`; Top Speeds: 4 traps, the unit in each column's header) are at least 16 data-type ems wide (a ranked row at the real font widths) and paged with ◀ ▶ when the width holds fewer. In the preset panes: Pace 609 x 286 at 1536 x 750: Live 9 rows a page, Best 3 columns x 10, Top Speeds 3 of 4 columns x 8; Overview 609 x 257: 7 / 9 / 7 rows a page; 1366 x 768 (541 px wide): 2 of 3 and 2 of 4 columns; Pace at 1920 x 1080 (794 x 452): Live and Best 20 rows at 18 px, Top Speeds 3 of 4 columns x 18; Pace at 2048 x 1100 (858 x 463): all 20 rows of every tab (Live and Best at 19 px, Top Speeds 4 columns at 18 px) (`node frontend/scripts/audit/panel_fit.mjs`, `docs/evidence/panel_fit.txt`; `frontend/src/__tests__/sectors.fit.test.jsx`). The fit measures the first column's body; the columns of a page share one header row (`dashboard.css` `@supports (grid-template-rows: subgrid)`), so every body is that tall, and the column titles are in the Bold face, so a title and its "Lap N" stay on one line in a 16 em column. Whether the pager line was on screen travels with each measure of the body (`chartBox.js` useBoxSize tagRef), so a render before the measure that sees the pager never unpages. |
| Consistency cards | No scroll in a preset pane (`ConsistencyPanel.jsx`, `utils/views/consistencyLayout.js`): a collapsed card is one line, 30 px down to 20 px; the cards are laid in as many columns of at least 32 data-type ems as the width holds; an expanded card (the focus driver's, a chevron, "Expand all") spans its row with its measured height; the cards that do not fit go to pages, with a ◀ ▶ pager in the panel's header line; the page shown is the one that holds the card the user acted on last (expanded or collapsed, or the first card of a page reached with the pager), else the focus driver's, so a card just expanded stays on screen when the pages move. Pace preset at 1536 x 750 (1225 x 228): the 20 collapsed cards on one page in 3 columns at 22 px, 2 pages with the focus driver's card expanded (4 columns at 30 px, one page, at 2048 x 1100); Overview (609 x 257): 1 column, 3 pages at 20 px, 5 pages with the focus driver's card expanded (155.4 px, its tyre rows on two lines) (`node frontend/scripts/audit/panel_fit.mjs`, `docs/evidence/panel_fit.txt`; `frontend/src/__tests__/consistency.fit.test.jsx`). An expanded card is never taller than the area: only in a floating overlay near its minimum size, where it would be, its details scroll (row "Consistency expanded card" above). |
| Timing Tower columns (Pit Wall) | The column widths are shares of the 480 px timing column (476 px of design widths drawn as percentages, `table-layout: fixed`, `TimingTower.jsx` COL). The tower's text stays at the 11 px data floor at every viewport (`--font-size-data-fixed`, CHART_FONT.fixed), because its columns do not grow with the window; every cell and header fits its column at that size (`docs/evidence/tower_columns.txt`), so no value ends in an ellipsis; there is no horizontal scroll. |
| Pit Wall side column (Weather, Race Control, Ask box) | Weather and the Ask box keep their height and Race Control takes the rest, newest message first (`PitWallLayout.jsx`): at 1536 x 750 the 263 px column leaves Race Control 102 px, three message lines (`layout_fit.txt`); the quick answer is a card laid over the column (row above). |
| Driver Comparison | The six sections (gap and lap charts, sectors, top speeds, race summary, tyres) are laid in columns of at least 320 px (`COMPARE_COL_MIN_W`) and in pages that fit the pane (`utils/views/driverCompare.js` comparePages, ◀ ▶ pager): in the Overview window preset 2 pages at 1536 x 750 and 1366 x 768, 1 page at 1920 x 1080 and 2048 x 1100 (`docs/evidence/compare_fit.txt`). |
| Strategy Timeline | Driver rows at least ceil(data type + 9) px high (`StrategyTimeline.jsx` ROW_MIN_PAD); a wide, low pane lays them in up to 3 columns, a narrow one pages them (fitRows / pageOf, pager in the panel header). Pit Window window preset: all 20 drivers in 3 columns of 7 rows at 1536 x 750 and 1366 x 768; Simulator preset: 2 pages of 16 at 1536 x 750 (`docs/evidence/strategy_fit.txt`). |
| Race Pace Grid (Pit Wall centre, dock) | The cells take the panel width (`utils/views/racePaceGrid.js` paceColumns: 78 px down to 36 px, the label shortened to what the cell holds, the glyph always kept, the full time in the tooltip; below 36 px the driver columns are paged) and the rows its height (fitRows, 26 px down to 18 px); the laps that do not fit are paged: the most recent ones follow the replay, older ones a page back with ◀ (paceLapWindow). At the four target viewports the 20 driver columns fit the Pit Wall centre in 42 to 76 px cells (`docs/evidence/layout_fit.txt`). The lap pager's slot is always in the legend bar, hidden while every lap fits, so the bar is the same paged or not and the rows are fitted to the final grid (`frontend/src/__tests__/pacegrid.pager.test.jsx`). |
| Strategy views (Race Prediction, Strategy Simulator, Strategy Analysis, Cross-Race Analysis, Undercut Calculator, Sector Delta, Race Control, Strategy Engineer, Circle of Doom) | Charts read their box (`utils/views/chartBox.js` useBoxSize) and draw what fits (Sector Delta: the most recent laps its width holds; Undercut: every candidate lap as a column; the Circle of Doom scales its ring to the smaller side of the pane and drops the labels of the cars that matter least before a label would shrink below the data size); tables and lists fit their rows to the height and page the rest with ◀ ▶ (`chartBox.js` fitRows / pageOf); the Simulator splits Plan / Result / Compare into tabs; the Strategy Engineer's analysis box is capped at 40 % of its tab (`visualizations.css .strategy-console__response`), the whole answer being in the chat log. Apart from the Strategy Engineer's chat log in its Radio tab (row "Strategy assistant chat log" above), no scroll area is left in these views (`docs/evidence/overflow_inventory.txt`). |
| Track Map | d3.zoom inside a fixed viewport; no CSS scroll. |
