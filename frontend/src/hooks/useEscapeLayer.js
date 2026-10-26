import { useEffect, useRef } from 'react';
import { openEscapeLayer } from '../utils/escapeStack';

/**
 * While `open`, the component is a transient element that Escape closes
 * (utils/escapeStack.js): the one opened last closes first, and nothing
 * else does. Replaces a component's own Escape listener.
 *
 * @param {boolean} open - the element is on screen
 * @param {function(): (boolean|void)} onClose - closes it; return false when
 *   it stays open (it went back one level)
 */
export function useEscapeLayer(open, onClose) {
  const latest = useRef(onClose);
  useEffect(() => { latest.current = onClose; });
  useEffect(() => {
    if (!open) return undefined;
    return openEscapeLayer(() => latest.current?.());
  }, [open]);
}
