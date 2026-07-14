# Hermes Schedule plugin

The Hermes Schedule plugin is the local, opt-in adapter between a Hermes conversation and
Schedule's authenticated integration gateway. It can read the authoritative Today plan and work
items, prepare one of Schedule's strict structured commands, and confirm that exact command only
after a separate human turn. A companion script produces a deterministic daily-plan reminder on
standard output without invoking an LLM.

This is not a public webhook receiver or a hosted integration. Version 1 accepts only a canonical
IPv4 loopback Schedule URL. Schedule remains the system of record, and neither the plugin nor the
reminder script writes its PostgreSQL tables directly.

## What is off by default

Nothing in this integration starts automatically:

- Schedule's integration routes remain absent until `INTEGRATION_API_MODE=enabled`.
- Hermes plugins are opt-in; copying the directory does not enable it.
- The reminder script runs once and writes to standard output. It does not create a timer, a cron
  job, or a WhatsApp delivery by itself.
- A Hermes cron job exists only after the operator creates one.
- WhatsApp delivery is not configured or verified merely because the plugin is installed. The
  Hermes operator must configure `WHATSAPP_HOME_CHANNEL` and run a live self-chat smoke test.

These defaults prevent a repository checkout, dependency install, or Schedule process restart from
silently enabling automation or sending schedule content to a messaging service.

## Prerequisites

Before installing the plugin:

1. Run Schedule's API on an IPv4 loopback address. The repository default is
   `http://127.0.0.1:4000`; use the port of the API process you actually started.
