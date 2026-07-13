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

| Command                              | Purpose                                                                     | Requires PostgreSQL             |
| ------------------------------------ | --------------------------------------------------------------------------- | ------------------------------- |
| `pnpm eval:features`                 | Validate feature-to-evidence traceability                                   | No                              |
| `pnpm eval:planner`                  | Run deterministic planner quality scenarios                                 | No                              |
| `pnpm test:coverage`                 | Run every unit/component test and enforce coverage floors                   | No                              |
| `pnpm eval`                          | Validate traceability and run the covered test suite                        | No                              |
| `pnpm verify:database`               | Exercise planner, product API, outbox, and migration behavior on PostgreSQL | Yes                             |
| `pnpm verify:backup-restore`         | Verify archive/schema/content/sequence fidelity                             | Yes                             |
| `pnpm verify:recovery-state-machine` | Exercise restore, promotion, rollback, and cleanup                          | Yes, disposable only            |
| `pnpm eval:full`                     | Run every evaluation layer above                                            | Yes, with the recovery sentinel |

The destructive recovery command requires the explicit environment guards documented in
[`OPERATIONS.md`](./OPERATIONS.md). CI supplies those guards only inside its disposable Compose
project.

## Current scorecard

The current audited suite contains 37 test files and 291 runtime test cases. Parameterized state
matrices expand into many cases, so this number must not be compared as though every case were an
independent product feature.

### Feature evidence

| Metric                                                                 | Current gate |
| ---------------------------------------------------------------------- | -----------: |
| Implemented features with CI-registered evidence                       |      16 / 16 |
| Critical implemented features with CI-registered integration or drills |        9 / 9 |
| Partial features with an explicit limitation                           |        1 / 1 |
| Deferred features incorrectly counted as passing                       |            0 |
| Missing or stale evidence anchors                                      |            0 |

### Coverage diagnostics

Coverage includes all first-party TypeScript source files, including unimported files. Floors are
set just below the measured baseline so a regression fails immediately; they are ratchets, not target
quality levels.

| Scope                      | Statements | Branches | Functions |  Lines |
| -------------------------- | ---------: | -------: | --------: | -----: |
| Whole repository, measured |      57.2% |   60.13% |    61.42% | 57.95% |
| Whole repository, required |        56% |      59% |       60% |    57% |
| Domain, measured           |     92.66% |   84.43% |    93.33% | 94.13% |
| Domain, required           |        91% |      82% |       92% |    93% |
| Application, measured      |     84.92% |   78.42% |      100% | 84.85% |
| Application, required      |        83% |      76% |       98% |    83% |
| API, measured              |     75.41% |    71.9% |    59.57% | 76.13% |
| API, required              |        73% |      69% |       57% |    74% |
| Worker, measured           |      94.9% |   89.04% |    92.59% | 97.85% |
| Worker, required           |        85% |      87% |       89% |    87% |
| Web, measured              |     76.57% |   64.41% |    70.33% | 80.41% |
| Web, required              |        75% |      63% |       70% |    79% |

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
- web behavior is component-tested rather than exercised through a real browser and API process; and
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
