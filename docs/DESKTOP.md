# Desktop application

Status: native shell, shared product interface, authenticated request boundary, and tested
coordinator/host/runtime foundation. The native effect executor and bundled release artifacts are not
in this milestone yet.

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

## Shared product interface

The desktop shell installs its native API transport before React renders, starts one redacted native
runtime inspection even under React Strict Mode, follows active startup at a bounded interval, and
mounts the existing product interface only after the supervisor reports `ready`. Terminal states
stop polling. Startup, recoverable failure, retry, and incompatible-data states remain in a small
accessible native gate, so the web interface cannot issue requests against an unavailable local
service.

The desktop build deliberately compiles the product UI directly from `apps/web/src` inside this
monorepo. The web application owns shared feature views and client behavior; `apps/desktop` owns only
the native bootstrap, runtime gate, transport installation, and desktop-specific presentation. This
keeps desktop and hosted behavior aligned without a copied UI. If either surface is later released
from a separate repository, these shared sources must first move behind an explicit workspace
package boundary.

## Implemented supervisor foundation

The native build now contains the bounded primitives and pure coordinator that launch integration
will use:

- A generation-aware lifecycle reducer orders lock acquisition, runtime verification, database
  startup, backup-before-migration, API/worker startup, and reverse cleanup. Failure and user-stop
  paths must finish cleanup before retry or restart can begin.
- A serialized coordinator drives that reducer through a fakeable executor, checks cancellation at
  effect boundaries, configures the private bridge only after API readiness, clears it before API
  shutdown, and attempts every reverse-cleanup effect while retaining the first cleanup error.
- A UI-agnostic host owns the coordinator on one dedicated thread. It pre-arms cancellation before
  queueing startup, coalesces overlapping lifecycle commands, linearizes shutdown admission, retries
  idempotent cleanup within a fixed budget, and exposes only redacted status and terminal shutdown
  outcomes. Executor panics, including destructor panics, cannot strand completion waiters.
- An operating-system file lock provides one runtime owner per user-data directory without deleting
  the coordination file during shutdown.
- A strict crash journal uses same-directory durable replacement. Windows uses `MoveFileExW` with
  replace and write-through flags, so an old migration record is never deleted before its successor
  is installed.
- Long-lived child and one-shot command runners clear inherited environments, reject relative
  executables, avoid shells, bound readiness/output/time, and expose only stable errors. Their only
  pre-admission child is an inert copy of the signed Schedule binary in an exact hidden guardian
  mode. A bounded binary launch packet crosses a private inherited pipe; paths, arguments, working
  directory, and environment never enter guardian arguments, logs, or temporary files. The parent
  consumes an exact guardian-ready acknowledgement from stderr, installs bounded stdout and stderr
  drains, and only then sends COMMIT. The final barrier atomically rejects an open admission or
  makes an in-progress admission force-stop before releasing its writer, without waiting for a
  stalled packet writer. Desktop process exit closes every pipe handle as the independent liveness
  fail-safe.
- On Windows, each guardian creates a private kill-on-close Job and joins it before creating the
  payload suspended. It verifies that the payload inherited Job membership before acknowledging
  readiness and resumes it only after COMMIT. Pipe EOF or FORCE terminates the Job; guardian exit
  closes its sole Job handle and therefore kills remaining descendants. On Linux, the guardian
  creates an isolated session, becomes a child subreaper, gives the direct payload a
  parent-death signal, and keeps the control descriptor close-on-exec. EOF or FORCE kills the
  payload group, walks adopted descendants (including new groups/sessions), and reaps until the
  kernel reports no children. Ownership is released exactly once after the guardian exits.
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
  requires the complete PostgreSQL command set, compiled database migration entrypoint, and pgcrypto
  files; creates a deterministic manifest, SBOM, and license inventory; and emits the manifest
  SHA-256 for embedding into the signed native binary. Rust compares that embedded trust anchor
  before accepting component hashes; a rewritten colocated manifest is not trusted. After verifying
  one canonical, non-link runtime root, it resolves fixed absolute Node, API, worker, migration, and
  PostgreSQL tool paths from that same tree. Unix links and all Windows reparse points fail closed.
- `runtime-sources.lock.json` strictly pins the initial Windows x64 and Linux x64 release inputs:
  Node 24.18.0 archives and PostgreSQL 17.10 source. Its fetcher rejects unknown fields and
  non-official HTTPS origins, follows at most three official-origin redirects, streams into a
  create-new private temporary file while hashing and bounding bytes, and publishes a final archive
  only after the committed SHA-256 matches. It keeps the verified handle open through publication
  and rejects a changed temporary or output hierarchy. A normal failure removes its partial; a
  crash orphan has a recognized, bounded name and is scavenged before retry. After publication the
  temporary hard link is removed, leaving only the verified final archive. It never extracts or
  executes fetched bytes.

