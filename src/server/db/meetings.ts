// Meetings: what was said (segments), where the focus was, the live board's saved state, and cost.
import type { StageEvent, StageView } from "../../shared/timeline.ts";
import type { DatabaseSync } from "node:sqlite";
import type { AgentCard, Board, ChapterRecap, MeetingCost, NextStep, Segment, SpaceCost } from "../../shared/protocol.ts";
import { newId } from "../ids.ts";
import type { ListItem } from "../liveList.ts";
import { costOf, type UsageRow } from "../usage.ts";
import { DISCUSSION_SELECT, type OpenMeeting, type Row, toDiscussion, toNote, toSegment } from "./rows.ts";

const USAGE_SUMS = "SUM(input) AS input, SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write, SUM(output) AS output, COUNT(*) AS calls";
const priced = (r: Row) => costOf({ model: r.model as string, input: r.input as number, cacheRead: r.cache_read as number, cacheWrite: r.cache_write as number, output: r.output as number });

/** Usage summed by task and model, as dollars by task, most expensive first. */
function costByTask(rows: Row[]): MeetingCost {
  const byTask = new Map<string, { usd: number; calls: number }>();
  for (const r of rows) {
    const t = byTask.get(r.task as string) ?? { usd: 0, calls: 0 };
    byTask.set(r.task as string, { usd: t.usd + priced(r), calls: t.calls + (r.calls as number) });
  }
  const tasks = [...byTask].map(([task, t]) => ({ task, ...t })).sort((a, b) => b.usd - a.usd);
  return { usd: tasks.reduce((s, t) => s + t.usd, 0), calls: tasks.reduce((s, t) => s + t.calls, 0), tasks };
}

