import type { Item } from "../shared/protocol.ts";

export const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
export const fmtDate = (ts: number) =>
  new Date(ts).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
export const fmtDuration = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

export const itemLabel = (it: Item | null | undefined) => (it ? it.title : "General discussion");

const palette = ["#5b5bd6", "#0d9488", "#d97706", "#db2777", "#2563eb", "#65a30d", "#9333ea", "#dc2626"];
export function colorFor(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
  return palette[Math.abs(h) % palette.length];
}
export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
