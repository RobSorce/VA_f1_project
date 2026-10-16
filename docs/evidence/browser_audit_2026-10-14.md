# V13 visual audit — first pass (2026-10-14, browser, Monza 2024 R16, lap 1, Pit Wall layout)

The primary target screen: 1920×1080 at 125% → 1536×864 CSS px; maximised browser ≈ 1536×750 viewport (devicePixelRatio 1.25).

## 1. Why the app is only usable after zooming out (root cause, measured)

- At 1920×1080: `.app-container` height 1080, `.app-body` 936, page height 1080 → fits.
- At 1536×750: page height **1896 px** (2.5 screens). Cause: `frontend/src/styles/dashboard.css:18` and `base.css:39`
  `@media (max-width: 1440px), (max-height: 900px)` switch the app to page-scroll mode
  (`.app-container { height: auto; overflow: visible }`, body `overflow: auto`). Every viewport lower than 900 px
  (every 15" laptop at 125–150%) falls in it. The Pit Wall centre grid row then grows to its content:
  the lap table (`table` 1442×1409 px, 53 rows) makes row 2 = 1440 px, the bottom row starts at y = 1528.
- The left Timing Tower column is 1746 px tall for the same reason.
- Fix direction: keep the fixed-viewport dashboard (100vh, no page scroll) down to at least 1280×650;
  grid rows `minmax(0, 1fr)`; long tables scroll inside their panel (justified in SCROLL_JUSTIFICATIONS.md, V5) or
  compress rows; type and spacing scale with `clamp()` on viewport height; check every layout preset and the dock.

## 2. Text contrast (WCAG 2.1: 4.5:1 normal text, 3:1 large/bold ≥ 14 px), measured on visible text at 1920×1080

540 text elements checked. Failing groups (ratio, count, font size, colour on background, samples):
- **Driver badges: white text on light team colours** (Pit Wall / Timing Tower numbers and codes):
  RUS on #27F4D2 1.40:1, BOT on #52E252 1.70, ALB on #64C4FF 1.93, HUL on #B6BABD 1.95, GAS on #FF87BC 2.22,
  NOR/PIA on #FF8000 2.52, RIC/TSU on #6692FF 2.95, ALO/STR on #229971 3.58 → choose black or white text per team
  colour by contrast (one helper in utils/colors.js), applied everywhere badges are drawn (HTML and SVG).
- Shortcut hints and keycaps almost invisible: `.tab-kbd` #2E2E2E on #222 1.17:1 (8 px), `.shortcut-hint-key`
  #333 on #222 1.26 (10 px), `.shortcut-hint-label` #202020 on #141414 1.13 (10 px), `.search-bar__kbd` 2.77.
- Secondary labels just under 4.5 and tiny: bottom tab labels 4.19 (8 px) and 3.21 (8 px), weather pill labels 4.26
  (9 px), race details 4.48 (10 px), panel controls SPD/THR/BRK 3.82 (10 px), compass E/S/W 4.46 (8 px),
  layout preset label "LAYOUT" 2.21 (8 px), "Custom" 3.59.
- Red text on dark red: lap counter "LAP / 53" 3.59 (11 px), session badge "R" 3.6 (9 px).

## 3. Text size

- **111 visible text elements below 10 px** at 1920×1080 (8–9 px: tab labels, keycaps, weather labels, compass,
  axis ticks). At that screen's 125 % scaling these are 10–11 device px. Target: data labels and axis ticks ≥ 11 px,
  secondary UI ≥ 10 px, at every supported viewport.

## 4. Still to check (Phase 9 / V13 + browser pass)

- Every layout preset and every dock panel at 1536×750, 1366×768, 1920×1080, 2048×1100: nothing clipped, no page
  scroll, no horizontal scroll inside charts except justified ones.
- SVG marks: team-colour lines and dots on the dark background (≥ 3:1), dark team colours (e.g. Williams/Alpine blues).
- Colour-vision deficiency (protanopia, deuteranopia, tritanopia) for every categorical/diverging encoding (V1–V3):
  compounds keep a letter, timing purple/green keep a glyph, diverging scales blue/orange with sign.
- Teammates: identical colours today (V3).
