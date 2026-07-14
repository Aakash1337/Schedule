# Documentation

Durable product and engineering specifications live here so the repository root remains focused on project entry points and tooling.

- [Product definition](./PRODUCT.md): product scope, terminology, behavior, phases, and deferred capabilities.
- [Deterministic planner](./PLANNER.md): implemented planning rules, determinism, persistence, and concurrency contracts.
- [Deterministic reminders](./REMINDERS.md): profile/rule/one-off policy, DST and quiet-hours semantics, exact-once intent materialization, and the delivery boundary.
- [Local product API](./API.md): local-only HTTP safety boundary, routes, errors, and example usage.
- [Inbound integration gateway](./INTEGRATIONS.md): authenticated automation credentials, versioned
  commands, confirmation, idempotency, and the future Hermes boundary.
- [Outbound webhook delivery](./WEBHOOKS.md): encrypted endpoint secrets, signed delivery, opt-in
  privacy-thin Today-change invalidations, subscriptions, network policy, rotation, retries, and
  dead-letter operations.
- [Local web application](./WEB.md): interface architecture, local runtime, and interaction contract.
- [Local operations](./OPERATIONS.md): verified backup, staged restore, automated recovery state-machine checks, and database maintenance.
- [Evaluation and test evidence](./EVALUATION.md): feature traceability, behavioral gates, coverage floors, planner metrics, and known evidence gaps.

The root [README](../README.md) remains the installation and repository entry point.
