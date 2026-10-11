// Stand for Mac, when the page runs inside it (desktop/preload.js). Missing in a
// browser, and older copies of the app have only snap().

/** What to tell the person once a snap is done, or nothing if they cancelled. */
export type SnapReport = { title: string; body: string; snapId?: string; settings?: "screen" | "microphone" } | null | undefined;

/** An open to-do in the space, for the floating bar's list. */
export type BarTodo = { id: string; text: string; owner: string | null; itemKey: string | null };

/** What the app's floating bar shows during a meeting. */
export type MeetingBar = {
  /** The space the meeting is in, so a snap goes to it whichever address the window is on. */
  roomId?: string;
  space: string;
  itemKey: string | null;
  item: string | null;
  micOn: boolean;
  /** You're sharing your screen (the app notes it, to see how the bar behaves then). */
  sharing?: boolean;
  todos: BarTodo[];
  /** For the host: the item the talk or screen seems to be about, to switch to from the bar. */
  nudge?: string | null;
  /** The nudge comes from the talk (not the screen): it means little while nothing is recorded. */
  nudgeFromTalk?: boolean;
  /** Just after Switch on the bar: where to, and how many remarks moved ("ENG-150 · 2 moved"), with Undo there. */
  switched?: string | null;
  /** What you say isn't being kept. */
  notRecording?: boolean;
  /** The connection to Stand is down. */
  offline?: boolean;
  /** The meeting has ended and the notes are being written. */
  ending?: boolean;
};

type Bridge = {
  /** The snap toolbar: the screen, a window or part of it. */
  snap(): Promise<SnapReport>;
  /** The meeting this window is in, or null once it's left. */
  meeting?(m: MeetingBar | null): void;
  /** How loud your mic is, 0 to 1, for the bar's ring. */
  level?(level: number): void;
  /** Buttons pressed on the floating bar, the mute shortcut and the Meeting menu. Returns a function that stops listening. */
  /** "saving" and "saved" bracket a snap saving while Stand is in front, where the bar isn't. */
  onCommand?(fn: (command: "mic" | "shortcuts" | "switch" | "undo" | "saving" | "saved") => void): () => void;
  /** Opens that page of System Settings. */
  openSettings?(which: "screen" | "microphone"): void;
};

export const macApp = (window as { standApp?: Bridge }).standApp;
