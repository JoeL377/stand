import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Capabilities, User } from "../shared/protocol.ts";
import { api } from "./api.ts";
import { Avatar } from "./room/Stage.tsx";
import { Logo } from "./icons.tsx";

interface Auth {
  user: User;
  caps: Capabilities;
  signOut: () => Promise<void>;
}

const Ctx = createContext<Auth | null>(null);
export const useAuth = () => useContext(Ctx)!;

/** Everything in the app is behind sign-in; links bring people back where they were going. */
export function AuthGate({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [caps, setCaps] = useState<Capabilities | null>(null);

  useEffect(() => {
    api.config().then(setCaps).catch(() => {});
    api.me().then(setUser).catch(() => setUser(null));
  }, []);

  if (user === undefined || !caps) return <div className="loading">Loading…</div>;
  if (!user) return <SignIn caps={caps} onSignedIn={setUser} />;

  const signOut = async () => {
    await api.signOut();
    setUser(null);
  };
  return <Ctx.Provider value={{ user, caps, signOut }}>{children}</Ctx.Provider>;
}

function SignIn({ caps, onSignedIn }: { caps: Capabilities; onSignedIn: (u: User) => void }) {
  const params = new URLSearchParams(location.search);
  const [error, setError] = useState<string | null>(params.get("signin_error"));
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const next = location.pathname + (params.has("signin_error") ? "" : location.search);

  return (
    <div className="home">
      <div className="home-card">
        <div className="brand">
          <Logo />
          Stand
        </div>
        <h1>Meetings that remember what each ticket was about.</h1>
        <p className="muted">Sign in to join the room. Your name shows next to what you say, and action items are assigned to you.</p>
        {caps.googleSignIn ? (
          <a className="google-btn" href={`/api/auth/google?next=${encodeURIComponent(next)}`}>
            <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
              <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
              <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
              <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
              <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
            </svg>
            Continue with Google
          </a>
        ) : (
          <form
            className="signin-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError(null);
              try {
                onSignedIn(await api.devSignIn(name, email));
              } catch (err) {
                setError((err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <p className="mode-note">
              <strong>Google sign-in isn't set up yet.</strong> Until it is, enter a name and email to try the app.
              Nothing is verified.
            </p>
            <input autoFocus placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
            <input placeholder="Work email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            <button className="primary" disabled={busy || !name.trim() || !email.trim()}>
              Continue
            </button>
          </form>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}

export function UserMenu() {
  const { user, signOut } = useAuth();
  return (
    <span className="user-menu">
      <Avatar id={user.id} name={user.name} picture={user.picture} size={24} />
      <span className="user-name">{user.name}</span>
      <button className="link small" onClick={() => void signOut()}>
        Sign out
      </button>
    </span>
  );
}
