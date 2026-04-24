# Heuristic-Evaluation Fixes — Implementation Report

Companion to `HEURISTIC_EVALUATION.md`. Each violation is either **fixed**,
**obviated** (the claimed defect did not exist in the current code),
**partially addressed**, or **deferred** (out of scope — feature-class
work). Covers all 25 identified violations.

## Summary table

| # | ID   | Severity | Status            | Notes |
|---|------|----------|-------------------|-------|
| 1 | V1.1 | 3 | **Fixed**              | Global backend-down toast with Retry action |
| 2 | V1.2 | 3 | **Fixed**              | LSTM confidence chip + 5-lap spread indicator |
| 3 | V1.3 | 2 | **Fixed**              | 3 px dock peek when auto-hidden |
| 4 | V1.4 | 2 | **Fixed**              | `insufficient_data` flag + "LOW DATA" chip |
| 5 | V2.1 | 2 | **Obviated**           | No user-visible "Docked Layout" strings exist |
| 6 | V2.2 | 2 | **Fixed**              | Raw + fuel-corrected slope both shown |
| 7 | V3.1 | 2 | **Fixed**              | Remove-from-dock now emits 6 s Undo toast |
| 8 | V3.2 | 2 | **Fixed**              | Dock-reset emits Undo toast |
| 9 | V4.1 | 2 | **Fixed**              | Divider + `--fixed` styling between reorderable and system buttons |
| 10| V4.2 | 2 | **Deferred**           | Dropping letter duplicates would break muscle memory; documented instead |
| 11| V4.3 | 1 | **Obviated**           | Hover ✕ badge is dead CSS, not rendered |
| 12| V5.1 | 3 | **Obviated + Fixed**   | No live badge to misclick; undo toast added for the context-menu remove |
| 13| V5.2 | 2 | **Fixed**              | Session-switch confirm dialog with list of state about to be lost |
| 14| V5.3 | 2 | **Fixed**              | Dock-reset moved to `Ctrl/Cmd+Alt+D` (off Chrome's chord) |
| 15| V6.1 | 2 | **Fixed**              | Keyboard-hint kbd is now always faintly visible on dock tabs |
| 16| V6.2 | 1 | **Deferred**           | Tyre compound single-letter glyphs — low severity, per-chart work |
| 17| V6.3 | 2 | **Fixed**              | Monte-Carlo battle badge has rich 4-line tooltip explaining semantics |
| 18| V7.1 | 1 | **Deferred**           | "Save layout as…" — new feature, out of scope |
| 19| V8.1 | 2 | **Deferred**           | Per-chart tooltip disclosure — per-chart work |
| 20| V8.2 | 1 | **Fixed**              | Fixed-button labels collapse below 1200 px |
| 21| V9.1 | 3 | **Fixed**              | `is_heuristic` / `model_used` in LSTM response + HEURISTIC chip |
| 22| V9.2 | 3 | **Fixed**              | Axios interceptor + backend-down toast with Retry; RetryPanel component |
| 23| V9.3 | 2 | **Fixed**              | MOCK chip on Gemini replies when `is_mock=true` |
| 24| V10.1| 2 | **Fixed**              | (?) info button in every overlay panel header with per-panel summary + doc link |
| 25| V10.2| 2 | **Deferred**           | First-open tour — feature-class work, one screenful of product onboarding |

**Resolved: 17.  Obviated: 3.  Deferred: 5.** All severity-3 issues are
resolved.

---

## Key infrastructure added

- **Global toast system** (`store.toasts` + `<ToastStack>`). Four kinds:
  `info`, `warn`, `error`, `undo`. Timed auto-dismiss, optional action
  button, all rendered as liquid-glass capsules that match the dock.
- **Backend-health interceptor** in `apiClient.js`. Network errors and
  5xx responses flip `backendHealthy` to false and push a persistent
  `backend-down` toast. Any subsequent successful fetch auto-dismisses
  it and shows a "Backend reconnected" confirmation.
- **RetryPanel** (`components/ui/RetryPanel.jsx`). Drop-in inline
  fetch-failure UI; accepts a `onRetry` async callback and shows a
  spinner while running.
- **Per-panel help registry** in `App.jsx:OVERLAY_TABS`. Each entry has
  a `helpText` string; `TireDegradation`, `Analytics`, and
  `RacePrediction` additionally link to their methodology docs.

---

## Backend changes

### `backend/api/routers/predictions.py`

- `/predict/lstm` response now includes:
  - `model_used`: `"lstm"` / `"fallback_mean"` / `"heuristic"`.
  - `is_heuristic`: boolean. True for every non-LSTM path.
- `/predict/degradation` response now includes:
  - `slope_fuel_corrected`: raw slope + 0.030 s/lap fuel correction.
  - `fuel_correction_per_lap`: 0.030 (documented constant).

### `backend/model/predict.py`

- Both the PyTorch-path return and both heuristic-path returns now stamp
  `model_used` + `is_heuristic`.

### `backend/api/routers/analytics.py`

- `/analytics/consistency/{y}/{r}` response now includes:
  - `race_length`: highest lap number seen.
  - `min_laps_threshold`: 75 % of race length.
  - Per driver: `lap_count`, `insufficient_data` (bool).

Demonstrated on Brazil 2024 R21: HUL (24 laps) flagged
`insufficient=True` against threshold 51.

---

## Frontend changes (map of files touched)

| File | Violations addressed |
|------|----------------------|
| `src/store/useF1Store.js` | Toast state + actions, health reporters, undo-wired remove/reset (V1.1, V3.1, V3.2, V5.1) |
| `src/utils/apiClient.js` | Axios interceptor + `setHealthReporter` (V1.1, V9.2) |
| `src/components/ui/ToastStack.jsx` | **New** — global toast rendering (V1.1, V3.1, V3.2) |
| `src/components/ui/RetryPanel.jsx` | **New** — inline fetch-failure UI (V9.2) |
| `src/components/ui/BottomTabBar.jsx` | `--fixed` subclass + divider (V4.1) |
| `src/components/ui/SessionMenu.jsx` | Session-switch confirm (V5.2) |
| `src/components/visualizations/ConsistencyPanel.jsx` | LOW DATA flag + grey-out (V1.4) |
| `src/components/visualizations/RacePredictionPanel.jsx` | LSTM / HEURISTIC chip + spread pill (V1.2, V9.1) |
| `src/components/visualizations/TireDegradation.jsx` | Dual raw/fuel-corrected annotation (V2.2) |
| `src/components/visualizations/GeminiAssistant.jsx` | MOCK chip on AI bubbles (V9.3) |
| `src/components/visualizations/Leaderboard.jsx` | Rich Monte-Carlo battle tooltip (V6.3) |
| `src/components/layout/OverlayPanel.jsx` | `helpText`/`helpHref` props + (?) button (V10.1) |
| `src/components/ShortcutCheatsheet/ShortcutCheatsheet.jsx` | `Ctrl+Alt+D` cheatsheet update (V5.3) |
| `src/hooks/useKeyboardShortcuts.js` | Move reset to `Ctrl+Alt+D` (V5.3) |
| `src/App.jsx` | Wire ToastStack + per-panel helpText registry (V1.1, V10.1) |
| `src/styles/dashboard.css` | Toast stack, peek, divider, LOW DATA chip, RetryPanel, help button, tab-kbd opacity, 1200 px breakpoint (V1.3, V1.4, V4.1, V6.1, V8.2, V9.2, V10.1) |
| `src/styles/visualizations.css` | MOCK chip style (V9.3) |

---

## Violations marked "Obviated" — detail

**V2.1** ("Docked Layout" is IDE jargon). The heuristic evaluation
described this as a user-facing string, but after `grep` across the
codebase the only uses of "Docked Layout" / "Floating Overlays" are in
code comments and module names. No button, label, or tooltip shows
those terms to the user. The internal `DockedLayout.jsx` name is
appropriate for developers.

**V4.3** ("Close ✕ is overloaded"). The `.bottom-tab-bar__remove-badge`
CSS exists but is not rendered by any component — only the
right-click context menu removes dock items. Treated as dead CSS; no
behavioural fix was needed. If the badge is re-introduced in future,
use a minus-sign glyph per the original recommendation.

**V5.1** ("Dock-item remove badge fires on single click"). Same root
cause as V4.3 — the badge is not rendered. The context-menu remove
path, which *is* used, now emits an Undo toast regardless, so the
stated mitigation is in place even for the code path that actually
runs today.

---

## Violations marked "Deferred" — detail

**V4.2** — Duplicate shortcuts (letter + number for the same panel).
Dropping the letter aliases would invalidate every muscle-memory path
users have built with the current mapping. The cheatsheet already
documents both forms. A safer future direction is to mark letters as
"secondary" in the cheatsheet; rejected in this pass as churn for
little usability gain.

**V6.2** — Tyre-compound single-letter glyphs. Per the severity-1
rating; already understandable to F1 viewers. A `Legend` component
exists that can be threaded into `TyresTabContent` / `StrategyTimeline`
later.

**V7.1** — "Save layout as…". Feature scope; would need a storage
schema for layout trees + per-panel settings and a picker UI. Noted
as a post-VA enhancement.

**V8.1** — Tooltip disclosure on advanced charts. Per-chart work
across 8+ D3 visualisations; best handled in a dedicated pass.

**V10.2** — First-open tour for PCA / t-SNE / strategy analysis. One
screenful of product onboarding deserves a discrete design effort;
not addressed in this fix pass.

---

## Verification checklist (what to click in the running app)

1. **Backend down banner (V1.1):** stop the backend (`lsof -ti:8000 |
   xargs kill`) then press → to advance a lap. Red toast appears in
   the top-right within 1-2 s, Retry button restarts the health probe.
2. **Dock peek (V1.3):** press `Shift+H`; the dock slides away but a
   3 px glass sliver remains visible along the bottom edge.
3. **LOW DATA chip (V1.4):** load Brazil 2024 → open Consistency. HUL's
   card shows an amber "LOW DATA" chip and is de-saturated.
4. **Fuel-corrected slope (V2.2):** load Monza 2024 → brush L17-L53 →
   open Tyre Degradation. Each stint line shows `-0.008 s/lap (raw)`
   above `+0.022 s/lap (tyre only)`.
5. **Undo remove (V3.1):** right-click a dock item → Remove. An
   amber-bordered toast appears with an Undo button.
6. **Undo dock reset (V3.2):** Cmd/Ctrl+Alt+D. Same Undo toast.
7. **Divider (V4.1):** the bottom dock now has a visible vertical
   hairline between the last reorderable tab and the Layouts button.
8. **Session-switch confirm (V5.2):** open a few panels, brush laps,
   then load a different race. Confirm dialog lists the state being
   discarded.
9. **LSTM HEURISTIC chip (V9.1):** rename `backend/model/saved/` to
   force fallback; Race Prediction panel shows amber HEURISTIC chip.
10. **Gemini MOCK chip (V9.3):** with no `GOOGLE_API_KEY` env var,
    Gemini replies show an amber MOCK chip next to "Engineer".
11. **Panel help button (V10.1):** hover the (?) icon in any overlay
    header — tooltip appears. Click to open the linked doc (Tyre
    Degradation, Analytics, Race Prediction).
12. **Monte Carlo tooltip (V6.3):** hover the ⇅ XX % badge in
    the Leaderboard — 4-line explanation tooltip.
