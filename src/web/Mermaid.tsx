// A mermaid diagram from a plan or spec, drawn where its code block was. The library is large, so it
// loads only when a diagram is on screen. A diagram that doesn't parse shows as the code it is.

import { useEffect, useId, useRef, useState } from "react";

let queue: Promise<unknown> = Promise.resolve();

/** Draws one diagram at a time: mermaid keeps its theme in one place. `dark`: the background it sits
 *  on, when that is dark. Null when the code isn't a diagram. */
function draw(id: string, code: string, dark: string | null): Promise<string | null> {
  const run = queue.then(async () => {
    const { default: mermaid } = await import("mermaid");
    // strict: labels are text, never HTML, and a diagram can't carry a click handler.
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      fontFamily: "inherit",
      theme: dark ? "dark" : "neutral",
      // The dark theme's grey behind a label on a line is hard to read: use the background instead.
      ...(dark && { themeVariables: { edgeLabelBackground: dark } }),
    });
    if (!(await mermaid.parse(code, { suppressErrors: true }))) return null;
    return (await mermaid.render(id, code)).svg;
  });
  queue = run.catch(() => {});
  return run.catch(() => null);
}

export function Mermaid({ code, className }: { code: string; className?: string }) {
  const id = `mermaid-${useId().replace(/[^a-z0-9]/gi, "")}`;
  const box = useRef<HTMLDivElement>(null);
  /** undefined while it is being drawn; null when it can't be. */
  const [svg, setSvg] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let active = true;
    setSvg(undefined);
    // The meeting room is dark whatever the theme, so ask the place it is drawn in.
    const style = box.current ? getComputedStyle(box.current) : null;
    const dark = style?.colorScheme.includes("dark") ? style.getPropertyValue("--bg").trim() || "#191919" : null;
    void draw(id, code, dark).then((out) => {
      if (active) setSvg(out);
    });
    return () => {
      active = false;
    };
  }, [code, id]);
  return (
    <div ref={box} className={`mermaid-diagram${className ? ` ${className}` : ""}`}>
      {svg ? (
        <div role="img" aria-label="Diagram" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : svg === null ? (
        <pre title="This diagram has an error, so it shows as it is written">
          <code>{code}</code>
        </pre>
      ) : (
        <span className="muted small">Drawing the diagram…</span>
      )}
    </div>
  );
}
