import { cx } from "@stackd/ui";
import { useEffect, useRef, useState } from "react";
import { Link, NavLink, useNavigate } from "react-router";
import { useSession } from "../../features/auth/useSession.tsx";
import { TABS } from "../tabs.ts";
import { Logo } from "./Logo.tsx";

/** 900px and up (WIDE_QUERY): the left rail with the brand and the same five destinations. */
export function SideRail() {
  return (
    <aside className="rail">
      <div className="rail__brand">
        <Logo />
        <span>Qash</span>
      </div>
      <nav className="rail__nav" aria-label="Primary">
        {TABS.map((t) => (
          <NavLink
            key={t.path}
            to={t.path}
            end={t.path === "/"}
            className={({ isActive }) => cx("rail__link", isActive && "rail__link--active")}
          >
            {t.label}
          </NavLink>
        ))}
      </nav>
      <SignedInAs />
    </aside>
  );
}

/** The mockup's rail footer: who is signed in. Clicking it opens Your account and Log out. */
function SignedInAs() {
  const { info, signOut } = useSession();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const user = info?.user;
  if (!user) return null;
  const name = user.display_name ?? user.email;
  return (
    <div className="rail__account" ref={box}>
      {open ? (
        <div className="rail__menu" id="rail-account-menu">
          <Link to="/me" className="rail__menu-item" onClick={() => setOpen(false)}>
            Your account
          </Link>
          <button
            type="button"
            className="rail__menu-item"
            onClick={async () => {
              setOpen(false);
              await signOut();
              navigate("/welcome", { replace: true });
            }}
          >
            Log out
          </button>
        </div>
      ) : null}
      <button
        type="button"
        className="rail__user"
        aria-expanded={open}
        aria-controls="rail-account-menu"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="avatar" aria-hidden="true">
          {name.charAt(0).toUpperCase()}
        </span>
        <span className="rail__user-text">
          <span>{name}</span>
          {user.display_name ? <span>{user.email}</span> : null}
        </span>
      </button>
    </div>
  );
}
