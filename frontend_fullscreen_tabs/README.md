# Full-Screen Tabs Variant

This folder contains the files that differ from the main `frontend/src/` to provide
full-screen overlay tabs instead of the multi-window floating panels.

## How to switch

Copy these files over the corresponding ones in `frontend/src/`:

```bash
cp -r frontend_fullscreen_tabs/src/* frontend/src/
```

## Files included

| File | Description |
|------|-------------|
| `src/App.jsx` | Single overlay based on `activeTab` |
| `src/store/useF1Store.js` | `activeTab` as single string, no `openOverlays` |
| `src/components/layout/OverlayPanel.jsx` | Full-screen overlay with close button only |
| `src/components/ui/BottomTabBar.jsx` | Single active tab highlight |
| `src/styles/dashboard.css` | Full-screen `.overlay-panel` with `inset: 0` |

## To revert back to multi-window

Just restore the files from git or copy back from `frontend/src/`.
