# Product evaluation and test evidence

The test count is a diagnostic, not a release claim. A test is useful when it has a strong behavioral
oracle, exercises a meaningful boundary or failure mode, and would fail if the corresponding product
contract were materially broken. Line coverage helps find code that was never exercised, but it does
not prove that ranking, concurrency, recovery, or user-visible behavior is correct.

## Evidence model

The machine-readable registry at [`evaluation/features.json`](../evaluation/features.json) connects
implemented product behavior to its contract, risk, executable command, evidence level, and exact
test or verifier anchors. `pnpm eval:features` rejects:

- duplicate feature identifiers;
- missing contract or evidence files and stale anchors;
- implemented features without registered evidence that is executed by CI;
- critical implemented features without PostgreSQL integration or a destructive drill;
- partial features that hide their limitations; and
- deferred features that claim passing evidence.

This makes traceability a CI gate without pretending that metadata proves a command passed. The
scorecard reports structurally valid, CI-registered evidence; the unit, component, integration, and
drill job results establish whether that evidence actually passed in a particular run.

## Commands

| Command                                  | Purpose                                                                     | Requires PostgreSQL             |
| ---------------------------------------- | --------------------------------------------------------------------------- | ------------------------------- |
| `pnpm eval:features`                     | Validate feature-to-evidence traceability                                   | No                              |
| `pnpm eval:planner`                      | Run deterministic planner quality scenarios                                 | No                              |
| `pnpm test:coverage`                     | Run every unit/component test and enforce coverage floors                   | No                              |
| `pnpm eval`                              | Validate traceability and run the covered test suite                        | No                              |
| `pnpm verify:database`                   | Exercise planner, APIs, outbox, webhooks, and migrations on PostgreSQL      | Yes                             |
| `pnpm verify:natural-language-proposals` | Verify private persistence and concurrent exactly-once confirmation         | Yes                             |
| `pnpm verify:webhook-delivery`           | Verify webhook lifecycle, subscriptions, fan-out, redrive, and rollback     | Yes, disposable only            |
| `pnpm verify:notification-core`          | Verify six sources, exact-once concurrency, invalidation, and tenant guards | Yes                             |
| `pnpm verify:notification-materializer`  | Verify bounded automatic ticks, replay, skips, and delivery separation      | Yes, disposable only            |
| `pnpm verify:notification-delivery`      | Verify fenced claims/receipts, retries, expiry, and invalidation            | Yes, disposable only            |
| `pnpm verify:notification-migrations`    | Upgrade populated reminder/delivery state through migration 0027            | Yes, disposable only            |
| `pnpm verify:local-model-advisor`        | Opt-in smoke check against the configured local Ollama/Gemma provider       | Ollama and an allowlisted model |
| `pnpm verify:backup-restore`             | Verify archive/schema/content/sequence fidelity                             | Yes                             |
| `pnpm verify:recovery-state-machine`     | Exercise restore, promotion, rollback, and cleanup                          | Yes, disposable only            |
| `pnpm verify:web-e2e`                    | Exercise the built browser, API, migrations, and PostgreSQL planning loop   | Own disposable Compose database |
| `pnpm eval:full`                         | Run every evaluation layer above, including Chromium                        | Yes, with the recovery sentinel |

The destructive recovery command requires the explicit environment guards documented in
[`OPERATIONS.md`](./OPERATIONS.md). CI supplies those guards only inside its disposable Compose
project.

## Current scorecard

The package and script runners currently execute 81 test files and 1,196 runtime test cases. Three
additional Playwright specifications contain eight live Chromium integration scenarios. Parameterized
state matrices expand into many cases, so this number must not be compared as though every case were
an independent product feature.

### Feature evidence

