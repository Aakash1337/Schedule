# Local Product API

The local product API exposes the deterministic planner without committing the project to a frontend or cloud authentication design. It is available under `/v1` when `PRODUCT_API_MODE=local_unauthenticated`.

## Safety boundary

- Development defaults to `local_unauthenticated` and binds to `127.0.0.1`.
- Production is always `disabled`; configuration rejects attempts to enable unauthenticated routes in production or on a non-loopback application bind.
- This mode must not be exposed to an untrusted network. Authentication and authorization are required before public hosting.
- CORS is disabled, JSON bodies are limited to 256 KiB, request objects reject unknown fields, and error responses do not include stack traces.
- Product routes are limited to 240 requests per minute per source address and two concurrent plan generations per API process.
- Local mode caps an installation at 20 workspaces; each workspace is capped at 500 routines, 5,000 activity events, 2,000 plan revisions, and 50 revisions for one date.
- Plan responses expose the original planning request, input hash, and algorithm versions, but not routine snapshots or activity history from the complete persisted input snapshot.

## Routes

| Method  | Route                                                                        | Result                                           |
| ------- | ---------------------------------------------------------------------------- | ------------------------------------------------ |
| `POST`  | `/v1/workspaces`                                                             | Create a workspace (`201`)                       |
| `POST`  | `/v1/workspaces/{workspaceId}/routines`                                      | Create a routine (`201`)                         |
| `GET`   | `/v1/workspaces/{workspaceId}/routines?status=active&limit=100&offset=0`     | List a bounded routine page (`200`)              |
| `GET`   | `/v1/workspaces/{workspaceId}/routines/{routineId}`                          | Retrieve one routine (`200` or `404`)            |
| `PATCH` | `/v1/workspaces/{workspaceId}/routines/{routineId}`                          | Version-checked partial update (`200` or `409`)  |
| `GET`   | `/v1/workspaces/{workspaceId}/routines/{routineId}/activity-events`          | List stable, cursor-paginated history (`200`)    |
| `POST`  | `/v1/workspaces/{workspaceId}/routines/{routineId}/activity-events`          | Idempotently record activity (`200`)             |
| `POST`  | `/v1/workspaces/{workspaceId}/plans`                                         | Generate or retry a daily plan revision (`200`)  |
| `GET`   | `/v1/workspaces/{workspaceId}/plans/{YYYY-MM-DD}?revision=1`                 | Retrieve an exact revision (`200` or `404`)      |
| `GET`   | `/v1/workspaces/{workspaceId}/plans/{YYYY-MM-DD}/current`                    | Retrieve the current Today plan and head version |
| `PATCH` | `/v1/workspaces/{workspaceId}/plans/{YYYY-MM-DD}/items/{itemId}/lock`        | Idempotently lock or unlock a current plan item  |
| `POST`  | `/v1/workspaces/{workspaceId}/plans/{YYYY-MM-DD}/regenerations`              | Regenerate around locked items                   |
| `POST`  | `/v1/workspaces/{workspaceId}/plans/{YYYY-MM-DD}/items/{itemId}/replacement` | Replace one unlocked item                        |

Activity requests require an `Idempotency-Key` header containing 1–160 characters. Reusing a key with identical event content returns the original event. Reusing it for different content returns `409 activity.idempotency_conflict`. Public event responses omit the key because the caller already owns it and it is retry metadata, not activity history.

Routine updates require `expectedVersion`. Scalar fields are partial; if `tags`, `duration`, or `cadence` is supplied, that nested object is a complete replacement. A real change increments the routine version once. A semantic no-op returns the current routine without writing or incrementing its version. A stale version returns `409 routine.version_conflict`.

Routine activity history is ordered by newest ingestion first and accepts `limit` from 1–200 (default 50) plus an opaque, integrity-protected `cursor`. The cursor is bound to its workspace and routine. The first page captures a high-water mark, so later appends do not shift subsequent pages. A non-null `page.nextCursor` retrieves the next page. Local cursor signing keys are process-bound, so clients should restart pagination after an API restart.

A plan is identified by workspace, local date, and positive request revision. Retrying against an unchanged input snapshot returns the persisted plan. If routine or activity history has changed, reusing the revision returns `409 planning.revision_conflict`; the caller must intentionally increment the revision.

Every plan item has a stable UUID and a projected `locked` flag. The current-plan response adds `headVersion`. Lock changes require an `Idempotency-Key` plus `expectedPlanId` and `expectedHeadVersion`; stale state returns `409 planning.head_conflict`. Identical retries return the original result, while key reuse for another command returns `409 planning.idempotency_conflict`. Lock and unlock facts are append-only even though the current flag is projected for efficient reads.

Regeneration and replacement require the same optimistic identity and idempotency header plus a complete planning request with a new seed. The server allocates the next revision. Regeneration carries locked items exactly and plans only residual capacity. Replacement anchors every sibling, rejects a locked target, excludes the removed routine, and fills the released capacity. Prior revisions remain immutable and mutation provenance is retained for replay. A retry resolves to the same immutable plan revision and recorded head version; its `locked` flags reflect the latest projected lock state for that revision.

## Error shape

```json
{
  "error": {
    "code": "cadence.minimum_exceeds_target",
    "message": "Cadence minimum cannot exceed its target."
  },
  "requestId": "req-1"
}
```

Malformed request data returns `400`, domain validation returns `422`, absent workspace/routine/plan resources return `404`, idempotency or revision conflicts return `409`, oversized bodies return `413`, rate or concurrency limits return `429`, and unexpected failures return a redacted `500`.

## Minimal local flow

Create a workspace:

```powershell
$workspace = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4000/v1/workspaces `
  -ContentType application/json -Body '{"name":"Personal"}'
```

Create a routine:

```powershell
$routineBody = @{
  title = "Practice Spanish"
  tags = @{ priority = "high"; contexts = @("computer"); categories = @("learning") }
  duration = @{ expectedMinutes = 30 }
  cadence = @{ period = "week"; targetCompletions = 3; maximumCompletions = 4 }
} | ConvertTo-Json -Depth 6

$routine = Invoke-RestMethod -Method Post `
  -Uri "http://127.0.0.1:4000/v1/workspaces/$($workspace.id)/routines" `
  -ContentType application/json -Body $routineBody
```

Pause the routine using optimistic concurrency:

```powershell
$updateBody = @{ expectedVersion = $routine.version; status = "paused" } | ConvertTo-Json
$routine = Invoke-RestMethod -Method Patch `
  -Uri "http://127.0.0.1:4000/v1/workspaces/$($workspace.id)/routines/$($routine.id)" `
  -ContentType application/json -Body $updateBody
```

The database-backed in-process API verification can be run with:

```powershell
pnpm verify:product-api
```