export function meetingsStore(db: DatabaseSync) {
  return {
    startMeeting(roomId: string) {
      const id = newId();
      const startedAt = Date.now();
      db.prepare("INSERT INTO meetings (id, room_id, started_at) VALUES (?, ?, ?)").run(id, roomId, startedAt);
      return { id, startedAt };
    },
    endMeeting(id: string, summary: string | null, synthesis: string | null = null, at = Date.now(), chapters: ChapterRecap[] = []) {
      db.prepare("UPDATE meetings SET ended_at = ?, summary = ?, synthesis = ?, chapters_json = ? WHERE id = ?").run(
        at,
        summary,
        synthesis,
        chapters.length ? JSON.stringify(chapters) : null,
        id,
      );
    },
    /** Someone pressed End meeting; the recap is being written. A restart before it's done finishes the job instead of resuming. */
    meetingEnding(id: string) {
      db.prepare("UPDATE meetings SET end_requested_at = COALESCE(end_requested_at, ?) WHERE id = ?").run(Date.now(), id);
    },
    /** Names a meeting; null or blank goes back to the name its kind gives it. */
    setMeetingTitle(id: string, title: string | null) {
      db.prepare("UPDATE meetings SET title = ? WHERE id = ?").run(title?.trim() || null, id);
    },
    setMeetingHost(id: string, hostId: string | null) {
      db.prepare("UPDATE meetings SET host_id = ? WHERE id = ?").run(hostId, id);
    },
    /** Meetings that were never ended (the server stopped while they ran), with
     *  when anything last happened in them. Newest first. */
    openMeetings(roomId?: string): OpenMeeting[] {
      return (
        db
          .prepare(
            `SELECT m.id, m.room_id, m.started_at, m.host_id, m.end_requested_at,
               (SELECT COUNT(*) FROM segments s WHERE s.meeting_id = m.id) AS n,
               MAX(m.started_at,
                 COALESCE((SELECT MAX(ts) FROM segments s WHERE s.meeting_id = m.id), 0),
                 COALESCE((SELECT MAX(ts) FROM focus_events f WHERE f.meeting_id = m.id), 0),
                 COALESCE((SELECT MAX(ts) FROM notes n WHERE n.meeting_id = m.id), 0)) AS active_at
             FROM meetings m WHERE m.ended_at IS NULL AND (? IS NULL OR m.room_id = ?) ORDER BY m.started_at DESC`,
          )
          .all(roomId ?? null, roomId ?? null) as Row[]
      ).map((r) => ({
        id: r.id as string,
        roomId: r.room_id as string,
        startedAt: r.started_at as number,
        hostId: (r.host_id as string) ?? null,
        endRequestedAt: (r.end_requested_at as number) ?? null,
        segmentCount: r.n as number,
        activeAt: r.active_at as number,
      }));
    },
    /** Where the meeting's focus went, in order, for picking up after a restart. */
    focusHistory(meetingId: string): Array<{ ts: number; itemId: string | null }> {
      return (db.prepare("SELECT item_id, ts FROM focus_events WHERE meeting_id = ? ORDER BY ts, rowid").all(meetingId) as Row[]).map((r) => ({
        ts: r.ts as number,
        itemId: (r.item_id as string) ?? null,
      }));
    },
    getMeeting(id: string) {
      const r = db.prepare("SELECT * FROM meetings WHERE id = ?").get(id) as Row | undefined;
      if (!r) return null;
      return {
        id: r.id as string,
        roomId: r.room_id as string,
        startedAt: r.started_at as number,
        endedAt: (r.ended_at as number) ?? null,
        /** Someone ended it; until endedAt is set the recap is still being written. */
        endRequestedAt: (r.end_requested_at as number) ?? null,
        summary: (r.summary as string) ?? null,
        /** The name someone gave it; null keeps the name its kind gives it. */
        title: (r.title as string) ?? null,
        /** What the space's synthesis instructions asked for, as Markdown; null without instructions. */
        synthesis: (r.synthesis as string) ?? null,
        /** What the recap wrote about each chapter. */
        chapters: (r.chapters_json ? JSON.parse(r.chapters_json as string) : []) as ChapterRecap[],
        /** Not a meeting: the holder of a to-do someone added by hand (see addTask). */
        added: r.kind === "added",
        /** Not a meeting: a stretch of a space's chat (chat.ts). */
        chat: r.kind === "chat",
      };
    },
    listMeetings(roomId: string) {
      return (
        db
          .prepare(
            `SELECT m.*, (SELECT COUNT(*) FROM segments s WHERE s.meeting_id = m.id) AS n
             FROM meetings m WHERE room_id = ? AND kind IS NULL ORDER BY started_at DESC LIMIT 50`,
          )
          .all(roomId) as Row[]
      ).map((r) => ({
        id: r.id as string,
        startedAt: r.started_at as number,
        endedAt: (r.ended_at as number) ?? null,
        summary: (r.summary as string) ?? null,
        segmentCount: r.n as number,
      }));
    },
    addSegment(s: Omit<Segment, "id">): Segment {
      const seg = { ...s, id: newId(12) };
      db.prepare(
        "INSERT INTO segments (id, meeting_id, item_id, speaker_id, speaker_name, kind, text, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(seg.id, seg.meetingId, seg.itemId, seg.speakerId, seg.speakerName, seg.kind, seg.text, seg.ts);
      return seg;
    },
    appendSegmentText(id: string, text: string): Segment | null {
      db.prepare("UPDATE segments SET text = text || ' ' || ? WHERE id = ?").run(text, id);
      const r = db.prepare("SELECT * FROM segments WHERE id = ?").get(id) as Row | undefined;
      return r ? toSegment(r) : null;
    },
    moveSegment(id: string, itemId: string | null): Segment | null {
      db.prepare("UPDATE segments SET item_id = ? WHERE id = ?").run(itemId, id);
      const r = db.prepare("SELECT * FROM segments WHERE id = ?").get(id) as Row | undefined;
      return r ? toSegment(r) : null;
    },
    /** Re-pins speech in [from, now] that was attached to `fromItem` onto `toItem`.
     *  Used when someone confirms an agent suggestion: the screen changed at
     *  `from`, so what was said since then belongs to the new item. */
    repinSince(meetingId: string, from: number, fromItem: string | null, toItem: string | null): Segment[] {
      const rows = db
        .prepare("SELECT * FROM segments WHERE meeting_id = ? AND ts >= ? AND item_id IS ?")
        .all(meetingId, from, fromItem) as Row[];
      const st = db.prepare("UPDATE segments SET item_id = ? WHERE id = ?");
      return rows.map((r) => {
        st.run(toItem, r.id as string);
        return { ...toSegment(r), itemId: toItem };
      });
    },
    saveList(meetingId: string, items: ListItem[]) {
      db.prepare("UPDATE meetings SET list_json = ? WHERE id = ?").run(JSON.stringify(items), meetingId);
    },
    saveMeetingNext(meetingId: string, steps: NextStep[]) {
      db.prepare("UPDATE meetings SET next_json = ? WHERE id = ?").run(steps.length ? JSON.stringify(steps) : null, meetingId);
    },
    meetingNext(meetingId: string): NextStep[] {
      const r = db.prepare("SELECT next_json FROM meetings WHERE id = ?").get(meetingId) as Row | undefined;
      return r?.next_json ? (JSON.parse(r.next_json as string) as NextStep[]) : [];
    },
    meetingList(meetingId: string): ListItem[] | null {
      const r = db.prepare("SELECT list_json FROM meetings WHERE id = ?").get(meetingId) as Row | undefined;
      return r?.list_json ? (JSON.parse(r.list_json as string) as ListItem[]) : null;
    },
    saveAgentCards(meetingId: string, cards: AgentCard[]) {
      db.prepare("UPDATE meetings SET agent_json = ? WHERE id = ?").run(JSON.stringify(cards), meetingId);
    },
    meetingAgentCards(meetingId: string): AgentCard[] | null {
      const r = db.prepare("SELECT agent_json FROM meetings WHERE id = ?").get(meetingId) as Row | undefined;
      return r?.agent_json ? (JSON.parse(r.agent_json as string) as AgentCard[]) : null;
    },
    saveBoard(meetingId: string, board: Board) {
      db.prepare("UPDATE meetings SET board_json = ? WHERE id = ?").run(JSON.stringify({ ...board, busy: false }), meetingId);
    },
    meetingBoard(meetingId: string): Board | null {
      const r = db.prepare("SELECT board_json FROM meetings WHERE id = ?").get(meetingId) as Row | undefined;
      return r?.board_json ? (JSON.parse(r.board_json as string) as Board) : null;
    },
    meetingSegments(meetingId: string): Segment[] {
      return (db.prepare("SELECT * FROM segments WHERE meeting_id = ? ORDER BY ts").all(meetingId) as Row[]).map(toSegment);
    },
    itemSegments(meetingId: string, itemId: string | null): Segment[] {
      return (db.prepare("SELECT * FROM segments WHERE meeting_id = ? AND item_id IS ? ORDER BY ts").all(meetingId, itemId) as Row[]).map(
        toSegment,
      );
    },
    /** The same, with who moved it and why ("manual", "pin", "suggestion", "system"), for the timeline. */
    focusEvents(meetingId: string): Array<{ id: string; ts: number; itemId: string | null; actor: string; reason: string }> {
      return (db.prepare("SELECT id, item_id, actor, reason, ts FROM focus_events WHERE meeting_id = ? ORDER BY ts, rowid").all(meetingId) as Row[]).map((r) => ({
        id: r.id as string,
        ts: r.ts as number,
        itemId: (r.item_id as string) ?? null,
        actor: r.actor as string,
        reason: r.reason as string,
      }));
    },
    /** What the main view showed from now on (see stage_events). */
    logStage(meetingId: string, view: StageView, ts = Date.now()) {
      db.prepare("INSERT INTO stage_events (id, meeting_id, ts, view_json) VALUES (?, ?, ?, ?)").run(newId(12), meetingId, ts, JSON.stringify(view));
    },
    stageEvents(meetingId: string): StageEvent[] {
      return (db.prepare("SELECT id, ts, view_json FROM stage_events WHERE meeting_id = ? ORDER BY ts, rowid").all(meetingId) as Row[]).map((r) => ({
        id: r.id as string,
        ts: r.ts as number,
        view: JSON.parse(r.view_json as string) as StageView,
      }));
    },
    logFocus(meetingId: string, itemId: string | null, actor: string, reason: string) {
      db.prepare("INSERT INTO focus_events (id, meeting_id, item_id, actor, reason, ts) VALUES (?, ?, ?, ?, ?, ?)").run(
        newId(12),
        meetingId,
        itemId,
        actor,
        reason,
        Date.now(),
      );
    },
    /** A space's finished meetings that had talk, newest first, with what came out of each. */
    feedMeetings(roomId: string, limit = 30) {
      return (
        db
          .prepare(
            `SELECT m.id, m.started_at, m.ended_at, m.summary, m.title,
               (SELECT COUNT(*) FROM notes n WHERE n.meeting_id = m.id AND n.kind = 'action') AS todos,
               (SELECT COUNT(*) FROM notes n WHERE n.meeting_id = m.id AND n.kind = 'decision') AS decided,
               (SELECT COUNT(*) FROM notes n WHERE n.meeting_id = m.id AND n.kind = 'question') AS open,
               (SELECT json_group_array(name) FROM (SELECT DISTINCT s.speaker_name AS name FROM segments s WHERE s.meeting_id = m.id)) AS people
             FROM meetings m
             WHERE m.room_id = ? AND m.kind IS NULL AND m.ended_at IS NOT NULL AND EXISTS (SELECT 1 FROM segments s WHERE s.meeting_id = m.id)
             ORDER BY m.started_at DESC LIMIT ?`,
          )
          .all(roomId, limit) as Row[]
      ).map((r) => ({
        id: r.id as string,
        startedAt: r.started_at as number,
        endedAt: r.ended_at as number,
        summary: (r.summary as string) ?? null,
        title: (r.title as string) ?? null,
        todos: r.todos as number,
        decided: r.decided as number,
        open: r.open as number,
        people: JSON.parse((r.people as string) ?? "[]") as string[],
      }));
    },
    /** The last finished meeting in a space before a time that more than one person talked in, so a
     *  quick test on your own doesn't count as "last time". */
    lastRealMeeting(roomId: string, before = Number.MAX_SAFE_INTEGER): { id: string; startedAt: number; endedAt: number } | null {
      const r = db
        .prepare(
          `SELECT m.id, m.started_at, m.ended_at FROM meetings m
           WHERE m.room_id = ? AND m.kind IS NULL AND m.started_at < ? AND m.ended_at IS NOT NULL
             AND (SELECT COUNT(DISTINCT s.speaker_name) FROM segments s WHERE s.meeting_id = m.id AND s.kind != 'chat') >= 2
           ORDER BY m.started_at DESC LIMIT 1`,
        )
        .get(roomId, before) as Row | undefined;
      return r ? { id: r.id as string, startedAt: r.started_at as number, endedAt: r.ended_at as number } : null;
    },
    addUsage(r: UsageRow) {
      db.prepare(
        "INSERT INTO llm_usage (meeting_id, room_id, task, model, input, cache_read, cache_write, output, at) VALUES (?, COALESCE(?, (SELECT room_id FROM meetings WHERE id = ?)), ?, ?, ?, ?, ?, ?, ?)",
      ).run(r.meetingId, r.roomId, r.meetingId, r.task, r.model, r.input, r.cacheRead, r.cacheWrite, r.output, r.at);
    },
    /** What a meeting's Claude calls cost, in dollars, in all and by task; null when none were recorded. */
    meetingCost(meetingId: string): MeetingCost | null {
      const rows = db
        .prepare(`SELECT task, model, ${USAGE_SUMS} FROM llm_usage WHERE meeting_id = ? GROUP BY task, model`)
        .all(meetingId) as Row[];
      return rows.length ? costByTask(rows) : null;
    },
    /** What a space's Claude calls cost from `since` up to `until`: in calls, in chat and between meetings, and
     *  by day in the viewer's time (`dayOffsetMin`: minutes east of UTC). Calls of no known space are left out. */
    spaceCost(roomId: string, range: { since: number; until: number; dayOffsetMin: number }): SpaceCost {
      const offset = Math.round(range.dayOffsetMin) * 60_000;
      const rows = db
        .prepare(
          `SELECT CAST((u.at + ?) / 86400000 AS INTEGER) AS day, CASE WHEN u.meeting_id IS NULL THEN 'between' WHEN m.kind = 'chat' THEN 'chat' ELSE 'calls' END AS place,
             u.task, u.model, ${USAGE_SUMS}
           FROM llm_usage u LEFT JOIN meetings m ON m.id = u.meeting_id
           WHERE u.room_id = ? AND u.at >= ? AND u.at < ?
           GROUP BY 1, 2, u.task, u.model`,
        )
        .all(offset, roomId, range.since, range.until) as Row[];
      const groups = (["calls", "chat", "between"] as const)
        .map((where) => ({ where, rows: rows.filter((r) => r.place === where) }))
        .filter((g) => g.rows.length)
        .map(({ where, rows }) => ({ where, ...costByTask(rows) }))
        .sort((a, b) => b.usd - a.usd);
      const days: SpaceCost["days"] = [];
      const dayOf = (at: number) => Math.floor((at + offset) / 86_400_000);
      for (let d = dayOf(range.since); range.until > range.since && d <= dayOf(range.until - 1); d++) {
        const on = rows.filter((r) => r.day === d);
        const usd = (where?: string) => on.filter((r) => !where || r.place === where).reduce((s, r) => s + priced(r), 0);
        days.push({ day: new Date(d * 86_400_000).toISOString().slice(0, 10), usd: usd(), calls: on.reduce((s, r) => s + (r.calls as number), 0), between: usd("between") });
      }
      return { since: range.since, until: range.until, usd: groups.reduce((s, g) => s + g.usd, 0), calls: groups.reduce((s, g) => s + g.calls, 0), groups, days };
    },
    getSegments(ids: string[]): Segment[] {
      if (!ids.length) return [];
      const st = db.prepare("SELECT * FROM segments WHERE id = ?");
      return ids
        .map((id) => st.get(id) as Row | undefined)
        .filter((r): r is Row => !!r)
        .map(toSegment);
    },
    latestMeeting(roomId: string) {
      const r = db.prepare("SELECT id FROM meetings WHERE room_id = ? AND kind IS NULL ORDER BY started_at DESC LIMIT 1").get(roomId) as Row | undefined;
      return r ? (r.id as string) : null;
    },
    /** When the meeting before this one ended: what closed after that is news at this one's check-in. */
    previousMeetingEnd(roomId: string, before: number): number | null {
      const r = db.prepare("SELECT MAX(ended_at) AS t FROM meetings WHERE room_id = ? AND started_at < ? AND ended_at IS NOT NULL AND kind IS NULL").get(roomId, before) as
        | Row
        | undefined;
      return (r?.t as number) ?? null;
    },
    /** When the meeting before this one started: "since last time" starts there. */
    previousMeetingStart(roomId: string, before: number): number | null {
      const r = db.prepare("SELECT MAX(started_at) AS t FROM meetings WHERE room_id = ? AND started_at < ? AND kind IS NULL").get(roomId, before) as
        | Row
        | undefined;
      return (r?.t as number) ?? null;
    },
    itemHistory(itemId: string) {
      const meetings = db
        .prepare(
          `SELECT DISTINCT m.id, m.started_at, m.ended_at FROM meetings m
           JOIN segments s ON s.meeting_id = m.id WHERE s.item_id = ?
           UNION
           SELECT DISTINCT m.id, m.started_at, m.ended_at FROM meetings m
           JOIN notes n ON n.meeting_id = m.id WHERE n.item_id = ? AND m.kind IS NULL
           ORDER BY started_at DESC`,
        )
        .all(itemId, itemId) as Row[];
      return meetings.map((m) => {
        const segments = (
          db.prepare("SELECT * FROM segments WHERE meeting_id = ? AND item_id = ? ORDER BY ts").all(m.id as string, itemId) as Row[]
        ).map(toSegment);
        const notes = (
          db.prepare("SELECT * FROM notes WHERE meeting_id = ? AND item_id = ? ORDER BY rowid").all(m.id as string, itemId) as Row[]
        ).map(toNote);
        return {
          meetingId: m.id as string,
          startedAt: m.started_at as number,
          endedAt: (m.ended_at as number) ?? null,
          participants: [...new Set(segments.map((s) => s.speakerName))],
          segments,
          notes,
          discussions: (
            db
              .prepare(`${DISCUSSION_SELECT} WHERE d.meeting_id = ? AND d.item_id = ? ORDER BY d.position`)
              .all(m.id as string, itemId) as Row[]
          ).map(toDiscussion),
        };
      });
    },
  };
}
