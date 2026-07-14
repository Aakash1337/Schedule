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

| Command                              | Purpose                                                                   | Requires PostgreSQL             |
| ------------------------------------ | ------------------------------------------------------------------------- | ------------------------------- |
| `pnpm eval:features`                 | Validate feature-to-evidence traceability                                 | No                              |
| `pnpm eval:planner`                  | Run deterministic planner quality scenarios                               | No                              |
| `pnpm test:coverage`                 | Run every unit/component test and enforce coverage floors                 | No                              |
| `pnpm eval`                          | Validate traceability and run the covered test suite                      | No                              |
| `pnpm verify:database`               | Exercise planner, APIs, outbox, webhooks, and migrations on PostgreSQL    | Yes                             |
| `pnpm verify:webhook-delivery`       | Verify webhook lifecycle, subscriptions, fan-out, redrive, and rollback   | Yes, disposable only            |
| `pnpm verify:backup-restore`         | Verify archive/schema/content/sequence fidelity                           | Yes                             |
| `pnpm verify:recovery-state-machine` | Exercise restore, promotion, rollback, and cleanup                        | Yes, disposable only            |
| `pnpm verify:web-e2e`                | Exercise the built browser, API, migrations, and PostgreSQL planning loop | Own disposable Compose database |
| `pnpm eval:full`                     | Run every evaluation layer above, including Chromium                      | Yes, with the recovery sentinel |

The destructive recovery command requires the explicit environment guards documented in
[`OPERATIONS.md`](./OPERATIONS.md). CI supplies those guards only inside its disposable Compose
project.

## Current scorecard

The current audited unit/component suite contains 61 test files and 760 runtime test cases, plus two
live Chromium integration scenarios. Parameterized state matrices expand into many cases, so this
number must not be compared as though every case were an independent product feature.

### Feature evidence

| Metric                                                                 | Current gate |
| ---------------------------------------------------------------------- | -----------: |
| Implemented features with CI-registered evidence                       |      24 / 24 |
| Critical implemented features with CI-registered integration or drills |      14 / 14 |
| Partial features with an explicit limitation                           |        1 / 1 |
| Deferred features incorrectly counted as passing                       |            0 |
| Missing or stale evidence anchors                                      |            0 |

### Coverage diagnostics

Coverage includes all first-party TypeScript source files, including unimported files. Floors are
set just below the measured baseline so a regression fails immediately; they are ratchets, not target
quality levels.

| Scope                      | Statements | Branches | Functions |  Lines |
| -------------------------- | ---------: | -------: | --------: | -----: |
| Whole repository, measured |      57.9% |    67.9% |    65.31% | 58.15% |
| Whole repository, required |        56% |      59% |       60% |    57% |
| Domain, measured           |     94.96% |   89.75% |    95.89% | 96.14% |
| Domain, required           |        91% |      82% |       92% |    93% |
| Application, measured      |      88.6% |    82.7% |      100% | 89.28% |
| Application, required      |        83% |      76% |       98% |    83% |
| API, measured              |     84.66% |    77.1% |    74.04% | 85.61% |
| API, required              |        73% |      69% |       57% |    74% |
| Worker, measured           |     92.26% |   89.18% |    91.11% | 95.14% |
| Worker, required           |        85% |      87% |       89% |    87% |
| Web, measured              |     82.98% |   70.71% |    70.11% | 83.48% |
| Web, required              |        75% |      63% |       70% |    79% |

The whole-repository totals are 4,902 of 8,465 statements, 3,601 of 5,303 branches,
1,113 of 1,704 functions, and 4,582 of 7,879 lines.

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
semantics for preserving and clearing a date, deterministic v4 deadline pressure for future, today,
overdue, capped-overdue, and outside-horizon work, and continued exclusion of non-plannable work.
The configured 14-day horizon and all deadline weights are validated before planning. The test also
proves that reversed candidate order produces the same v4 snapshot hash and selected items.

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

### Temporary routine-feedback evidence

Temporary routine feedback has independent oracles for policy, planning, persistence, command, and
interface behavior. Domain tests cover inclusive day and routine-defined week boundaries, tenant and
future-event filtering, deterministic latest-event resolution, reset and expiry, and immutable
recording-time input. Planner tests require **Not today** and **Not this week** to be hard routine
exclusions without changing score or cadence evidence, include the canonical latest event in the v3
input snapshot and hash, and preserve that input through residual replanning.

Application tests require an unlocked, pending routine source, prove immediate server-allocated
replanning and identical idempotent replay, and show that an appended reset clears the active
exclusion without resurrecting an older instruction. They also require read-committed feedback
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
  invalidation; reminder policy, phone notifications, Hermes/WhatsApp transport, and downstream
  delivery receipts remain deferred;
- live browser evidence covers the central desktop Chromium mixed routine/work-item planning loop,
  including temporary routine feedback, reload, reset, work completion/reversal, and routine
  completion. A second scenario covers duration-insight dismissal, persisted disposition, exact-key
  reset, and resurfacing after changed evidence, but not every browser, responsive layout, validation
  branch, Calendar interaction, or the duration-calibration approval flow;
- duration calibration has domain, component, API, repository, and real PostgreSQL evidence, and
  exact-key dismissal/reset now preserves reversible rejection memory. It still has no production
  outcome data, learned cadence/energy/preference model, automatic application, historical insight
  comparison, or local-model participation; and
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