| Metric                                                                 | Current gate |
| ---------------------------------------------------------------------- | -----------: |
| Implemented features with CI-registered evidence                       |      32 / 32 |
| Critical implemented features with CI-registered integration or drills |      18 / 18 |
| Partial features with an explicit limitation                           |        2 / 2 |
| Deferred features explicitly tracked as not passing                    |        1 / 1 |
| CI-registered evidence items                                           |          165 |
| Missing or stale evidence anchors                                      |            0 |

### Coverage diagnostics

Coverage includes all first-party TypeScript source files, including unimported files. Floors are
set just below the measured baseline so a regression fails immediately; they are ratchets, not target
quality levels.

| Scope                      | Statements | Branches | Functions |  Lines |
| -------------------------- | ---------: | -------: | --------: | -----: |
| Whole repository, measured |     59.17% |   70.46% |    67.22% | 59.58% |
| Whole repository, required |        56% |      59% |       60% |    57% |
| Domain, measured           |     96.52% |   92.21% |    97.14% | 97.56% |
| Domain, required           |        91% |      82% |       92% |    93% |
| Application, measured      |     90.54% |   84.47% |    99.24% | 91.28% |
| Application, required      |        83% |      76% |       98% |    83% |
| API, measured              |     86.49% |   75.97% |    75.50% | 87.87% |
| API, required              |        73% |      69% |       57% |    74% |
| Worker, measured           |     92.26% |   89.18% |    91.11% | 95.14% |
| Worker, required           |        85% |      87% |       89% |    87% |
| Web, measured              |     84.63% |   72.68% |    73.07% | 85.08% |
| Web, required              |        80% |      68% |       72% |    82% |

The whole-repository totals are 8,351 of 14,112 statements, 6,154 of 8,733 branches,
1,856 of 2,761 functions, and 7,883 of 13,230 lines.

Database repositories and operational scripts intentionally depress unit coverage because their
meaningful evidence runs against PostgreSQL in a separate CI job. They remain included in the global
report so new untested code cannot disappear from the denominator.

### Planner evaluation metrics

The deterministic evaluation suite currently requires:

- zero eligibility errors across workspace, lifecycle, date, pause, weekday, and consecutive-day
  hard exclusions;
- monotonic score ordering when only priority or recent-completion history changes;
- an aggregate category-diversity advantage over paired equal-capacity control scenarios;
- zero time-budget, task-count, window, duplicate-routine, position, or non-positive-duration
  violations; and
- zero replay mismatches across 24 seeds when candidate input order is reversed.

Unified-candidate coverage additionally requires that only opted-in eligible work enters the same
hard budgets as routines; persisted plan and activity records retain an exclusive typed source
identity; terminal work is not resurrected by regeneration; and a work-derived completion/reversal
is idempotent without clobbering a later accepted completion or work-item edit. The PostgreSQL and
API verifiers exercise those properties against the real candidate query and persisted schema,
including source-matched activity references.

These are contract metrics, not claims that the heuristic is globally optimal. Historical replay and
fitness-regret evaluation will become meaningful once real usage fixtures and a second planner version
exist.

### Work-item deadline evidence

The deadline feature has independent domain, application, database, API, web, and executable
PostgreSQL evidence. Domain tests require nullable real Gregorian local dates, normal version
semantics for preserving and clearing a date, deterministic v5 deadline pressure for future, today,
overdue, capped-overdue, and outside-horizon work, and continued exclusion of non-plannable work.
The configured 14-day horizon and all deadline weights are validated before planning. The test also
proves that reversed candidate order produces the same v5 snapshot hash and selected items.

Application and repository tests cover create, update, explicit clear, database row mapping, and
the nullable `due_on` column. Product API tests round-trip a leap-day date through create, get, list,
update, and clear requests while rejecting impossible and noncanonical input. Inbound-integration
tests require the canonical confirmation payload and result to retain the due date, including an
explicit clear. The Work component tests cover creating, displaying, editing, clearing, and retaining
a due-date draft after a failed save.

