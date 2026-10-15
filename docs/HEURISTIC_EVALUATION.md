# Heuristic Evaluation — F1 Race Strategy Dashboard

Nielsen's ten usability heuristics applied to the current frontend
(branch `v4`, commit state `324bb9f` + live edits). Conducted by
reading every UI component, the keyboard-shortcut hook, the Zustand
store, and running the app against several cached sessions.

## Severity scale (Nielsen, 1994)

| Score | Meaning |
|-------|---------|
| 0 | Not a usability problem at all |
| 1 | Cosmetic — fix if time permits |
| 2 | Minor — low priority |
| 3 | Major — high priority |
| 4 | Catastrophe — must fix |

## Summary table

| # | Heuristic                            | Worst severity | Count |
|---|--------------------------------------|----------------|-------|
| 1 | Visibility of system status          | **3**          | 4     |
| 2 | Match between system and real world  | 2              | 2     |
| 3 | User control and freedom             | 2              | 2     |
| 4 | Consistency and standards            | 2              | 3     |
| 5 | Error prevention                     | **3**          | 3     |
| 6 | Recognition rather than recall       | 2              | 3     |
| 7 | Flexibility and efficiency of use    | 1              | 1     |
| 8 | Aesthetic and minimalist design      | 2              | 2     |
| 9 | Recognize, diagnose, recover errors  | **3**          | 3     |
| 10| Help and documentation               | 2              | 2     |

**Total violations: 25.** No catastrophes, but four heuristics carry
major (severity-3) issues that should be prioritised.

---

## H1 — Visibility of system status

Critique: the app communicates session-loading state clearly (spinner on
`ENTER SESSION`, live pulse indicator, LSTM prediction pill) but has
silent failure modes on subsystems the user cannot inspect.

### V1.1 — Backend-down has no global banner **[severity 3]**

Store sets `error: e.message` on fetch failures
(`useF1Store.js:1087`, etc.), but most panels read their own slice and
simply render empty. If the FastAPI server dies mid-session the user
sees the track-map freeze, lap-chart stop updating, and the LSTM
returning stale values — with no banner telling them the backend is
offline.

**Evidence:** kill the backend, switch laps with `→` — no feedback.

**Fix:** render a top-of-screen toast whenever any store fetch has
failed within the last 10 s. Auto-recover when the next fetch succeeds.

### V1.2 — LSTM confidence is not surfaced **[severity 3]**

From `docs/INSIGHTS_BRAZIL_2024.md`: LSTM MAE goes from 0.74 s (Monza)
to 2.50 s (Brazil). The prediction panel paints the same-looking
5-lap pill in both cases. A strategist cannot tell that the Brazil
prediction is 3× less trustworthy.

**Fix:** compute rolling MAE from the last completed lap vs the model's
previous prediction for that lap; display it next to each forecast as
a ±σ band or a colour-graded confidence pip.

### V1.3 — Auto-hide dock with no "it is hidden" affordance **[severity 2]**

`BottomTabBar.jsx:141` — when `showDashboard=false`, the dock
translates off-screen and waits for mouse-in-bottom-12px to reveal.
The 12 px hover zone is invisible. A user who hits `Shift+H`
accidentally sees the dock disappear and has no cursor signal to
recover it.

**Fix:** render a 4 px peek of the dock (or a thin line) so users
discover the reveal zone by proximity, not luck.

### V1.4 — Consistency σ ranks DNFs / low-lap-count drivers as P1 **[severity 2]**

Per `INSIGHTS_BRAZIL_2024.md`: at São Paulo 2024 HUL ranked σ-P1 with
σ = 3.4 s because he DNF'd early (small sample). No minimum-lap
filter is enforced. The user therefore cannot tell whether the
ranking represents a real performance or a statistical artefact.

**Fix:** grey out (or drop) drivers with < 75 % of race-lap count, and
show `n laps` next to σ in the ranking.

---

## H2 — Match between the system and the real world

Critique: vocabulary is strong (Pit Wall, Stint, Compound, SC / VSC,
PB / SB, undercut, overcut), tyre / team / country colours match F1
TV broadcast conventions. Two subtle mismatches remain.

