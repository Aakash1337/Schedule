# Documentation

Durable product and engineering specifications live here so the repository root remains focused on project entry points and tooling.

- [Product definition](./PRODUCT.md): product scope, terminology, behavior, phases, and deferred capabilities.
- [Deterministic planner](./PLANNER.md): implemented planning rules, determinism, persistence, and concurrency contracts.
- [Deterministic reminders](./REMINDERS.md): profile/rule/one-off policy, DST and quiet-hours
  semantics, exact-once intent materialization, the fenced provider-neutral delivery gateway, and
  the local settings/planned/execution-history interface.
- [Local product API](./API.md): local-only HTTP safety boundary, routes, errors, and example usage.
- [Natural-language proposals](./NATURAL_LANGUAGE.md): review-only local model capture, privacy,
  lifecycle, exactly-once confirmation, and deliberate command limits.
- [Integration gateway](./INTEGRATIONS.md): authenticated automation credentials, versioned
  commands, confirmation, idempotency, reminder claims/receipts, and the external-adapter boundary.
- [Hermes integrations](./HERMES.md): checked local installation and sender-bound confirmation plus
  the separate provider-neutral polling, lease, durable dedupe, health, and shutdown boundary;
  includes WhatsApp prerequisites, privacy, limitations, and safe rollout.
- [Outbound webhook delivery](./WEBHOOKS.md): encrypted endpoint secrets, signed delivery, opt-in
  privacy-thin Today-change invalidations, subscriptions, network policy, rotation, retries, and
  dead-letter operations.
- [Web applications](./WEB.md): local interface architecture plus the isolated hosted capture
  entry, reminder management, browser verification, and interaction contracts.
- [Desktop application](./DESKTOP.md): native Windows/Linux runtime architecture, lifecycle,
  security, recovery, packaging status, and the future hosted-continuity boundary.
- [Portable data migration](./PORTABLE_MIGRATION.md): versioned Windows/Linux export and import,
  durable AI/history coverage, exclusions, replacement, rollback, and custody limits.
- [Database migration policy](./MIGRATION_POLICY.md): append-only SQL/journal/manifest history,
  destructive-change review, and the pinned historical ledger compatibility exception.
- [Local operations](./OPERATIONS.md): verified backup, staged restore, portable migration, automated
  recovery state-machine checks, and database maintenance.
- [Hosted deployment](./DEPLOYMENT.md): provider-neutral topology, the lean Railway adapter,
  release ordering, secrets, health checks, backups, rollback, and staging acceptance.
- [Worker observability](./OBSERVABILITY.md): loopback health, fixed-cardinality metrics, privacy
  boundaries, queue signals, alert guidance, and verification.
- [Hosted identity foundation](./HOSTED_IDENTITY.md): dormant exact provider bindings, digest-only
  browser sessions, binary memberships, deletion boundaries, and PostgreSQL verification.
- [Hosted authorization seam](./HOSTED_AUTHORIZATION.md): closed-by-default cookie/CSRF transport,
  request authentication, enumeration-resistant workspace authorization, revocation semantics, and
  transaction limits.
- [Hosted work-item sync](./HOSTED_SYNC.md): staged keyset bootstrap, pinned deltas, signed cursors,
  transactional capture, bounded retention, and fresh-bootstrap recovery.
- [Evaluation and test evidence](./EVALUATION.md): feature traceability, behavioral gates, coverage floors, planner metrics, and known evidence gaps.

The root [README](../README.md) remains the installation and repository entry point.