The `planner-db`, product-API, and integration-gateway PostgreSQL verifiers exercise the persisted
round trip, due-today explanation and ranking against otherwise equivalent work, HTTP validation,
and confirmed integration clear. The Chromium flow creates and clears a due date through the real
Work UI, generates Today through the live API and database, and observes the due-today deadline
pressure. The browser scenario is registered because it exists; it is not treated as the sole
correctness oracle.

### Work-item dependency evidence

The dependency slice separates graph correctness, planner eligibility, persistence, transport, and
interface behavior. Domain tests cover tenant-scoped edge construction, self-reference and timestamp
validation, mixed-case equality for persisted PostgreSQL UUIDs without folding arbitrary domain IDs,
done-only satisfaction across every direct prerequisite, canonical ordering and snapshot hashing,
prerequisite projections outside the candidate list, malformed and duplicate input, and dependency-
aware replanning with explicit nonterminal anchors. Planner v5 reports
`work_item_dependency_unsatisfied` without changing work-item status or deadline scoring.

Application tests cover graph-lock call ordering, same-tenant endpoint validation, exact duplicate-add
replay, transitive-cycle rejection without a write or audit, idempotent missing-edge removal, audit
only for real changes, mixed-case self-reference rejection before opening a transaction, stable
bounded listing, relevant planner projection, and the 2,000-row fail-
closed planning limit. Regeneration, feedback, and feedback-reset units prove that unmet dependents
remain excluded, including when routine feedback frees capacity. Advisor units prove that unmet
dependents are absent from provider membership, cannot be valid targets, and that dependency-status
changes invalidate an in-flight review even when membership stays unchanged. Schema and repository
tests cover the composite key, tenant foreign keys,
cascading cleanup, database self-edge check, stable pagination, joined prerequisite status,
the canonical workspace-scoped advisory-lock statement and key, a bounded ordered one-statement work/
dependency projection with malformed-result rejection and unmasked database failures, and recursive
tenant-scoped cycle detection.

API tests cover strict UUID, body, and page validation; `201` create versus `200` exact replay;
lowercase canonicalization of uppercase path/body values; mixed-case self-edge rejection; bounded
listing; idempotent `204` removal; ISO timestamps; exact self-reference, cycle, and missing-item
mappings; and redacted `500` responses with code-only invariant logging for corrupt graph projections.
Web API and Work component tests cover complete offset traversal, title/status resolution
outside the active priority filter, bounded candidate choices, inline add/remove, pending and failure
states, cycle retention, focus restoration, cache/status merging, explicit graph revalidation and
retry, workspace-switch cancellation, and the guarantee that dependency edits do not change workflow
status.

The PostgreSQL product-API verifier exercises the real add, replay, list, transitive-cycle,
cross-workspace rejection, immutable-current-plan, regeneration exclusion, prerequisite completion,
reselection, remove, repeated-remove, and audit paths. It also checks that rejected and replayed
commands do not create graph or audit rows, that a mixed-case self-edge remains `422`, and that two
simultaneous reciprocal additions serialize into exactly one `201` edge and one `409` cycle conflict.
The passing 320px Chromium scenario keyboard-opens the progressive editor, checks 44px targets and
horizontal fit, adds a done prerequisite, verifies focus, count, status, and unchanged workflow state,
reloads the persisted edge, removes it, and reloads its absence without page, request, or HTTP errors.
Together these establish the direct-prerequisite, two-request graph-mutation, and live-browser edit
contracts.

### Temporary routine-feedback evidence

Temporary routine feedback has independent oracles for policy, planning, persistence, command, and
interface behavior. Domain tests cover inclusive day and routine-defined week boundaries, tenant and
future-event filtering, deterministic latest-event resolution, reset and expiry, and immutable
recording-time input. Planner tests require **Not today** and **Not this week** to be hard routine
exclusions without changing score or cadence evidence, include the canonical latest event in the v5
input snapshot and hash, and preserve that input through residual replanning.

