// Line icons for the meeting controls and the brand mark. 24px grid, drawn
// with currentColor so they follow the button they sit in.

import type { ReactNode } from "react";

function Svg({ children, size = 20 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

export const MicIcon = () => (
  <Svg>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </Svg>
);

export const MicOffIcon = () => (
  <Svg>
    <path d="M15 9.5V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.6 2.5M5 11a7 7 0 0 0 11.3 5.5M19 11a7 7 0 0 1-.6 2.8M12 18v3M4 4l16 16" />
  </Svg>
);

export const ShareIcon = () => (
  <Svg>
    <rect x="3" y="4" width="18" height="13" rx="2" />
    <path d="M8 21h8M12 17v4M12 13V8M9.5 10.5 12 8l2.5 2.5" />
  </Svg>
);

export const StopShareIcon = () => (
  <Svg>
    <rect x="3" y="4" width="18" height="13" rx="2" />
    <path d="M8 21h8M12 17v4" />
    <rect x="9.5" y="8" width="5" height="5" rx="1" fill="currentColor" />
  </Svg>
);

export const PlayIcon = () => (
  <Svg>
    <path d="M7 5v14l11-7z" />
  </Svg>
);

export const LinkIcon = () => (
  <Svg size={16}>
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  </Svg>
);

/** The Stand mark: bars of a voice level meter. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="logo-mark">
      <rect width="32" height="32" rx="8" fill="var(--brand, #2d6cdf)" />
      <path d="M9 20v-8M14 23V9M19 19v-6M24 17v-2" stroke="white" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

// Agenda entry kinds: a typed task, a Linear ticket, a deck made in Stand,
// an uploaded PDF deck, and the general / off-agenda line.
export const TaskIcon = ({ size = 15 }: { size?: number }) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m8.5 12.2 2.4 2.3 4.6-4.8" />
  </Svg>
);

export const TicketIcon = ({ size = 15 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2.5a2.5 2.5 0 0 0 0 5V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2.5a2.5 2.5 0 0 0 0-5Z" />
    <path d="M14 5v2M14 11v2M14 17v2" />
  </Svg>
);

export const DeckIcon = ({ size = 15 }: { size?: number }) => (
  <Svg size={size}>
    <rect x="3" y="4" width="18" height="12" rx="1.5" />
    <path d="M12 16v4M8.5 20h7M7.5 12.5l3-3 2 2 4-4" />
  </Svg>
);

export const PdfIcon = ({ size = 15 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
    <path d="M14 3v5h5M9 13h6M9 17h4" />
  </Svg>
);

export const ChatIcon = ({ size = 15 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M20 12a7.5 7.5 0 0 1-11 6.6L4 20l1.4-4.6A7.5 7.5 0 1 1 20 12Z" />
  </Svg>
);