### V2.1 — "Docked Layout" is IDE jargon, not pit-wall language **[severity 2]**

The UI uses "Docked Layout" / "Floating Overlays" / "Pit Wall" as
three modes. A race strategist has never heard of "floating overlays"
— the metaphor is JetBrains / VS Code, not motorsport.

**Fix:** rename to "Multi-panel view" / "Single panel" / "Pit wall
timing" (or equivalent) — terms the target persona uses.

### V2.2 — Degradation slope sign is counter-intuitive **[severity 2]**

`TireDegradation` shows raw slope (ms/lap). A *negative* slope means
"getting faster" = good, but the colour palette commonly paints
negative-delta cells red (bad). At Monza (`INSIGHTS_MONZA_2024.md`)
every Hard stint returns a negative slope because fuel burn dominates.
Users who read "negative = bad" will mis-identify the best-tyre
managers as the worst.

**Fix:** display two columns — *raw* slope and *fuel-corrected* slope
— or label the sign explicitly ("-8 ms/lap  ← improving").

---

## H3 — User control and freedom

Critique: Escape closes everything (cheatsheet → overlays → blur),
drag-and-drop reorder is undoable via the inverse drag, dock items
have a right-click context menu with Remove / Pin / Move. Two
minor gaps:

### V3.1 — No "undo last dock removal" **[severity 2]**

Hovering a dock item shows a small ✕ badge; a single click removes it
permanently (`BottomTabBar.jsx` hover-reveal). Recovery path: open
Settings → Dock accordion → toggle the panel back in. Not obvious,
and a mid-race mis-click is frustrating.

**Fix:** toast "Removed X — Undo" with a 6 s window that pushes the
item back into its previous index.

### V3.2 — Cmd/Ctrl+Shift+D resets dock with no confirm **[severity 2]**

`useKeyboardShortcuts.js:20–25`. Settings has a confirm-to-apply
button for the same action, but the keyboard path bypasses it.

**Fix:** use the same confirm flow on the keyboard shortcut, or emit a
"Dock reset — Undo" toast.

---

## H4 — Consistency and standards

### V4.1 — "Settings" is fixed outside the dock but uses the same `active` styling **[severity 2]**

`BottomTabBar.jsx:322–335` — the gear button is a normal dock tab
visually but is not in the `dockItems` array, not reorderable, not
removable. Users who drag-to-reorder learn "all bar items can move" —
but Settings cannot.

**Fix:** give the Settings + Command-palette + Layouts buttons a
separate visual cluster (e.g. a subtle divider, slightly different
opacity), matching what the code already treats as distinct.

### V4.2 — Duplicate shortcuts across mnemonics and number keys **[severity 2]**

Cheatsheet and `useKeyboardShortcuts.js` both define e.g.:

- `2` → Tyres, `T` → Tyres
- `3` → Strategy, `S` → Strategy
- `6` → Analytics, `A` → Analytics
- `5` → Prediction, `Shift+P` → Prediction (different: Shift+P also *runs* the model)

Users who learn the number row will later be confused when they
discover letter shortcuts that do *almost* the same thing
(`Shift+P` has a side effect; plain `5` does not).

**Fix:** either drop the letter duplicates, or document "letter =
shortcut+action" consistently.

### V4.3 — Close "✕" is overloaded **[severity 1]**

Overlay panels use ✕ to close; dock-item hover badge also uses ✕, but
the latter *removes from dock* (not just closes the view). Same icon,
two destructively-different operations.

**Fix:** use a different glyph for "remove from dock" (minus sign, or
pin-off icon).

---

## H5 — Error prevention

### V5.1 — Dock-item remove badge fires on single click **[severity 3]**

`.bottom-tab-bar__remove-badge` is positioned at −3 px top/right on a
12 px disc. Hover reveals it; single click removes. Users attempting
to *click the tab* whose cursor drifts up-right by 10–12 px will
silently remove the tab instead of activating it — a mis-click pattern
well documented in UI research for small destructive controls near
click targets.