Application tests require an unlocked, pending routine source, prove immediate server-allocated
replanning and identical idempotent replay, and show that an appended reset clears the active
exclusion without resurrecting an older instruction. Both feedback and feedback-reset tests use the
combined work/dependency graph and keep an unmet dependent out of newly freed capacity. They also
require read-committed feedback
transactions, compare the canonical sequence-and-ID head across plan dates, reject stale heads, fail
closed on malformed snapshot metadata, and preserve accepted-command replay after the head advances.
Schema and repository tests cover tenant-bound
routine/plan/item provenance, strict suppression horizons, database-enforced append-only history,
bounded latest-per-routine reads, database-allocated ingestion order, equivalent concurrent replay,
and conflicting idempotency-key reuse. API tests reject unsupported feedback kinds before dispatch.
Today component tests cover control eligibility, missing-plan-settings safety, both time horizons,
returned-plan rendering, same-key/seed ambiguous retry, active-feedback visibility, and reset through
both the immediate success notice and a reloaded plan. None of these checks treats feedback as an
activity event or cadence edit.

The PostgreSQL product-API verifier adds a complete real route and storage flow: cross-workspace
requests and foreign provenance fail without writes; **Not today**, **Not this week**, and both resets
advance immutable revisions and the optimistic head exactly once; identical retry replays while
semantic key reuse conflicts; the weekly horizon follows the routine's Monday boundary; ingestion
sequences increase; and plan-mutation kinds retain exact provenance. A queued two-connection race
holds the routine feedback lock, commits a newer cross-date head, and requires the waiting stale API
mutation to return `409 planning.feedback_head_conflict` without row or revision growth. It also
proves the routine row
and activity count do not change and PostgreSQL rejects direct feedback updates or deletes. The live
Chromium flow applies **Not today**, verifies the hidden state survives reload, resets it, observes
the routine return pending, and then continues through persisted activity and reversal behavior.

### Duration-calibration evidence

The transparent duration slice has independent oracles at each boundary. Domain tests cover the
inclusive 90-day edge, future and unrelated evidence, minimum sample size, correction ordering,
reversal removal, even-sample rounding, material-change threshold, range review, input-order
invariance, and immutability. Application and repository tests cover tenant-first lookup, the exact
window passed to one bounded evidence query, deterministic mapping, invalid windows, and overflow
failure. Approval-use-case tests prove that routine version, current evidence, and the saved expected
duration are revalidated together; stale versions skip the evidence read, changed evidence cannot be
applied, and every other user-owned duration field is protected. API and component tests cover the
response contract, strict complete approval body, evidence-conflict mapping, all four user-visible
states, stale-response suppression, atomic approval without generic `PATCH`, conflict reload without
automatic retry, and non-blocking retries.

The PostgreSQL product-API verifier adds persisted tenant isolation, an exactly-on-boundary sample and
a one-millisecond-outside sample, correction and reversal amendments, an evidence change between GET
and approval, atomic refreshed approval, stale-version rejection, and proof that approval does not
change any current plan head. Normal PostgreSQL units of work run at serializable isolation. Insight
approval deliberately uses read committed and acquires the same per-routine advisory lock as activity
appends before capturing its evaluation cutoff and reading evidence, so statements after a lock wait
see the earlier holder's commit and the time window includes it. The verifier exercises that production
boundary and proves queued routine and plan-item evidence changes win over stale approval, including
an occurrence after the pre-wait clock time. This establishes contract correctness for
the implemented statistical rule; it does not establish that the 90-day window, three-sample minimum,
median, or material threshold improves real user outcomes.

Duration-insight feedback extends this boundary with exact-key, reversible user disposition. The
registered domain anchors cover deterministic SHA-256 key derivation and sensitivity to the
calculation policy, relevant duration policy, completion evidence, corrections, and reversals. They
also cover latest-event resolution into `available` or `dismissed`, while informational insights have
no actionable key. Application anchors cover current-insight revalidation, evidence snapshots,
exact-command replay before state revalidation, dismissal reset, and rejection when the requested
exact key is no longer current or dismissed.

