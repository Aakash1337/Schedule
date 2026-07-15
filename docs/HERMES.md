# Hermes reminder adapter foundation

Schedule includes a separate, provider-neutral adapter foundation for a future Hermes/WhatsApp
reminder process. It consumes the existing `schedule:delivery` claim/receipt API without adding
provider, destination, recipient, conversation, or account data to Schedule.

This is not yet a running WhatsApp transport. The concrete Hermes send API, human/account binding,
and shared durable dedupe-store implementation depend on the external Hermes installation and must
be supplied before the adapter can be started.

## Components

`@schedule/hermes-reminders` provides:

- `HttpScheduleDeliveryGateway`, a strict client for the existing claim and receipt endpoints. It
  permits plaintext HTTP only on literal IPv4 or IPv6 loopback addresses, rejects credentials in
  URLs and redirects, bounds streamed response size and total request time, validates exact
  versioned envelopes, and exposes only fixed error classes without response bodies or bearer
  tokens.
- `HermesReminderRunner`, which claims at most one command, checks that the Schedule lease has enough
  provider-call time, the gateway's declared maximum request duration, and an additional receipt
  margin; it reserves the stable `dedupeKey` before transport and persists a delivered dedupe record
  before acknowledging Schedule.
- `ReminderTransport`, the port a concrete Hermes integration must implement. Repeated delivery with
  the same dedupe key must be provider-idempotent or conclusively reconciled. An implementation that
  can only blind-resend ambiguous submissions is not compatible.
- `DeliveryDedupeStore`, the shared persistence port. Multiple adapter replicas must share one
  implementation. Reservations bind the stable command hash and fence updates with an opaque token;
  a mismatched payload fails permanently rather than reusing a dedupe identity for different text.

## Outcome and crash semantics

A known accepted transport result is marked delivered in the dedupe store before the Schedule
receipt. If the receipt response is lost, a later Schedule claim carries the same `dedupeKey`; the
adapter returns the already-delivered result without another external send.

A known-not-accepted retryable or permanent provider result releases the reservation before its
bounded Schedule receipt. If transport throws, times out, or is otherwise ambiguous, the adapter
keeps the reservation and records no Schedule failure receipt. The current claim is allowed to
expire; a later reservation owner may proceed only through the transport's idempotent send or
reconciliation contract. Likewise, an active reservation owned by another adapter records no
failure receipt. These rules prevent adapter contention or ambiguity from burning Schedule's bounded
delivery attempts before the external state is known.

`delivered` means the adapter obtained a known accepted/idempotently reconciled provider result. It
does not mean a handset displayed the message. Provider delivery-status callbacks remain
adapter-side and cannot rewrite Schedule receipts.

## Security boundary

Use a separate delivery-only Schedule credential for each workspace adapter. Conversational
read/write automation needs a different credential and process. The adapter's public callback
ingress, if any, must hold no Schedule bearer credential.

Account binding belongs outside Schedule and must be established through a trusted local control or
authenticated hosted control plane with explicit consent. Never choose a Schedule workspace or
credential from a callback phone number, display name, message body, or unverified provider claim.
Keep Schedule credentials, provider secrets, callback verification material, binding data, and
encryption keys separate. Do not log authorization headers, message bodies, destinations, provider
payloads, or raw exceptions.

## Remaining integration work

Before enabling a real process, provide and verify:

1. the exact Hermes/WhatsApp send and reconciliation contract;
2. an explicit human/account binding lifecycle;
3. a durable shared `DeliveryDedupeStore` with reservation expiry and fencing;
4. provider authentication, secret rotation, circuit breaking, and an operator kill switch;
5. an opt-in live smoke test using a non-production recipient.

Inbound messages, natural-language interpretation, command confirmation, provider callbacks, and
hosted binding UI are separate follow-on slices. Schedule's existing structured prepare/confirm
gateway remains authoritative for any future conversational mutation.

## Verification

The package's normal tests cover successful ordering, empty claims, delivered replay without a
second send, lease-budget refusal, reservation contention, payload conflict, known failure release,
ambiguous-send preservation, malformed transport results, exact HTTP request contracts, strict
streaming response limits and hard timeout, outbound receipt validation, URL safety, and fixed HTTP
failure classification. The HTTP tests use a real ephemeral loopback server and no provider
network.
