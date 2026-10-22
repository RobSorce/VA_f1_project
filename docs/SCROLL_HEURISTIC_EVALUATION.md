# Scroll-Policy Heuristic Evaluation

Focused follow-up to `HEURISTIC_EVALUATION.md`. Target: the dashboard's
**scroll and viewport-fit behaviour on sub-1920 × 1080 displays**
(15-inch laptops typically run 1366 × 768 or 1440 × 900).

## Status on 2026-10-15: read this first

The evaluation below is the record of the first review. Its Tier 1 item 1
(page scroll below 1440 × 900) was applied and has since been **withdrawn**:
on a 1536 × 750 window (a 1920 × 1080 screen at 125 % scaling) it let the
Pit Wall grow to its lap table, a 1896 px page
(`docs/evidence/browser_audit_2026-10-14.md`). The dashboard is now a
fixed-viewport layout at every supported size: the page never scrolls, the
chrome rows shrink with the viewport height, every grid track is
`minmax(0, …)` or has a cell with `min-height: 0`, and the few areas that keep
an internal scroll are each justified in `docs/SCROLL_JUSTIFICATIONS.md`.
Static checks at 1536 × 750, 1366 × 768, 1920 × 1080 and 2048 × 1100:
`frontend/scripts/audit/layout_fit.mjs` and
`frontend/src/__tests__/layout.viewport.test.js`.

| ID | Original finding | Status now |
|----|------------------|------------|
| S1 | Session selector clips below the fold | The start screen keeps its own fallback scroll (`.session-screen`, justified); it is not the dashboard. |
| S2 | Dock: Settings unreachable behind a hidden horizontal scroll | Resolved: the dock never scrolls. `BottomTabBar.jsx` measures its buttons and moves the items that do not fit into the ⋯ popover (`utils/dockCapacity.js`); the fixed Layouts / ⌘K / Settings buttons are always shown, at full opacity (no faded modifier). The shortcut hints card sits above the bottom chrome (`bottom: calc(var(--chrome-bottom) + 8px)`), takes no click (`pointer-events: none`) and hides whole after 5 s, so it never covers or blocks the dock (`ShortcutHints.css`). The fixed 72 px per item quoted below is gone. |
| S3 | Overlay default sizes too big | Overlays open at 82 % of their container below 1440 × 900 and are clamped to it; the overlay layer sits between the weather bar and the bottom chrome from the same tokens (`--overlay-inset-*`). |
| S4 | Settings accordion did not scroll | Settings scrolls inside its overlay window (`.settings-tab`, justified); auto-fit is off below 1440 × 900. |
| S5 | Visualisations below a usable size | Pane sizes of every window preset at the four sizes are listed by `layout_fit.mjs` (`docs/evidence/layout_fit.txt`); the browser pass judges each view at those sizes. |
| S6 | No page-level scroll fallback | By design: a fixed-viewport dashboard. The fallback that was added for it is the regression described above and has been removed. |
| S7 | Cheatsheet on a short viewport | Three balanced columns in which a section may continue in the next column, modal up to 92 vh: the 45 shortcut rows need at most 492 px of column at 1536 x 750 and 493 px at 1366 x 768, against 604 and 620 px of room (`docs/evidence/cheatsheet_fit.txt`; re-measured on 2026-10-16, after Shift+C and the Ctrl+arrow keys were added to the cheatsheet: 42 rows needed 468 and 469 px), so no target window shows a scrollbar. With the earlier sections that never split and the 88 vh modal they did not fit at those two sizes (an estimate). The scroll stays as the fallback below 900 px of width. |
| S8 | Command palette at narrow height | Unchanged: keyboard-first result list, justified. |

Statements of the record below that are no longer true: the dashboard
header no longer reads "No-scroll tabbed design (1920 × 1080)"; the line
numbers it cites have moved; the dock capacity is no longer
`Math.floor((vw - 40 - 160) / 72)`; and the proposals end with a request for
confirmation that was answered at the time.

More of them, found on a second pass on 2026-10-15:

- Root cause: the shell no longer assumes a 1920 × 1080 canvas. It is
  exactly the viewport height, and the weather bar, the timeline and the dock
  shrink with it (`--weather-bar-height`, `--timeline-height`,
  `--bottom-tab-height` in `tokens.css`).
- S3 and S5: a floating window's minimum is 420 × 320 px (`MIN_W`, `MIN_H` in
  `OverlayPanel.jsx`), not `MIN_H = 240`. Only Settings opens as a floating
  window now: the AI and Championship views, whose 600 px default heights S3
  discusses, open as tabs of the docked workspace (`setActiveTab` in
  `useF1Store.js`).
- S4: `.settings-tab__section` no longer clips its accordion body with
  `overflow: hidden` (`dashboard.css`).
