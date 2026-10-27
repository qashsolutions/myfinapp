/**
 * The Qash mark, "Rising Q" (owner, October 16, 2026): a white Q on an indigo tile with three
 * marigold bars rising inside it. Brand colours, so the same in every look; apps/web/scripts/icons.ts
 * draws the same mark for the app icons and apps/site/src/components/Logo.astro for the website.
 */
const INDIGO = "#4338FF";
const MARIGOLD = "#FFB020";

export function Logo({ size = 36 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <rect width="100" height="100" rx="22" fill={INDIGO} />
      <g transform="translate(10 10) scale(0.8)">
        <circle cx="46" cy="46" r="28" fill="none" stroke="#FFFFFF" strokeWidth="10" />
        <rect x="27" y="42" width="6" height="8" rx="2" fill={MARIGOLD} />
        <rect x="35.5" y="37" width="6" height="13" rx="2" fill={MARIGOLD} />
        <rect x="44" y="32" width="6" height="18" rx="2" fill={MARIGOLD} />
        <line
          x1="56"
          y1="56"
          x2="78"
          y2="78"
          stroke="#FFFFFF"
          strokeWidth="10"
          strokeLinecap="round"
        />
      </g>
    </svg>
  );
}
