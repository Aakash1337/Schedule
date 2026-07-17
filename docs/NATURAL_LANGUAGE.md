# Local natural-language work proposals

Schedule can use an optional local Ollama/Gemma model to turn free-form text into one reviewable
backlog-title proposal. When the text states them unambiguously, the model may also return separate
review-only suggestions for priority, due date, and planning duration. The user must explicitly use
or replace each value before confirmation. This is a deliberately narrow capture path, not a general command agent. The
model cannot create work, call tools, read Schedule data, select a workspace, or change planning
state. A work item exists only after the user reviews the title and those user-authored fields and
explicitly confirms them.

## Implemented scope

The version 1 contract supports exactly one command:

```json
{ "type": "work_item.create", "title": "Prepare the launch checklist" }
```

The executable model command remains title-only. A separate `modelSuggestions` object may contain a
non-`none` priority, an absolute local due date, or a planning duration from 1 to 43,200 minutes.
Relative dates are resolved only against the browser-supplied local reference date; ambiguous or
unstated values remain `null`. The review still starts with no priority, due date, or planning
duration. A suggestion changes only the local form after the user activates its **Use suggestion**
control, and the user may edit it again before confirmation. Confirmation creates exactly one root
`backlog` work item with no description and the complete reviewed snapshot. Routine creation, tags,
recurrence, task breakdown, bulk commands,
calendar changes, and plan mutations remain outside the model contract.

## Trust and privacy boundary

`LOCAL_MODEL_PROPOSAL_MODE` defaults to `disabled`. When enabled, proposal generation shares the
same strict local-model transport as the read-only advisor: one direct IPv4-loopback `/api/chat`
request, an allowlisted Gemma model, no DNS, proxy, redirect, credentials, tools, thinking, or
automatic retry, and bounded connection, request, response-size, and concurrency controls. The
fixed system instruction treats the submitted text as untrusted data. Provider output must match an
exact versioned JSON schema and then pass independent provider and application validation of keys, lengths,
NFC normalization, whitespace, control and bidirectional-formatting characters, command kind, and
work-item domain rules. Suggestions have exact keys and bounded values; an empty or malformed
suggestion object cannot cross the provider boundary.

The prompt is sent only to the configured local provider. Schedule never stores the prompt, model
summary, warnings, raw envelope, hidden reasoning, or provider error body. A deployment-secret,
domain-separated HMAC fingerprint of the normalized prompt and reference date is stored only to
recognize conflicting reuse of a request ID;
an unkeyed prompt hash is not used. The persisted proposal contains the canonical command and its
SHA-256 digest, bounded provider/model identifiers, lifecycle state, expiration, optimistic version,
eventual result identity, immutable advisory suggestions plus their own canonical SHA-256 digest,
and the separately stored user-authored review fields plus their own digest. Suggestions are excluded
from the command and review digests, confirmation input, and audit payloads. API responses use
`Cache-Control: no-store` for the complete proposal route family, including validation and error paths.

## Proposal lifecycle

1. The browser generates a request UUID and submits the versioned prompt plus its current local date.
2. The application checks the workspace in a short transaction and closes it before inference.
3. A valid provider result is canonicalized and inserted as a pending proposal with immutable,
   separately stored suggestions and a configurable
   lifetime of 60 seconds to one hour. Reusing the same request UUID and normalized prompt returns
   the pending winner without another model call; different text conflicts.
4. The browser displays the exact proposed title, labels suggestions separately, and provides one
   explicit-use control per suggested field. Suggestions never prefill the user's choices. An edit
   replaces the complete reviewed snapshot under one
   version check and is not a work-item mutation. If an edit response is lost, an exact-snapshot retry
   may return the already-won current version without another write or audit.
5. Cancellation is version-checked, audited, terminal, and creates no work item.
6. Confirmation requires an `Idempotency-Key` and the expected proposal version. One serializable
   PostgreSQL transaction locks the tenant-scoped proposal, revalidates expiration and the canonical
   command digest and reviewed-field digest, creates the deterministic root backlog work item, marks the
   proposal confirmed, and appends the audit event.

The same confirmation key replays the original result with `replayed: true`. A different key after a
successful confirmation conflicts. The deterministic work-item ID also permits safe recovery if the
item insert completed inside an earlier transaction attempt. PostgreSQL uniqueness, row locking,
optimistic versions, serializable retries, and a tenant-bound result foreign key form the durable
backstop; process-local memory is not part of exactly-once behavior. Expired, cancelled, and
confirmed proposals cannot be edited, cancelled again, or regenerated through the original request.

## User interaction

The Work view exposes **Describe work** beside ordinary quick capture. The local-proposal panel
explains its one-title authority, keeps the prompt visible on recoverable provider failure, and shows
the model result only as review data. **Review proposal** never creates work. **Cancel proposal**
records the terminal cancellation. The review labels priority, due date, and planning duration as
user choices and places bounded model suggestions beside the matching native controls. Each **Use
suggestion** action changes only the local draft. **Create this work item** first persists a changed full snapshot when needed and then
confirms with one stable key; an ambiguous network retry reuses that key. After
success, the panel closes, filters are cleared if necessary, the returned backlog item is merged into
the board, and keyboard focus moves to its card. Workspace changes abort and discard in-flight work.
Cancellation is rechecked after inference, around persistence and audit writes, and immediately before
the serializable transaction commits. An abort observed before completion rolls the transaction back;
if commit wins an unavoidable simultaneous disconnect race, replaying the same request ID recovers the
same proposal rather than creating another one.

## API and operations

The four local product routes are documented in [API.md](./API.md). Enable the feature only with a
stable secret of at least 32 bytes:

```dotenv
LOCAL_MODEL_PROPOSAL_MODE=ollama
LOCAL_MODEL_PROPOSAL_HMAC_KEY=replace-with-stable-random-secret-material
LOCAL_MODEL_PROPOSAL_TTL_SECONDS=600
LOCAL_MODEL_ADVISOR_URL=http://127.0.0.1:11434
LOCAL_MODEL_ADVISOR_MODEL=gemma4:e4b
```

Keep the HMAC key in local secret storage, not source control. Changing it does not invalidate
confirmation of existing proposals, but the same pending request can no longer be recognized from
its prompt; disable generation and let the maximum one-hour proposal lifetime elapse before planned
rotation. `LOCAL_MODEL_PROPOSAL_MODE=disabled` is the generation kill switch and does not affect
ordinary capture, planning, health, or readiness.

Migration `0028` adds `natural_language_proposals`, migration `0032` adds the user-authored
review fields, and migration `0038` adds nullable advisory suggestions without widening the model
command; the table is included in the exact backup and
restore catalog. With PostgreSQL running, `pnpm verify:natural-language-proposals` checks private
persistence, immutable suggestion isolation, reviewed fields that deliberately differ from those
suggestions on the exact root backlog result, tenant isolation, same-key replay,
competing-key conflict, and exactly one work item and confirmation audit under real concurrent transactions. `pnpm verify:web-e2e` uses the production
adapter against a strict in-process loopback Ollama double and drives the built UI without network
interception. Neither check is a model-quality benchmark.

## Deliberate boundaries

- No provider output is applied without a second explicit human action.
- A model suggestion is not a user selection and cannot enter confirmation until explicitly copied
  into the editable review form and saved.
- No proposal can invoke another Schedule command or carry caller/model-controlled identifiers.
- No prompt or free-form model prose is retained for history, analytics, logs, or audit.
- No public/hosted model endpoint is accepted.
- No claim is made that the model chooses the best title; the tests establish authority, privacy,
  validation, persistence, concurrency, and interaction behavior.