These pieces are connected to the native effect executor and Tauri lifecycle. Launch integration
calls the durable credential store and stale-secret scavenger only while holding the singleton lock,
refuses to regenerate credentials for an existing cluster, and runs `pg_ctl stop -m fast`
successfully before treating platform containment as the database shutdown fallback. Release
acceptance must also exercise real descendant trees on Linux and supported Windows launch
environments. The Linux guarantee covers
ordinary descendants and processes reparented to the guardian while it is alive; an unprivileged
process cannot impose a kernel kill-on-owner-loss contract on a deliberately detached grandchild
that escapes ancestry immediately before an external `SIGKILL` of the guardian. Normal desktop
loss is stronger than that boundary because control EOF is handled by the live subreaper before it
exits. Deployments needing containment against hostile payloads require an external cgroup/systemd
scope; Schedule's bundled and integrity-checked runtime is not an adversarial-code sandbox.

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
pnpm desktop:runtime:acquire-sources
pnpm desktop:build -- --runtime <assembled-runtime-root>
```

`desktop:build` is an alias for `desktop:package` and requires the direct root emitted by
`desktop:runtime:assemble`; it refuses a parent directory, a partial runtime, or a runtime whose
component/inventory hashes no longer match its manifest. For example:

```powershell
pnpm desktop:build -- --runtime E:\release-inputs\runtime-windows-x86_64
```

The packager stages that root as Tauri's immutable `resources/runtime`, compiles with the manifest
SHA-256 in `SCHEDULE_DESKTOP_RUNTIME_MANIFEST_SHA256`, and removes its staging directory afterwards.
It is not an end-user installer release until CI supplies real, verified Node and PostgreSQL runtime
artifacts for the selected target.

Runtime assembly performs no downloads. Release automation must supply production API/worker
deployment trees, pinned Node and PostgreSQL 17 directories, their exact versions and tree hashes,
and a target OS/architecture. The emitted `SCHEDULE_DESKTOP_RUNTIME_MANIFEST_SHA256` value must be
present while compiling the signed native binary; a release build without that anchor cannot start
the bundled runtime.

### Pinned source acquisition

`pnpm desktop:runtime:acquire-sources` fetches the archive set declared in the committed
[`runtime-sources.lock.json`](../runtime-sources.lock.json) into `.desktop-runtime-sources/`, split
by target to keep the shared PostgreSQL source archive unambiguous. The lock is the runtime trust
anchor; the command does not fetch checksum text at runtime. The recorded values were checked from
the [Node 24.18.0 signed checksum listing](https://nodejs.org/en/blog/release/v24.18.0) and the
[PostgreSQL 17.10 SHA-256 file](https://ftp.postgresql.org/pub/source/v17.10/postgresql-17.10.tar.gz.sha256).

The dedicated `PostgreSQL desktop runtime` workflow turns the pinned PostgreSQL source into the
small runtime tree consumed by `desktop:runtime:assemble`. It currently produces and tests only the
two declared x64 targets: Ubuntu 22.04 Linux and Windows Server 2022. Linux builds pinned OpenSSL and
zlib sources; Windows builds a pinned vcpkg commit with fixed, hash-checked Meson, Ninja, and
WinFlexBison tools. Workflow actions are commit-pinned. Both artifacts include native notices, build
provenance, a per-file SHA-256 inventory, and an archive SHA-256 file.

The build fails on archive path escapes, source links, final runtime links, missing pgcrypto files,
unresolved native dependencies, or a changed inventory. Its smoke test copies the finished runtime
to a path containing spaces, initializes and starts a temporary cluster, exercises pgcrypto,
performs a custom-format dump/list operation, and stops the cluster. Linux additionally enforces
relative RUNPATHs and an Ubuntu 22.04 GLIBC symbol floor; Windows walks PE dependencies and bundles
non-system Visual C++ runtime DLLs. This evidence does not claim compatibility with other Linux
distributions, Windows versions, or CPU architectures.

The Node and PostgreSQL workflows produce verified native component artifacts, while service
staging produces the API and worker deployment trees. `desktop:runtime:assemble` validates those
four supplied trees, and `desktop:build` embeds the resulting manifest hash before packaging. A
production release must still consume the matching platform artifacts and independently verify
upstream release signatures; a committed hash protects the selected bytes but does not replace that
provenance check.

The acquisition directory must remain private to the same user; this developer tool does not try to
defend against a same-user process modifying a published archive after it returns. The release
consumer re-hashes every final runtime-bundle file against its manifest before launch.