- S7: the cheatsheet modal is up to 92 vh, not 80 vh (see the status table).
- S8: the command palette modal is up to 80 vh, not 70 vh
  (`CommandPalette.css`).

## Original evaluation (record)

The design intent — stated in `dashboard.css` line 3: *"No-scroll tabbed
design (1920 × 1080)"* — is load-bearing for the whole frontend. On
smaller displays the constraint inverts from "elegant constraint" to
"content hidden with no recovery path."

## Severity scale (Nielsen, 1994)

| Score | Meaning |
|-------|---------|
| 0 | Not a usability problem at all |
| 1 | Cosmetic — fix if time permits |
| 2 | Minor — low priority |
| 3 | Major — high priority |
| 4 | Catastrophe — must fix |

---

## Root cause (one paragraph)

The layout pins `html`, `body`, `.app-container`, and `.app-body` to
`overflow: hidden` (`base.css:26, 85` and `dashboard.css:11, 90`). Every
viewport-sized element then assumes the full 1920 × 1080 canvas is
available. When the real viewport is smaller, children overflow their
parent and **are silently clipped** because no ancestor falls back to
`overflow: auto`. There is no graceful degradation — the app loses
information rather than offering a scrollbar.

On a 1366 × 768 laptop with the browser chrome (≈ 80 px) eaten, the
"usable" viewport is **≈ 1366 × 688 px**. Subtract the 44 px weather
bar, 52 px bottom dock, and 8 px dock margin, the Analyse-mode content
area collapses to ≈ **1326 × 584 px** — 54 % of the design height.

---

## Violations

### S1 — Session selector screen clips below the fold  **[severity 4 — catastrophe]**

**Where.** `SessionSelectorScreen.jsx:148` renders with
`position: fixed; inset: 0; display: flex; align-items: center`
(`dashboard.css:1327`). The `.session-screen__body` below it is a
three-column flex row: Live card (≈ 500 px tall) + Selector card
(≈ 600 px tall) + Driver grid (420 × 520 px). Stacking the brand block
(100 px) on top, total vertical demand is **≈ 700 px**.

On 1366 × 768 (≈ 688 px of usable height) the driver grid's bottom
"Select All / Clear" actions **fall off the bottom of the viewport
with no scroll available**. Worse: the "ENTER SESSION" button can
itself be below the fold. The entire product is unreachable.

**Evidence.** Tested by resizing the window to 1366 × 720. Neither the
screen nor any ancestor has a scroll fallback.

---

### S2 — Bottom dock labels eat horizontal space, Settings unreachable  **[severity 3]**

**Where.** `BottomTabBar.jsx`. Each tab is `DOCK_ITEM_WIDTH = 72 px`
(`BottomTabBar.jsx:10`). The three fixed buttons (Layouts, ⌘K,
Settings) sit after the reorderable items. Capacity is computed as
`Math.floor((vw - 40 - 160) / 72)` (`BottomTabBar.jsx:108–111`) — so
at 1366 px the capacity is **`floor(1166 / 72) = 16`** slots.

The issue is not the *count* but the *total width* after the divider:
with 8 dock items + overflow + divider + 3 fixed buttons, the nav's
measured width can exceed the `max-width: calc(100vw - 40px)` cap,
triggering horizontal scroll — and because the scrollbar is hidden
(`scrollbar-width: none`), **users have no visual cue the dock is
scrollable**. The right-most buttons (Settings) silently disappear.

We mitigated this partially in the previous fix (H8/V8.2 breakpoint
at 1200 px) by hiding fixed-button labels, but the breakpoint is too
generous — 15-inch laptops at default Chrome zoom of 100 % + browser
chrome consistently hit the overflow.

---

### S3 — Overlay panels exceed container height on 1366 × 768  **[severity 3]**

**Where.** `OverlayPanel.jsx:6–11` hard-codes default sizes:

```js
const PANEL_SIZES = {
  settings: [820, 580],
  ai: [880, 600],
  championship: [880, 600],
};
const DEFAULT_SIZE = [700, 520];
const MIN_H = 240;
```

The code then clamps to `container - 16 px` (`OverlayPanel.jsx:57–62`).
On 1366 × 768 the available container is ≈ 580–620 px tall, so:

- **Settings (580 tall)** — fits exactly, with zero breathing room.
- **AI / Championship (600 tall)** — forced clamp to ≈ 580 px, the
  panel gets 20 px squeezed out of its body.

With the timeline player expanded, the container shrinks further. The
panel tries to resize itself via the window-resize handler but the
user can still end up with a panel whose header is flush against the
weather bar and whose bottom-resize edge is under the dock.

---

### S4 — Settings accordion: internal scroll defeated by `autoFit`  **[severity 4 — "can't reach" bug the user reported]**

