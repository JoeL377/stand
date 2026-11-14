// Spaces: the list, a space and its agenda, its feed and suggested agenda, archiving, and the call's token.
import type { Express } from "express";
import { type ItemHistory, MAX_SYNTHESIS_INSTRUCTIONS, type Note, type SpaceMembers } from "../../shared/protocol.ts";
import { spaceActivity } from "../activity.ts";
import { artifactDetail, moveArtifact, spaceArtifacts } from "../artifacts.ts";
import { archiveRow, restoreRow } from "../archive.ts";
import { spaceFeed } from "../captures.ts";
import { capabilities, config } from "../config.ts";
import { importFromLinear } from "../linear.ts";
import { participantToken } from "../livekit.ts";
import { mentionView, unreadChatMentions } from "../mentions.ts";
import { withFrom } from "../noteFrom.ts";
import { ownedBy, toSpaceSummary } from "../spaces.ts";
import { upNextView } from "../upNextPolish.ts";
import type { Services } from "../services.ts";
import { memberRoom, notFound, route } from "./http.ts";

const DAY_MS = 86_400_000;
const whole = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Math.trunc(Number(v));
  return v === undefined || v === "" || !Number.isFinite(n) ? fallback : Math.min(max, Math.max(min, n));
};

/** The cost page's range: whole days in the viewer's time (`tz`: minutes east of UTC), the oldest
 *  `days - 1` days back, up to now. One past now, so a range asked for at midnight still has today. */
export function costRange(days: unknown, tz: unknown, now: number) {
  const dayOffsetMin = whole(tz, -840, 840, 0);
  const offset = dayOffsetMin * 60_000;
  const today = Math.floor((now + offset) / DAY_MS) * DAY_MS - offset;
  return { since: today - (whole(days, 1, 90, 30) - 1) * DAY_MS, until: now + 1, dayOffsetMin };
}

