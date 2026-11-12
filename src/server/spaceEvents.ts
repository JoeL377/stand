// A space's event stream: what changes in a space, pushed to the pages that have it open
// (server-sent events). One way only; a page sends with a normal request.
import type { Request, Response } from "express";

/** A line this often keeps a quiet stream from being cut by a proxy on the way. */
const BEAT_MS = 25_000;

export class SpaceEvents {
  private readonly streams = new Map<string, Set<Response>>();
  private beat: ReturnType<typeof setInterval> | null = null;

  /** Turns the response into the space's stream. It stays open until the page goes away. */
  open(roomId: string, req: Request, res: Response) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(": open\n\n");
    const set = this.streams.get(roomId) ?? new Set();
    this.streams.set(roomId, set.add(res));
    req.on("close", () => {
      set.delete(res);
      if (!set.size) this.streams.delete(roomId);
    });
    this.beat ??= setInterval(() => {
      for (const all of this.streams.values()) for (const r of all) r.write(": beat\n\n");
    }, BEAT_MS);
    this.beat.unref();
  }

  send(roomId: string, event: unknown) {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of this.streams.get(roomId) ?? []) res.write(line);
  }

  /** How many pages have the space's stream open. */
  watching(roomId: string): number {
    return this.streams.get(roomId)?.size ?? 0;
  }
}
