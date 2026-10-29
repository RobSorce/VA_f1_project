import React from 'react';
import { APP_NAME, APP_TAGLINE } from '../../utils/brand';
import { FONT_SIZE, wordmarkGeometry } from '../../utils/wordmark';

/**
 * The drawn wordmark: APP_NAME over a line with a chicane jog and a dot
 * (utils/wordmark.js). Inline SVG sized in em, so it scales with the
 * font-size of the place that shows it (className); the word takes
 * --color-text-primary, the line and the dot --color-brand-accent
 * (components.css .wordmark-svg). One image for assistive technology, named
 * APP_NAME. size 'hero' with `tagline` adds APP_TAGLINE under the line.
 */
export default function Wordmark({ size = 'header', tagline = false, className = '' }) {
  const g = wordmarkGeometry(APP_NAME, size);
  return (
    <span className={`wordmark-lockup wordmark-lockup--${g.size}${className ? ` ${className}` : ''}`}>
      <svg
        className="wordmark-svg"
        role="img"
        aria-label={APP_NAME}
        focusable="false"
        viewBox={`0 ${g.top} ${g.width} ${g.height}`}
        width={`${g.width / FONT_SIZE}em`}
        height={`${g.height / FONT_SIZE}em`}
      >
        <text
          className="wordmark-svg__name"
          aria-hidden="true"
          x="0"
          y="0"
          fontSize={FONT_SIZE}
          textLength={g.width}
          lengthAdjust="spacing"
        >
          {APP_NAME}
        </text>
        <path className="wordmark-svg__line" d={g.path} strokeWidth={g.stroke} />
        <circle className="wordmark-svg__dot" cx={g.dot.cx} cy={g.dot.cy} r={g.dot.r} />
      </svg>
      {tagline && g.size === 'hero' && <span className="wordmark-lockup__tagline">{APP_TAGLINE}</span>}
    </span>
  );
}
