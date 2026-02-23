import React from 'react';

/**
 * Minimal stroke-based SVG icons for the command palette.
 * All icons: 16x16, stroke-only, strokeWidth 1.5, currentColor.
 */
const PATHS = {
  // Navigation
  map:          <><circle cx="8" cy="8" r="6"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5"/><circle cx="8" cy="8" r="1.5"/></>,
  'map-pin':    <><path d="M8 1.5A4.5 4.5 0 0112.5 6C12.5 9.5 8 14.5 8 14.5S3.5 9.5 3.5 6A4.5 4.5 0 018 1.5z"/><circle cx="8" cy="6" r="1.5"/></>,
  clock:        <><circle cx="8" cy="8" r="6.5"/><path d="M8 4v4l2.5 1.5"/></>,
  'bar-chart':  <><path d="M2 14h12"/><rect x="3" y="6" width="2" height="8" rx=".5"/><rect x="7" y="3" width="2" height="11" rx=".5"/><rect x="11" y="8" width="2" height="6" rx=".5"/></>,
  circle:       <><circle cx="8" cy="8" r="5.5"/></>,
  zap:          <><path d="M8.5 1L3.5 9h4l-1 6 6-8h-4.5z"/></>,
  'trending-down': <><path d="M14 11l-3.5-3.5L8 10 2 4"/><path d="M14 7v4h-4"/></>,
  sparkles:     <><path d="M8 1l1.5 4.5L14 7l-4.5 1.5L8 13l-1.5-4.5L2 7l4.5-1.5z"/><path d="M12.5 1l.5 1.5L14.5 3l-1.5.5-.5 1.5-.5-1.5L10.5 3l1.5-.5z"/></>,
  settings:     <><circle cx="8" cy="8" r="2.5"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41"/></>,

  // Actions
  user:         <><circle cx="8" cy="5.5" r="3"/><path d="M2.5 14.5c0-3 2.5-5 5.5-5s5.5 2 5.5 5"/></>,
  crosshair:    <><circle cx="8" cy="8" r="5"/><path d="M8 1v3M8 12v3M1 8h3M12 8h3"/></>,
  'git-compare':<><circle cx="5" cy="4" r="1.5"/><circle cx="11" cy="12" r="1.5"/><path d="M5 5.5V11a2 2 0 002 2h2M11 10.5V5a2 2 0 00-2-2H7"/><path d="M9 5l-2-2 2-2"/><path d="M7 11l2 2-2 2"/></>,
  hash:         <><path d="M4 1v14M10 1v14M1 5h14M1 11h14"/></>,

  // Windows
  'arrow-right':<><path d="M3 8h10M9 4l4 4-4 4"/></>,
  'arrow-left': <><path d="M13 8H3M7 4L3 8l4 4"/></>,
  x:            <><path d="M4 4l8 8M12 4l-8 8"/></>,
  'x-square':   <><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5"/></>,

  // Replay
  play:         <><path d="M4.5 2.5l9 5.5-9 5.5z"/></>,
  'skip-back':  <><path d="M8 8L14 3v10zM2 3v10"/></>,
  'skip-fwd':   <><path d="M8 8L2 3v10zM14 3v10"/></>,
  'chevrons-r': <><path d="M3 3l5 5-5 5M8 3l5 5-5 5"/></>,
  'chevrons-l': <><path d="M13 3l-5 5 5 5M8 3L3 8l5 5"/></>,

  // Analytics
  activity:     <><path d="M1 8h3l2-5 4 10 2-5h3"/></>,
  layers:       <><path d="M8 1L1 5l7 4 7-4zM1 8l7 4 7-4M1 11l7 4 7-4"/></>,
  'refresh-cw': <><path d="M14 2v4h-4"/><path d="M2 14v-4h4"/><path d="M13.5 6A6 6 0 003 3.5L2 6M2.5 10A6 6 0 0013 12.5l1-2.5"/></>,

  // Utility
  trash:        <><path d="M3 4h10M5.5 4V3a1 1 0 011-1h3a1 1 0 011 1v1M4 4v9a1 1 0 001 1h6a1 1 0 001-1V4"/></>,
  keyboard:     <><rect x="1" y="3" width="14" height="10" rx="1.5"/><path d="M4 6h1M7.5 6h1M11 6h1M4 9h1M11 9h1M6.5 9h3"/></>,
};

export default function CommandIcon({ name, size = 16 }) {
  const paths = PATHS[name];
  if (!paths) return null;

  return (
    <svg
      className="cmd-icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths}
    </svg>
  );
}
