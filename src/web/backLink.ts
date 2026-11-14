// Where a page's back link goes when it was opened from somewhere in particular: the tab or project an
// artifact was clicked in, so the way back is that place and not the space's front page.
import { useLocation } from "react-router-dom";

export interface Back {
  to: string;
  label: string;
}

/** The place this page was opened from, when the link that opened it said so. */
export function useBack(): Back | null {
  const s = useLocation().state as { back?: Back } | null;
  return s?.back?.to ? s.back : null;
}
