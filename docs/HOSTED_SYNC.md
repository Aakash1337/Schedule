# Hosted work-item sync protocol v1

Schedule exposes a narrow, authenticated pull protocol for reconstructing and following one
workspace's work items. The hosted browser shell consumes it through an online, in-memory client;
there is no durable local cache, offline client, upload queue, conflict resolver, or push channel.
It covers work items only.

The existing offset endpoint at
`GET /v1/hosted/workspaces/:workspaceId/work-items/snapshot` remains an independent current-state
pagination endpoint. It may shift between requests and has no sync semantics. The hosted browser
shell now uses only the two sync routes below for work-item reconciliation.

## Protocol flow

Both routes return `protocolVersion: 1`, default `limit` to 100, accept limits from 1 through 200,
reject unknown or noncanonical query fields, and send `Cache-Control: no-store`.

| Stage     | Request                                                                                        | Response                                                                 |
| --------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Bootstrap | `GET /v1/hosted/workspaces/:workspaceId/work-items/sync/bootstrap?limit=100`                   | `{ protocolVersion, items, checkpoint, nextCursor }`                     |
| Continue  | Repeat bootstrap with its non-null `nextCursor`                                                | Same shape and checkpoint; `nextCursor: null` ends the item traversal    |
| Delta     | `GET /v1/hosted/workspaces/:workspaceId/work-items/sync/changes?cursor={checkpoint}&limit=100` | `{ protocolVersion, changes, checkpoint, nextCursor }`                   |
| Continue  | Repeat changes with its non-null `nextCursor`                                                  | Same pinned checkpoint; `nextCursor: null` ends that frozen delta window |

A consumer reconstructs safely by staging an empty item set and atomically committing each bootstrap
page together with its continuation cursor. Once bootstrap traversal ends, it sends the bootstrap
`checkpoint` to the changes route and atomically applies each returned page in response order until
the delta `nextCursor` is null. Only then can it promote the staged set and persist that terminal
delta `checkpoint`; it must not render or publish a partially caught-up stage. Later polls send the
saved checkpoint to the changes route and repeat the pinned-delta traversal.

The browser implementation stages every bootstrap or delta continuation in memory and publishes the
collection only after the complete traversal succeeds. It keeps one checkpoint for the selected
workspace, discards it on workspace change or sign-out, and performs a delta after successful local
mutations or an explicit retry. A `410` starts exactly one fresh bootstrap recovery. It does not
persist data or cursors, poll in the background, or synchronize while the page is closed.

Bootstrap pages are ordered by immutable work-item ID and retain the first page's checkpoint. A
per-row database fence prevents values written after that checkpoint from leaking into bootstrap;
changed rows move into the subsequent delta instead. A retried bootstrap continuation can therefore
return a different payload after intervening writes. The protocol promises convergence after staged
catch-up, not byte-stable bootstrap replay or a server-held snapshot session. The first delta page
captures its own upper checkpoint; every continuation is pinned to that same upper bound and remains
immutable while retained, so later writes cannot leak into the in-progress delta window.

`items` and `upsert.item` contain the full current work-item projection except `workspaceId`:
`id`, nullable `parentWorkItemId`, title, nullable description, status, priority, nullable `dueOn`,
nullable `planningDurationMinutes`, optimistic version, and ISO creation/update timestamps. A change
is exactly one of:

```json
{ "type": "upsert", "item": { "id": "...", "title": "...", "version": 2 } }
{ "type": "delete", "workItemId": "..." }
```

The example abbreviates the full upsert only for readability. A deletion is deliberately
identity-minimal: it has no title, description, version, workspace ID, or deletion timestamp.

## Durable cursor boundary

`checkpoint` and `nextCursor` are opaque, versioned, HMAC-protected tokens. The server binds each
token to its workspace and stage (`bootstrap`, durable checkpoint, or pinned delta continuation),
and exposes no standalone decimal cursor field. The base64url JSON payload is signed, not encrypted,
so it is not confidential. Clients must store and return tokens unchanged rather than decode or
construct them.

The signing key is purpose-derived from the hosted browser-session pepper. Cursors therefore survive
API restarts and work across replicas that use the same secret. Rotating that pepper signs out browser
sessions and invalidates outstanding sync cursors; affected clients must authenticate and bootstrap
again.

The hosted workspace boundary authenticates and authorizes the requested workspace before parsing a
cursor. Unavailable or unauthorized workspaces remain the same redacted `404`. An authorized request
with a malformed, tampered, reversed-window, wrong-workspace, or wrong-stage cursor receives `400`.
If retention has removed required history, or a valid signed checkpoint, after-position, or pinned
through-position is ahead of the restored database head after point-in-time recovery, the route
returns `410 hosted_sync.cursor_expired` with the instruction to start a fresh bootstrap. A disabled
or missing capture capability, missing per-workspace sync state, and other store corruption produce a
redacted `500`, never a partial page.

## Transactional change capture

