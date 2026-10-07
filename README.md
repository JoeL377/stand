# Standup

Voice rooms where an AI agent pins every remark to the ticket or doc section it's about.

People talk (voice only, no cameras) and share their screen. The room has an agenda: typed items or Linear issues. An agent listens to each person separately, watches the shared screen, and when it sees the presenter has moved on it asks "Moved on to ENG-142?". One click confirms, and anything said since the screen changed moves with it. Anyone can click an item to switch to it, or pin it so the agent stops suggesting. Chat in the room is pinned the same way.

Everyone signs in with Google, so names in the transcript and owners of action items are real accounts.

Afterwards, every item has its own history: transcript, decisions, action items with owners, and open questions, across every meeting where it came up.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173 (API on :3001)
npm test
```

With no keys it runs in **mock mode**:

| Piece | Mock mode | With keys |
|---|---|---|
| Sign-in | Name and email, not verified | Google |
| Voice and screen share between people | Off. Each person's screen is visible only to them. | LiveKit |
| Transcription | Each browser transcribes its own mic (Chrome, Edge, Safari) | Deepgram, through a hidden agent in the LiveKit room |
| Reading the shared screen | Notices a change and guesses the next item | Claude matches the screenshot against the agenda |
| Notes per item | Keyword heuristics | Claude |
| Agenda from Linear | "Load a sample sprint" only | Project, cycle, view or issue links |

**Play demo** in the room plays a scripted four-person standup, so you can see the whole flow with no mic.

## Keys

Copy `.env.example` to `.env` and fill in what you have. Each one switches on independently.

- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` from [LiveKit Cloud](https://cloud.livekit.io) (the free tier is enough).
- `DEEPGRAM_API_KEY` from [Deepgram](https://console.deepgram.com). Needs LiveKit too, since the agent hears people through the LiveKit room.
- `ANTHROPIC_API_KEY` for notes and screen reading. `ANTHROPIC_MODEL` overrides the model (default `claude-opus-5-5`).
- `LINEAR_API_KEY`, a personal API key from Linear settings.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` from an OAuth client ID ("Web application") in Google Cloud. Add `<origin>/api/auth/google/callback` as an authorized redirect URI. `ALLOWED_EMAIL_DOMAINS` limits who can sign in; `PUBLIC_URL` sets the origin when behind a proxy.

## Production

```bash
npm run build && npm start   # serves the built app and API on $PORT
```

Data is a SQLite file in `DATA_DIR` (default `./data`). Node 22.13 or newer.

## How it works

```
browser ──WebSocket /ws/rooms/:id──▶ RoomSession (src/server/room.ts)
   │                                   ├─ focus log: which item was in focus when
   │  mic + screen                     ├─ segments: speech + chat, each pinned to an item
   ▼                                   ├─ suggestions from screen snapshots
LiveKit room ◀── hidden agent ──▶ Deepgram (one stream per speaker)
                                       └─ notes per item ──▶ Claude
```

- **Per-speaker transcription.** Every person's mic is its own LiveKit track, so the agent never has to guess who spoke. Deepgram's word timings are mapped back to wall-clock time, and each utterance lands on the item that was in focus *when it was said*, even if the transcript arrives after someone switched items.
- **Screen reading.** The presenter's browser takes a snapshot when the screen changes and settles (`src/web/room/useFrameSampler.ts`), at most one every few seconds. The agent compares it to the agenda and only suggests above a confidence threshold. A dismissed suggestion stays quiet for 90 seconds; pinning turns suggestions off.
- **Notes.** Each item's notes are regenerated a few seconds after the talk about it pauses, and again when the meeting ends. Items belong to the room rather than one meeting, so a recurring standup builds history per ticket.

Code map: `src/server` (Express + ws + SQLite), `src/web` (React + Vite), `src/shared/protocol.ts` (messages between them).

## Not built yet

- Per-room permissions (anyone signed in who has the link can join).
- Writing decisions back to Linear as comments.
- Google Docs / Notion outlines as agenda sources.
- Asking the agent things mid-meeting ("what did we decide about this last week?").
