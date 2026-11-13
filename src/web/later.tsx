// The parts of the app that load after the first page shows: the call screen and the pages reached
// from a space. The first page then needs about a third of the script it used to.
//
// They are fetched a moment after the first page is up, not on the click that needs them, so
// opening a call or a recap is as quick as before. That also means a tab left open across a deploy
// already has them, and never asks the server for a file the new build no longer has.

import { type ComponentType, useEffect, useState } from "react";

const loads: Array<() => Promise<unknown>> = [];
/** A part that loads later. Once it is here it draws at once, with no "Loading…" in between: React's own
 *  `lazy` shows its fallback for a moment even for a part that has already arrived, which made
 *  Start talking take most of a second. */
function later<P extends object>(load: () => Promise<ComponentType<P>>) {
  let Part: ComponentType<P> | null = null;
  let got: Promise<void> | null = null;
  const once = () =>
    (got ??= load().then(
      (c) => void (Part = c),
      (err) => {
        got = null;
        throw err;
      },
    ));
  loads.push(once);
  return function Later(props: P) {
    const [failed, setFailed] = useState(false);
    const [, drawn] = useState(0);
    useEffect(() => {
      if (Part) return;
      let here = true;
      once().then(() => here && drawn((n) => n + 1), () => here && setFailed(true));
      return () => {
        here = false;
      };
    }, [failed]);
    if (Part) return <Part {...props} />;
    if (failed)
      return (
        <div className="loading">
          Couldn’t load this page.{" "}
          <button className="link" onClick={() => setFailed(false)}>
            Try again
          </button>
        </div>
      );
    return <div className="loading">Loading…</div>;
  };
}

export const Meeting = later(() => import("./room/Meeting.tsx").then((m) => m.Meeting));
export const RecapPage = later(() => import("./pages/RecapPage.tsx").then((m) => m.RecapPage));
export const ReviewPage = later(() => import("./pages/ReviewPage.tsx").then((m) => m.ReviewPage));
export const DesignReviewPage = later(() => import("./pages/DesignReviewPage.tsx").then((m) => m.DesignReviewPage));
export const BrainstormPage = later(() => import("./pages/BrainstormPage.tsx").then((m) => m.BrainstormPage));
export const ItemHistoryPage = later(() => import("./pages/ItemHistoryPage.tsx").then((m) => m.ItemHistoryPage));
export const DeckHistoryPage = later(() => import("./pages/DeckHistoryPage.tsx").then((m) => m.DeckHistoryPage));
export const DeckEditorPage = later(() => import("./pages/DeckEditorPage.tsx").then((m) => m.DeckEditorPage));
export const ConnectAgentPage = later(() => import("./pages/ConnectAgentPage.tsx").then((m) => m.ConnectAgentPage));
export const ManageSpaces = later(() => import("./pages/ManageSpaces.tsx").then((m) => m.ManageSpaces));

/** Fetches all of them, one after another, a moment after the first page is up and the browser is idle,
 *  so they never compete with the page someone is waiting for. */
export function loadTheRest() {
  const idle = (run: () => void) => ("requestIdleCallback" in window ? requestIdleCallback(run, { timeout: 4000 }) : setTimeout(run, 500));
  let i = 0;
  const next = () => {
    const load = loads[i++];
    if (load) void load().then(() => idle(next), () => {});
  };
  const start = () => setTimeout(() => idle(next), 1000);
  if (document.readyState === "complete") start();
  else window.addEventListener("load", start, { once: true });
}

// A file this build asks for is gone: the server has a newer build. Loading the page again gets it.
// Once only, so a server that is really down doesn't loop.
window.addEventListener("vite:preloadError", (e) => {
  try {
    if (sessionStorage.getItem("stand.reloadedForBuild")) return;
    sessionStorage.setItem("stand.reloadedForBuild", String(Date.now()));
  } catch {
    return;
  }
  e.preventDefault();
  location.reload();
});
