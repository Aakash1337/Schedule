# Desktop application

Status: native shell, authenticated request boundary, and tested coordinator/platform foundation.
The native effect executor, bundled release artifacts, and product interface are not in this
milestone yet.

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
accessible startup-state model, the authenticated API/bridge contract, platform process
containment, private temporary launch material, Windows and Linux compile checks, and installer
metadata. It intentionally reports that the local runtime is unavailable until the supervised
runtime milestone lands; it must not present a scaffold as a working desktop release.

## Implemented supervisor foundation

The native build now contains the bounded primitives and pure coordinator that launch integration
will use:

- A generation-aware lifecycle reducer orders lock acquisition, runtime verification, database
  startup, backup-before-migration, API/worker startup, and reverse cleanup. Failure and user-stop
  paths must finish cleanup before retry or restart can begin.
- A serialized coordinator drives that reducer through a fakeable executor, checks cancellation at
  effect boundaries, configures the private bridge only after API readiness, clears it before API
  shutdown, and attempts every reverse-cleanup effect while retaining the first cleanup error. Its
  current synchronous boundary still requires an asynchronous native host adapter to interrupt an
  effect that is blocked inside platform I/O.
- An operating-system file lock provides one runtime owner per user-data directory without deleting
  the coordination file during shutdown.
- A strict crash journal uses same-directory durable replacement. Windows uses `MoveFileExW` with
  replace and write-through flags, so an old migration record is never deleted before its successor
  is installed.
- Long-lived child and one-shot command runners clear inherited environments, reject relative
  executables, avoid shells, bound readiness/output/time, retain direct child handles, and expose
  only stable errors. Windows creates a private kill-on-close Job Object and assigns each suspended
  child before it can execute. Linux starts a new session/process group and gives the direct child a
  parent-death signal. Ownership is released exactly once after reaping, which also prevents
  surviving descendants from escaping ordinary shutdown.
- Desktop API and worker processes emit bounded, token-free dynamic-port readiness records and
  accept only the inherited `shutdown` line. EOF or a control-stream failure requests graceful
  shutdown; non-desktop deployments retain their existing signal behavior and do not consume stdin.
- Per-launch bearer and PostgreSQL bootstrap secrets use operating-system entropy. Temporary files
  are exclusively created beneath a private directory with Unix `0700`/`0600` modes or a protected
  current-user-only Windows DACL. Generated bootstrap SQL creates distinct constrained roles and
  grants the runtime role only the required database/schema access.
- PostgreSQL role credentials have a strict immutable v1 store beneath that private root. Creation
  is durable and non-replacing, restart loads are bound to the expected database and role names,
  interrupted publication is recovered only from an exact canonical pending record, and startup can
  scavenge only bounded, recognized temporary-secret directories without following links.
- PostgreSQL 17 plans separate initdb's raw password file from libpq's pgpass format, start the real
  `postgres` process directly, generate loopback-only SCRAM rules, define a private bootstrap step,
  authenticate the expected server/data directory, and use bounded fast shutdown and backup
  verification commands.
- The runtime assembler accepts only pinned, symlink-free, portable Windows/Linux input trees. It
  requires the complete PostgreSQL command set and pgcrypto files, creates a deterministic manifest,
  SBOM, and license inventory, and emits the manifest SHA-256 for embedding into the signed native
  binary. Rust compares that embedded trust anchor before accepting component hashes; a rewritten
  colocated manifest is not trusted.

These pieces are compiled and tested on Windows and Linux, but the coordinator still has no native
effect executor and is not invoked by `main`. The application therefore continues to report
`foundation` rather than claiming it is ready. Launch integration must call the durable credential
store and stale-secret scavenger only while holding the singleton lock, refuse to regenerate
credentials for an existing cluster, and run `pg_ctl stop -m fast` successfully before treating
platform containment as the database shutdown fallback. Release acceptance must also exercise real
descendant trees on Linux and supported Windows launch environments; a Linux parent-death signal
covers the direct child, not arbitrary grandchildren.

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
are derived beneath that root by the supervisor path contract.

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
diagnostics. Temporary deletion and Rust buffer zeroization are logical cleanup, not secure erase of
filesystem remnants, page cache, or copies held by child libraries. The current path checks assume a
trusted per-user data-root hierarchy rather than an attacker who can replace its parent directories.
The durable PostgreSQL store relies on those operating-system access controls; it is not encrypted
and does not protect against administrators, root, or malware already running as the same user.

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
pnpm desktop:runtime:assemble -- <pinned runtime arguments>
pnpm desktop:build
```

`desktop:build` builds the installer formats supported by the current operating system. The current
installer contains only the foundation shell and is not an end-user release.

Runtime assembly performs no downloads. Release automation must supply production API/worker
deployment trees, pinned Node and PostgreSQL 17 directories, their exact versions and tree hashes,
and a target OS/architecture. The emitted `SCHEDULE_DESKTOP_RUNTIME_MANIFEST_SHA256` value must be
present while compiling the signed native binary; a release build without that anchor cannot start
the bundled runtime.