Schema and repository anchors cover tenant-bound immutable history, database-allocated ingestion
order, deterministic latest-key reads, append-only persistence, workspace-scoped idempotency replay,
and conflicting key reuse. API and component anchors cover strict lowercase SHA-256 bodies, required
idempotency headers, dismiss/refetch, control gating, **Show again**, retained retryable failures,
stale-evidence refresh, and late-response protection. The PostgreSQL verifier anchors
`routine-duration-insight-feedback-api` and `routine-duration-insight-feedback-postgres` are intended
to exercise persisted dismissal, identical replay, semantic idempotency conflict, reset, automatic
resurfacing after evidence changes, database rejection of feedback UPDATE/DELETE, unchanged routine,
duration, Today-head, and planner state, and a queued routine edit winning before stale feedback can
append. These are registered evidence targets, not a claim in this document that the checks have run.

### Daily Plan Fit evidence

Daily Plan Fit has separate deterministic calculation, feedback, persistence, transport, component,
PostgreSQL, and browser oracles. Domain units require three fully resolved nonempty current heads,
exclude whole plans with pending or started items, count only scheduled minutes and item count for
completed work, cap evidence at the 28 most recent eligible samples, and remain invariant to input
order and evaluation time. Domain and repository bounds fail closed above 512 items per plan and a
candidate-derived total row ceiling. The calculation units verify half-up medians, the
30-minute/20% and one-task/25%
materiality thresholds, safe 30-minute/one-task floors, downward-only joint suggestions, canonical
SHA-256 keys, and exact-key dismissal/reset resolution.

Application units require tenant-first lookup, the bounded 90-day/90-candidate repository request,
lowercase-canonical workspace locking, read-committed feedback transactions, evidence revalidation before append, exact
idempotent replay before recalculation, semantic-key conflict rejection, and valid disposition
transitions. Repository and schema tests cover one bounded current-head projection, malformed target
exclusion, deterministic item grouping, tenant-bound append-only feedback, database-allocated
ingestion order, and workspace-scoped idempotency. API units cover explicit local-date validation,
strict lowercase SHA-256 feedback payloads, required idempotency, service delegation, and `409`
mapping for stale evidence. Web API and Today component units cover all visible states, retry,
stale-response protection, exact-key hide/restore, accessible focus and announcements, and the
central authority rule: using a suggestion only prefills both fields and cannot generate a plan.

The PostgreSQL verifier creates four real routines and three resolved current heads, derives the
expected 90-minute/two-task suggestion from 180-minute/four-task plans, exercises dismiss/reset and
exact replay, rejects semantic idempotency reuse and direct feedback UPDATE/DELETE, proves feedback
does not mutate plan heads, proves mixed-case UUID spelling queues behind the same real PostgreSQL
advisory lock, and changes terminal evidence so the old dismissal cannot hide the new key. The live
Chromium flow repeats the visible lifecycle through built processes, real routes,
migrations, and a disposable database, and confirms that plan creation occurs only after the user
submits the prefilled form. These checks establish the implementation contract, not that its
thresholds improve completion or wellbeing for a particular user.

### Local-model advisor evidence

The implemented advisor scope is deliberately narrower than the broad feature name, so the registry
marks it `partial`. Configuration units require disabled defaults, the exact four-model Gemma
allowlist, one canonical raw IPv4-loopback HTTP origin, bounded numeric controls, and a request
timeout no shorter than the connection timeout. Application units assert that the provider receives
only a bounded sanitized current-plan and eligible-backlog projection, that unmet dependents are not
provider members or valid targets, that no database unit of work is open during inference, and that
valid advice is discarded when the Today snapshot, eligible backlog, or dependency fingerprint
changes before the exact post-call recheck. They also cover bounded graph overflow, target membership,
strict output structure, duplicate rejection, deterministic truncation, and the aggregate 64 KiB
limit.

