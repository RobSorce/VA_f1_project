import { useState, useEffect, useCallback } from 'react';

/**
 * Measures the available height of a container element via ResizeObserver.
 * Returns the height in pixels so components can compute how many items fit.
 */
export default function useContainerHeight(ref) {
  const [height, setHeight] = useState(600); // sensible default

  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect?.height;
      if (h > 0) setHeight(Math.floor(h));
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [ref]);

  return height;
}