Migration `0041` creates the global `hosted_work_item_sync_capability` singleton with capture disabled.
While disabled, the work-item trigger leaves row fences and workspace heads at zero and writes no
full-upsert change journal, so a never-enrolled default local runtime does not accumulate sync history.
Bootstrap and delta stores fail closed rather than reading while the singleton is disabled or missing.

Hosted OIDC startup calls `enableHostedWorkItemSyncCapture()` after app assembly and before returning
the app to its listener. The function locks the singleton and performs its only allowed transition,
from disabled to enabled; `protect_hosted_work_item_sync_capability()` and the
`hosted_work_item_sync_capability_guard` trigger reject reversal or replacement. Activation failure
closes startup. Each work-item trigger takes a shared capability lock, so a concurrent mutation is
ordered wholly before enrollment at cursor zero with no history, or wholly after it at cursor one or
later with a captured change. Enrollment is database-wide and irreversible; later starting the API in
disabled mode does not turn capture off.

After enrollment, the row-level database trigger covers successful `INSERT`, `UPDATE`, and `DELETE`
statements on `work_items`, including writers that bypass the ordinary repository. It serializes
cursor allocation inside the work-item transaction, so a committed mutation and its change either
both persist or both roll back. Upserts retain the full work-item fields needed by the wire projection;
deletion rows keep only identity plus internal recording metadata. The internal recording timestamp
exists only for retention and is never returned as a tombstone field. Guarded cleanup may delete only
an expired prefix while the workspace exists.

Migration `0041` initializes every existing workspace at cursor zero and marks its existing work items
with the zero bootstrap fence. The `initialize_hosted_work_item_sync_state()` function and
`workspaces_initialize_hosted_sync_state` trigger create the same `head=0, minimum=0` state for every
new workspace, including one with no items. Fresh bootstrap therefore includes migrated rows without
inventing historical changes, and a missing state row is corruption rather than an empty workspace.
The work-item trigger covers ordinary row DML while enabled; it suppresses no-op updates and rejects
attempts to rewrite work-item identity or its managed cursor.
It is not a promise about `TRUNCATE`, disabled triggers, DDL rewrites, or data loaded into a
pre-migration schema. Hosted backup/restore must preserve the capability singleton, state table,
change log, per-row fence, sync enum, and all initializer, capture, and protection functions and
triggers together. Deleting a workspace cascades its item, state, and retained history; no child
tombstones survive a workspace that can no longer be authorized.

Restore first checks the archive catalog for every application table and its data, then compares the
migrated staging schema's full signal before promotion; that second gate covers the sync enum,
functions, non-internal triggers, constraints, and indexes.

## Retention and fresh bootstrap

Change history can be pruned by the worker or by an explicit operator command. Automatic cleanup is
off by default. Enable it on the worker with:

```dotenv
HOSTED_WORK_ITEM_SYNC_CLEANUP_MODE=enabled
HOSTED_WORK_ITEM_SYNC_CLEANUP_INTERVAL_MS=3600000
HOSTED_WORK_ITEM_SYNC_CLEANUP_RETENTION_DAYS=90
HOSTED_WORK_ITEM_SYNC_CLEANUP_BATCH_SIZE=250
HOSTED_WORK_ITEM_SYNC_CLEANUP_MAX_BATCHES=20
```

Each non-overlapping cycle uses one clock instant and a dedicated one-connection pool with a
two-second per-statement PostgreSQL timeout. A failed cycle emits aggregate-only telemetry and retries
after the configured interval; shutdown finishes its bounded in-flight statement and starts no new
batch. Cleanup is not part of worker readiness.

The manual fallback remains:

```powershell
pnpm hosted-sync:cleanup -- --retention-days 90 --batch-size 250 --max-batches 100
```

The default retention is 90 days, bounded from 30 through 3,650 days. Automatic cleanup runs every
one minute through one hour (default one hour), deletes 1–500 changes per batch (default 250), and
runs 1–20 batches per cycle (default 20). The manual command accepts 1–1,000 changes per batch and
1–1,000 batches per invocation (defaults 250 and 100) for supervised backlog recovery. Each database
transaction removes only one contiguous expired prefix for one workspace and advances that
workspace's retained floor atomically. Concurrent cleanup workers skip locked workspace state and
report transaction contention rather than claiming the backlog is empty.

The command prints only aggregate `batches`, `deletedChanges`, `workspacesTouched`, and
`limitReached`. A true `limitReached` means the bounded run exhausted its batch allowance; let the
next cycle continue, run the command again, or intentionally increase the allowance. Operators
should choose a retention window longer than the supported client-disconnection interval and
monitor cleanup freshness, failures, cap exhaustion, database growth, and `410` rates. Any cursor
behind the advanced floor is intentionally unrecoverable; the client discards its partial state and
starts a fresh bootstrap.

## Deliberate limits

The browser integration is online and in-memory only. Protocol v1 has no shipped offline store,
background polling policy, upload/bidirectional synchronization, merge policy, conflict resolution,
push notification, or synchronization for routines, plans, calendar blocks, reminders, memberships,
or workspace administration. The ordinary optimistic write APIs remain authoritative.
