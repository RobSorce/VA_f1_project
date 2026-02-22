# Overlay Panel CSS Replacement

In `frontend/src/styles/dashboard.css`, find the section:

```
/* ==========================================================================
   Overlay Windows — multi-panel floating glass system
   ========================================================================== */
```

And replace everything from `.overlay-container` through `.overlay-panel__content`
with the CSS below:

```css
/* ==========================================================================
   Overlay Panel (full-screen, slides over center area)
   ========================================================================== */
.overlay-panel {
  position: absolute;
  inset: 0;
  background: rgba(12, 12, 28, 0.78);
  backdrop-filter: blur(var(--glass-blur-heavy));
  -webkit-backdrop-filter: blur(var(--glass-blur-heavy));
  z-index: 10;
  display: flex;
  flex-direction: column;
  animation: overlaySlideUp 250ms ease-out;
  overflow: hidden;
  border-radius: 20px;
}

@keyframes overlaySlideUp {
  from {
    opacity: 0;
    transform: translateY(16px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.overlay-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  background: rgba(20, 22, 40, 0.4);
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  flex-shrink: 0;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

.overlay-panel__title {
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-black);
  font-family: var(--font-display);
  color: var(--color-text-primary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.overlay-panel__close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: var(--radius-sm);
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.overlay-panel__close:hover {
  background: rgba(255, 255, 255, 0.12);
  color: var(--color-text-primary);
}

.overlay-panel__content {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
```