**Where.** `OverlayPanel.jsx:71–112` — when `autoFit=true` (used only
for Settings, per `App.jsx`), the panel's height tracks the natural
content height via `ResizeObserver`. Measure loop:

```js
const natural = inner.scrollHeight;
const target  = natural + headerH + 2;
const maxH    = Math.max(MIN_H, cr.height - EDGE_PAD * 2);
const clamped = Math.min(Math.max(MIN_H, target), maxH);
```

When the user opens the **Dock** accordion section (≈ 25 panel toggle
rows × 40 px ≈ 1000 px of content), `target` exceeds `maxH`, so the
panel snaps to `maxH` = container height. At that point, `.settings-tab`
(`dashboard.css:3828`) *does* have `overflow-y: auto`, so in principle
it should scroll.

But: the `ResizeObserver` re-measures on every internal layout change
and **keeps trying to shrink the panel back**. Sometimes it fights the
inner scrollbar. Worse, `.overlay-panel--autofit .overlay-panel__content
> :first-child` sets `height: auto; max-height: 100%`
(`dashboard.css:2407`) — this forces the settings-tab's own height to
never exceed 100 % of the panel, which means its `overflow-y: auto`
*should* engage — but the visible symptom the user reports is that the
scroll does not engage at all. Likely cause: the accordion section
body (`.settings-tab__section-body`) inherits from a parent that has
`overflow: hidden` (`dashboard.css:3842` on `.settings-tab__section`),
which clips the accordion content without ever handing it to the
scroll container.

---

### S5 — Visualisation panels below usable minimum on 1366 × 688  **[severity 3]**

**Where.** Several D3 components compute their chart area from the
wrapper's `clientHeight` (e.g. `LapTimeChart`, `TrackMap`,
`StrategyTimeline`, `PCABiplot`). The CSS minimum for most panels is
`MIN_H = 240` (`OverlayPanel.jsx:12`), but once axes, legend, title,
and padding are deducted, a 240 px-tall panel gives the chart itself
≈ 140 px — too cramped for 20-driver lap-time lines or the PCA biplot
with loadings vectors.

Users can manually resize panels larger, but on a 688 px viewport
they cannot grow beyond the container cap. The dashboard's own
analytics views become **too small to extract insight** — the very
thing the tool exists to do.

---

### S6 — No page-level scroll fallback anywhere  **[severity 3]**

**Where.** `base.css:26` sets `body { overflow: hidden; }` and
`dashboard.css:11` sets `.app-container { overflow: hidden; }`. This
is the decision that removes the user's last recovery path. Every
other scroll issue in this document is a direct consequence.

On Shneiderman's Visual Information-Seeking Mantra ("overview first,
zoom and filter, details on demand"), the `hidden` policy violates the
**"details on demand"** contract — the user cannot reach the detail
rows of Settings → Dock even by scrolling with a trackpad or wheel.

---

### S7 — ShortcutCheatsheet modal can exceed viewport  **[severity 2]**

**Where.** `.cs-modal` uses a CSS `max-height: 80vh`. On 1366 × 768
that is 614 px, and the 6-section cheatsheet with ≈ 42 shortcuts is
taller than 614 px. The modal *does* have `overflow-y: auto` on its
body (`ShortcutCheatsheet.css`), so this one is **not broken** — it
is here for completeness to show the pattern worked in at least one
place in the codebase.

---

### S8 — CommandPalette at narrow height  **[severity 2]**

**Where.** `.cp-modal` similarly uses `max-height: 70vh`. On small
screens the result list gets ≈ 400 px — acceptable for short
searches but cramped for the 40-command full list. Only minor —
palette is keyboard-first and scrolls internally.

---

## Severity summary

| ID  | Surface                             | Severity | Recoverable today? |
|-----|-------------------------------------|----------|--------------------|
| S1  | Session selector                    | **4**    | No — app unreachable |
| S2  | Bottom dock — Settings unreachable  | 3        | No — silent scroll |
| S3  | Overlay default sizes too big       | 3        | Partial — user can resize |
| S4  | Settings accordion doesn't scroll   | **4**    | No — content hidden |
| S5  | Visualisations below usable size    | 3        | Partial — resize panel |
| S6  | No body-level scroll fallback       | 3        | No — by design |
| S7  | Cheatsheet on short viewport        | 2        | Yes — already scrolls |
| S8  | Command palette at narrow height    | 2        | Yes — already scrolls |

Two catastrophes (S1, S4). The user's verbatim complaint — "can't even
reach the settings" — maps to S2 + S4.

---

## Proposed solutions — three tiers

Each tier is independently shippable. **Please confirm which tier(s)
to apply** before I touch code.

