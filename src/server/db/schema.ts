// The tables, and the checks that bring a database made by an older version up to date.
import type { DatabaseSync } from "node:sqlite";
import { newId } from "../ids.ts";
import { normalizeProjectName, projectKey } from "../../shared/projects.ts";
import type { Row } from "./rows.ts";

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  google_sub TEXT UNIQUE,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  picture TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS room_members (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  last_joined_at INTEGER NOT NULL,
  role TEXT,                        -- 'admin', or NULL for everyone else. The creator is rooms.created_by
  PRIMARY KEY (room_id, user_id)
);
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
-- Items belong to a room, not a meeting, so a recurring standup builds up
-- history per ticket across meetings.
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  source TEXT NOT NULL,
  external_id TEXT,
  title TEXT NOT NULL,
  url TEXT,
  description TEXT,
  position INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS items_external ON items(room_id, source, external_id) WHERE external_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS decks (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  title TEXT NOT NULL,
  page_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  summary TEXT
);
CREATE TABLE IF NOT EXISTS segments (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id),
  item_id TEXT REFERENCES items(id),
  speaker_id TEXT NOT NULL,
  speaker_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS segments_item ON segments(item_id, ts);
CREATE INDEX IF NOT EXISTS segments_meeting ON segments(meeting_id, ts);
CREATE TABLE IF NOT EXISTS focus_events (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id),
  item_id TEXT,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id),
  item_id TEXT,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  owner TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_item ON notes(item_id);
