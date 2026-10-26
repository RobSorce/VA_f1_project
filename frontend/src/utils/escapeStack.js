/**
 * The transient elements open on screen (menus, popovers, dropdowns, the
 * help panel, the cheatsheet, the command bar's list), in the order they
 * opened. Escape closes the topmost one only: the global key handler
 * (hooks/useKeyboardShortcuts.js) calls closeTopEscapeLayer first, and the
 * docked layout and the windows stay. Components join with the
 * hooks/useEscapeLayer.js hook while they are open.
 */
const layers = [];

/**
 * Put an open element on top of the stack.
 *
 * @param {function(): (boolean|void)} close - closes the element; return
 *   false when it stays open (e.g. a list that went back one level)
 * @returns {function(): void} removes the element from the stack (call it
 *   when the element closes or unmounts)
 */
export function openEscapeLayer(close) {
  const layer = { close };
  layers.push(layer);
  return () => {
    const i = layers.indexOf(layer);
    if (i >= 0) layers.splice(i, 1);
  };
}

/**
 * Close the topmost open element, if any.
 *
 * @returns {boolean} true when an element took the Escape
 */
export function closeTopEscapeLayer() {
  const top = layers[layers.length - 1];
  if (!top) return false;
  const stays = top.close() === false;
  if (!stays) {
    const i = layers.indexOf(top);
    if (i >= 0) layers.splice(i, 1);
  }
  return true;
}

/** How many transient elements are open (for tests and the handler). */
export function escapeLayerCount() {
  return layers.length;
}