export function spaceRoutes(app: Express, ctx: Services) {
  const { db, sessions, live, polisher, afterItemsChange } = ctx;
  // The spaces you're in. Spaces are invite only: opening one from its link
  // adds you, and only then does it show on your home page.
  // The Activity tab: what agents did in the space, newest first, a page at a time.
  app.get(
    "/api/rooms/:id/activity",
    route((req, res) => {
      const room = memberRoom(db, req, res);
      if (!room) return;
      const before = Number(req.query.before);
      const who = typeof req.query.who === "string" && req.query.who ? req.query.who.slice(0, 200) : undefined;
      res.json(spaceActivity(db, room.id, { before: Number.isFinite(before) && before > 0 ? before : undefined, who }));
    }),
  );
  // The Artifacts tab: what the space made, newest first, and one of them opened.
  app.get(
    "/api/rooms/:id/artifacts",
    route((req, res) => {
      const room = memberRoom(db, req, res);
      if (!room) return;
      const list = spaceArtifacts(db, room.id);
      const have = new Set(list.artifacts.map((a) => a.id));
      res.json({ ...list, pinned: db.pinnedArtifacts(room.id, req.user!.id).filter((id) => have.has(id)) });
    }),
  );
  // { pinned }: this person's own pin on an artifact. Nobody else's Artifacts tab changes.
  app.put(
    "/api/rooms/:id/artifacts/:artifactId/pin",
    route((req, res) => {
      const room = memberRoom(db, req, res);
      if (!room) return;
      if (typeof req.body?.pinned !== "boolean") return void res.status(400).json({ error: "Give pinned: true or false." });
      const id = String(req.params.artifactId).slice(0, 200);
      if (req.body.pinned && !spaceArtifacts(db, room.id).artifacts.some((a) => a.id === id)) return notFound(res, "That artifact isn't in this space any more.");
      db.pinArtifact(room.id, req.user!.id, id, req.body.pinned);
      res.json({ pinned: db.pinnedArtifacts(room.id, req.user!.id) });
    }),
  );
  app.get(
    "/api/rooms/:id/artifacts/:artifactId",
    route((req, res) => {
      const room = memberRoom(db, req, res);
      if (!room) return;
      const detail = artifactDetail(db, room.id, String(req.params.artifactId).slice(0, 200));
      if (!detail) return notFound(res, "That artifact isn't in this space any more.");
      res.json(detail);
    }),
  );
  // Move a doc, a deck or a sketch to a project ({ project: "<id>" }) or to Unassigned ({ project: null }).
  app.put(
    "/api/rooms/:id/artifacts/:artifactId/project",
    route((req, res) => {
      const room = memberRoom(db, req, res);
      if (!room) return;
      const project = typeof req.body?.project === "string" && req.body.project ? req.body.project.slice(0, 40) : null;
      const moved = moveArtifact(db, room.id, String(req.params.artifactId).slice(0, 200), project, req.user!.name);
      if (moved === "missing") return notFound(res, "That artifact isn't in this space any more.");
      if (moved === "spec") return void res.status(400).json({ error: "A spec is in its to-do's project. Move the to-do." });
      if (moved === "project") return void res.status(400).json({ error: "That project isn't in this space." });
      res.json({ ok: true });
    }),
  );
  app.get(
    "/api/spaces",
    route((req, res) => {
      const user = req.user!;
      // Your to-dos whose work is in (a PR reported ready) and waits on your look, per space.
      const waiting = new Map<string, number>();
      for (const u of db.readyToShip()) {
        const n = u.noteId ? db.getNote(u.noteId) : null;
        if (n && ownedBy(n.owner, user.name)) waiting.set(n.roomId, (waiting.get(n.roomId) ?? 0) + 1);
      }
      // Your open tasks where a comment tags you, per space.
      const mentioned = new Map<string, Set<string>>();
      for (const u of db.openMentions(user.id)) {
        if (!mentioned.has(u.roomId)) mentioned.set(u.roomId, new Set());
        mentioned.get(u.roomId)!.add(u.noteId);
      }
      const unread = db.unreadChat(user.id);
      const chatMentions = unreadChatMentions(db, user.id);
      const spaces = db.spaceRows(user.id).map((row) => {
        const live = sessions.get(row.id);
        const state = live && !live.ended ? live.state() : null;
        const on = state && state.participants.length > 0;
        return toSpaceSummary(
          row,
          user,
          on
            ? {
                people: state.participants.map(({ name, picture }) => ({ name, picture })),
                focusTitle: state.items.find((i) => i.id === state.focusItemId)?.title ?? null,
                since: state.meetingStartedAt,
                // You're in this call yourself (from the Mac app or a browser).
                you: Boolean(live?.has(user.id)),
              }
            : null,
          waiting.get(row.id) ?? 0,
          mentioned.get(row.id)?.size ?? 0,
          unread.get(row.id) ?? 0,
          chatMentions.get(row.id) ?? 0,
        );
      });
      res.json(spaces.sort((a, b) => b.activeAt - a.activeAt));
    }),
  );

  /** Rename a space or change its purpose: only whoever created it and its admins (or anyone, for
   *  older spaces with no creator). Anyone in the space can change its synthesis instructions. */
  app.patch(
    "/api/rooms/:id",
    route((req, res) => {
      const room = db.getRoom(req.params.id);
      if (!room) return notFound(res, "Space not found");
      const name = req.body?.name === undefined ? undefined : String(req.body.name).trim().slice(0, 80);
      const purpose = req.body?.purpose === undefined ? undefined : String(req.body.purpose).trim().slice(0, 200);
      const synthesisInstructions =
        req.body?.synthesisInstructions === undefined ? undefined : String(req.body.synthesisInstructions).trim().slice(0, MAX_SYNTHESIS_INSTRUCTIONS);
      const adminOnly = name !== undefined || purpose !== undefined;
      if (adminOnly && !db.managesSpace(room, req.user!.id)) return void res.status(403).json({ error: "Only an admin of this space can change it" });
      if (!adminOnly && !db.isMember(room.id, req.user!.id)) return notFound(res, "Space not found");
      if (name === "") return void res.status(400).json({ error: "A space needs a name" });
      db.updateRoom(room.id, { name, purpose, synthesisInstructions });
      if (name) sessions.get(room.id)?.renamed(name);
      res.json(db.getRoom(room.id));
    }),
  );

  // The people in a space and who manages it. The creator and admins make people admins and take that back.
  const spaceMembers = (room: { id: string; createdBy: string | null }, userId: string): SpaceMembers => ({
    canManage: db.managesSpace(room, userId),
    members: db.spaceMembers(room, userId),
  });
  app.get(
    "/api/rooms/:id/members",
    route((req, res) => {
      const room = memberRoom(db, req, res);
      if (room) res.json(spaceMembers(room, req.user!.id));
    }),
  );
  app.put(
    "/api/rooms/:id/members/:userId",
    route((req, res) => {
      const room = memberRoom(db, req, res);
      if (!room) return;
      if (!db.managesSpace(room, req.user!.id)) return void res.status(403).json({ error: "Only an admin of this space can change its admins" });
      if (typeof req.body?.admin !== "boolean") return void res.status(400).json({ error: "Say whether they're an admin" });
      if (req.params.userId === room.createdBy) return void res.status(400).json({ error: "The person who created the space always manages it" });
      if (!db.setAdmin(room.id, req.params.userId, req.body.admin)) return notFound(res, "That person isn't in this space");
      res.json(spaceMembers(room, req.user!.id));
    }),
  );

  // What Stand's Claude calls for the space cost over the last `days` days (usage.ts). Only its admins see it.
  app.get(
    "/api/rooms/:id/cost",
    route((req, res) => {
      const room = memberRoom(db, req, res);
      if (!room) return;
      if (!db.managesSpace(room, req.user!.id)) return void res.status(403).json({ error: "Only an admin of this space can see what it spent" });
      res.json(db.spaceCost(room.id, costRange(req.query.days, req.query.tz, Date.now())));
    }),
  );

  app.post(
    "/api/rooms",
    route((req, res) => {
      const name =
        String(req.body?.name ?? "")
          .trim()
          .slice(0, 80) || "New space";
      const purpose = String(req.body?.purpose ?? "")
        .trim()
        .slice(0, 200);
      const room = db.createRoom(name, req.user!.id, purpose);
      db.touchMembership(room.id, req.user!.id);
      res.json(room);
    }),
  );

  app.get(
    "/api/rooms/:id",
    route((req, res) => {
      const room = db.getRoom(req.params.id);
      if (!room) return notFound(res, "Space not found");
      db.touchMembership(room.id, req.user!.id);
      const live = sessions.get(room.id);
      const graph = db.projectGraph(room.id);
      const grouped = <T extends Note>(notes: T[]) => db.withProjects(room.id, notes, graph);
      res.json({
        ...room,
        items: db.listItems(room.id),
        decks: db.listDecks(room.id),
        projects: db.listProjects(room.id, graph),
        pinnedProjects: db.pinnedProjects(room.id, req.user!.id),
        meetings: db.listMeetings(room.id),
        followUps: grouped(withFrom(db, db.roomFollowUps(room.id).filter((f) => !f.doneAt))),
        doneFollowUps: grouped(
          withFrom(
            db,
            db
              .roomFollowUps(room.id)
              .filter((f) => f.doneAt)
              .sort((a, b) => b.doneAt! - a.doneAt!),
          ),
        ),
        liveMeetingId: live && !live.ended ? live.meetingId : null,
        // Who is in the call now, for the lobby's avatars.
        people: live && !live.ended ? live.state().participants.map(({ name, picture }) => ({ name, picture })) : [],
      });
    }),
  );
  app.post(
    "/api/rooms/:id/items",
    route((req, res) => {
      const room = db.getRoom(req.params.id);
      if (!room) return notFound(res);
      const lines: string[] = (Array.isArray(req.body?.titles) ? req.body.titles : [])
        .map((t: unknown) => String(t).trim().slice(0, 300))
        .filter(Boolean)
        .slice(0, 100);
      db.addItems(
        room.id,
        lines.map((title) => ({ source: "agenda", externalId: null, title, url: null, description: null })),
      );
      res.json(afterItemsChange(room.id));
    }),
  );

  app.post(
    "/api/rooms/:id/items/linear",
    route(async (req, res) => {
      const room = db.getRoom(req.params.id);
      if (!room) return notFound(res);
      try {
        const items = await importFromLinear(String(req.body?.input ?? ""));
        if (!items.length) return res.status(400).json({ error: "No open issues found there." });
        db.addItems(room.id, items);
        res.json(afterItemsChange(room.id));
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
      }
    }),
  );
  app.delete(
    "/api/rooms/:id/items/:itemId",
    route((req, res) => {
      const item = db.getItem(req.params.itemId);
      if (!item || item.roomId !== req.params.id) return notFound(res);
      db.archiveItem(item.id);
      res.json(afterItemsChange(item.roomId));
    }),
  );

  // Undo for "Remove from agenda": the items come back where they were.
  app.post(
    "/api/rooms/:id/items/restore",
    route((req, res) => {
      const room = db.getRoom(req.params.id);
      if (!room) return notFound(res);
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((x: unknown) => typeof x === "string").slice(0, 500) : [];
      db.unarchiveItems(room.id, ids);
      res.json(afterItemsChange(room.id));
    }),
  );

  app.get(
    "/api/items/:itemId/history",
    route((req, res) => {
      const item = db.getItem(req.params.itemId);
      if (!item) return notFound(res);
      const body: ItemHistory = { item, deck: item.deckId ? db.getDeck(item.deckId) : null, meetings: db.itemHistory(item.id) };
      res.json({ ...body, room: db.getRoom(item.roomId) });
    }),
  );
  // The space page's feed: snaps saved to the space, meetings, agents' updates, and what's
  // decided and open across it.
  app.get(
    "/api/rooms/:id/feed",
    route((req, res) => {
      const room = db.getRoom(req.params.id);
      if (!room) return notFound(res, "Space not found");
      db.touchMembership(room.id, req.user!.id);
      res.json({ ...spaceFeed(db, room.id), mentions: db.openMentions(req.user!.id, room.id).map(mentionView) });
    }),
  );

  // The agent's suggested agenda for the space: what's open from earlier
  // meetings and what changed since, ranked, each with a reason.
  app.get(
    "/api/rooms/:id/suggested.json",
    route((req, res) => {
      const room = db.getRoom(req.params.id);
      if (!room) return notFound(res);
      res.json({
        schema: "stand.suggested-agenda/v1",
        space: { id: room.id, name: room.name },
        ...upNextView(db, room.id, live(room.id)?.meetingStartedAt ?? null, polisher.busy(room.id)),
      });
    }),
  );

  // Archive a row off the space page ({ ref: "todo:<id>" }, see archive.ts), or restore it ({ archived: false }).
  app.post(
    "/api/rooms/:id/archive",
    route((req, res) => {
      const room = db.getRoom(req.params.id);
      if (!room) return notFound(res);
      const ref = String(req.body?.ref ?? "");
      const keys: unknown[] = Array.isArray(req.body?.keys) ? req.body.keys : [];
      const ok =
        req.body?.archived === false
          ? restoreRow(db, room.id, ref)
          : archiveRow(db, room.id, ref, req.user!.name, {
              title: String(req.body?.title ?? ""),
              keys: keys.filter((k): k is string => typeof k === "string"),
            });
      if (!ok) return notFound(res);
      // Agenda items, decks and suggestions came off (or back onto) the agenda too.
      if (/^(item|deck|suggestion):/.test(ref)) afterItemsChange(room.id);
      res.json({ ok: true });
    }),
  );
  app.post(
    "/api/rooms/:id/token",
    route(async (req, res) => {
      if (!capabilities().livekit) return res.json({ url: null, token: null });
      const room = db.getRoom(req.params.id);
      if (!room) return notFound(res);
      const user = req.user!;
      res.json({ url: config.livekit.url, token: await participantToken(room.id, user.id, user.name) });
    }),
  );
}
