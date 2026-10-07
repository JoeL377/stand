// Small line icons for the kinds of things a meeting produces, so a to-do,
// a decision, an open question and a topic never look alike.

type P = { size?: number };
const svg = (size: number, children: React.ReactNode) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);

export const TodoIcon = ({ size = 16 }: P) => svg(size, <><rect x="2.5" y="2.5" width="11" height="11" rx="3" /><path d="M5.5 8.2 7.3 10l3.4-4" /></>);
export const DecidedIcon = ({ size = 16 }: P) => svg(size, <><circle cx="8" cy="8" r="5.8" /><path d="M5.4 8.2 7.2 10l3.5-4" /></>);
export const QuestionIcon = ({ size = 16 }: P) => svg(size, <><circle cx="8" cy="8" r="5.8" /><path d="M6.4 6.3a1.7 1.7 0 0 1 3.2.6c0 1.2-1.6 1.4-1.6 2.5" /><path d="M8 11.4h.01" /></>);
export const TopicIcon = ({ size = 16 }: P) => svg(size, <path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5A1.5 1.5 0 0 1 11.5 11H7l-3 2.5V11h0A1.5 1.5 0 0 1 3 9.5z" />);
export const InfoIcon = ({ size = 16 }: P) => svg(size, <><circle cx="8" cy="8" r="5.8" /><path d="M8 7.4v3.4" /><path d="M8 5.2h.01" /></>);
export const CarryIcon = ({ size = 16 }: P) => svg(size, <><circle cx="8" cy="8" r="5.8" /><path d="M8 5v3.2l2 1.3" /></>);
