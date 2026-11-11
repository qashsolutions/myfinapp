import { Link, useLocation } from "react-router";
import { useSession } from "../../features/auth/useSession.tsx";
import { useSplitGuest } from "../../features/splits/guest.ts";
import { useMediaQuery, WIDE_QUERY } from "../../lib/useMediaQuery.ts";
import { ME_PATH, TABS } from "../tabs.ts";

/**
 * Me on a phone (owner decision, November 11, 2026): the round initial at the top right of each
 * tab's own screen, since Splits took Me's place in the tab bar. Not on deeper screens (they have
 * Back), not from 900px (the rail's footer opens Me there) and not for a split-bill guest, whose
 * tab bar still has Me.
 */
export function MeButton() {
  const { pathname } = useLocation();
  const wide = useMediaQuery(WIDE_QUERY);
  const guest = useSplitGuest();
  const user = useSession().info?.user;
  if (wide || guest || !TABS.some((t) => t.path === pathname)) return null;
  const name = user?.display_name ?? user?.email ?? "";
  return (
    <Link to={ME_PATH} className="avatar me-btn" aria-label="Me">
      {name ? (
        name.charAt(0).toUpperCase()
      ) : (
        <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" strokeWidth="2.2" />
          <path
            d="M4.5 20c1.2-3.6 4-5.5 7.5-5.5s6.3 1.9 7.5 5.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
        </svg>
      )}
    </Link>
  );
}
