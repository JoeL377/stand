// A meeting's recap and brief, and the space's follow-ups feed.
import type { Express } from "express";
import type { MeetingRecap } from "../../shared/protocol.ts";
import { brainstormOfMeeting } from "../brainstorm.ts";
import { briefToMarkdown, buildBrief, buildFollowUps, followUpsToMarkdown } from "../brief.ts";
import { designReviewOfMeeting } from "../designReviews.ts";
import { ideaReviewOfMeeting } from "../ideaReview.ts";
import { reviewOfMeeting } from "../reviews.ts";
import { suggestedNext } from "../nextSteps.ts";
import { meetingTimeline } from "../timeline.ts";
import { cleanMeetingTitle, meetingKindName } from "../meetingNames.ts";
import { forgetMeetingFrom } from "../noteFrom.ts";
import type { Services } from "../services.ts";
import { notFound, route } from "./http.ts";

export function meetingRoutes(app: Express, ctx: Services) {
  const { db, meetingGroups } = ctx;
  app.get(
    "/api/meetings/:id",
    route((req, res) => {
      const m = db.getMeeting(req.params.id);
      if (!m) return notFound(res);
      const room = db.getRoom(m.roomId)!;
      const body: MeetingRecap = {
        meetingId: m.id,
        title: m.title,
        kindName: meetingKindName(db, m.id),
        roomId: m.roomId,
        roomName: room.name,
        startedAt: m.startedAt,
        endedAt: m.endedAt,
        writingUp: !m.endedAt && !!m.endRequestedAt,
        summary: m.summary,
        synthesis: m.synthesis,
        items: meetingGroups(m),
        chapters: m.chapters,
        cost: db.meetingCost(m.id),
        review: reviewOfMeeting(db, m.id),
        ideaReview: ideaReviewOfMeeting(db, m.id),
        designReview: designReviewOfMeeting(db, m.id),
        brainstorm: brainstormOfMeeting(db, m.id),
        next: suggestedNext(db.meetingNext(m.id)),
        timeline: meetingTimeline(db, m.id),
      };
      res.json(body);
    }),
  );

  // Names a meeting, for anyone in its space. An empty title goes back to the name its kind gives it.
  app.put(
    "/api/meetings/:id/title",
    route((req, res) => {
      const m = db.getMeeting(req.params.id);
      if (!m || m.added || m.chat || !db.isMember(m.roomId, req.user!.id)) return notFound(res);
      const title = cleanMeetingTitle(req.body?.title);
      db.setMeetingTitle(m.id, title);
      forgetMeetingFrom(m.id);
      res.json({ title, kindName: meetingKindName(db, m.id) });
    }),
  );

  // The meeting brief for follow-up: /brief.json for agents and tools,
  // /brief.md for pasting. Add ?transcript=1 to include what was said.
  app.get(
    "/api/meetings/:id/brief.:format",
    route((req, res) => {
      const m = db.getMeeting(req.params.id);
      if (!m || !["json", "md"].includes(req.params.format)) return notFound(res);
      const brief = buildBrief({
        meeting: m,
        roomName: db.getRoom(m.roomId)!.name,
        synthesisInstructions: db.getRoom(m.roomId)!.synthesisInstructions,
        groups: meetingGroups(m, `${req.protocol}://${req.get("host")}`),
        decks: db.listDecks(m.roomId),
        baseUrl: `${req.protocol}://${req.get("host")}`,
        followUps: db.roomFollowUps(m.roomId),
        itemById: (id) => db.getItem(id),
        discussionById: (id) => db.getDiscussion(id),
        withTranscript: req.query.transcript === "1",
        timeline: req.query.transcript === "1" ? meetingTimeline(db, m.id) : undefined,
      });
      if (req.params.format === "json") return void res.json(brief);
      res.type("text/markdown; charset=utf-8").send(briefToMarkdown(brief));
    }),
  );

  // The room's follow-ups across meetings: the standing to-do list for people
  // and agents. ?status=open (default), done or all; .json or .md.
  app.get(
    "/api/rooms/:id/followups.:format",
    route((req, res) => {
      const room = db.getRoom(req.params.id);
      if (!room || !["json", "md"].includes(req.params.format)) return notFound(res);
      const status = (["open", "done", "all"] as const).find((s) => s === req.query.status) ?? "open";
      const feed = buildFollowUps({
        room,
        followUps: db.roomFollowUps(room.id),
        itemById: (id) => db.getItem(id),
        decks: db.listDecks(room.id),
        baseUrl: `${req.protocol}://${req.get("host")}`,
        status,
        discussionById: (id) => db.getDiscussion(id),
      });
      if (req.params.format === "json") return void res.json(feed);
      res.type("text/markdown; charset=utf-8").send(followUpsToMarkdown(feed));
    }),
  );
}
