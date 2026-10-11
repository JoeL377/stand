// Stand for Mac, when the page runs inside it (desktop/preload.js). Missing in a
// browser, and older copies of the app have only snap().

/** What to tell the person once a snap is done, or nothing if they cancelled. */
export type SnapReport = { title: string; body: string; snapId?: string } | null | undefined;

/** An open to-do in the space, for the floating bar's list. */
export type BarTodo = { id: string; text: string; owner: string | null; itemKey: string | null };

/** What the app's floating bar shows during a meeting. */
export type MeetingBar = { space: string; itemKey: string | null; item: string | null; micOn: boolean; todos: BarTodo[] };

type Bridge = {
  /** The snap toolbar: the screen, a window or part of it. */
  snap(): Promise<SnapReport>;
  /** The meeting this window is in, or null once it's left. */
  meeting?(m: MeetingBar | null): void;
  /** Buttons pressed on the floating bar. Returns a function that stops listening. */
  onCommand?(fn: (command: "mic") => void): () => void;
};

export const macApp = (window as { standApp?: Bridge }).standApp;