-- Notes the meeting's host deleted or reworded, so the agent's next redraft doesn't bring the old ones back.
CREATE TABLE IF NOT EXISTS dismissed_notes (
  meeting_id TEXT NOT NULL,
  item_id TEXT,
  kind TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS dismissed_notes_item ON dismissed_notes(meeting_id, item_id);
-- Agenda suggestions the host waved off, so the agent doesn't bring them back until something changes.
CREATE TABLE IF NOT EXISTS upnext_dismissed (
  room_id TEXT NOT NULL,
  key TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (room_id, key)
);
-- Stills of a screen (snaps.ts). The image is a file named by id. Taken in a meeting, or
-- saved straight to the space between meetings (no meeting_id).
CREATE TABLE IF NOT EXISTS snaps (
  id TEXT PRIMARY KEY,
  -- Not NOT NULL so an older build sharing this database can still save meeting snaps;
  -- those get their space from the meeting on the next start.
  room_id TEXT,
  meeting_id TEXT REFERENCES meetings(id),
  item_id TEXT,
  -- The agent picked item_id and nobody has confirmed it yet.
  item_suggested INTEGER NOT NULL DEFAULT 0,
  ts INTEGER NOT NULL,
  ext TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL,
  taken_by_id TEXT,
  taken_by TEXT NOT NULL,
  sharer_id TEXT,
  sharer_name TEXT,
  caption TEXT,
  note_id TEXT,
  -- The topic the end-of-meeting recap placed it under, when it backs no note.
  discussion_id TEXT,
  -- The line the person typed with it, and the text read off the image on their Mac.
  line TEXT,
  screen_text TEXT,
  -- The note (jots) it was pinned to on the Mac's bar.
  jot_id TEXT
);
CREATE INDEX IF NOT EXISTS snaps_meeting ON snaps(meeting_id, ts);
-- Notes saved straight to a space from the Mac's bar (captures.ts): a line of text, typed or dictated.
CREATE TABLE IF NOT EXISTS jots (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  item_id TEXT,
  -- The agent picked item_id and nobody has confirmed it yet.
  item_suggested INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL,
  by_id TEXT,
  by_name TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jots_room ON jots(room_id, ts);
CREATE INDEX IF NOT EXISTS snaps_item ON snaps(item_id, ts);
-- Claude's last pass over a space's suggested agenda (upNext.ts Polish), as JSON.
CREATE TABLE IF NOT EXISTS upnext_polish (
  room_id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  rows_json TEXT NOT NULL
);
-- Claude's pass over a space's decisions and open questions across its meetings (spaceSettle.ts):
-- which questions a later decision answered and which decisions a later one replaced, as JSON.
CREATE TABLE IF NOT EXISTS space_settled (
  room_id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  basis TEXT NOT NULL,
  rows_json TEXT NOT NULL
);
-- Stand's last sweep of a space's open questions (questionSweep.ts), as JSON: what it read, which
-- questions it proposes to close, and the ones someone chose to keep open.
CREATE TABLE IF NOT EXISTS question_sweep (
  room_id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  sweep_json TEXT NOT NULL
);
-- "Done since last time" (doneDeck.ts): what the space closed since its last meeting, as pages Claude
-- laid out for the next one to open on. since: when that meeting ended; basis: what the pass read.
CREATE TABLE IF NOT EXISTS space_done (
  room_id TEXT PRIMARY KEY,
  since INTEGER NOT NULL,
  basis TEXT NOT NULL,
  deck_json TEXT NOT NULL
);
-- Product reviews (reviews.ts): a space has one being put together (draft) at a time; agents and people
-- add slides to it, and starting it turns them into a deck whose slides are agenda items.
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  status TEXT NOT NULL,
  deck_id TEXT,
  meeting_id TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS reviews_room ON reviews(room_id, created_at);
CREATE TABLE IF NOT EXISTS review_slides (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES reviews(id),
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  note_id TEXT,
  owner TEXT,
  added_by TEXT,
  pr TEXT,
  item_id TEXT,
  outcome TEXT,
  outcome_by TEXT,
  outcome_at INTEGER,
  created_at INTEGER NOT NULL,
  name TEXT
);
CREATE INDEX IF NOT EXISTS review_slides_review ON review_slides(review_id, position);
-- What Stand wrote for one version of a plan ahead of its design review (planBrief.ts), with the
-- author's edits, as JSON.
CREATE TABLE IF NOT EXISTS plan_briefs (
  note_id TEXT NOT NULL,
  version TEXT NOT NULL,
  brief_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (note_id, version)
);
-- Brainstorms (brainstorm.ts): one sentence and the map the talk drew around it.
CREATE TABLE IF NOT EXISTS brainstorms (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  item_id TEXT,
  meeting_id TEXT,
  started_by TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  map_json TEXT
);
CREATE INDEX IF NOT EXISTS brainstorms_room ON brainstorms(room_id, started_at);
-- Token use of every Claude call (usage.ts), with the meeting it was for (null outside a meeting) and
-- its space (null: not known, as for calls between meetings from before the space was kept).
CREATE TABLE IF NOT EXISTS llm_usage (
  meeting_id TEXT,
  room_id TEXT,
  task TEXT NOT NULL,
  model TEXT NOT NULL,
  input INTEGER NOT NULL,
  cache_read INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  output INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS llm_usage_meeting ON llm_usage (meeting_id);
-- Rows someone archived off the space page (archive.ts): ref is "<kind>:<id>". title and ts are kept so
-- the Archived list can show it; extra holds what restoring needs (a deck's items, a suggestion's keys).
CREATE TABLE IF NOT EXISTS space_archived (
  room_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  title TEXT NOT NULL,
  ts INTEGER NOT NULL,
  at INTEGER NOT NULL,
  by_name TEXT NOT NULL,
  extra_json TEXT,
  PRIMARY KEY (room_id, ref)
);
-- The agent's grouping of an item's talk into discussions, one per question.
CREATE TABLE IF NOT EXISTS discussions (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id),
  item_id TEXT,
  topic TEXT NOT NULL,
  positions_json TEXT NOT NULL,
  outcome TEXT NOT NULL,
  segment_ids_json TEXT NOT NULL,
  continues_id TEXT,
  position INTEGER NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS discussions_item ON discussions(item_id);
CREATE INDEX IF NOT EXISTS discussions_meeting ON discussions(meeting_id);
-- Where a smaller topic sits on the board: inside a main topic of its item, or in a small group
-- (see topicMerge.ts). Kept apart from discussions, which every notes run rewrites.
CREATE TABLE IF NOT EXISTS topic_merges (
  meeting_id TEXT NOT NULL,
  discussion_id TEXT NOT NULL,
  parent_id TEXT,
  group_title TEXT,
  PRIMARY KEY (meeting_id, discussion_id)
);
-- Personal access tokens for agents (the Stand MCP). Only a hash is kept.
CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  label TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  hint TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
-- Apps that connect through the sign-in flow (Claude's custom connectors, for
-- example). They register themselves; they're public clients, so no secret.
CREATE TABLE IF NOT EXISTS oauth_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
-- One-time codes from the consent page, swapped for a token within minutes.
CREATE TABLE IF NOT EXISTS oauth_codes (
  hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  redirect_uri TEXT NOT NULL,
  challenge TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
-- What agents and people report back on an item between meetings. Append only.
CREATE TABLE IF NOT EXISTS updates (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  item_id TEXT,
  note_id TEXT,
  note_text TEXT,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  client TEXT,
  status TEXT NOT NULL,
  text TEXT NOT NULL,
  links_json TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS updates_room ON updates(room_id, ts);
CREATE INDEX IF NOT EXISTS updates_item ON updates(item_id, ts);
CREATE INDEX IF NOT EXISTS updates_note ON updates(note_id);
-- People tagged with @Name in a task comment (mentions.ts). Open until they comment on the task,
-- dismiss it, or the task closes.
CREATE TABLE IF NOT EXISTS mentions (
  update_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  note_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  cleared_at INTEGER,
  PRIMARY KEY (update_id, user_id)
);
CREATE INDEX IF NOT EXISTS mentions_user ON mentions(user_id, cleared_at);
-- Screenshots an agent attaches to a to-do's work log. They join the next
-- update it posts on that to-do (update_id); until then they show on their own.
CREATE TABLE IF NOT EXISTS work_shots (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  note_id TEXT NOT NULL,
  update_id TEXT,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  client TEXT,
  caption TEXT,
  ext TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS work_shots_note ON work_shots(note_id, ts);
-- Conflict checks people's own agents run on a decision (decisionCheck.ts). A row means someone
-- took it; done_at means it came back. A decision with no row is waiting.
CREATE TABLE IF NOT EXISTS decision_checks (
  note_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  version TEXT NOT NULL,
  claimed_until INTEGER NOT NULL,
  done_at INTEGER,
  actor_json TEXT,
  findings_json TEXT
);
-- Plans and specs attached to a to-do. Each attach adds a version; the newest is the plan.
CREATE TABLE IF NOT EXISTS task_plans (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  text TEXT NOT NULL,
  made_by TEXT NOT NULL,
  made_at INTEGER NOT NULL,
  made_actor_json TEXT
);
CREATE INDEX IF NOT EXISTS task_plans_note ON task_plans(note_id, made_at);
CREATE TABLE IF NOT EXISTS plan_threads (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL,
  thread_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS plan_threads_note ON plan_threads(note_id);
-- How a space's tasks, decisions and context relate (docs/mvp-primitives.md).
CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  made_by TEXT NOT NULL,
  made_at INTEGER NOT NULL,
  UNIQUE (from_id, to_id, relation)
);
CREATE INDEX IF NOT EXISTS links_to ON links(to_id, relation);
-- What a call's main view showed, each time it changed (room.ts logStage): the item, the board's tab,
-- a to-do's brief or spec, which picture of a review slide, a still on the stage, who was sharing.
-- What a line or a to-do was said in front of is read from this by time (shared/timeline.ts).
CREATE TABLE IF NOT EXISTS stage_events (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id),
  ts INTEGER NOT NULL,
  view_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS stage_events_meeting ON stage_events(meeting_id, ts);
-- Chat (chat.ts). A channel is a place text comes from, tied to one space; the space's own chat is
-- one (source 'stand'). Its talk is kept as sessions: meetings rows of kind 'chat'.
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  source TEXT NOT NULL,
  -- The source's id for it; null for 'stand'.
  external_id TEXT,
  name TEXT NOT NULL,
  -- The session messages go to now. A session's ended_at is always set, so this is what says it is open.
  open_session_id TEXT,
  -- The seq of the newest message a capture run has read (chatCapture.ts). It moves back when a
  -- message is changed, and when a session closes, so the session is read once more.
  captured_up_to INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS channels_room ON channels(room_id);
CREATE UNIQUE INDEX IF NOT EXISTS channels_external ON channels(source, external_id) WHERE external_id IS NOT NULL;
-- What chat adds to a message, beside its segments row. seq orders them. external_id is the key a
-- message was sent with (the source's message id, for an outside source): a channel takes it once.
CREATE TABLE IF NOT EXISTS chat_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  segment_id TEXT NOT NULL UNIQUE REFERENCES segments(id),
  channel_id TEXT NOT NULL REFERENCES channels(id),
  external_id TEXT,
  reply_to TEXT,
  edited_at INTEGER,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS chat_messages_channel ON chat_messages(channel_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_external ON chat_messages(channel_id, external_id) WHERE external_id IS NOT NULL;
-- An emoji someone answered a chat message with. One row per person, message and emoji.
CREATE TABLE IF NOT EXISTS chat_reactions (
  segment_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (segment_id, user_id, emoji)
);
-- How far each person has read a channel: the seq of the last message they saw.
-- Projects (shared/projects.ts): named groups of a space's to-dos, open questions and decisions.
-- A note's own project_id is only what someone set by hand; the rest comes from the rules each read.
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  name TEXT NOT NULL,
  goal TEXT,
  position INTEGER NOT NULL,
  archived_at INTEGER,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS projects_room ON projects(room_id, position);
CREATE TABLE IF NOT EXISTS channel_reads (
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  read_up_to INTEGER NOT NULL,
  PRIMARY KEY (channel_id, user_id)
);
-- An iPhone with the Stand app that said yes to notifications (push.ts): its Apple push token, and
-- whether it was built for Apple's test servers (sandbox, an Xcode build) or the real ones (TestFlight, App Store).
CREATE TABLE IF NOT EXISTS push_devices (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  env TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS push_devices_user ON push_devices(user_id);
-- Which chat messages in a space notify someone: 'mentions' (only @mentions and replies to them).
-- No row is every message.
CREATE TABLE IF NOT EXISTS chat_notify (
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  level TEXT NOT NULL,
  PRIMARY KEY (room_id, user_id)
);
`;

/** Makes the tables a new database needs, and adds what later versions added to an older one.
 *  Each check looks at what the database has, so running it again changes nothing. */
export function migrate(db: DatabaseSync) {
  db.exec(schema);
  // Added after the first version; older databases lack it.
  const roomCols = (db.prepare("PRAGMA table_info(rooms)").all() as Row[]).map((c) => c.name);
  const tokenCols = (db.prepare("PRAGMA table_info(api_tokens)").all() as Row[]).map((c) => c.name);
  if (!tokenCols.includes("client_id"))
    db.exec("ALTER TABLE api_tokens ADD COLUMN client_id TEXT; ALTER TABLE api_tokens ADD COLUMN refresh_hash TEXT;");
  if (!roomCols.includes("created_by")) db.exec("ALTER TABLE rooms ADD COLUMN created_by TEXT");
  // Space admins: people the creator (or another admin) lets manage the space.
  const memberCols = (db.prepare("PRAGMA table_info(room_members)").all() as Row[]).map((c) => c.name);
  if (!memberCols.includes("role")) db.exec("ALTER TABLE room_members ADD COLUMN role TEXT");
  if (!roomCols.includes("purpose")) db.exec("ALTER TABLE rooms ADD COLUMN purpose TEXT NOT NULL DEFAULT ''");
  // Synthesis instructions: what the space asks the agent to pull out of every meeting, besides the default notes.
  if (!roomCols.includes("synthesis_instructions")) db.exec("ALTER TABLE rooms ADD COLUMN synthesis_instructions TEXT NOT NULL DEFAULT ''");
  const meetingCols = (db.prepare("PRAGMA table_info(meetings)").all() as Row[]).map((c) => c.name);
  if (!meetingCols.includes("synthesis")) db.exec("ALTER TABLE meetings ADD COLUMN synthesis TEXT");
  if (!meetingCols.includes("chapters_json")) db.exec("ALTER TABLE meetings ADD COLUMN chapters_json TEXT");
  // The middle board's threads (board.ts), so a restarted server carries on with the same board.
  if (!meetingCols.includes("board_json")) db.exec("ALTER TABLE meetings ADD COLUMN board_json TEXT");
  // "added": not a meeting but where a to-do someone added by hand (MCP create_action) lives, since
  // every note sits in a meeting. Lists of meetings leave these out (see addTask).
  if (!meetingCols.includes("kind")) db.exec("ALTER TABLE meetings ADD COLUMN kind TEXT");
  // "chat": a session of a chat channel (chat.ts), which is the channel in channel_id.
  if (!meetingCols.includes("channel_id")) db.exec("ALTER TABLE meetings ADD COLUMN channel_id TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS meetings_channel ON meetings(channel_id, started_at) WHERE channel_id IS NOT NULL;");
  // How far capture has read a channel (chatCapture.ts).
  if (!(db.prepare("PRAGMA table_info(channels)").all() as Row[]).some((c) => c.name === "captured_up_to"))
    db.exec("ALTER TABLE channels ADD COLUMN captured_up_to INTEGER NOT NULL DEFAULT 0");
  // A design session (designSession.ts) is a brainstorm whose board is a diagram of boxes and arrows.
  const brainCols = (db.prepare("PRAGMA table_info(brainstorms)").all() as Row[]).map((c) => c.name);
  if (!brainCols.includes("kind"))
    db.exec("ALTER TABLE brainstorms ADD COLUMN kind TEXT NOT NULL DEFAULT 'map'; ALTER TABLE brainstorms ADD COLUMN diagram_json TEXT; ALTER TABLE brainstorms ADD COLUMN seed TEXT; ALTER TABLE brainstorms ADD COLUMN task_id TEXT;");
  if (!brainCols.includes("context_json")) db.exec("ALTER TABLE brainstorms ADD COLUMN context_json TEXT");
  // The ideas people starred on a brainstorm's page. Kept beside the map, not in it: the map is
  // rewritten by every pass of a running brainstorm.
  if (!brainCols.includes("stars_json")) db.exec("ALTER TABLE brainstorms ADD COLUMN stars_json TEXT");
  if (!brainCols.includes("sketch_json")) db.exec("ALTER TABLE brainstorms ADD COLUMN sketch_json TEXT");
  // The map of a topic: the board thread it follows, and the stretches of the meeting it read.
  if (!brainCols.includes("thread_id")) db.exec("ALTER TABLE brainstorms ADD COLUMN thread_id TEXT; ALTER TABLE brainstorms ADD COLUMN spans_json TEXT;");
  // A brainstorm used to lead the agenda with its sentence. A map is now a view beside the board: a
  // running one lets go of its item.
  db.exec(
    "UPDATE items SET archived = 1 WHERE id IN (SELECT item_id FROM brainstorms WHERE status = 'live' AND item_id IS NOT NULL); UPDATE brainstorms SET item_id = NULL WHERE status = 'live' AND item_id IS NOT NULL;",
  );
  if (!meetingCols.includes("list_json")) db.exec("ALTER TABLE meetings ADD COLUMN list_json TEXT");
  // The next steps people asked for out loud in the call (nextSteps.ts).
  if (!meetingCols.includes("next_json")) db.exec("ALTER TABLE meetings ADD COLUMN next_json TEXT");
  // What ✦ Stand did on the board (meetingAgent.ts): its cards, which are also its log.
  if (!meetingCols.includes("agent_json")) db.exec("ALTER TABLE meetings ADD COLUMN agent_json TEXT");
  const itemCols = (db.prepare("PRAGMA table_info(items)").all() as Row[]).map((c) => c.name);
  if (!itemCols.includes("deck_id")) db.exec("ALTER TABLE items ADD COLUMN deck_id TEXT; ALTER TABLE items ADD COLUMN slide_no INTEGER;");
  if (!itemCols.includes("slide_json")) db.exec("ALTER TABLE items ADD COLUMN slide_json TEXT");
  // "Present task" (room.ts): the to-do an agenda item walks through.
  if (!itemCols.includes("note_id")) db.exec("ALTER TABLE items ADD COLUMN note_id TEXT");
  // The project an agenda item links to (shared/projects.ts).
  if (!itemCols.includes("project_id")) db.exec("ALTER TABLE items ADD COLUMN project_id TEXT");
  const deckCols = (db.prepare("PRAGMA table_info(decks)").all() as Row[]).map((c) => c.name);
  if (!deckCols.includes("parent_item_id")) db.exec("ALTER TABLE decks ADD COLUMN parent_item_id TEXT;");
  // A product review's deck (reviews.ts).
  if (!deckCols.includes("review_id")) db.exec("ALTER TABLE decks ADD COLUMN review_id TEXT;");
  const reviewSlideCols = (db.prepare("PRAGMA table_info(review_slides)").all() as Row[]).map((c) => c.name as string);
  if (!reviewSlideCols.includes("name")) db.exec("ALTER TABLE review_slides ADD COLUMN name TEXT;");
  // Design reviews (designReviews.ts) share the review tables: a review has a kind, and a slide a role.
  if (!reviewSlideCols.includes("role")) db.exec("ALTER TABLE review_slides ADD COLUMN role TEXT; ALTER TABLE review_slides ADD COLUMN plan_version TEXT;");
  if (!reviewSlideCols.includes("section")) db.exec("ALTER TABLE review_slides ADD COLUMN section TEXT; ALTER TABLE review_slides ADD COLUMN thread_id TEXT;");
  if (!(db.prepare("PRAGMA table_info(reviews)").all() as Row[]).some((c) => c.name === "kind")) db.exec("ALTER TABLE reviews ADD COLUMN kind TEXT NOT NULL DEFAULT 'product';");
  // Idea reviews (ideaReview.ts): a review named for a brainstorm, whose slides are its ideas.
  if (!(db.prepare("PRAGMA table_info(reviews)").all() as Row[]).some((c) => c.name === "source_id")) db.exec("ALTER TABLE reviews ADD COLUMN title TEXT; ALTER TABLE reviews ADD COLUMN source_id TEXT;");
  if (!(db.prepare("PRAGMA table_info(review_slides)").all() as Row[]).some((c) => c.name === "idea_json")) db.exec("ALTER TABLE review_slides ADD COLUMN idea_json TEXT;");
  const noteCols = (db.prepare("PRAGMA table_info(notes)").all() as Row[]).map((c) => c.name);
  if (!noteCols.includes("topic")) db.exec("ALTER TABLE notes ADD COLUMN topic TEXT;");
  if (!noteCols.includes("project_id")) topicsToProjects(db);
  db.exec("CREATE INDEX IF NOT EXISTS notes_project ON notes(project_id);");
  // Stand's suggested project (rule 4), and when it last read the note for one. NULL: not read.
  if (!noteCols.includes("suggested_project_id")) db.exec("ALTER TABLE notes ADD COLUMN suggested_project_id TEXT; ALTER TABLE notes ADD COLUMN project_judged_at INTEGER;");
  if (!noteCols.includes("discussion_id")) db.exec("ALTER TABLE notes ADD COLUMN discussion_id TEXT;");
  if (!noteCols.includes("edited_by")) db.exec("ALTER TABLE notes ADD COLUMN edited_by TEXT;");
  // Who did it, as fields (shared/actors.ts). Older rows read theirs from done_by and edited_by.
  if (!noteCols.includes("done_actor_json")) db.exec("ALTER TABLE notes ADD COLUMN done_actor_json TEXT; ALTER TABLE notes ADD COLUMN added_actor_json TEXT;");
  if (!(db.prepare("PRAGMA table_info(updates)").all() as Row[]).some((c) => c.name === "actor_json")) db.exec("ALTER TABLE updates ADD COLUMN actor_json TEXT;");
  if (!(db.prepare("PRAGMA table_info(links)").all() as Row[]).some((c) => c.name === "made_actor_json")) db.exec("ALTER TABLE links ADD COLUMN made_actor_json TEXT;");
  // A decision's words as said (protocol.ts Quote), from the run as the meeting ends.
  if (!noteCols.includes("quote_json")) db.exec("ALTER TABLE notes ADD COLUMN quote_json TEXT;");
  if (!noteCols.includes("done_at")) db.exec("ALTER TABLE notes ADD COLUMN done_at INTEGER; ALTER TABLE notes ADD COLUMN done_by TEXT;");
  // Task fields (shared/tasks.ts). A dropped task also gets done_at, so every list that shows open
  // to-dos leaves it out; state tells the two apart.
  if (!noteCols.includes("state"))
    db.exec(
      `ALTER TABLE notes ADD COLUMN state TEXT; ALTER TABLE notes ADD COLUMN done_when TEXT; ALTER TABLE notes ADD COLUMN parent_id TEXT;
       ALTER TABLE notes ADD COLUMN closed_by TEXT; ALTER TABLE notes ADD COLUMN drop_reason TEXT; ALTER TABLE notes ADD COLUMN said_done_json TEXT;
       ALTER TABLE notes ADD COLUMN checked_at INTEGER;`,
    );
  if (!meetingCols.includes("host_id")) db.exec("ALTER TABLE meetings ADD COLUMN host_id TEXT;");
  if (!meetingCols.includes("end_requested_at")) db.exec("ALTER TABLE meetings ADD COLUMN end_requested_at INTEGER;");
  const snapCols = (db.prepare("PRAGMA table_info(snaps)").all() as Row[]).map((c) => c.name);
  if (!snapCols.includes("discussion_id")) db.exec("ALTER TABLE snaps ADD COLUMN discussion_id TEXT;");
  // Snaps used to need a meeting. SQLite can't loosen a column, so the table is rebuilt once,
  // each row taking its space from its meeting.
  if (!snapCols.includes("room_id")) {
    db.exec(`BEGIN;
      CREATE TABLE snaps_spaces (
        id TEXT PRIMARY KEY, room_id TEXT, meeting_id TEXT REFERENCES meetings(id), item_id TEXT,
        item_suggested INTEGER NOT NULL DEFAULT 0, ts INTEGER NOT NULL, ext TEXT NOT NULL, width INTEGER NOT NULL,
        height INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL, taken_by_id TEXT,
        taken_by TEXT NOT NULL, sharer_id TEXT, sharer_name TEXT, caption TEXT, note_id TEXT, discussion_id TEXT,
        line TEXT, screen_text TEXT
      );
      INSERT INTO snaps_spaces (id, room_id, meeting_id, item_id, ts, ext, width, height, version, source, taken_by_id,
        taken_by, sharer_id, sharer_name, caption, note_id, discussion_id)
        SELECT s.id, m.room_id, s.meeting_id, s.item_id, s.ts, s.ext, s.width, s.height, s.version, s.source, s.taken_by_id,
          s.taken_by, s.sharer_id, s.sharer_name, s.caption, s.note_id, s.discussion_id
        FROM snaps s JOIN meetings m ON m.id = s.meeting_id;
      DROP TABLE snaps;
      ALTER TABLE snaps_spaces RENAME TO snaps;
      CREATE INDEX snaps_meeting ON snaps(meeting_id, ts);
      CREATE INDEX snaps_item ON snaps(item_id, ts);
      COMMIT;`);
  }
  if (!(db.prepare("PRAGMA table_info(snaps)").all() as Row[]).some((c) => c.name === "jot_id")) db.exec("ALTER TABLE snaps ADD COLUMN jot_id TEXT;");
  db.exec("CREATE INDEX IF NOT EXISTS snaps_room ON snaps(room_id, ts);");
  db.exec("CREATE INDEX IF NOT EXISTS snaps_jot ON snaps(jot_id);");
  db.exec("UPDATE snaps SET room_id = (SELECT room_id FROM meetings WHERE id = snaps.meeting_id) WHERE room_id IS NULL;");
  if (!deckCols.includes("kind"))
    db.exec(
      "ALTER TABLE decks ADD COLUMN kind TEXT NOT NULL DEFAULT 'pdf'; ALTER TABLE decks ADD COLUMN theme TEXT NOT NULL DEFAULT 'paper';",
    );
  // Each call's space (Manage spaces shows what a space spent). Older rows with a meeting take its
  // space; those with no meeting stay unknown.
  if (!(db.prepare("PRAGMA table_info(llm_usage)").all() as Row[]).some((c) => c.name === "room_id"))
    db.exec("ALTER TABLE llm_usage ADD COLUMN room_id TEXT; UPDATE llm_usage SET room_id = (SELECT room_id FROM meetings WHERE id = llm_usage.meeting_id) WHERE meeting_id IS NOT NULL;");
  db.exec("CREATE INDEX IF NOT EXISTS llm_usage_room ON llm_usage (room_id, at);");
  // Stand sends nothing to Conxt now. A database from before still has the triggers that copied each new
  // meeting and transcript line into the conxt_* tables; they go, and the tables stay as they were.
  db.exec(`DROP TRIGGER IF EXISTS conxt_meeting_started;
    DROP TRIGGER IF EXISTS conxt_live_meeting;
    DROP TRIGGER IF EXISTS conxt_live_segment;
    DROP TRIGGER IF EXISTS conxt_live_segment_updated;
    DROP TRIGGER IF EXISTS conxt_default_new_room;`);
}

/** Once: the free-text topic labels become projects. Each different label in a space becomes one, in the
 *  spelling used most. A note with a label is set by hand to its project, one with an empty label to
 *  Unassigned, and one with no label follows the rules. notes.topic stays, but nothing reads it. */
function topicsToProjects(db: DatabaseSync) {
  db.exec("BEGIN");
  try {
    db.exec("ALTER TABLE notes ADD COLUMN project_id TEXT; ALTER TABLE notes ADD COLUMN project_set_by TEXT;");
    const rows = db
      .prepare("SELECT n.id, n.topic, m.room_id FROM notes n JOIN meetings m ON m.id = n.meeting_id WHERE n.topic IS NOT NULL ORDER BY n.ts, n.rowid")
      .all() as Array<{ id: string; topic: string; room_id: string }>;
    // Per space, per label: how often each spelling is used.
    const spellings = new Map<string, Map<string, Map<string, number>>>();
    for (const r of rows) {
      const key = projectKey(r.topic);
      if (!key) continue;
      const room = spellings.get(r.room_id) ?? new Map<string, Map<string, number>>();
      const counts = room.get(key) ?? new Map<string, number>();
      const name = normalizeProjectName(r.topic);
      counts.set(name, (counts.get(name) ?? 0) + 1);
      room.set(key, counts);
      spellings.set(r.room_id, room);
    }
    const insert = db.prepare("INSERT INTO projects (id, room_id, name, goal, position, created_by, created_at) VALUES (?, ?, ?, NULL, ?, 'migrated', ?)");
    const ids = new Map<string, string>();
    const now = Date.now();
    for (const [roomId, labels] of spellings) {
      const names = [...labels].map(([key, counts]) => ({ key, name: [...counts].sort((a, b) => b[1] - a[1])[0][0] }));
      names.sort((a, b) => a.name.localeCompare(b.name));
      names.forEach((n, i) => {
        const id = newId(12);
        insert.run(id, roomId, n.name.slice(0, 80), i, now);
        ids.set(`${roomId}\n${n.key}`, id);
      });
    }
    const set = db.prepare("UPDATE notes SET project_id = ?, project_set_by = 'migrated' WHERE id = ?");
    for (const r of rows) {
      const key = projectKey(r.topic);
      set.run(key ? (ids.get(`${r.room_id}\n${key}`) ?? null) : null, r.id);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
