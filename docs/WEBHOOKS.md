# Outbound webhook delivery

## Status and scope

Schedule's outbound webhook subsystem is a disabled-by-default delivery substrate for trusted
integrations. Its first release can send a deliberately thin test event so an operator can verify a
receiver, signing keys, DNS policy, retries, and dead-letter handling before product events exist.

This is not yet a reminder service, a WhatsApp transport, or automatic Hermes synchronization. It
does not publish titles, descriptions, plan contents, reasons, activity metadata, or conversational
content. Hermes can continue to use the authenticated inbound gateway described in
[INTEGRATIONS.md](./INTEGRATIONS.md) while outbound product-event contracts are designed.

## Security boundary

- Endpoint management is local CLI-only. There is no public endpoint-management API.
- Every endpoint, signing-secret version, delivery, outbox row, and audit event is bound to one
  workspace. Composite database constraints reject cross-workspace references.
- Each endpoint has its own random 256-bit HMAC secret. The database stores only an AES-256-GCM
  encrypted envelope; the plaintext receiver secret is shown once when it is created or rotated.
- The encryption keyring lives outside PostgreSQL. Losing every configured master key makes the
  corresponding signing-secret envelopes unrecoverable.
- The worker sends only to an ordinary DNS hostname over HTTPS on port 443. It rejects credentials,
  fragments, IP literals, local/reserved hostnames, redirects, proxy environment variables, and any
  DNS response containing a non-global address.
- DNS is resolved immediately before each attempt. Every returned address is checked, and the chosen
  validated address is pinned into the TLS connection while the original hostname remains the Host,
  SNI, and certificate-verification name.
- Delivery is at least once. Receivers must authenticate the signature, enforce a timestamp window,
  and deduplicate the stable delivery ID.

An outbound webhook still crosses a trust boundary. Use an endpoint dedicated to Schedule, give the
receiver the least access it needs, and block metadata/private networks with an egress firewall as a
second layer of protection.

## Configuration

The worker recognizes these settings:

| Variable                       | Default     | Purpose                                                               |
| ------------------------------ | ----------- | --------------------------------------------------------------------- |
| `WEBHOOK_DELIVERY_MODE`        | `disabled`  | Set to `enabled` only after keys and endpoints are provisioned        |
| `WEBHOOK_MASTER_KEYS`          | empty       | Comma-delimited `key-id:base64url-32-byte-key` entries; at most eight |
| `WEBHOOK_ACTIVE_MASTER_KEY_ID` | empty       | Key used to encrypt newly generated endpoint secrets                  |
| `WEBHOOK_CONNECT_TIMEOUT_MS`   | `5000`      | Maximum time to establish the TLS connection                          |
| `WEBHOOK_REQUEST_TIMEOUT_MS`   | `15000`     | Maximum total request time; must be at least the connect timeout      |
| `WEBHOOK_MAX_RESPONSE_BYTES`   | `65536`     | Maximum receiver response bytes read and discarded                    |
| `WEBHOOK_MAX_RETRY_AFTER_MS`   | `300000`    | Maximum retry delay, including a receiver's valid `Retry-After`       |
| `WEBHOOK_MAX_DELIVERY_AGE_MS`  | `604800000` | Permanently reject a queued delivery after seven days                 |

Key IDs use a conservative lowercase identifier. Key material is canonical unpadded base64url that
decodes to exactly 32 bytes. Do not commit the keyring, put it in Compose files, or share it with the
receiver. The master key encrypts endpoint signing secrets; it is not itself a webhook signing
secret.

The accepted bounds are 100–30,000 ms for connect timeout, 1,000–120,000 ms for request timeout,
1,024–1,048,576 bytes for response bodies, 0–3,600,000 ms for retry delay, and
60,000–2,592,000,000 ms for delivery age. The response header block is independently limited by the
worker. Invalid or inconsistent settings stop configuration loading rather than weakening a limit.

Generate a key from a trusted shell and copy its output to the local secret manager:

```powershell
pnpm webhooks -- generate-master-key --id primary
```

For a future master-key rotation, keep the old key in `WEBHOOK_MASTER_KEYS`, add the new key, and make
the new key active before creating or rotating endpoint secrets. Removing an old key before all
secret versions encrypted with it are no longer needed will make affected deliveries fail closed.

## Endpoint lifecycle

All commands require access to the Schedule database. Commands that generate an endpoint signing
secret also require a configured active master key.

```powershell
pnpm webhooks -- create --workspace <workspace-uuid> --name "Hermes bridge" --url https://hooks.example.com/schedule
pnpm webhooks -- list --workspace <workspace-uuid>
pnpm webhooks -- send-test --workspace <workspace-uuid> --endpoint <endpoint-uuid>
pnpm webhooks -- prepare-rotation --workspace <workspace-uuid> --endpoint <endpoint-uuid>
pnpm webhooks -- activate-rotation --workspace <workspace-uuid> --endpoint <endpoint-uuid> --secret <secret-version-uuid>
pnpm webhooks -- revoke --workspace <workspace-uuid> --endpoint <endpoint-uuid>
```

Creation prints the receiver signing secret once. Store it at the receiver before sending a test.
Rotation is deliberately staged:

