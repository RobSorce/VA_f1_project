import { useEffect, useState } from 'react';

/**
 * Whether a media query matches now, kept up to date on changes (false
 * without window.matchMedia, e.g. in a server render).
 *
 * @param {string} query - e.g. '(max-height: 899px)'
 * @returns {boolean}
 */
export function useMediaQuery(query) {
  const get = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query).matches : false);
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, [query]);
  return matches;
}
