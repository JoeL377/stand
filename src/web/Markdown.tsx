import type { Passage } from "../shared/planReview.ts";
// Markdown as people and agents write it in plans, specs and reports: GitHub-flavored (tables,
// task lists, strikethrough, bare links), never raw HTML. Stand refs like stand:action/<id> open
// the thing they point at.

import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link } from "react-router-dom";

const REF_RE = /\bstand:(action|decision|question|context|topic)\/([a-z0-9]{4,24})\b/gi;

/** A stand: ref as the app's link for it, else the URL if it's safe (no javascript: and the like). */
const urlTransform = (url: string) => {
  const m = /^stand:(action|decision|question|context|topic)\/([a-z0-9]{4,24})$/i.exec(url);
  return m ? `/ref/${m[1].toLowerCase()}/${m[2]}` : defaultUrlTransform(url);
};

type MdNode = { type: string; value?: string; url?: string; children?: MdNode[] };

/** Splits plain text into text, links for bare refs and, with breaks, a line break per newline. */
function splitText(value: string, breaks: boolean): MdNode[] {
  const out: MdNode[] = [];
  const text = (s: string) => {
    if (!breaks) return s && out.push({ type: "text", value: s });
    s.split("\n").forEach((line, i) => {
      if (i > 0) out.push({ type: "break" });
      if (line) out.push({ type: "text", value: line });
    });
  };
  let last = 0;
  for (const m of value.matchAll(REF_RE)) {
    const at = m.index ?? 0;
    text(value.slice(last, at));
    out.push({ type: "link", url: m[0], children: [{ type: "text", value: m[0] }] });
    last = at + m[0].length;
  }
  text(value.slice(last));
  return out;
}

/** A remark plugin for refs and breaks. Code and existing links are left alone. */
const refsAndBreaks = (breaks: boolean) => () => (tree: MdNode) => {
  const walk = (node: MdNode) => {
    if (!node.children || node.type === "link") return;
    node.children = node.children.flatMap((c) => {
      if (c.type === "text") return splitText(c.value ?? "", breaks);
      walk(c);
      return [c];
    });
  };
  walk(tree);
};

const components: Components = {
  a: ({ href, children }) =>
    href?.startsWith("/") ? (
      <Link to={href}>{children}</Link>
    ) : (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    ),
};

type RenderedNode = {
  tagName?: string;
  properties?: Record<string, unknown>;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: RenderedNode[];
};

type ReviewMarks = { highlight: Passage | null; marked?: (Passage & { id: string })[] };
const reviewPassages = ({ highlight, marked }: ReviewMarks) => () => (root: RenderedNode) => {
  function walk(node: RenderedNode, top: boolean) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (node.properties && (top || node.tagName === "li") && start !== undefined && end !== undefined) {
      node.properties.dataPlanStart = start;
      node.properties.dataPlanEnd = end;
      if (highlight && highlight.start <= start && end <= highlight.end) node.properties.dataPlanHighlight = "true";
      const thread = marked?.find((range) => range.start <= start && end <= range.end);
      if (thread) node.properties.dataPlanThread = thread.id;
    }
    node.children?.forEach((child) => walk(child, false));
  }
  root.children?.forEach((node) => walk(node, true));
};

/** Renders markdown. breaks: a single newline starts a new line, as in a chat message or a short report. */
export function Markdown({ text, breaks = false, className, review }: { text: string; breaks?: boolean; className?: string; review?: ReviewMarks }) {
  return (
    <div className={`md${className ? ` ${className}` : ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm, refsAndBreaks(breaks)]} rehypePlugins={review ? [reviewPassages(review)] : []} components={components} urlTransform={urlTransform}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
