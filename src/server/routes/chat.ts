// Chat in a space (chat.ts): its messages, sending, editing and deleting your own, how far you
// have read, and the space's event stream that tells open pages what changed.
import type { Express, Request } from "express";
import type { ChatMessage, ChatThread } from "../../shared/chat.ts";
import { caughtIn } from "../chatCapture.ts";
import type { Services } from "../services.ts";
import { type Params, memberRoom, notFound, route } from "./http.ts";

export function chatRoutes(app: Express, ctx: Services) {
  const { db, chat, spaceEvents } = ctx;

  /** A page of messages with the sessions they are in, and what Stand caught from each. */
  const page = (messages: ChatMessage[]) => {
    const ids = [...new Set(messages.map((m) => m.sessionId))];
    return { messages, sessions: ids.map((id) => db.chatSession(id)!), caught: ids.flatMap((id) => caughtIn(db, id) ?? []) };
  };
  /** The channel in :id when the signed-in person is in its space. */
  const memberChannel = (req: Request<Params>) => {
    const c = db.getChannel(req.params.id);
    return c && db.isMember(c.roomId, req.user!.id) ? c : null;
  };
  const seq = (v: unknown) => (typeof v === "string" && /^\d{1,15}$/.test(v) ? Number(v) : undefined);

  app.get(
    "/api/rooms/:id/events",
    route((req, res) => {
      const room = memberRoom(db, req, res);
      if (room) spaceEvents.open(room.id, req, res);
    }),
  );

  // The space's chat, as its tab opens on it: the newest messages and how far you have read.
  app.get(
    "/api/rooms/:id/chat",
    route((req, res) => {
      const room = memberRoom(db, req, res);
      if (!room) return;
      const channel = db.spaceChannel(room.id, req.user!.id);
      const thread: ChatThread = {
        channel,
        ...page(db.channelMessages(channel.id)),
        readUpTo: db.channelReadUpTo(channel.id, req.user!.id),
        people: db.roomPeople(room.id),
      };
      res.json(thread);
    }),
  );

  // ?before=<seq> for older messages, ?after=<seq> for the ones that came since.
  app.get(
    "/api/channels/:id/messages",
    route((req, res) => {
      const channel = memberChannel(req);
      if (!channel) return notFound(res);
      res.json(page(db.channelMessages(channel.id, { before: seq(req.query.before), after: seq(req.query.after) })));
    }),
  );

  // {text, key?, replyTo?}. A send that is tried again with the same key gives the same message back.
  app.post(
    "/api/rooms/:id/chat/messages",
    route((req, res) => {
      const room = memberRoom(db, req, res);
      if (!room) return;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const key = typeof body.key === "string" && /^[A-Za-z0-9-]{8,64}$/.test(body.key) ? `${req.user!.id}:${body.key}` : undefined;
      const channel = db.spaceChannel(room.id, req.user!.id);
      const [message] = chat.accept(channel.id, [
        { type: "message", externalId: key, author: { userId: req.user!.id }, text: String(body.text ?? ""), ts: Date.now(), replyTo: typeof body.replyTo === "string" ? body.replyTo : undefined },
      ]).messages;
      if (!message) return res.status(400).json({ error: "Write something to send." });
      // What you send, you have read.
      db.markChannelRead(channel.id, req.user!.id, message.seq);
      res.json(message);
    }),
  );

  /** Your own message, changed or deleted. */
  const change = (del: boolean) =>
    route((req, res) => {
      const was = db.chatMessage(req.params.id);
      const channel = was && db.getChannel(was.channelId);
      if (!was || !channel || !db.isMember(channel.roomId, req.user!.id)) return notFound(res);
      if (was.authorId !== req.user!.id) return res.status(403).json({ error: `Only whoever wrote it can ${del ? "delete" : "change"} it.` });
      const by = { userId: req.user!.id };
      const text = String(req.body?.text ?? "");
      if (!del && !text.trim()) return res.status(400).json({ error: "A message needs some text. Delete it instead." });
      chat.accept(channel.id, [del ? { type: "delete", id: was.id, by, ts: Date.now() } : { type: "edit", id: was.id, by, text, ts: Date.now() }]);
      res.json(db.chatMessage(was.id));
    });
  app.patch("/api/chat/messages/:id", change(false));
  app.delete("/api/chat/messages/:id", change(true));

  // What Stand caught from one session, read again when the stream says it changed.
  app.get(
    "/api/chat/sessions/:id/caught",
    route((req, res) => {
      const session = db.chatSession(req.params.id);
      if (!session || !db.isMember(session.roomId, req.user!.id)) return notFound(res);
      res.json(caughtIn(db, session.id) ?? { sessionId: session.id, summary: null, topics: [], lines: [] });
    }),
  );

  // A line Stand caught from chat that isn't one: it goes, and isn't written again for that session.
  // Chat has no host and no end, so anyone in the space can, as a meeting's host can during the call.
  app.delete(
    "/api/chat/caught/:id",
    route((req, res) => {
      const note = db.getNote(req.params.id);
      const session = note && db.chatSession(note.meetingId);
      if (!note || !session || !db.isMember(session.roomId, req.user!.id) || note.kind === "summary" || note.kind === "context") return notFound(res);
      // A to-do or question someone took up is theirs to close. A decision has nowhere else to go from.
      if (note.kind !== "decision" && db.noteActedOn(note.id)) return res.status(409).json({ error: "Someone is working with this one. Drop it on the Tasks tab instead." });
      db.removeNote(note.id);
      spaceEvents.send(session.roomId, { type: "notes", channelId: session.channelId, sessionId: session.id });
      res.json({ removed: note.id });
    }),
  );

  // {upTo: seq}: you have read the channel up to that message.
  app.post(
    "/api/channels/:id/read",
    route((req, res) => {
      const channel = memberChannel(req);
      if (!channel) return notFound(res);
      const upTo = Number(req.body?.upTo);
      if (!Number.isSafeInteger(upTo) || upTo < 0) return res.status(400).json({ error: "upTo is a message's seq." });
      // No further than the channel's last message.
      const last = db.channelMessages(channel.id, { limit: 1 })[0]?.seq ?? 0;
      db.markChannelRead(channel.id, req.user!.id, Math.min(upTo, last));
      res.json({ readUpTo: db.channelReadUpTo(channel.id, req.user!.id) });
    }),
  );
}