**Fix:** require a two-step (right-click menu → Remove) or add a brief
undo toast as in V3.1.

### V5.2 — Switching session mid-analysis drops unsaved state silently **[severity 2]**

SessionMenu swaps the entire session. Brush selections, focus driver,
selected projection points (then t-SNE, now the PCA biplot's), open overlays — all reset with no warning.

**Fix:** show "Switch session — your current analysis (N overlays,
lap-range brush) will close. Continue?" confirm.

### V5.3 — `Cmd/Ctrl+Shift+D` collides with Chrome bookmarks **[severity 2]**

Many browsers bind this to "Bookmark all tabs". In Chrome the dialog
pops *and* the dock resets — we `preventDefault` inside the hook, but
on some platforms the browser hotkey fires first.

**Fix:** move the reset to a less-contested chord (e.g. `Cmd+Alt+D`).

---

## H6 — Recognition rather than recall

Critique: icons + labels on every dock item, keyboard hint overlays
(`ShortcutHints`), `?` cheatsheet. Three remaining recall burdens:

### V6.1 — 42 keyboard shortcuts with overlapping letters **[severity 2]**

Counted in `useKeyboardShortcuts.js`. Many single-letter chords
(A / T / S / M / V / L / D / G / C / F / R / H). A new user has to
consult the cheatsheet every session for weeks.

**Fix:** print the primary letter on the dock tab (`kbd` already
exists but only on hover, tied to the *hint* field) so it is visible
continuously when `Shift+H` is pressed — that would cut learning time
materially.

### V6.2 — Tyre-compound one-letter glyphs (S/M/H/I/W) **[severity 1]**

In `LapTimeChart`, `StrategyTimeline`, `TireSilhouette` the compound
is a single coloured letter. Soft/Hard is well-known to F1 fans but
Intermediate (`I`) and Wet (`W`) overlap with nothing else.

**Fix:** tooltip on hover, or a persistent mini-legend at the top of
the `TyresTabContent`. The `Legend` component already exists.

### V6.3 — Monte-Carlo "⇅ XX %" badge has no in-place affordance **[severity 2]**

Leaderboard draws a coloured `⇅ 35 %` next to a driver. Meaning:
"probability of position swap with the driver ahead/behind in the
next lap, Monte-Carlo N=100". Users must remember that.

