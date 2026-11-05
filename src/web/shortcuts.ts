// Keyboard shortcuts, named the way this computer's keyboard does. The meeting's help card and the
// profile menu's Shortcuts both read these lists.

const IS_MAC = /Mac/.test(navigator.platform);
export const MOD = IS_MAC ? { ctrl: "Control", alt: "Option", cmd: "Command" } : { ctrl: "Ctrl", alt: "Alt", cmd: "Ctrl" };

export type Shortcut = [keys: string, what: string];

export const pageShortcuts = (): Shortcut[] => [
  [`${MOD.cmd} + B`, "Fold or open the sidebar"],
  ["Esc", "Close a menu or form"],
];

export const meetingShortcuts = (canSteer: boolean): Shortcut[] => [
  ...(canSteer
    ? ([
        [`${MOD.alt} + ↓  /  ↑`, "Next / previous agenda item"],
        ["←  /  →", "Flip slides while a deck is open"],
      ] as Shortcut[])
    : []),
  [`${MOD.cmd} + D`, "Mute or unmute"],
  [`Hold ${MOD.ctrl} + Space`, "Ask Stand: say your question, then let go"],
  [`${MOD.cmd} + \\`, "Hide or show the agenda"],
  [`${MOD.ctrl} + Shift + S`, "Snap the shared screen into the meeting"],
  ["Paste or drop an image", "Add a screenshot to the item in focus"],
  ["Esc", "Close a menu or form"],
  ["?", "Show or hide these shortcuts"],
];
