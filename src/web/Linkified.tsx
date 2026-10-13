/** Text with any web addresses in it made clickable, so a link pasted into chat opens. */
const URL_RE = /\bhttps?:\/\/[^\s<>"']+/g;

export function Linkified({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    // A sentence's closing punctuation isn't part of the link.
    const url = m[0].replace(/[.,;:!?)\]]+$/, "");
    const at = m.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    parts.push(
      <a key={at} href={url} target="_blank" rel="noreferrer">
        {url}
      </a>,
    );
    last = at + url.length;
  }
  if (last === 0) return <>{text}</>;
  parts.push(text.slice(last));
  return <>{parts}</>;
}