### Tier 1 — Safety net (minimum viable, ≈ 30 min)

Give the user a recovery path even when a specific surface has a bug.

1. **Drop body-level `overflow: hidden`** → replace with
   `overflow: auto` *only* at viewport widths below 1440 × 900. On the
   design-intended 1920 × 1080 the UX stays identical; on 15-inch
   laptops the user can at least scroll the page to discover anything
   pushed below the fold.
2. **Session selector scroll**: `.session-screen` → `overflow-y: auto;
   padding-block: 32px` + change `align-items: center` to
   `align-items: flex-start` when viewport height < 800 px so the
   content lays out from the top instead of clipping.
3. **Settings accordion scroll fix**: remove `overflow: hidden` from
   `.settings-tab__section` (the container that clips the expanded
   accordion body) OR add `overflow: visible` when
   `.settings-tab__section--open`. This is the single CSS line that
   fixes the reported bug.
4. **Force overlay autoFit off below 1440 × 900** so Settings opens at
   the regular max-container-height with its internal scroll engaged
   instead of "tracking content" against a too-small container.

**Outcome.** S1 and S4 resolved. S2/S3/S5 still imperfect but no
information is ever completely unreachable.

---

### Tier 2 — Responsive overlay sizing (≈ 1–2 h)

Make panels viewport-aware instead of using hard-coded 820 × 580.

5. Change `PANEL_SIZES` to be **percentages** or to derive from the
   live container: `w = min(fixed, container * 0.8)`, `h = min(fixed,
   container * 0.85)`. This stops Settings from opening at 580 px
   when the container is 580 px.
6. Set `MIN_H = 320` (from 240) and `MIN_W = 420` (from 360) so every
   panel opens at a size where its viz is usable. If the viewport is
   smaller than the minimum, the panel gracefully becomes full-screen.
7. Bump the bottom-dock breakpoint from 1200 px → **1440 px** so the
   fixed-button labels collapse earlier, reclaiming ≈ 180 px of nav
   width — closes the "Settings unreachable" scroll case (S2).
8. Add a `1366 × 768 class` helper on `html` when
   `matchMedia('(max-height: 800px) and (max-width: 1440px)').matches`,
   and use it to gate dashboard.css overrides (smaller paddings,
   shorter header, etc.) without polluting the default layout.

**Outcome.** S2, S3, S5 resolved for 15-inch laptops. Desktop 1920 ×
1080 unchanged.

---

### Tier 3 — Proper breakpoints + layout variants (≈ 4–6 h)

A first-class responsive layout. Larger change, biggest pay-off.

9. Media-query cascade: `@media (max-width: 1440px)`, `@media
   (max-height: 800px)`, `@media (max-width: 1280px)`. Each tier
   tightens paddings, shrinks the leaderboard to a compact-row mode
   ('V' cycleable), collapses the WeatherBar to an icon row, docks
   the TimelinePlayer to a permanent 28 px strip.
10. Pit Wall layout reflow: on <1440 × 900 the 3-column grid becomes
    a 2-column stacked layout, with the Race Control feed moved into
    a collapsible drawer.
11. Overlay panels become **full-screen by default** on < 1200 × 720
    (they already tile via `tileOverlay`; just change the default).
12. Panel-internal chart minimum: if `clientHeight < 320`, the chart
    renders a simplified "summary card" instead of the full D3
    visualisation, with a "Expand" button that switches to full-screen.

**Outcome.** The dashboard is usable on any display from 1280 × 720
upwards without compromising the 1920 × 1080 experience.

---

## Recommendation

**Apply Tier 1 now** — it fixes the two catastrophes, the specific
user complaint, and creates a safety net so *future* regressions on
small screens are visible (they scroll) rather than silent (clipped).

**Also apply the specific fixes from Tier 2 that address the bottom-dock
case (item 7) and the overlay sizing (items 5–6)** — these are the
remaining high-severity items and a 1-hour job.

Defer Tier 3 until the user confirms the VA report doesn't need the
app to be production-polished on arbitrary viewports. Tier 3 is a
proper responsive layout project; items there could regress the 1920
× 1080 look if not tested carefully.

---

## Summary for the user

```
Tier 1  (must-fix, ≈ 30 min):  S1 + S4 + S6 — remove body overflow
                                hidden on small screens, fix settings
                                accordion scroll, make session selector
                                scroll.
Tier 2  (should-fix, ≈ 1 h):   S2 + S3 + S5 — responsive overlay sizes,
                                earlier dock-label collapse, larger
                                panel minima.
Tier 3  (can-fix, ≈ 4–6 h):    S5 + polish — media-query cascade,
                                full-screen overlay on small viewport,
                                summary-card fallback under min size.
```

**Waiting for your confirmation** on which tiers to implement before
making changes.