Adapter units use disposable loopback HTTP servers rather than a model. They prove the immutable
`/api/chat` path, fixed tool-free request, direct `127.0.0.1` peer, no redirect or retry, separate
connect/total limits, streamed and declared response-size limits, bounded concurrency with permit
release including caller cancellation, strict schema/canonical-text validation, and removal of raw
Ollama metadata. Product API units cover the strict versioned `both` request, exact request
correlation, rejection of caller-controlled provider fields before dispatch, disconnect cancellation,
disabled/unavailable responses, early `Cache-Control: no-store` on parser/body/rate-limit failures, and
`advisor.snapshot_conflict` mapping. Today component units cover fixed request construction, visible
non-blocking loading, safe unavailable messages, literal hostile-text rendering, absence of model-
supplied elements or mutation controls, focus restoration, conflict refresh, and stale response
invalidation across plan and workspace changes.

`scripts/verify-local-model-advisor.test.ts` is CI-executed unit evidence for the smoke verifier
itself: it requires explicit Ollama mode, runs the production adapter against a deterministic
loopback-compatible server, validates target relationships and input immutability, and ensures
successful diagnostics contain only provider, model, latency, and suggestion count while failures
contain only a fixed allowlisted reason. The actual
`pnpm verify:local-model-advisor` invocation is intentionally manual and opt-in. It calls the
production adapter with one synthetic plan item and one synthetic backlog item, but it is not run in
CI, does not exercise the product API or database snapshot recheck, and is not evidence that Gemma's
recommendations improve scheduling outcomes.

During the 2026-07-13 local audit, the production adapter passed this smoke check against the
installed `gemma4:e4b` model. A warm run completed in about 3.9 seconds and a separately controlled
model reload in about 12.9 seconds; an earlier first-ever cold load exceeded the former 45-second
limit. That host-specific observation motivated the bounded 60-second default, but it is neither a
benchmark nor a claim that every cold load behaves like the controlled reload. Operators may need a
different bounded timeout for another allowlisted model or machine.

### Natural-language proposal evidence

The Work proposal path has independent authority, persistence, transport, API, component, and live
browser oracles. Application units require keyed and domain-separated prompt fingerprints, no raw
prompt persistence, one strict command, safe canonical title text, pending-only replay, versioned
edit/cancel, expiration, tenant isolation, audit rollback, deterministic result identity, exact
same-key replay, and conflict for another confirmation key. Provider units require a fixed tool-free
schema, no thinking, strict response validation, and one concurrency budget shared with the Today
advisor.

Schema and repository tests cover request uniqueness, prompt/command/key digest shapes, bounded TTL,
terminal timestamps, tenant-bound result identity, expiry indexes, canonical JSON revalidation,
row locking, optimistic saves, and serializable retry. API tests cover strict caller authority,
disconnect cancellation, complete no-store behavior, `201` first confirmation versus `200` replay,
terminal `410` mappings, and redacted corrupt-state failures. Work component and web-client tests
cover no mutation during review/cancel, encoded routes, abort propagation, title edit before confirm,
stable-key ambiguous retry, filter-safe insertion, focus transfer, and workspace-switch invalidation.

`pnpm verify:natural-language-proposals` runs production repositories through independent real
PostgreSQL connection pools. It asserts the schema has no prompt/summary/warnings columns, a prompt
is not discoverable as an unkeyed SHA-256 value, no work exists before confirmation, concurrent
same-key calls yield one creation and one replay, competing keys yield one creation and one precise
conflict, exactly one confirmation audit exists, and another workspace cannot address the proposal.
The live Chromium scenario uses the built API and production adapter against a strict in-process
IPv4-loopback Ollama double. It proves the card is absent during review, persists the edited title,
confirms through the real HTTP/database path, moves focus to the result, and reloads it without
browser interception. These checks establish command authority, privacy, concurrency, and UI
behavior; they do not score real-model title quality.

