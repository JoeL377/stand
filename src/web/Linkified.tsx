/** Text with any web addresses in it made clickable, so a link pasted into chat opens, and each @Name marked. */
import { MentionText } from "./Mentions.tsx";

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/g;

/** A link as the text shows it: without "https://" or a closing slash, and cut in the middle of a long path. */
const shown = (url: string) => {
  const bare = url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
  return bare.length > 48 ? `${bare.slice(0, 30)}…${bare.slice(-14)}` : bare;
};

export function Linkified({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    // A sentence's closing punctuation isn't part of the link.
    const url = m[0].replace(/[.,;:!?)\]]+$/, "");
    const at = m.index ?? 0;
    if (at > last) parts.push(<MentionText key={`t${last}`} text={text.slice(last, at)} />);
    parts.push(
      <a key={at} href={url} title={url} target="_blank" rel="noreferrer">
        {shown(url)}
      </a>,
    );
    last = at + url.length;
  }
  if (last === 0) return <MentionText text={text} />;
  parts.push(<MentionText key={`t${last}`} text={text.slice(last)} />);
  return <>{parts}</>;
}