2. Enable the integration gateway and provision its pepper as described in
   [INTEGRATIONS.md](./INTEGRATIONS.md#runtime-settings).
3. Create a workspace-bound integration credential.
4. Install a Hermes version with native plugin hooks and ensure the same operating-system account
   can reach the Schedule loopback API.
5. For phone delivery, complete Hermes's WhatsApp setup and configure its operator-owned home
   channel. Do not use a group or another person's conversation for an initial test.

The full interactive plugin needs both Schedule scopes:

```powershell
pnpm integration:credentials -- create `
  --workspace 11111111-1111-4111-8111-111111111111 `
  --name "Hermes Schedule plugin" `
  --scopes schedule:read,schedule:write
```

The credential is printed once. Store it in the secret environment of the Hermes process; do not
put it in `config.yaml`, a checked-in `.env`, a cron prompt, a chat message, or a command transcript.
A standalone reminder process needs only `schedule:read`, so give it a separate read-only credential
when its environment can be isolated from the interactive plugin.

## Install and enable

The repository-owned source is [`integrations/hermes-schedule`](../integrations/hermes-schedule).
Install it as a user plugin rather than enabling project-plugin discovery. From the Schedule
repository on Windows PowerShell:

```powershell
$HermesHome = if ($env:HERMES_HOME) { $env:HERMES_HOME } else { Join-Path $HOME ".hermes" }
$PluginRoot = Join-Path $HermesHome "plugins"
New-Item -ItemType Directory -Force $PluginRoot | Out-Null
Copy-Item .\integrations\hermes-schedule `
  (Join-Path $PluginRoot "hermes-schedule") -Recurse
```

If the destination already exists, stop Hermes and replace that directory as one unit instead of
mixing files from two plugin versions. Configure the process environment before enabling the copied
plugin.

Set these variables in the environment of the Hermes process:

```powershell
$env:SCHEDULE_INTEGRATION_URL = "http://127.0.0.1:4000"
$env:SCHEDULE_INTEGRATION_TOKEN = "<credential-uuid>.<secret>"
$BindingBytes = [byte[]]::new(32)
[Security.Cryptography.RandomNumberGenerator]::Fill($BindingBytes)
$env:SCHEDULE_HERMES_BINDING_KEY = [Convert]::ToBase64String($BindingBytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")

hermes plugins enable hermes-schedule
hermes plugins list --enabled
```

`SCHEDULE_INTEGRATION_URL` has no implicit value and is required. Its accepted form is exactly
`http://127.0.0.1:<port>`, with a canonical decimal port from 1024 through 65535: no `localhost`,
IPv6 spelling, non-loopback address, HTTPS host, user information, path, trailing slash, query, or
fragment. This deliberate restriction means the v1 plugin cannot connect to a hosted Schedule
deployment. It also never follows a redirect.

`SCHEDULE_INTEGRATION_TOKEN` is required. It is a Schedule machine capability, not a Hermes user
login or browser session. `SCHEDULE_HERMES_BINDING_KEY` is a separate local secret used to bind a
pending confirmation to Hermes's sender, session, and platform identity. It must contain 32 through
4,096 UTF-8 bytes with no whitespace. Generate it independently from the integration token and the
Schedule API pepper. Restrict both secrets and the Hermes home directory to the operating-system
account running Hermes. Persist them through the service's secret environment rather than relying
on one interactive PowerShell session. Enabling updates Hermes's plugin allow-list; restart every
long-running Hermes gateway or agent process so it loads the new code and environment.

Pending exchanges are stored under `$HERMES_HOME/state/schedule-adapter.sqlite3` (or the equivalent
default Hermes home). It contains keyed identity hashes, turn counters, opaque Schedule identifiers,
the operation type, one-use challenge, expiry, idempotency identity, and an optional in-flight claim—not
raw sender IDs, raw messages, the bearer token, or the prepared command. Back up or delete this state
only while Hermes is stopped. Deleting it cancels the adapter's local recovery path but does not
revoke the Schedule credential or undo an operation that may already have committed.

## Conversation contract

The plugin registers five tools:

| Tool                       | Purpose                                                                | Required Schedule scope                 |
| -------------------------- | ---------------------------------------------------------------------- | --------------------------------------- |
| `schedule_today`           | Read one existing authoritative Today plan                             | `schedule:read`                         |
| `schedule_list_work_items` | Read a bounded, filtered work-item page                                | `schedule:read`                         |
| `schedule_prepare_change`  | Validate and persist one exact structured command without executing it | `schedule:write`                        |
| `schedule_confirm_change`  | Execute the one pending prepared command after human confirmation      | `schedule:write`                        |
| `schedule_cancel_change`   | Remove the local pending exchange without executing it                 | none beyond the existing local exchange |

Hermes may interpret a natural-language request, but Schedule does not receive or interpret the raw
WhatsApp message. The model must select a command from the versioned vocabulary in
[INTEGRATIONS.md](./INTEGRATIONS.md#commands). Schedule validates that command using the same domain
and optimistic-concurrency rules as every other integration client.

Preparation must occur inside a captured Hermes turn. On success, the plugin verifies Schedule's
canonical command display and SHA-256 command hash, stores the pending exchange, and returns the
complete command plus a one-use challenge. The mutation has **not** happened at this point.

The user must send this exact text in a later user turn:

```text
CONFIRM SCHEDULE <challenge>
```

Do not add punctuation, commentary, Markdown, or another instruction. `schedule_confirm_change`
accepts the phrase only from the same HMAC-bound Hermes sender, session, and platform identity that
prepared it. A copied phrase from another WhatsApp sender, another platform, or another session is
not authority. The server-side Schedule confirmation must also still be unexpired and belong to the
same integration credential.

The plugin atomically marks a confirmation in flight before contacting Schedule. Cancellation is
rejected while that claim exists, so it cannot race an irreversible request. A normal transport
failure releases the claim. If the process dies mid-request, the same exact confirmation phrase can
retry after 60 seconds with the same idempotency key; Schedule then replays the exact receipt instead
of executing the mutation again. A stale in-flight claim can be retried but never canceled. The local
pending exchange is consumed only after a strict successful response.

The adapter validates the returned operation and command hash, accepts only the expected typed
outcome schema, and returns a reduced receipt containing bounded identifiers, status/version fields,
and no work description, activity reason, or metadata. If the user changes their mind before a
confirmation is in flight, Hermes should invoke `schedule_cancel_change`; a changed command requires
a new preparation and challenge.

The challenge flow limits accidental or model-initiated writes, but it does not make an untrusted
Hermes account safe. Sender and session authenticity are only as strong as the configured Hermes
platform connector and access to its local state.

## Deterministic reminders

[`reminder.py`](../integrations/hermes-schedule/reminder.py) performs one authenticated Today read,
formats a bounded deterministic summary, writes it to standard output, and exits. It does not call
Hermes's model, invoke the planner, change activity, create a plan, or mark anything complete.

Test it locally before creating a scheduled delivery:

```powershell
$env:SCHEDULE_INTEGRATION_URL = "http://127.0.0.1:4000"
$env:SCHEDULE_INTEGRATION_TOKEN = "<read-only-or-read-write-token>"
python .\integrations\hermes-schedule\reminder.py --date 2026-07-14
```

Use an explicit Schedule-local `YYYY-MM-DD` date for a repeatable manual check. Without `--date`, the
script uses `SCHEDULE_REMINDER_DATE` when present, then the host's current local date. Do not leave a
fixed `SCHEDULE_REMINDER_DATE` in a recurring production job unless repeating that old date is
intentional.

The message contains at most 20 pending or started items and at most 3,500 characters. A missing plan
or a plan with no unfinished items produces an explicit informational message. A configuration,
authentication, transport, or response-validation failure writes only a bounded error code to
standard error and exits nonzero. Standard output is the delivery boundary: inspect it for the
intended workspace and content before allowing any delivery command to consume it.

To run the same deterministic script through Hermes cron without an LLM, copy it to Hermes's script
directory and create a local-delivery job:

```powershell
$HermesHome = if ($env:HERMES_HOME) { $env:HERMES_HOME } else { Join-Path $HOME ".hermes" }
$ScriptRoot = Join-Path $HermesHome "scripts"
New-Item -ItemType Directory -Force $ScriptRoot | Out-Null
Copy-Item .\integrations\hermes-schedule\reminder.py `
  (Join-Path $ScriptRoot "schedule-reminder.py")
Copy-Item .\integrations\hermes-schedule\client.py `
  (Join-Path $ScriptRoot "client.py")

hermes cron create "0 9 * * *" `
  --name "Schedule morning reminder" `
  --script schedule-reminder.py `
  --no-agent `
  --deliver local

hermes cron list
```

The cron scheduler process must receive the same Schedule URL and token environment. `--no-agent`
is a security and determinism requirement here: it delivers the script's standard output verbatim
rather than asking a model to rewrite it. Use `hermes cron run <job-id>` and inspect the local result
before changing the target. Keep `schedule-reminder.py` and its adjacent `client.py` from the same
repository revision; recopy both when upgrading the adapter.

Only after local output is correct and Hermes's own WhatsApp transport is healthy should the
operator configure its home channel and create or edit a delivery with:

```powershell
$env:WHATSAPP_HOME_CHANNEL = "<operator-owned-self-chat-channel>"

hermes cron create "0 9 * * *" `
  --name "Schedule WhatsApp morning reminder" `
  --script schedule-reminder.py `
  --no-agent `
  --deliver whatsapp
```

`WHATSAPP_HOME_CHANNEL` is a Hermes transport prerequisite, not a Schedule setting. Until it is
configured in the environment of the cron/gateway process and an operator-run self-chat succeeds,
live WhatsApp delivery is **not complete**. The repository's automated checks cannot establish that
a phone, WhatsApp account, bridge session, or provider channel accepted a message.

## Privacy and threat model

- The plugin connects outbound to one exact loopback origin. It opens no public listener and does
  not consume Schedule's outbound webhooks.
- The bearer token is sent only in the loopback `Authorization` header. The plugin and verification
  suite must never print it, the binding key, or credential digests.
- The token selects exactly one Schedule workspace. Use least-privilege scopes, replace an exposed
  token, and revoke the old credential with `pnpm integration:credentials -- revoke`.
- WhatsApp and its configured provider can see any reminder text delivered through that channel.
  The helper applies its fixed 20-item/3,500-character bound; choose a private self-chat and avoid
  task titles that should not leave the machine.
- Work-item titles and every Schedule-returned string are untrusted data. The adapter verifies and
  displays the complete canonical command; it never treats a title, description, or metadata value
  as a hidden instruction or substitutes a model summary for confirmation authority.
- The explicit later-turn challenge reduces silent writes by a compromised model. Schedule's own
  strict schemas, credential scopes, confirmation expiry, optimistic versions, row locking, audit,
  and idempotency remain the final enforcement boundary.
- HMAC sender binding is not identity proof independent of Hermes. A compromised platform adapter,
  Hermes account, operating-system account, plugin directory, environment, or state database can
  defeat the local boundary. Keep the machine patched and the Hermes home private.
- The Hermes connector must supply stable, nonempty `sender_id` and `platform` hook values. The
  plugin refuses to capture confirmation state when either is missing, so the mutation tools fail
  closed instead of falling back to session-only authority.
- Local malware and a malicious process running as the Hermes user are outside this adapter's trust
  boundary. They can potentially read environment secrets or call the loopback API directly.

## Verification and safe rollout

Run the repository verifier from the Schedule checkout:

```powershell
pnpm verify:hermes-adapter
```

It runs deterministic Python tests plus a disposable PostgreSQL and real Fastify integration flow.
The gate verifies the local plugin/provider boundary, including no mutation before confirmation and
idempotent single execution after confirmation. It does not contact WhatsApp and does not prove
phone delivery.

Use this rollout order:

1. Verify the plugin with the disposable automated gate.
2. Install it disabled, set secrets in the Hermes service environment, then enable and restart.
3. Exercise `schedule_today` and `schedule_list_work_items` against the intended workspace.
4. Prepare a harmless test change, inspect every canonical field, and cancel it.
5. Prepare another bounded test, confirm from the same sender/session/platform on a later turn, and
   verify the result through Schedule.
6. Run `reminder.py` directly and inspect standard output.
7. Create a `--deliver local` no-agent cron job and trigger it once.
8. Configure `WHATSAPP_HOME_CHANNEL` to the operator's own self-chat, then perform one live delivery
   smoke. Record only opaque message or delivery identifiers, never the token or message contents.

## Limitations

- Version 1 is local-only. The strict loopback URL deliberately excludes hosted Schedule instances.
- The plugin exposes only the integration gateway's current read surfaces and structured command
  vocabulary. It does not add recurrence authoring, dependency editing, plan generation, deletes,
  arbitrary SQL, or a general Schedule natural-language API.
- Natural-language interpretation occurs in Hermes and can be wrong. Nothing is written until the
  exact server-validated command is presented and separately confirmed.
- The reminder is a deterministic snapshot, not a durable Schedule reminder engine. It has no quiet
  hours, snooze, escalation, provider delivery receipt, phone read receipt, or Schedule-side delivery
  history.
- The adapter polls Schedule when invoked. Privacy-thin `schedule.changed.v1` webhooks remain a
  separate refresh mechanism and do not trigger this local plugin.
- One token is bound to one workspace. Multiple workspaces require distinct credentials and isolated
  plugin/runtime configuration.
- Credential rotation requires updating the Hermes process environment and restarting processes
  that captured the old value.
- An expired or abandoned pending confirmation remains local state until it is canceled. Ask Hermes
  to cancel the pending Schedule change before preparing a replacement.
- Automated verification establishes local/stdout behavior only. WhatsApp remains operator-verified
  and must not be described as complete while `WHATSAPP_HOME_CHANNEL` is absent.