### Calendar-aware Today availability evidence

Pure web units exercise the interval contract independently of React: no-overlap retention,
half-open edge behavior, clipping, deterministic sorting, overlapping and adjacent block merging,
complete coverage, combined free-minute calculation, a 25-hour civil day expressed as absolute
instants, order-independent freshness keys, relevant revision/timing sensitivity, irrelevant-block
stability, and fail-closed malformed intervals or versions.

Today component units observe the user-facing behavior and submitted request. They require a labelled
native opt-in control with descriptive help, a visible free-window list, exact multi-window
generation after subtraction, a second calendar read before submission, changed-calendar rejection
followed by successful reviewed retry, disabled generation for a fully consumed range, fail-closed
load errors or malformed successful responses with an explicit manual-range escape hatch, and
abort/ignore behavior for a prior workspace response. The feature remains client-owned: these checks
do not claim a server-side block lock or automatic calendar placement, and the accepted explicit
windows remain the replay contract.

## Known evidence gaps

The audit deliberately leaves these visible instead of turning them into false green checks:

- historical migration verification covers fresh-to-head, populated `0003` plan-state backfills,
  and the populated `0011` weekday-array upgrade, not every prior release boundary;
- the populated-upgrade repair preserves migration `0004`'s canonical timestamp but changes its SQL
  hash; databases migrated before the repair retain the legacy hash, while recovery compatibility
  deliberately uses the ordered timestamp ledger;
- PostgreSQL recovery verifies the successful swap/rollback path, while compensation fault injection
  is currently operation-level rather than process-kill testing;
- backup rejection covers empty, plain-SQL, truncated, schema-only, and migration-ledger-filtered
  archives plus caller-path replacement; it does not authenticate a structurally complete foreign
  Schedule archive, so backup custody remains part of the recovery trust boundary;
- worker process-kill recovery covers crashes before a side effect and after an idempotent side
  effect but before acknowledgement; future external consumers must still enforce event-ID
  idempotency at their own durability boundary;
- the inbound integration gateway verifier covers real authenticated HTTP routes, credential-scoped
  Today and backlog/Kanban work-item discovery, all five command kinds, digest-only credentials,
  idempotent replay, tenant isolation, pagination/filter behavior, and atomic rollback against
  disposable PostgreSQL; it also proves bounded retention cleanup deletes only
  eligible old receipts/confirmations while preserving fresh, processing, referenced, and audit
  rows. It does not exercise a Hermes runtime, WhatsApp transport, provider delivery, or
  natural-language interpretation;
- the outbound webhook verifier covers real PostgreSQL endpoint/secret lifecycles, workspace
  isolation, default-empty and replacement subscription state, privacy-thin automatic Today-change
  fan-out, deterministic event identity, immutable delivery/outbox linkage, dead-letter metadata,
  redrive identity, revocation, audits, and rollback. DNS, pinned-address HTTPS, TLS, and the external
  receiver are unit-faked, so there is no live-network delivery claim. The automatic event is only an
  invalidation; it does not transport reminder commands. Phone notifications and Hermes/WhatsApp
  transport remain deferred; claims and receipts use the separate authenticated pull gateway;
