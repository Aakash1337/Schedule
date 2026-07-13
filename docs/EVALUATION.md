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

The current audited unit/component suite contains 54 test files and 590 runtime test cases, plus one
live Chromium integration scenario. Parameterized state matrices expand into many cases, so this
number must not be compared as though every case were an independent product feature.

### Feature evidence

| Metric                                                                 | Current gate |
| ---------------------------------------------------------------------- | -----------: |
| Implemented features with CI-registered evidence                       |      21 / 21 |
| Critical implemented features with CI-registered integration or drills |      13 / 13 |
| Partial features with an explicit limitation                           |        0 / 0 |
| Deferred features incorrectly counted as passing                       |            0 |
| Missing or stale evidence anchors                                      |            0 |

### Coverage diagnostics

Coverage includes all first-party TypeScript source files, including unimported files. Floors are
set just below the measured baseline so a regression fails immediately; they are ratchets, not target
quality levels.

| Scope                      | Statements | Branches | Functions |  Lines |
| -------------------------- | ---------: | -------: | --------: | -----: |
| Whole repository, measured |      58.1% |   66.26% |    64.79% | 58.39% |
| Whole repository, required |        56% |      59% |       60% |    57% |
| Domain, measured           |     94.44% |   88.47% |    96.02% | 95.67% |
| Domain, required           |        91% |      82% |       92% |    93% |
| Application, measured      |     88.11% |   82.17% |      100% | 88.84% |
| Application, required      |        83% |      76% |       98% |    83% |
| API, measured              |     83.87% |    75.9% |     71.9% | 84.83% |
| API, required              |        73% |      69% |       57% |    74% |
| Worker, measured           |     92.26% |   89.18% |    91.11% | 95.14% |
| Worker, required           |        85% |      87% |       89% |    87% |
| Web, measured              |     76.93% |   65.49% |       71% | 80.63% |
| Web, required              |        75% |      63% |       70% |    79% |

The whole-repository totals are 4,540 of 7,814 statements, 3,282 of 4,953 branches,
1,029 of 1,588 functions, and 4,247 of 7,273 lines.

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
- the inbound integration gateway verifier covers real authenticated HTTP routes, all five command
  kinds, credential workspace isolation, digest-only credentials, idempotent replay, and atomic
  rollback against disposable PostgreSQL; it also proves bounded retention cleanup deletes only
  eligible old receipts/confirmations while preserving fresh, processing, referenced, and audit
  rows, but does not exercise a Hermes runtime, WhatsApp transport, or natural-language
  interpretation;
- the outbound webhook verifier covers real PostgreSQL endpoint/secret lifecycles, workspace
  isolation, default-empty and replacement subscription state, privacy-thin automatic Today-change
  fan-out, deterministic event identity, immutable delivery/outbox linkage, dead-letter metadata,
  redrive identity, revocation, audits, and rollback. DNS, pinned-address HTTPS, TLS, and the external
  receiver are unit-faked, so there is no live-network delivery claim. The automatic event is only an
  invalidation; reminder policy, phone notifications, Hermes/WhatsApp transport, and downstream
  delivery receipts remain deferred;
- live browser evidence covers the central desktop Chromium mixed routine/work-item planning loop,
  including work completion and reversal, but not every browser, responsive layout, validation
  branch, or Calendar interaction; and
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
