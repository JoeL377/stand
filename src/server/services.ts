// What the server's routes and its WebSocket share: the database, the model, the meetings running
// now, and the background jobs that tell them when something changed. Made once, at start.
import { meetingTimeline } from "./timeline.ts";
import path from "node:path";
import type { Note } from "../shared/protocol.ts";
import { agentApi } from "./agents.ts";
import { buildBrief } from "./brief.ts";
import { Chat } from "./chat.ts";
import { ChatAsks } from "./chatAgent.ts";
import { ChatCapture } from "./chatCapture.ts";
import { capabilities, config } from "./config.ts";
import { type DB, type OpenMeeting, openDb } from "./db.ts";
import { specChanged } from "./designReviews.ts";
import { DoneDecks } from "./doneDeck.ts";
import { GithubApp, appReady } from "./github.ts";
import { startLiveKitTranscriber } from "./livekit.ts";
import { createAgent } from "./llm.ts";
import { labeled } from "./usage.ts";
import { PlanBriefs } from "./planBrief.ts";
import { Push } from "./push.ts";
import { ProjectSuggester, SUGGEST_AFTER_CHANGE_MS, SUGGEST_AFTER_PROJECT_MS } from "./projectSuggest.ts";
import { QuestionSweeper } from "./questionSweep.ts";
import { Sources, setSources } from "./sources.ts";
import { RoomSession } from "./room.ts";
import { ShipWatch, githubPrState } from "./shipWatch.ts";
import { linkSnaps } from "./snaps.ts";
import { SpaceEvents } from "./spaceEvents.ts";
import { POLISH_BATCH_MS, UpNextPolisher, upNextView } from "./upNextPolish.ts";
import { setUsageSink } from "./usage.ts";
import { UploadLinks } from "./workLog.ts";

/** A meeting left running when the server stopped is picked up again if
 *  anything happened in it this recently; an older one gets its recap instead. */
const RESUME_WINDOW_MS = 30 * 60_000;
const recent = (m: OpenMeeting) => Date.now() - m.activeAt < RESUME_WINDOW_MS;
/** People who arrive while a meeting is being written up wait for it, unless the write-up is stuck. */
const WAIT_FOR_RECAP_MS = 3 * 60_000;

export type Services = ReturnType<typeof startServices>;

