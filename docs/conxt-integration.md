# Conxt transcript integration

Stand can deliver completed meeting transcripts to a Conxt hosted project using
Conxt's authenticated source API. Stand retains its meeting SQLite database; Conxt
owns the shared PostgreSQL sources, review proposals and accepted knowledge.

Current Stand deployment `dcaa4b59-5054-42cc-9558-9597ab43b6ac` combines the
integration with GitHub main `433cfca`, retains one replica and its `/data` volume,
and reports SUCCESS. A later GitHub deployment had replaced the initial source
upload; this repaired build preserves those newer Stand changes.

The configured destination is **conxt-pilot / Stand**. The owner explicitly connected
only the dedicated **Conxt integration test** room (`v5xajrip`). Historical meetings
were not exported. Conxt deployment `a7fff958-a0c7-4b48-afee-db6fd4325fcb` serves the
full hosted dashboard, API, remote MCP and DeepSeek source worker.

A synthetic meeting in an isolated local Stand database used the actual finalization
and delivery code against the hosted Conxt API. A lost acknowledgement and retry
returned one source; DeepSeek produced one grounded proposal in the shared review
queue, and Stand recorded ready. That fictional proposal remains pending, unpublished.
This verifies the downstream pipeline, not the production Stand outbox or speech
recognition. Live solo transcription attempted to start but LiveKit inference returned
HTTP 429; that provider issue and real-user MCP retrieval remain open checks.

Stand was backed up before deployment. The private archive is
`/Users/tin/.conxt/database-backups/stand-20261011-before-conxt/stand.tar.gz`, with a
restore-verified manifest. The temporary backup SSH key was revoked and removed.
Implementation changes are committed on `codex/conxt-transcript-delivery`, including
merge `a192af8`; no Git push occurred.
A later Git-based deployment must include these changes to retain the integration.

## Configure and connect

1. Deploy the Conxt hosted API, dashboard and cloud source worker. Set its
   source model and server-side provider credential. The current hosted rollout is
   already configured with `openrouter/deepseek/deepseek-v4-flash` and its OpenRouter secret.
2. In Conxt, sign in, choose the team and shared project, open **Connections**,
   and use **Connect an app**. Confirm the team audience and cloud processing. Save the one-time
   integration credential and the submission URL in Stand's server secrets.
3. Set `CONXT_DESTINATIONS` on Stand to a JSON array:

```json
[
  {
    "key": "product",
    "label": "Acme / Product",
    "submissionUrl": "https://conxt-api.up.railway.app/api/v1/integrations/REPLACE-WITH-INTEGRATION-UUID/sources",
    "token": "REPLACE-WITH-SERVER-ONLY-INTEGRATION-CREDENTIAL"
  }
]
```

Replace both placeholders. The UUID must be the integration created in Conxt. The
label should accurately identify its team and project. Conxt derives the destination
from the integration credential, never from Stand's request body. The URL must be
HTTPS, match the exact source submission path, and contain no embedded credentials,
query or fragment. Stand follows no redirects when sending credentials.

All Stand room owners can choose from these operator-configured destinations. Only
configure destinations approved for those owners. Credentials never appear in Stand's
browser APIs, browser storage or SQLite outbox. Rotate a token in the server variable
while retaining the same key and URL; restart Stand to load the new configuration.
Changing a key or URL does not reroute persisted work.

4. Set Stand's existing `PUBLIC_URL` to its real HTTPS origin. This is required for
   correct same-origin browser checks behind a proxy, and supplies meeting evidence
   links such as `/meetings/<id>`.
5. Restart/deploy Stand, keeping its persistent `DATA_DIR` volume and exactly one
   replica, as the existing deployment requires.
6. In Stand **Manage spaces**, the room's owner selects a Conxt destination and
   explicitly confirms transcript sharing. Meetings started after connecting are
   eligible. Past meetings and meetings already in progress are excluded, including
   meetings started in the same millisecond as the connection action.

Anyone in the Stand room can read its delivery status on the meeting recap. Owners
can connect/disconnect and retry delivery in Manage spaces. Conxt team members can
read imported sources and review/publish resulting proposals through Conxt's flat
team access. Stand membership and Conxt team membership are separate.

## Durability and privacy

A SQLite trigger binds each new meeting to the active connection when it starts.
Finalization saves the ended meeting and its immutable outgoing source envelope in
a single SQLite transaction. A failed insert rolls back both. Startup/periodic
reconciliation catches completed eligible meetings missing an outbox row. It cannot
backfill unconnected history or silently adopt another destination.

The envelope includes a durable UUID delivery ID, a namespaced Stand instance/meeting
identity, a content/metadata revision hash, UTC timestamps, speaker labels, recorded
speech/chat and an optional HTTPS meeting link. The original transcript is shared;
generated notes and summaries do not replace it. The same persisted payload is used
on every retry, even if an acknowledgement is lost or Stand restarts after remote
acceptance. Conxt's delivery and source-revision deduplication returns the same receipt.

