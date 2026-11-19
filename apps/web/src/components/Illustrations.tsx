// Flat inline illustrations colored by the active palette (see .sp-art-* in global.css).
// They are decorative: every use is aria-hidden and sits next to real text.

const STAR =
  'M0-10c.6 5.4 4.6 9.4 10 10-5.4.6-9.4 4.6-10 10-.6-5.4-4.6-9.4-10-10 5.4-.6 9.4-4.6 10-10Z';

function Star({ x, y, scale = 1, className }: { x: number; y: number; scale?: number; className: string }) {
  return <path d={STAR} transform={`translate(${x} ${y}) scale(${scale})`} className={className} />;
}

/** A glass jar keeping a spark; small sparks drift toward it when `animated`. */
export function JarScene({ animated = false, className = '' }: { animated?: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 220 170"
      className={`sp-art ${animated ? 'sp-art--animated' : ''} ${className}`}
      aria-hidden="true"
      focusable="false"
    >
      <ellipse cx="110" cy="156" rx="64" ry="7" className="sp-art-shadow" />
      <circle cx="110" cy="106" r="40" className="sp-art-glow" />
      <rect x="70" y="62" width="80" height="92" rx="30" className="sp-art-glass" />
      <rect x="84" y="48" width="52" height="18" rx="6" className="sp-art-glass" />
      <rect x="79" y="32" width="62" height="19" rx="7" className="sp-art-primary" />
      <path d="M86 84c-4 6-5 14-4 22" className="sp-art-shine" />
      <Star x={110} y={108} scale={1.9} className="sp-art-spark" />
      <circle cx="127" cy="88" r="3.2" className="sp-art-spark" />
      <circle cx="94" cy="128" r="2.4" className="sp-art-spark" />
      <g className="sp-art-drift sp-art-drift--1">
        <Star x={40} y={58} scale={0.9} className="sp-art-spark" />
      </g>
      <g className="sp-art-drift sp-art-drift--2">
        <Star x={182} y={44} scale={0.7} className="sp-art-primary-soft" />
      </g>
      <g className="sp-art-drift sp-art-drift--3">
        <circle cx="176" cy="104" r="4" className="sp-art-spark" />
      </g>
      <g className="sp-art-drift sp-art-drift--4">
        <circle cx="34" cy="116" r="3" className="sp-art-primary-soft" />
      </g>
    </svg>
  );
}

/** Two notebooks with washi tape — for an empty project list. */
export function NotebookScene({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 220 170" className={`sp-art ${className}`} aria-hidden="true" focusable="false">
      <ellipse cx="110" cy="154" rx="70" ry="7" className="sp-art-shadow" />
      <g transform="rotate(-8 92 96)">
        <rect x="46" y="44" width="92" height="108" rx="12" className="sp-art-soft" />
        <rect x="46" y="44" width="16" height="108" rx="8" className="sp-art-primary-soft" />
      </g>
      <g transform="rotate(6 128 98)">
        <rect x="86" y="40" width="96" height="112" rx="12" className="sp-art-glass" />
        <path d="M104 74h60M104 92h60M104 110h42" className="sp-art-line" />
        <rect x="112" y="30" width="44" height="16" rx="3" className="sp-art-tape" />
      </g>
      <Star x={182} y={36} scale={0.8} className="sp-art-spark" />
    </svg>
  );
}

/** A magnifier over a note — for "nothing found". */
export function SearchScene({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 220 170" className={`sp-art ${className}`} aria-hidden="true" focusable="false">
      <ellipse cx="110" cy="154" rx="62" ry="7" className="sp-art-shadow" />
      <rect x="54" y="34" width="96" height="114" rx="14" className="sp-art-glass" />
      <path d="M72 64h58M72 82h58M72 100h36" className="sp-art-line" />
      <circle cx="140" cy="104" r="26" className="sp-art-lens" />
      <path d="M158 123l20 20" className="sp-art-handle" />
      <Star x={140} y={104} scale={0.85} className="sp-art-spark" />
    </svg>
  );
}
