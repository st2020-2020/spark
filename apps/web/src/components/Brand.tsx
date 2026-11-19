import { Link } from 'react-router-dom';

const SPARK_PATH =
  'M12 2.25c.72 5.06 3.68 8.02 8.75 8.75v2c-5.07.73-8.03 3.69-8.75 8.75h-2C9.27 16.69 6.31 13.73 1.25 13v-2c5.06-.73 8.02-3.69 8.75-8.75h2Z';

/** Four-point spark glyph; inherits currentColor. */
export function SparkGlyph({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 22 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path d={SPARK_PATH} />
    </svg>
  );
}

/**
 * The Spark jar: a small glass jar that keeps a spark of light — "catch the idea, sort it later".
 * Jar outline and lid use currentColor; the spark inside uses --sp-spark.
 */
export function JarGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <rect x="7.4" y="2.4" width="9.2" height="3.3" rx="1.5" fill="currentColor" />
      <path
        d="M8.6 5.7v1.5C6.5 8.1 5 10 5 12.5v4.4c0 2.5 2 4.6 4.6 4.6h4.8c2.6 0 4.6-2.1 4.6-4.6v-4.4c0-2.5-1.5-4.4-3.6-5.3V5.7"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
      <path
        className="sp-jar-spark"
        d="M12 10.5c.38 2.42 1.6 3.64 4 4-2.4.38-3.62 1.6-4 4-.38-2.4-1.6-3.62-4-4 2.4-.36 3.62-1.58 4-4Z"
      />
      <circle className="sp-jar-spark" cx="15.3" cy="10.4" r="0.9" />
    </svg>
  );
}

export function BrandMark({ size = 'md' }: { size?: 'md' | 'lg' }) {
  return (
    <span className={`sp-brand-mark ${size === 'lg' ? 'sp-brand-mark--lg' : ''}`} aria-hidden="true">
      <JarGlyph size={size === 'lg' ? 30 : 19} />
    </span>
  );
}

/** Brand lockup used by the sidebar, top bar and drawer. */
export function BrandLink({ className = '' }: { className?: string }) {
  return (
    <Link to="/inbox" className={`sp-brand ${className}`}>
      <BrandMark />
      <span className="sp-brand-word">Spark</span>
    </Link>
  );
}