Stand leases each delivery and fences updates by lease UUID. Network errors, HTTP 429
and 5xx responses retry with bounded exponential backoff (up to five minutes); after
12 consecutive unconfirmed attempts, the room owner can retry when the connection is
restored. Credential, scope, payload and conflict errors surface safely without
reflecting remote bodies or tokens. Expired in-flight leases recover after a restart.

After acceptance, Stand polls only the receipt URL derived from its configured
integration URL. A remote `status_path` cannot redirect its bearer credential. Queued
or processing sources are shown as received/processing. Remote failures stay visible;
retry cloud processing in Conxt, and Stand observes the updated status. Delivery
failures can be retried from Stand. A `ready` receipt means Conxt processed the
transcript; publication still requires team review in Conxt.

Disconnecting or switching destinations pauses the old connection's pending work and
stops eligibility for subsequent meetings. An already-sent or in-flight request may
complete and cannot be recalled by disconnecting. Reconnecting creates a new connection
for new meetings; it does not resume or resend old paused work. Old delivery records
remain visible. Re-selecting the already active destination is idempotent.

Conxt currently accepts at most 250,000 UTF-8 bytes per transcript. Stand marks larger
transcripts failed and sends nothing; it never silently truncates them. Empty meetings
are skipped. Source corrections and explicit historical backfill are not implemented
by this producer. Connection setup does not transmit past meetings.

## Code and validation

- `src/server/conxt.ts`: connection config, schema, exporter, outbox worker and routes.
- `src/server/db.ts`: atomic meeting finalization and source enqueue.
- `src/server/index.ts`: authenticated route registration and cloud delivery loop.
- `src/web/ConxtPanel.tsx`: consent, connection and delivery status controls.
- `src/server/conxt.test.ts`: restart/ambiguity recovery, leases, exact source delivery,
  origin/membership/owner checks, secret isolation, limits and rollback/reconciliation.

Run `npm run typecheck`, `npm test` and `npm run build`. All 99 server tests, including
nine integration tests, pass on the combined current-main integration. A Chromium check exercises destination selection,
explicit consent, retry, processed status and disconnection. A local cross-application
smoke test uses Stand's actual Node exporter, Conxt's real HTTP API and disposable
PostgreSQL: a lost acknowledgement followed by identical retry creates one hosted
source; cloud extraction prepares a review proposal; Stand observes ready; another
member publishes it. Model responses are fake in that test, and no production service
or provider credential is used.

Before calling the integration live, verify both deployment statuses, an actual room
owner connection, a real completed meeting, provider processing and a second user's
Conxt review/retrieval. Back up each production database before additive schema rollout.


## Producer synthesis (2026-10-11)

Stand now owns synthesis for this integration. At finalization the immutable outbox
captures existing structured notes, summary, optional narrative, and ordered transcript
turns. Discussion-linked segments supply exact evidence. Turn starts use Unicode code
point coordinates in the canonical transcript (not JavaScript UTF-16 offsets).
Decisions outside a decided discussion and notes without bounded transcript links are
held unresolved. No additional model call is made; summaries never replace evidence.
Conxt stages evidence-linked settled knowledge for assessment and human review.
Tasks/questions remain source context, with owner/completion snapshots; Stand remains
the task authority. Later edits and task completion do not currently sync automatically.
Old queued deliveries remain unchanged. Deploy the Conxt contract first, then Stand.
A synthetic producer fixture was generated with actual finalization/outbox code and
validated through Conxt's disposable PostgreSQL API/worker/review pipeline.


## Live transcript delivery

Connected meetings now send recorded turns while the meeting runs, including updates
when consecutive speech extends an existing turn. SQLite triggers persist changes in
a separate durable outbox. Pending batches are immutable until acknowledged; ordered
sequences make lost receipts and restart retries safe. New events remain queued while
a batch is in flight. Acknowledged events are compacted. Disconnecting pauses live
sharing; changed destinations never reroute pending work. Owner-only live retry and
status are available in the connection panel.

Deploy Conxt's live transcript API/migration first. Conxt Sources shows provisional
turns and refreshes every two seconds; MCP can read them separately from accepted
knowledge. The final synthesis delivery remains the existing governed path. Only
meetings bound to a connected room are shared; connecting mid-meeting applies to its
next meeting. Speech generation depends on the existing Stand speech provider.


## App-level default

Set `CONXT_DEFAULT_DESTINATION` to a configured destination key and
`CONXT_DEFAULT_OPERATOR_EMAIL` to an existing Stand operator's email. This is an
explicit app-wide sharing choice: future meetings in existing and new rooms inherit
the destination, with transcripts visible to everyone in its Conxt team. No room-by-
room connection is needed. The operator is recorded as the default's connection actor.

Existing explicit room destinations and prior disconnects remain overrides. Owners
can turn sharing off persistently or explicitly Use app default again. The panel
shows the app policy and room mode. Changes apply to future meeting bindings and
never adopt historical meetings or redirect an already bound meeting. Removing the
app default pauses inherited connections but preserves explicit room connections.
Reapplying the same configuration is idempotent across restarts.

Tests cover old/new rooms, live/final delivery, room opt-out and restart, default
changes and explicit overrides, old preference migration, invalid configuration,
owner/origin/consent checks, and credential non-disclosure.
