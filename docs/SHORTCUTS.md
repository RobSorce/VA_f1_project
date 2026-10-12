# Keyboard Shortcuts Reference

All shortcuts are defined in three synchronized sources:
- `frontend/src/hooks/useKeyboardShortcuts.js` (live handler)
- `frontend/src/components/CommandPalette/commandRegistry.js` (Cmd+K palette)
- `frontend/src/components/ShortcutCheatsheet/ShortcutCheatsheet.jsx` (? overlay)

## Global (always active)

| Key | Action | Notes |
|-----|--------|-------|
| `Cmd/Ctrl+K` | Open Command Palette | Works even with modifier keys |
| `?` | Toggle shortcut cheatsheet | Not in input fields |
| `Esc` | Close cheatsheet / Close overlays / Blur input | Cascading priority |

## Number Keys (Panel Navigation)

| Key | Tab ID | Panel | Status |
|-----|--------|-------|--------|
| `1` | — | Close all overlays (return to Charts) | Active |
| `2` | `laptimes` | Lap Times | Active |
| `3` | `sectors` | Sectors | Active |
| `4` | `tyres` | Tyres | Active |
| `5` | `speed` | Speed Rankings | Active |
| `6` | `consistency` | Consistency | Active |
| `7` | `prediction` | Prediction | Active |
| `8` | `ai` | AI Assistant | Active |
| `9` | `compare` | Driver Compare | Active |
| `0` | `analytics` | Analytics (PCA) | Active |

## Letter Shortcuts

| Key | Action | Tab/Effect | Status |
|-----|--------|-----------|--------|
| `P` | Toggle Pit Wall / Analysis | `pitwall` <-> `charts` | Active |
| `S` | Strategy Timeline | `strategy` | Active |
| `T` | Tyres (Degradation) | `tyres` | Active |
| `A` | Analytics (PCA) | `analytics` | Active |
| `M` | Strategy Simulator | `simulator` | Active |
| `G` | Toggle Gemini AI panel | Dispatches `toggle-gemini-panel` event | Active |
| `D` | Open driver selector | Opens command palette with driver filter | Active |
| `F` | Focus/unfocus highlighted driver | Toggles `focusDriver` | Active |
| `C` | Toggle compare mode | `toggleCompareMode` | Active |
| `L` | Toggle leaderboard sidebar | `toggleLeaderboard` | Active |
| `V` | Cycle leaderboard column mode | `cycleLeaderboardColumn` | Active |
| `H` | Toggle shortcut hints | `toggleShortcutHints` | Active |
| `W` | Close last tab/window | `closeLastTab` | Active |
| `X` | Close all windows / exit layout | `closeAllOverlays` | Active |
| `R` | Rotate track clockwise | `rotateTrackCW` | Active |

## Shift Combinations

| Key | Action | Status |
|-----|--------|--------|
| `Shift+P` | Run LSTM prediction + open Prediction view | Active |
| `Shift+R` | Rotate track counter-clockwise | Active |
| `Shift+S` | Toggle sectors on track map | Active |
| `Shift+D` | Toggle DRS zones on track map | Active |
| `Shift+H` | Toggle bottom bar auto-hide | Active |
| `Shift+G` | Driver comparison (requires 2 selected drivers) | Active |
| `Shift+C` | Championship tab | Active |

## Ctrl Combinations

| Key | Action | Status |
|-----|--------|--------|
| `Ctrl+Arrow Left` | Tile active overlay left | Active (overlay mode only) |
| `Ctrl+Arrow Right` | Tile active overlay right | Active (overlay mode only) |
| `Ctrl+Arrow Up` | Maximize active overlay | Active (overlay mode only) |
| `Ctrl+Arrow Down` | Restore/clear tile | Active (overlay mode only) |
| `Ctrl+G` | Cycle layout arrangements | Active |

## Replay Controls

| Key | Action | Status |
|-----|--------|--------|
| `Space` | Play / Pause replay | Active |
| `Arrow Left` | Previous lap | Active |
| `Arrow Right` | Next lap | Active |
| `Home` | Jump to first lap | Active |
| `End` | Jump to last lap | Active |
| `<` | Slower playback (0.25x min) | Active |
| `>` | Faster playback (8x max) | Active |

## Notes

- Shortcuts are disabled when typing in input/textarea/select fields.
- When the cheatsheet is open, only `Esc` is active.
- When the command palette is open, keys are handled by the palette.
- `Ctrl+Arrow` tiling only works in floating overlay mode, not in docked layout mode.
- Playback speeds: 0.25x, 0.5x, 1x, 2x, 4x, 8x.
