// You, at the bottom of the nav: click for your account, help and signing out. Rows marked Soon are
// places we mean to have and don't yet.

import { useEffect, useState } from "react";
import { BookOpen, Keyboard, LogOut, MessageCircle, Monitor, Moon, Settings, Sun, type LucideIcon } from "lucide-react";
import { useAuth } from "./auth.tsx";
import { Avatar } from "./room/Stage.tsx";
import { meetingShortcuts, pageShortcuts, type Shortcut } from "./shortcuts.ts";
import { savedTheme, setTheme, type Theme } from "./theme.ts";
import { useDismiss } from "./useDismiss.ts";

const SOON: Array<{ label: string; icon: LucideIcon }> = [
  { label: "Settings", icon: Settings },
  { label: "Docs", icon: BookOpen },
  { label: "Contact us", icon: MessageCircle },
];

const THEMES: Array<{ theme: Theme; label: string; icon: LucideIcon; title: string }> = [
  { theme: "auto", label: "Auto", icon: Monitor, title: "Follow this computer's setting" },
  { theme: "light", label: "Light", icon: Sun, title: "Always light" },
  { theme: "dark", label: "Dark", icon: Moon, title: "Always dark" },
];

/** The meeting room stays dark whichever you pick, like a video call. */
function ThemePicker() {
  const [theme, pick] = useState(savedTheme);
  return (
    <div className="sp-theme" role="radiogroup" aria-label="Theme">
      {THEMES.map(({ theme: t, label, icon: Icon, title }) => (
        <button
          key={t}
          type="button"
          role="radio"
          aria-checked={theme === t}
          title={title}
          onClick={() => {
            setTheme(t);
            pick(t);
          }}
        >
          <Icon size={14} aria-hidden />
          {label}
        </button>
      ))}
    </div>
  );
}

function ShortcutList(props: { title: string; rows: Shortcut[] }) {
  return (
    <section>
      <h3>{props.title}</h3>
      <dl>
        {props.rows.map(([keys, what]) => (
          <div key={keys}>
            <dt>
              <kbd>{keys}</kbd>
            </dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function ShortcutsDialog(props: { onClose: () => void }) {
  const { onClose } = props;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog sp-keys" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title">
        <div className="sp-newform-head">
          <strong id="shortcuts-title">Keyboard shortcuts</strong>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <ShortcutList title="Everywhere" rows={pageShortcuts()} />
        <ShortcutList title="In a meeting" rows={meetingShortcuts(true).filter(([keys]) => keys !== "Esc")} />
      </div>
    </div>
  );
}

export function ProfileMenu(props: { collapsed: boolean }) {
  const { user, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const [keys, setKeys] = useState(false);
  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  return (
    <div className="sp-profile" ref={ref}>
      <button
        type="button"
        className="sp-navrow sp-profile-btn"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${user.name}: account and help`}
        title={props.collapsed ? user.name : undefined}
      >
        <Avatar id={user.id} name={user.name} picture={user.picture} size={22} />
        <span className="sp-side-text">{user.name}</span>
      </button>
      {open && (
        <div className="sp-profile-pop" role="menu" aria-label="Account and help">
          <div className="sp-profile-who">
            <strong>{user.name}</strong>
            <span>{user.email}</span>
          </div>
          {SOON.map(({ label, icon: Icon }) => (
            <button key={label} type="button" role="menuitem" disabled>
              <Icon size={15} aria-hidden />
              {label}
              <span className="sp-soon">Soon</span>
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setKeys(true);
            }}
          >
            <Keyboard size={15} aria-hidden />
            Shortcuts
          </button>
          <div className="sp-profile-rule" />
          <ThemePicker />
          <div className="sp-profile-rule" />
          <button type="button" role="menuitem" onClick={() => void signOut()}>
            <LogOut size={15} aria-hidden />
            Sign out
          </button>
        </div>
      )}
      {keys && <ShortcutsDialog onClose={() => setKeys(false)} />}
    </div>
  );
}