**Fix:** add a persistent legend row at the top of the Leaderboard
with a sample badge, or use the existing `title` attribute for a
richer tooltip ("35 % chance of an overtake in the next lap, based on
100 Monte-Carlo race simulations").

---

## H7 — Flexibility and efficiency of use

Critique: this is the dashboard's strongest heuristic. Command palette
(`Cmd/Ctrl+K` fuzzy search over 40+ commands), customizable dock,
five layout presets + custom `LayoutBuilder`, keyboard-driven replay
control, auto-hide dock for full-screen analysis. Only a minor gap:

### V7.1 — No saved user profiles / views **[severity 1]**

Dock is persisted to `localStorage`, but docked-layout trees and
per-panel state (brushed lap ranges, zoom, filter settings) are not.
A user who builds the perfect "qualifying-analysis layout" must
rebuild it every session.

**Fix:** add "Save layout as…" / "Load layout…" to the Layouts
popover, storing full tree + per-panel settings in localStorage.

---

## H8 — Aesthetic and minimalist design

Critique: the iOS/macOS liquid-glass dock (recently refined),
broadcast-TV Leaderboard, Formula1 typography, and careful dark-theme
tokens all support a minimalist aesthetic. Two concerns:

### V8.1 — Panel tooltips expose every internal field **[severity 2]**

Several D3 panels (e.g. `LapTimeChart`, `TrackMap`, `PCABiplot`)
render 8–12-field tooltips on hover. Strategists need 3–4 numbers max
at a glance.

**Fix:** promote 3–4 key fields to a primary row (driver, lap time,
compound/tyre life), collapse the rest behind a "…" disclosure.

### V8.2 — Bottom dock + Layouts + Settings + ⋯ crowd below 1440 px **[severity 1]**

Capacity calculation in `BottomTabBar.jsx:106` reduces to `⋯` early,
but the three fixed buttons (Layouts / Cmd+K / Settings) always stay
even when they overflow their own shelf.

**Fix:** collapse Layouts and Settings into the ⋯ overflow when
viewport < 1200 px.

---

## H9 — Help users recognize, diagnose, recover from errors

### V9.1 — Silent LSTM heuristic fallback **[severity 3]**

`backend/model/predict.py:75–77` logs "No trained model found. Using
heuristic prediction." to the server console only. The UI continues
to display the answer as if it came from the model. A strategist
acting on a heuristic answer thinking it is LSTM is making decisions
with 2–3× higher error.

**Fix:** `/api/predict/lstm` already returns model metadata; surface
an `is_heuristic=true` flag in the response (parallel to
`is_mock` already added to the Gemini router) and render a "heuristic
fallback" chip in the prediction pill.

### V9.2 — Fetch errors have no retry **[severity 3]**

Store sets `error: e.message` and stops. There is no "Retry" button
on panels that consume the failed endpoint; the user must reload.

**Fix:** panels with a failed dependency render a "Couldn't fetch —
Retry" inline action.

### V9.3 — Mock Gemini responses marked only via text prefix **[severity 2]**

Recent commit added `is_mock` to the Gemini response, but the UI is
not yet displaying this flag prominently (we added a note in
mock-path user-facing text, but not a visual chip).

**Fix:** amber "MOCK" badge on every Gemini bubble when
`is_mock === true`.

---

## H10 — Help and documentation

### V10.1 — Rich `docs/` folder is not linked from the app **[severity 2]**

`docs/` contains `PCA_METHODOLOGY.md`, `DEGRADATION_METHODOLOGY.md`,
`MASTER_LEDGER.md`, `INSIGHTS_*.md`, `SHORTCUTS.md` — all
high-quality. The app's only in-product help is `?` (keyboard
cheatsheet). A user who wants to understand what "PCA loadings vector
length" means has no path to the doc.

**Fix:** add a `(i)` info button in each analytical panel's header
that opens the relevant docs in an overlay, or links to the hosted
GitHub page.

### V10.2 — Tooltips on advanced visualisations are thin **[severity 2]**

PCA biplot, t-SNE scatter (since removed), strategy-analysis panel — advanced charts
with no onboarding on the first view. The axis labels
("PC1 · 42 % var") are correct but assume the reader knows what
principal-component analysis is.

**Fix:** first-open tour (one screenful) explaining how to read the
biplot: loadings are feature vectors, points are (driver, race), lasso
selects a subset that triggers a Cohen's-d analysis panel.

---

## Prioritised fix list (top 7)

Ranked by severity × frequency of encounter:

1. **V1.1** — Backend-down banner. *(Affects every panel on failure)*
2. **V5.1** — Dock ✕ mis-click removes panel silently.
3. **V9.1** — LSTM heuristic fallback is invisible.
4. **V9.2** — No retry on failed fetch.
5. **V1.2** — LSTM prediction confidence / MAE not shown.
6. **V1.4** — Consistency σ does not filter DNFs.
7. **V2.2** — Negative-slope sign convention in the degradation panel.

Addressing these seven would lift the dashboard from "research-grade"
to "deployable pit-wall tool."

---

## Positive findings (worth keeping)

Heuristic evaluations are usually a list of complaints; these are
genuine strengths we should *not* regress:

- Bidirectional coordination: brush on lap-time chart → degradation
  re-fits automatically; lasso on PCA → strategy-analysis panel fills.
  This is exactly the Shneiderman "overview-zoom-filter-details" loop.
- Command palette with fuzzy search + every command reachable by
  both keyboard and mouse — textbook dual-interface design.
- Shortcut hints overlay (`H`) teaches bindings without forcing the
  user to memorise them.
- The docked layout's `cleanupTree()` auto-merges empty panes — an
  invisible correctness guarantee that prevents broken states.

These represent a high ceiling of design quality that makes the
violations above worth fixing rather than worth tolerating.