1. `prepare-rotation` creates a pending version and prints its secret once.
2. Configure the new secret at the receiver while the current version remains active.
3. `activate-rotation` retires the current version and activates the pending version atomically.
4. Keep the receiver able to verify the retired key while already queued deliveries finish.

Revocation stops new and queued delivery attempts for the endpoint. History is retained for audit;
the command does not delete endpoint or delivery records. URL changes use a replacement endpoint so
the destination change has an explicit lifecycle and audit trail.

## Wire protocol

Schedule sends the exact immutable UTF-8 JSON body stored with the delivery. Retries preserve the
body and delivery ID. Each attempt has a fresh timestamp and signature:

```text
Schedule-Webhook-Id: <delivery-uuid>
Schedule-Webhook-Timestamp: <unix-seconds>
Schedule-Webhook-Key-Id: <secret-version-uuid>
Schedule-Webhook-Signature: <base64url-hmac-sha256>
Content-Type: application/json
```

The signed byte sequence is:

```text
v1.<delivery-uuid>.<unix-seconds>.<exact-raw-request-body>
```

The receiver base64url-decodes the one-time endpoint secret to 32 key bytes, calculates
HMAC-SHA-256, base64url-decodes the expected and received digests, and compares them in constant
time. It should reject timestamps outside a five-minute window and retain delivery IDs for at least
the maximum retry/redrive horizon. Parse the JSON only after authenticating the exact raw bytes.

The initial test event contains protocol metadata and a fixed non-sensitive test marker only. It is
not evidence that automatic scheduling events are enabled.

## Delivery behavior

- Any `2xx` response completes the outbox event.
- Network/TLS failures, `408`, `425`, `429`, and `5xx` responses are retried with bounded full-jitter
  exponential backoff.
- A valid `Retry-After` value overrides that jitter within `WEBHOOK_MAX_RETRY_AFTER_MS`; an
  unbounded or malformed value is ignored.
- Redirects and every other `4xx` response are permanent failures and go directly to dead letter.
- The outbox keeps a stable ID and uses lease fencing. A worker crash after the receiver accepts the
  request but before acknowledgement can produce a duplicate.
- No ordering guarantee is made. Receivers must use event timestamps and future resource versions to
  ignore stale notifications.

Errors and logs contain bounded failure classes and opaque IDs only. They must never contain endpoint
URLs, DNS answers, request/response bodies, signatures, key material, or raw networking exceptions.

## Dead letters and redrive

List dead letters as metadata only, then redrive a specific delivery after correcting the receiver or
configuration:

```powershell
pnpm webhooks -- dead-letters --workspace <workspace-uuid>
pnpm webhooks -- redrive --workspace <workspace-uuid> --delivery <delivery-uuid>
```

Redrive keeps the same delivery ID and body, rechecks endpoint/workspace state, and creates an audit
event. It never changes the destination or signing-secret version. Do not repeatedly redrive a
permanent receiver rejection without understanding the cause.

Monitor dead-letter count, retry rate, and oldest pending age. Database backups contain endpoint
URLs, encrypted signing-secret envelopes, immutable test bodies, and delivery/audit metadata, so
protect backups accordingly.

## Operator runbook

1. Leave delivery disabled, generate and store a master key outside the database, then set
   `WEBHOOK_MASTER_KEYS` and `WEBHOOK_ACTIVE_MASTER_KEY_ID` in the worker environment.
2. Create the endpoint. The command validates the HTTPS URL and current DNS answers before the
   database transaction, then prints the receiver signing secret once after commit.
3. Configure that one-time secret at the receiver and queue `send-test` while the worker is still
   disabled if you want to inspect the durable delivery first.
4. Enable `WEBHOOK_DELIVERY_MODE`, restart the worker, and verify the receiver authenticates and
   deduplicates the test delivery.
5. If delivery fails, inspect metadata with `dead-letters`; correct the receiver or configuration,
   then redrive by the stable delivery ID. Do not put secrets, bodies, DNS answers, or endpoint URLs
   into incident notes copied from ad hoc debugging.
6. To rotate a receiver secret, prepare it, configure both old and new versions at the receiver,
   activate the pending version, and retain the retired version until every old delivery is outside
   the retry/redrive horizon.
7. To stop an integration, revoke the endpoint. Revocation is audited and makes queued attempts fail
   closed; it does not erase history.

Run `pnpm verify:webhook-delivery` against a disposable local PostgreSQL service after migration or
persistence changes. It exercises tenant constraints, secret rotation, exact immutable bodies,
outbox linkage, dead-letter metadata, redrive identity, revocation, audits, and rollback behavior.

## Current limits

- Only operator-queued test events are supported. Automatic schedule, plan, task, and reminder events
  are deferred until their privacy and versioning contracts are specified.
- Private-network and loopback callbacks are not supported. A future local Hermes transport needs a
  separate authenticated design rather than an unsafe general-purpose bypass.
- Custom headers, redirects, HTTP, arbitrary ports, proxy routing, mTLS, per-endpoint ordering, and a
  management UI are not supported.
- Delivery success means the receiver returned `2xx`; it does not prove that a phone notification or
  downstream WhatsApp action completed.
