import path from "node:path";
import type { Capabilities } from "../shared/protocol.ts";

const env = (k: string) => process.env[k]?.trim() || undefined;

export const config = {
  port: Number(env("PORT") ?? 3001),
  dataDir: path.resolve(env("DATA_DIR") ?? "./data"),
  production: process.env.NODE_ENV === "production",
  /** npm run preview:ui only: the sample person everyone is, so a local look needs no sign-in. */
  previewUser: env("PREVIEW_USER"),
  livekit: {
    url: env("LIVEKIT_URL"),
    apiKey: env("LIVEKIT_API_KEY"),
    apiSecret: env("LIVEKIT_API_SECRET"),
  },
  /** Optional: talk to Deepgram directly instead of through LiveKit Inference. */
  deepgramKey: env("DEEPGRAM_API_KEY"),
  /** LiveKit Inference speech-to-text model. */
  sttModel: env("STT_MODEL") ?? "deepgram/nova-3",
  anthropicKey: env("ANTHROPIC_API_KEY"),
  anthropicModel: env("ANTHROPIC_MODEL") ?? "claude-opus-5-5",
  /** The model for live item notes, which run every few seconds while people talk:
   *  a fast, cheap one. The tidy run as the meeting ends puts right what it got wrong. */
  notesModel: env("NOTES_MODEL") ?? "claude-haiku-5-5",
  /** For the calls that run once per meeting and merge things: the notes' tidy run as
   *  the meeting ends (it feeds the recap) and the suggested agenda. */
  notesTidyModel: env("NOTES_TIDY_MODEL") ?? "claude-sonnet-5-5",
  /** The middle board's card (board.ts), every 30 s while people talk. Haiku held one card far
   *  too long on the Conxt replays; Sonnet followed the talk (2026-10-16). */
  boardModel: env("BOARD_MODEL") ?? "claude-sonnet-5-5",
  /** For the board's running list (liveList.ts), after every pause. Haiku missed late items on the
   *  Oct 17 and Oct 22 replays; Sonnet caught every core one in about 5 s (2026-10-23). */
  listModel: env("LIST_MODEL") ?? "claude-sonnet-5-5",
  /** A brainstorm's map (brainstorm.ts), after every pause in the talk. */
  mapModel: env("MAP_MODEL") ?? "claude-sonnet-5-5",
  /** ✦ Stand's options for an open question (meetingAgent.ts), with web search, on a click. */
  agentModel: env("AGENT_MODEL") ?? "claude-sonnet-5-5",
  /** Off for now (joe, 2026-11-11), to cut Claude calls between meetings. DONE_SINCE=on brings back
   *  the Done since pages (doneDeck.ts); SUGGESTED_AGENDA=on brings back the suggested agenda and its
   *  Claude pass (upNextPolish.ts). */
  doneSince: env("DONE_SINCE") === "on",
  suggestedAgenda: env("SUGGESTED_AGENDA") === "on",
  /** Stand's project suggestions (projectSuggest.ts): a pass that files a space's unfiled to-dos and
   *  open questions into its projects, as suggestions a person confirms. PROJECT_SUGGEST=off stops it. */
  projectSuggest: env("PROJECT_SUGGEST") !== "off",
  /** Stand's sweep of a space's open questions (questionSweep.ts): it runs after enough new questions,
   *  decisions or context, and proposes which questions to close. QUESTION_SWEEP=off stops it. */
  questionSweep: env("QUESTION_SWEEP") !== "off",
  /** CHAT_QUIET_MS: the quiet that closes a session of chat (an hour), for a run that proves the close. */
  chatQuietMs: Number(env("CHAT_QUIET_MS") ?? 0) || null,
  /** Chat capture (chatCapture.ts): to-dos, open questions, decisions and topics from a space's
   *  chat, as from a meeting. CHAT_CAPTURE=off stops it. The waits are for tests and replays:
   *  CHAT_CAPTURE_QUIET_MS (how long a channel is quiet before a run) and CHAT_CAPTURE_MAX_WAIT_MS. */
  chatCapture: env("CHAT_CAPTURE") !== "off",
  chatCaptureQuietMs: Number(env("CHAT_CAPTURE_QUIET_MS") ?? 0) || null,
  chatCaptureMaxWaitMs: Number(env("CHAT_CAPTURE_MAX_WAIT_MS") ?? 0) || null,
  /** Small, frequent calls: captions for snaps and Mac bar captures, filing a bar note under an
   *  item, and matching a shared screen to the agenda. Haiku is about 40x cheaper than Opus. */
  quickModel: env("QUICK_MODEL") ?? "claude-haiku-5-5",
  /** A product review deck drafted from a brief: mostly reshaping, so Sonnet. */
  deckModel: env("DECK_MODEL") ?? "claude-sonnet-5-5",
  /** Live notes experiments, for trying on a recorded meeting with scripts/replay-notes.ts; all
   *  off unless set. NOTES_TURNS=ranges: the model lists a topic's lines as ranges ("3-17, 20")
   *  instead of every number. NOTES_THINKING=off: live notes runs answer without thinking first.
   *  NOTES_LAST_TOPICS=on: each run is shown the topics the last run made, asked to keep their
   *  titles, and to leave a short aside in the discussion around it. On Haiku that steadied the
   *  titles but left far fewer topics (Conxt replay, 2026-10-12), so it stays off for now. */
  notesTurnsAsRanges: env("NOTES_TURNS") === "ranges",
  notesThinking: env("NOTES_THINKING") !== "off",
  notesLastTopics: env("NOTES_LAST_TOPICS") === "on",
  /** NOTES_LOCK=off: live runs regroup all of a topic's talk still going, up to 15 minutes of it
   *  (settle.ts FOLD_AFTER_MS), instead of locking talk a few minutes old to its topic. */
  notesLock: env("NOTES_LOCK") !== "off",
  /** NOTES_LOCK_MINUTES: how old talk is before it locks (settle.ts LOCK_AFTER_MS), for replays. */
  notesLockMinutes: Number(env("NOTES_LOCK_MINUTES") ?? 0) || null,
  /** NOTES_LAYOUT=stable: lines numbered through the item and topics that went quiet listed after
   *  the talk, so far more of the prompt comes back from the cache. In the Conxt replays on Haiku
   *  it cost about $0.08 a meeting hour less, but picked the right current topic 5 to 7 points less
   *  often, so the layout where each run numbers its lines from 1 and lists quiet topics first
   *  stays the default. */
  notesStableLayout: env("NOTES_LAYOUT") === "stable",
  linearKey: env("LINEAR_API_KEY"),
  /** Optional: a GitHub token that can read the repos agents open PRs in, so Stand can tell when a
   *  to-do's PR merges (shipWatch.ts). Without it only public repos' PRs can be checked. */
  githubToken: env("GITHUB_TOKEN"),
  /** The Stand GitHub App (github.ts), so people connect GitHub with a click and Stand hears about
   *  merged PRs at once. Set up once per server; see the README. */
  githubApp: {
    id: env("GITHUB_APP_ID"),
    slug: env("GITHUB_APP_SLUG"),
    /** The app's private key (PEM). Newlines may be written as \n. */
    privateKey: env("GITHUB_APP_PRIVATE_KEY")?.replace(/\\n/g, "\n"),
    webhookSecret: env("GITHUB_WEBHOOK_SECRET"),
  },
  google: {
    clientId: env("GOOGLE_CLIENT_ID"),
    clientSecret: env("GOOGLE_CLIENT_SECRET"),
  },
  /** Public origin, e.g. https://standup.example.com. Defaults to the request's own origin. */
  publicUrl: env("PUBLIC_URL"),
  /** Notifications on the iPhone app through Apple (push.ts). Without a key Stand sends none.
   *  From Apple Developer > Keys, a key with Apple Push Notifications service: APNS_KEY is the .p8
   *  file's text (its line breaks may be written as \n), APNS_KEY_ID its ten-letter id, APNS_TEAM_ID
   *  the team's id. APNS_TOPIC is the app's bundle id (ios/App, capacitor.config.ts). */
  apns: {
    key: env("APNS_KEY")?.replace(/\\n/g, "\n"),
    keyId: env("APNS_KEY_ID"),
    teamId: env("APNS_TEAM_ID"),
    topic: env("APNS_TOPIC") ?? "studio.conxt.stand",
  },

  /** Comma-separated email addresses allowed in, e.g. "ann@gmail.com,bo@acme.com". */
  allowedEmails: (env("ALLOWED_EMAILS") ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
  /** Comma-separated email domains allowed in, e.g. "acme.com". With neither list set, anyone can sign in. */
  allowedDomains: (env("ALLOWED_EMAIL_DOMAINS") ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean),
};

/** Without Google credentials, people sign in with just a name and email
 *  (no verification) so the app can be tried before OAuth is set up. */
export const googleEnabled = () => Boolean(config.google.clientId && config.google.clientSecret);

export function capabilities(): Capabilities {
  const livekit = Boolean(config.livekit.url && config.livekit.apiKey && config.livekit.apiSecret);
  return {
    livekit,
    // Server-side transcription needs the agent in the LiveKit room to hear people.
    // LiveKit Inference bills speech-to-text to the LiveKit account, so no extra key.
    transcription: !livekit ? "browser" : config.deepgramKey ? "deepgram" : "livekit",
    llm: Boolean(config.anthropicKey),
    linear: Boolean(config.linearKey),
    googleSignIn: googleEnabled(),
  };
}
