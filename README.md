# Standup

Voice rooms where an AI agent pins every remark to the ticket or doc section it's about.

People talk (voice only, no cameras) and share their screen. The room has an agenda: typed items, Linear issues, or the slides of a deck. A **host** clicks through it, and whatever item the host has open is what everything said is recorded against. An agent listens to each person separately and writes notes per item.

The room's creator hosts whenever they're there; otherwise the first person in does. The host can hand it to anyone, and it passes on if they leave. Only the host switches items, pins one, or ends the meeting. Anyone can chat, and anyone can move a remark to the right item afterwards.

If the host shares their screen and it shows a different item than the one open, the agent gives the host a quiet nudge ("Your screen shows ENG-142 · Switch to it"). Switching also moves anything said since the screen changed. Nobody else sees the nudge.

**Slides.** Upload a deck as a PDF (Keynote, PowerPoint and Google Slides all export one). Each slide becomes an agenda item under the deck's name, titled by its biggest line of text. When the host opens a slide, everyone sees that page drawn in their own browser, sharp at any size, and the host flips with the arrow keys or the ← → buttons. Whatever is said lands on the slide that was showing, and the deck page (↗ next to the deck) shows every slide beside its discussion, decisions and action items.

**Making slides in Stand.** Agenda → + Add → Slides → *Create deck* opens Stand's own editor in a new tab: five layouts (title, bullets, section, image, quote), four themes, images, and speaker notes that only the host sees under the slide. Paste an outline (`#` per slide, `-` bullets, `>` quote, `Notes:`) to start from notes you already have; with an Anthropic key the same box drafts a deck from a plain description. Every change saves on its own and shows up in a running meeting straight away. Removed slides keep their history on the deck page.

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
| Transcription | Each browser transcribes its own mic (Chrome, Edge, Safari) | A hidden agent in the LiveKit room, using Deepgram through LiveKit Inference (no Deepgram account needed) |
| Reading the shared screen | Notices a change and guesses the next item | Claude matches the screenshot against the agenda |
| Notes per item | Keyword heuristics | Claude |
| Agenda from Linear | "Load a sample sprint" only | Project, cycle, view or issue links |

**Play demo** in the room plays a scripted four-person standup, so you can see the whole flow with no mic.

## Keys

Copy `.env.example` to `.env` and fill in what you have. Each one switches on independently.

- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` from [LiveKit Cloud](https://cloud.livekit.io) (the free tier is enough).
- Transcription needs nothing extra: it runs through [LiveKit Inference](https://docs.livekit.io/agents/models/stt/deepgram.md) on your LiveKit keys and is billed by LiveKit (about $0.005/min; the free plan includes some credit). `STT_MODEL` picks the model (default `deepgram/nova-3`). If you'd rather pay Deepgram directly, set `DEEPGRAM_API_KEY` and the agent talks to Deepgram instead.
- `ANTHROPIC_API_KEY` for notes and screen reading. `ANTHROPIC_MODEL` overrides the model (default `claude-opus-5-5`).
- `LINEAR_API_KEY`, a personal API key from Linear settings.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` from an OAuth client ID ("Web application") in Google Cloud. Add `<origin>/api/auth/google/callback` as an authorized redirect URI. `ALLOWED_EMAILS` (exact addresses) and `ALLOWED_EMAIL_DOMAINS` limit who can get in, checked on every request, so removing someone takes effect at once; once either is set, only Google sign-in works; `PUBLIC_URL` sets the origin when behind a proxy.

## Production

```bash
npm run build && npm start   # serves the built app and API on $PORT
```

Data is a SQLite file in `DATA_DIR` (default `./data`), with uploaded decks in `DATA_DIR/decks`. Node 22.13 or newer.

### Deploying (Railway)

`Dockerfile` and `railway.json` deploy the whole app as one container. Because meetings live in SQLite, run exactly one replica and attach a Railway volume mounted at `/data`. Set the keys from `.env.example` in Railway's Variables tab, plus `PUBLIC_URL=https://<your domain>`. For Google sign-in, add `https://<your domain>/api/auth/google/callback` as an authorized redirect URI on the OAuth client. The health check is `GET /api/health`.

## How it works

```
browser ──WebSocket /ws/rooms/:id──▶ RoomSession (src/server/room.ts)
   │                                   ├─ focus log: which item was in focus when
   │  mic + screen                     ├─ segments: speech + chat, each pinned to an item
   ▼                                   ├─ suggestions from screen snapshots
LiveKit room ◀── hidden agent ──▶ speech-to-text (one stream per speaker)
                                       └─ notes per item ──▶ Claude
```

- **Per-speaker transcription.** Every person's mic is its own LiveKit track, so the agent never has to guess who spoke. Speech-to-text word timings are mapped back to wall-clock time, and each utterance lands on the item that was in focus *when it was said*, even if the transcript arrives after someone switched items.
- **Screen reading.** The presenter's browser takes a snapshot when the screen changes and settles (`src/web/room/useFrameSampler.ts`), at most one every few seconds. The agent compares it to the agenda and only suggests above a confidence threshold. A dismissed nudge stays quiet for 90 seconds; pinning turns nudges off.
- **Notes.** Each item's notes are regenerated a few seconds after the talk about it pauses, and again when the meeting ends. Items belong to the room rather than one meeting, so a recurring standup builds history per ticket.

Code map: `src/server` (Express + ws + SQLite), `src/web` (React + Vite), `src/shared/protocol.ts` (messages between them).

## Not built yet

- Per-room permissions (anyone signed in who has the link can join).
- Writing decisions back to Linear as comments.
- Google Docs / Notion outlines as agenda sources.
- Google Slides links that stay in sync, and .pptx upload (export to PDF for now).
- Asking the agent things mid-meeting ("what did we decide about this last week?").