export function startServices() {
  const db = openDb(path.join(config.dataDir, "standup.db"));
  setUsageSink((row) => db.addUsage(row));
  // Calls made outside a meeting are kept under their task name in llm_usage (usage.ts).
  const agent = labeled(createAgent());
  const planBriefs = new PlanBriefs(db, agent);
  const sessions = new Map<string, RoomSession>();
  /** The meeting running in a space now, if one is. */
  const live = (roomId: string) => {
    const s = sessions.get(roomId);
    return s && !s.ended ? s : null;
  };
  const polisher = new UpNextPolisher(
    db,
    agent,
    (roomId) => live(roomId)?.meetingStartedAt ?? null,
    (roomId) => live(roomId)?.upNextChanged(),
  );
  // "Done since last time": rewritten each time a task closes between meetings, ready for the next one.
  const doneDecks = new DoneDecks(
    db,
    agent,
    (roomId) => !!live(roomId),
    (roomId) => live(roomId)?.followUpsChanged(),
  );
  // Stand's project suggestions for to-dos nobody filed (projectSuggest.ts).
  const projectSuggester = new ProjectSuggester(db, agent, (roomId) => live(roomId)?.followUpsChanged());
  // Stand's sweep of open questions, after enough new ones or new decisions (questionSweep.ts).
  const questionSweeper = new QuestionSweeper(db, agent);

  /** The space's meeting, started or picked up as someone arrives. Null when there's no such space. */
  function session(roomId: string): RoomSession | null {
    const existing = sessions.get(roomId);
    if (existing && !existing.released && (!existing.ended || Date.now() - existing.endingSince < WAIT_FOR_RECAP_MS)) return existing;
    const room = db.getRoom(roomId);
    if (!room) return null;
    // The server may have stopped mid-meeting (every deploy does): carry on with it.
    let resume: OpenMeeting | null = null;
    for (const m of db.openMeetings(roomId)) {
      if (m.id === existing?.meetingId || writingUp.has(m.id)) continue; // still being written up
      // One someone ended is written up, never resumed: its people have already gone to the recap.
      if (!resume && !finishing.has(m.id) && !m.endRequestedAt && recent(m)) resume = m;
      else finishOpenMeeting(m);
    }
    const s = new RoomSession(
      db,
      agent,
      room,
      (closed) => {
        writingUp.delete(closed.meetingId);
        if (sessions.get(roomId) === closed) sessions.delete(roomId);
        // The recap is saved: what the meeting caught can be filed, and read against the open questions.
        projectSuggester.schedule(roomId, 0);
        questionSweeper.schedule(roomId, 0);
      },
      capabilities().transcription !== "browser" ? (r) => startLiveKitTranscriber(roomId, r, () => keytermsFor(roomId, room.name)) : undefined,
      polisher,
      resume,
      planBriefs,
    );
    // Ended: its recap is written in the background, and the next person to arrive starts a new call.
    s.onRelease = (released) => {
      writingUp.add(released.meetingId);
      if (sessions.get(roomId) === released) sessions.delete(roomId);
    };
    sessions.set(roomId, s);
    if (resume) console.log(`[room] ${roomId}: picked up meeting ${resume.id} after a restart`);
    return s;
  }

  /** What speech-to-text listens for in a room: the space's name, "Stand" and the first names of its
   *  members, which it otherwise mishears ("Duke" for Huy, "Stan" for Stand). */
  function keytermsFor(roomId: string, spaceName: string): string[] {
    const names = db.memberNames(roomId).map((n) => n.trim().split(/\s+/)[0]).filter((n) => n.length > 1);
    return [...new Set([spaceName.trim(), "Stand", ...names].filter(Boolean))].slice(0, 100);
  }

  /** Meetings whose people have gone to the recap while it is written. */
  const writingUp = new Set<string>();
  /** Meetings being written up after the fact, one at a time. */
  const finishing = new Set<string>();
  let finishQueue = Promise.resolve();
  function finishOpenMeeting(m: OpenMeeting) {
    if (finishing.has(m.id)) return;
    finishing.add(m.id);
    const room = db.getRoom(m.roomId);
    // Nothing was said: nothing to write up.
    if (!room || !m.segmentCount) return db.endMeeting(m.id, null, null, m.activeAt);
    finishQueue = finishQueue
      .then(() => new RoomSession(db, agent, room, () => {}, undefined, polisher, m).end(m.activeAt))
      .then(() => console.log(`[room] ${m.roomId}: wrote up meeting ${m.id}, left open by an earlier run`))
      .catch((err) => console.error("[room] writing up an open meeting failed:", err));
  }

  // On start: meetings the last run left open come back if they're recent (and
  // end as usual if nobody returns); older ones get the recap they missed.
  const open = db.openMeetings();
  for (const roomId of new Set(open.map((m) => m.roomId))) {
    if (open.some((m) => m.roomId === roomId && recent(m))) session(roomId);
    else for (const m of open.filter((x) => x.roomId === roomId)) finishOpenMeeting(m);
  }

  // The Stand GitHub App, when this server has it set up.
  const githubApp = appReady(config.githubApp) ? new GithubApp(config.githubApp, db.raw) : null;

  /** A meeting's segments and notes grouped by agenda item, in agenda order. */
  function meetingGroups(m: { id: string; roomId: string }, baseUrl = "") {
    const segments = db.meetingSegments(m.id);
    const notes = db.meetingNotes(m.id);
    const discussions = db.meetingDiscussions(m.id);
    const snaps = linkSnaps(db.meetingSnaps(m.id), segments, discussions, baseUrl);
    const ids = [...new Set([...segments.map((s) => s.itemId), ...notes.map((n) => n.itemId), ...snaps.map((s) => s.itemId)])];
    const items = db.listItems(m.roomId);
    ids.sort((a, b) => (items.find((i) => i.id === a)?.position ?? 1e9) - (items.find((i) => i.id === b)?.position ?? 1e9));
    return ids.map((id) => ({
      item: id ? db.getItem(id) : null,
      segments: segments.filter((s) => s.itemId === id),
      notes: notes.filter((n) => n.itemId === id),
      discussions: discussions.filter((d) => d.itemId === id),
      snaps: snaps.filter((s) => s.itemId === id),
    }));
  }

  /** The agenda changed: a call running in the space sees it. Returns the agenda as it is now. */
  const afterItemsChange = (roomId: string) => {
    sessions.get(roomId)?.itemsChanged();
    return db.listItems(roomId);
  };

  /** An agenda item in this room that decks can sit under (not a slide itself). */
  const parentFor = (roomId: string, id: unknown): string | null => {
    const item = id ? db.getItem(String(id)) : null;
    return item && item.roomId === roomId && !item.deckId && db.listItems(roomId).some((i) => i.id === item.id) ? item.id : null;
  };

  // ---- agents: the Stand MCP and the Copy for agent button ---------------------

  const uploadLinks = new UploadLinks();
  /** A plan in a running design review changed (a comment, a new version, the author's edit): its
   *  slides are laid out again for the people in the call. */
  function specTouched(task: Note & { roomId: string }) {
    const s = sessions.get(task.roomId);
    if (specChanged(db, planBriefs, task)) s?.itemsChanged();
  }

  const agents = agentApi({
    db,
    briefs: planBriefs,
    specTouched,
    brainstormTouched: (roomId) => {
      const s = sessions.get(roomId);
      if (!s) return;
      s.itemsChanged();
      s.brainstormChanged();
    },
    uploads: uploadLinks,
    readyToShip: () => void shipWatch.check(),
    liveMeeting: (roomId) => {
      const s = live(roomId);
      return s ? { meeting_id: s.meetingId, people: s.state().participants.map((p) => p.name) } : null;
    },
    call: (roomId) => {
      const s = live(roomId);
      return s
        ? {
            meetingId: s.meetingId,
            startedAt: s.meetingStartedAt,
            people: s.state().participants.map((p) => p.name),
            tail: (since) => s.tail(since),
            say: (actor, out, askId) => s.agentSay(actor, out, askId),
            wait: (actor, ms, signal) => s.waitForAsk(actor, ms, signal),
          }
        : null;
    },
    notify: (roomId, what) => {
      const s = live(roomId);
      if (s) what === "updates" ? s.updatesChanged() : s.followUpsChanged();
      // Between meetings, let reports settle, then tidy the next agenda and what's been done.
      else {
        polisher.schedule(roomId, POLISH_BATCH_MS);
        doneDecks.schedule(roomId);
        projectSuggester.schedule(roomId, SUGGEST_AFTER_CHANGE_MS);
        questionSweeper.schedule(roomId);
      }
    },
    projectsChanged: (roomId) => projectSuggester.schedule(roomId, SUGGEST_AFTER_PROJECT_MS),
    suggested: (roomId) => upNextView(db, roomId, live(roomId)?.meetingStartedAt ?? null, polisher.busy(roomId)),
    brief: (meetingId, baseUrl, transcript) => {
      const m = db.getMeeting(meetingId)!;
      return buildBrief({
        meeting: m,
        roomName: db.getRoom(m.roomId)!.name,
        synthesisInstructions: db.getRoom(m.roomId)!.synthesisInstructions,
        groups: meetingGroups(m, baseUrl),
        decks: db.listDecks(m.roomId),
        baseUrl,
        followUps: db.roomFollowUps(m.roomId),
        itemById: (id) => db.getItem(id),
        discussionById: (id) => db.getDiscussion(id),
        withTranscript: transcript,
        timeline: transcript ? meetingTimeline(db, m.id) : undefined,
      });
    },
  });

  // To-dos an agent finished as a PR get checked off when the PR merges.
  const shipWatch = new ShipWatch(
    db,
    (roomId) => {
      const s = live(roomId);
      if (s) s.followUpsChanged();
      else {
        polisher.schedule(roomId, POLISH_BATCH_MS);
        doneDecks.schedule(roomId);
      }
    },
    (link) => (githubApp ? githubApp.prState(link, config.githubToken) : githubPrState(link, config.githubToken)),
  );
  shipWatch.start();
  doneDecks.start();
  projectSuggester.start();
  questionSweeper.start();

  // A space's sources: GitHub repos it links, which Stand reads and Ask Stand knows (sources.ts).
  const sources = new Sources(db.raw, path.join(config.dataDir, "repos"), githubApp);
  setSources(sources);
  sources.start();

  // Chat between meetings (chat.ts). Sessions left open by the last run close here if they went quiet.
  const spaceEvents = new SpaceEvents();
  // What is written there is read for to-dos, open questions and decisions, as a meeting's talk is (chatCapture.ts).
  const capture = config.chatCapture
    ? new ChatCapture(
        db,
        agent,
        (roomId, e) => {
          spaceEvents.send(roomId, e);
          // The run over a session that closed is its last: what it caught can be filed.
          if (e.type === "notes" && db.getChannel(e.channelId)?.openSessionId !== e.sessionId) {
            projectSuggester.schedule(roomId, 0);
            questionSweeper.schedule(roomId, 0);
          }
        },
        { quietMs: config.chatCaptureQuietMs ?? undefined, maxWaitMs: config.chatCaptureMaxWaitMs ?? undefined },
      )
    : null;
  // Notifications on the iPhone app for new chat messages (push.ts).
  const push = new Push(db, config.apns);
  let asks: ChatAsks | null = null;
  const chat = new Chat(
    db,
    (roomId, e) => {
      spaceEvents.send(roomId, e);
      capture?.heard(e);
      push.heard(roomId, e);
      asks?.heard(roomId, e);
    },
    { quietMs: config.chatQuietMs ?? undefined },
  );
  // Stand answers in the chat when someone tags it (chatAgent.ts).
  asks = new ChatAsks(db, chat, agent, (roomId, e) => spaceEvents.send(roomId, e));
  // An agent's report on a to-do shows in the chat as one line: the open pages read the reports again.
  const addUpdate = db.addUpdate.bind(db);
  db.addUpdate = (u) => {
    const update = addUpdate(u);
    if (update.client && update.noteId) spaceEvents.send(update.roomId, { type: "reports" });
    return update;
  };
  chat.start();
  capture?.start();

  return {
    db: db as DB,
    agent,
    planBriefs,
    sessions,
    live,
    session,
    polisher,
    doneDecks,
    projectSuggester,
    githubApp,
    shipWatch,
    sources,
    chat,
    spaceEvents,
    push,
    agents,
    uploadLinks,
    specTouched,
    meetingGroups,
    afterItemsChange,
    parentFor,
  };
}
