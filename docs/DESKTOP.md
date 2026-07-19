# Desktop application

Status: native foundation and authenticated request boundary; the self-contained service supervisor
and product interface are not in this milestone yet.

Schedule is gaining a native Tauri 2 shell for Windows and Linux while retaining the existing web
application. The desktop and hosted applications will share domain behavior and API contracts, but
their runtime and authentication profiles remain deliberately separate.

## User experience target

The completed desktop distribution will be installed and opened like any other application. It will
start its private database, API, and worker automatically, show explicit startup and recovery states,
and shut them down with the application. End users will not install Node.js, pnpm, Docker, or
PostgreSQL and will not need to open a browser or enter a local URL.

The implemented foundation provides the native window, an empty built-in capability set, an
origin-locked navigation policy, strict production and development content security policies, an
accessible startup-state model, the authenticated API/bridge contract, Windows and Linux compile
checks, and installer metadata. It intentionally reports that the local runtime is unavailable until
the supervised runtime milestone lands; it must not present a scaffold as a working desktop release.

## Runtime architecture

The planned installed runtime has four layers:

1. The Tauri process owns lifecycle, recovery, and the private request bridge.
2. The existing React interface is bundled as native application assets.
3. Pinned production API and worker deployments run as supervised child processes.
4. A pinned PostgreSQL runtime stores local data in the operating system's per-user application-data
   directory, never beside installed binaries.

PostgreSQL remains the local store because the implemented planner and delivery guarantees depend on
PostgreSQL transactions, locks, JSON/array types, triggers, and migration behavior. Replacing it with
SQLite would be a separate correctness-sensitive storage port rather than a packaging shortcut.

Expected mutable locations are `%LOCALAPPDATA%\\Schedule` on Windows and
`${XDG_DATA_HOME:-~/.local/share}/schedule` on Linux. Exact subdirectories and the recovery journal
will be versioned by the supervisor implementation.

## Security boundary

The installed application uses a distinct `desktop_authenticated` production profile, not the
development `local_unauthenticated` mode. A random per-launch credential remains inside Rust. The API
loads it from its inherited environment, keeps only a SHA-256 digest, clears the raw environment
value, binds directly to dynamic-port `127.0.0.1`, and emits a readiness record containing only that
port. Product requests require the exact bearer credential and no browser `Origin`.

The webview calls a narrow Tauri bridge; Rust owns the loopback authority and adds the credential
when forwarding allowlisted `/v1/workspaces` requests. Renderer-supplied authorization and arbitrary
headers never cross the bridge. The native client disables proxies and redirects, bounds paths and
bodies, limits concurrent requests, and preserves only the response status, JSON body, and request
ID. The credential never enters JavaScript, URLs, process arguments, persisted configuration, or
logs. The bridge is registered but intentionally has no target until the next supervisor milestone
completes startup; that supervisor must clear the target on API exit and issue a fresh credential on
every restart.

The shell currently grants no shell or filesystem capability. Remote navigation and new remote
windows will remain disabled. Runtime processes will use non-administrative database roles, private
data-directory permissions, bounded readiness handshakes, ownership-checked shutdown, and redacted
diagnostics.

## Data lifecycle and recovery

First launch will initialize a staged private database cluster, apply migrations, validate the
result, and promote it atomically. Later upgrades will create a verified pre-migration backup before
changing user data. An interrupted or incompatible upgrade will fail closed into a recovery screen;
the application will not silently discard or recreate an existing database.

Database major upgrades require the old bundled runtime to export the data and a staged new runtime
to restore and validate it. A new PostgreSQL major version must never be started directly against an
older data directory.

## Web hosting and continuity

The existing web application remains valuable for a future hosted product, including a Cloudflare,
AWS, Railway, or other provider-neutral deployment. The repository already has dormant hosted OIDC,
workspace authorization, and a narrow work-item pull protocol. Those are foundations, not a complete
cross-device account system.

Desktop-to-web continuity will require an explicit remote-workspace identity, durable local outbox,
upload protocol, conflict policy, deletion semantics, token lifecycle, offline cache, and replication
coverage for plans, routines, calendar blocks, reminders, and history. Until those contracts are
implemented and tested, local data remains authoritative and the product must not claim bidirectional
sync.

## Developer commands

Development currently requires the normal repository prerequisites plus the stable Rust toolchain.

```powershell
pnpm install
pnpm desktop:dev
pnpm desktop:check
pnpm desktop:build
```

`desktop:build` builds the installer formats supported by the current operating system. The current
installer contains only the foundation shell and is not an end-user release.
