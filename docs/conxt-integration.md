# Conxt transcript integration

Stand can deliver completed meeting transcripts to a Conxt hosted project using
Conxt's authenticated source API. Stand retains its meeting SQLite database; Conxt
owns the shared PostgreSQL sources, review proposals and accepted knowledge.

Both applications were deployed on 2026-10-11 UTC. Stand deployment
`3f9b92bc-4036-4faa-85d8-c7948988b968` retains one replica and its `/data` volume.
The configured destination is **conxt-pilot / Stand**; no existing room was connected
and no historical meeting was exported. A room owner must explicitly connect first.
Conxt uses the existing OpenRouter DeepSeek model. A synthetic cloud submission
passed real model processing and duplicate-safe receipt checks; its proposals were
rejected as cleanup and nothing was published. Real-account MCP sign-in and a real
meeting after owner consent remain first-use checks. No real meeting data was exported.

Stand was backed up before deployment. The private archive is
`/Users/tin/.conxt/database-backups/stand-20261011-before-conxt/stand.tar.gz`, with a
restore-verified manifest. The temporary backup SSH key was revoked and removed.
Changes are uncommitted on `codex/conxt-transcript-delivery`; no Git push occurred.
A later Git-based deployment must include these changes to retain the integration.

## Configure and connect

1. Deploy the Conxt hosted API, `/team` browser app and cloud source worker. Set its
   source model and server-side provider credential. The current hosted rollout is
   already configured with `openrouter/deepseek/deepseek-v4-flash` and its OpenRouter secret.
2. In Conxt `/team`, sign in, choose/create the shared project and use **Connect
   meeting app**. Confirm the team audience and cloud processing. Save the one-time
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

Run `npm run typecheck`, `npm test` and `npm run build`. All 67 server tests, including
nine integration tests, pass. A Chromium check exercises destination selection,
explicit consent, retry, processed status and disconnection. A local cross-application
smoke test uses Stand's actual Node exporter, Conxt's real HTTP API and disposable
PostgreSQL: a lost acknowledgement followed by identical retry creates one hosted
source; cloud extraction prepares a review proposal; Stand observes ready; another
member publishes it. Model responses are fake in that test, and no production service
or provider credential is used.

Before calling the integration live, verify both deployment statuses, an actual room
owner connection, a real completed meeting, provider processing and a second user's
Conxt review/retrieval. Back up each production database before additive schema rollout.