- the deterministic reminder core has domain/application/API/schema evidence, a populated migration
  upgrade, real PostgreSQL coverage for all six source kinds, two-request advisory-lock concurrency,
  policy/target/terminal invalidation, tenant and duplicate-key constraints, backup/restore
  inclusion, and a no-outbox-side-effect check. Its delivery verifier exercises the real Fastify
  gateway and PostgreSQL lifecycle for least-privilege scope denial, exact claim and empty-claim
  replay, fresh database-clock leases after lock waits, row-locked revocation linearization,
  concurrent exclusion, retry/dead-letter, indexed expiry fencing/recovery, source invalidation,
  bounded receipts, audits, occurrence uniqueness, cross-tenant rejection, and a workspace-scoped,
  product-safe execution-history projection that omits claim, lease, credential, and provider data.
  Its opt-in local materializer has unit evidence for disabled mode, bounded sequential cycles,
  failure isolation, non-overlap, abort behavior, and sibling-service supervision, plus disposable
  PostgreSQL evidence for catch-up boundaries, concurrent exact-once ticks, recreated-pool restart
  replay, unconfigured-workspace skips, and no outbox/delivery side effects. It does not process-kill a materialization mid-transaction;
  graceful shutdown waits for that transaction because the use case has no cancellation signal. It
  also has no external provider/account binding, shared adapter dedupe store, or dead-letter redrive
  control;
- eight live Chromium scenarios cover the central mixed routine/work-item planning loop with temporary
  feedback and activity, due-date deadline pressure, exact-key duration-insight dismissal/reset, and
  a 320px prerequisite add/reload/remove/reload flow with keyboard and target-size assertions, a
  320px subtask create/complete/reload/detach/reparent/overflow flow with leaf-only planning, plus
  explicit reminder setup, rule/one-off changes, materialization, safe execution history, and
  a 320px reminder layout, plus local proposal review/edit/confirm/replay/cancel/reload behavior
  against a strict loopback model double. They do not cover every browser, every responsive breakpoint, every
  validation branch, Calendar interaction, or the duration-calibration approval flow;
- work-item dependencies have domain, application, repository, API, component, and real PostgreSQL
  evidence, including a two-request reciprocal-add concurrency drill and the 320px live browser flow;
  dependency management is not exposed through the authenticated integration gateway;
- work-item hierarchy has domain, application, schema, API, component, authenticated Hermes,
  PostgreSQL concurrency, and 320px live-browser evidence. The database drill forces product and
  Hermes reciprocal writes to queue on the same graph lock and proves post-lock validation rejects
  the second edge without consuming its confirmation. Projects, milestones, checklist rows, roll-up
  status, and cascading completion remain distinct deferred concepts;
- duration calibration has domain, component, API, repository, and real PostgreSQL evidence, and
  exact-key dismissal/reset now preserves reversible rejection memory. It still has no production
  outcome data, learned cadence/energy/preference model, automatic application, historical insight
  comparison, or local-model participation; and
- Daily Plan Fit has deterministic cross-layer and live-browser evidence but no production outcome
  data for its 90-day window, minimum sample, medians, thresholds, or acceptance rate. It does not
  recommend increases, learn a per-user policy, apply automatically, compare historical suggestion
  outcomes, or use a model; and
- the local-model advisor has CI unit/component evidence for its configuration, application,
  transport, API, and UI boundaries, while a real Ollama/Gemma call remains an operator-run smoke
  check. The separate Work capture supports one reviewed backlog title with CI and PostgreSQL/browser
  evidence, but there is no CI real-model invocation, quality benchmark, natural-language routine or
  multi-task creation, task breakdown, automatic plan or calibration application, hosted provider,
  or Hermes/WhatsApp delivery path; and
- production outcome measures such as acceptance rate, completion rate, cadence attainment, and
  duration error need actual local usage data and are not CI release gates.

## Adding or changing a feature

1. Define or update the behavioral contract in the appropriate document.
2. Add a test whose assertions observe the behavior, not only a mock call or implementation detail.
3. Add PostgreSQL or drill evidence when the behavior is safety-critical or persistence-dependent.
4. Register exact anchors and commands in `evaluation/features.json`.
5. Run `pnpm eval`, followed by the relevant database verifier.
6. Raise coverage floors when sustained coverage improves; never add exclusions merely to preserve a
   percentage.

Production outcome metrics remain local and privacy-preserving. Their definitions must include a time
window, denominator, exclusions, minimum sample size, and planner version before comparisons are made.
