# Desktop application

Status: native shell, shared product interface, supervised private runtime, authenticated request
boundary, and verified Windows/Linux installer pipeline.

Schedule provides a native Tauri 2 shell for Windows and Linux while retaining the existing web
application. The desktop and hosted applications share domain behavior and API contracts, but
their runtime and authentication profiles remain deliberately separate.

## User experience target

The desktop distribution installs and opens like any other application. It starts its private
database, API, and worker automatically, shows explicit startup and recovery states, and shuts them
down with the application. End users do not install Node.js, pnpm, Docker, or PostgreSQL and do not
need to open a browser or enter a local URL.

The desktop distribution provides the native window, an empty built-in capability set, an
origin-locked navigation policy, strict production and development content security policies, an
accessible startup-state model, the authenticated API/bridge contract, platform process
containment, private temporary launch material, verified bundled services and PostgreSQL, Windows
and Linux compile checks, and installer metadata. It starts and stops that private runtime with the
application and reports bounded startup, recovery, and incompatibility states without exposing
runtime secrets.

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

## Implemented supervisor and runtime

The native build uses these bounded primitives and its pure coordinator for launch integration:

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
  pre-admission child is an inert copy of the native Schedule binary in an exact hidden guardian
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
  SHA-256 for embedding into the native binary. Rust compares that embedded trust anchor
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

The installed runtime has four layers:

1. The Tauri process owns lifecycle, recovery, and the private request bridge.
2. The existing React interface is bundled as native application assets.
3. Pinned production API and worker deployments run as supervised child processes.
4. A pinned PostgreSQL runtime stores local data in the operating system's per-user application-data
   directory, never beside installed binaries.

PostgreSQL remains the local store because the implemented planner and delivery guarantees depend on
PostgreSQL transactions, locks, JSON/array types, triggers, and migration behavior. Replacing it with
SQLite would be a separate correctness-sensitive storage port rather than a packaging shortcut.

The private service data lives in the dedicated `data` child of Tauri's per-user local app-data
directory: `%LOCALAPPDATA%\\com.aakash.schedule\\data` on Windows and
`${XDG_DATA_HOME:-~/.local/share}/com.aakash.schedule/data` on Linux. Keeping it separate from the
WebView profile lets the supervisor create and verify its own private root. Exact subdirectories and
the recovery journal are derived beneath that root by the supervisor path contract.

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
logs. The supervisor assigns the bridge target only after authenticated API readiness, clears it on
API exit, and issues a fresh credential on every restart.

The shell grants no shell or filesystem capability. Remote navigation and new remote windows are
disabled. Runtime processes use non-administrative database roles, private
data-directory permissions, bounded readiness handshakes, ownership-checked shutdown, and redacted
diagnostics. Temporary deletion and Rust buffer zeroization are logical cleanup, not secure erase of
filesystem remnants, page cache, or copies held by child libraries. The current path checks assume a
trusted per-user data-root hierarchy rather than an attacker who can replace its parent directories.
The durable PostgreSQL store relies on those operating-system access controls; it is not encrypted
and does not protect against administrators, root, or malware already running as the same user.

## Data lifecycle and recovery

First launch initializes and atomically promotes a staged private database cluster, then applies
migrations and validates it before serving user traffic. No user data exists during that initial
promotion. Later upgrades create a verified pre-migration backup before changing user data. An
interrupted or incompatible upgrade will fail closed into a recovery screen; the application will
not silently discard or recreate an existing database.

The application identifier and its `data` child are a storage compatibility boundary: a future
release must not rename either without an explicit copy, validation, and atomic-switch migration.
Before automatic desktop upgrade compatibility is considered complete, startup must use the full
live migration ledger—not only a hand-maintained schema token—to distinguish an exact database, a
valid upgrade prefix, a newer database, and a divergent history. Release acceptance must also prove
a populated installed N-1 to N upgrade and a fail-closed downgrade on both supported operating
systems. These remaining evidence gaps are tracked in [EVALUATION.md](./EVALUATION.md).

Database major upgrades require the old bundled runtime to export the data and a staged new runtime
to restore and validate it. A new PostgreSQL major version must never be started directly against an
older data directory.

The repository CLI now provides a versioned logical `.schedule` archive for moving every classified
durable product row—including stored AI proposals and long-term behavior feedback—between matching
Schedule schemas on Windows and Linux. It excludes environment identities, credentials, secrets,
delivery queues, and hosted sync journals; see [PORTABLE_MIGRATION.md](./PORTABLE_MIGRATION.md).
One-click desktop controls for this archive are still pending native lifecycle integration.

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

## Release automation

The `desktop-release` workflow runs on manual dispatch, with a path-filtered pull request trigger that
verifies changes to its release inputs. For each Windows x64 and Linux x64 build
it creates production API and worker deploy trees, downloads locked source archives, builds and verifies
the minimal Node runtime and PostgreSQL 17 runtime, assembles the authenticated runtime, then builds the
native Tauri installers. It retains the installers plus the runtime manifest, SBOM, license inventory,
component provenance, installer hashes, and workflow provenance as one Actions artifact set for 90
days. These are verified CI/test installers, not published releases. In particular, the Windows
installers are not Authenticode-signed and may show a SmartScreen warning. Tag publication and public
release claims remain disabled until a real code-signing identity and release policy are configured.

Build and download the current `main` installers with GitHub CLI:

```powershell
gh workflow run desktop-release.yml --repo Aakash1337/Schedule --ref main
gh run list --repo Aakash1337/Schedule --workflow desktop-release.yml --limit 1
gh run watch <run-id> --repo Aakash1337/Schedule --exit-status
gh run download <run-id> --repo Aakash1337/Schedule -n schedule-desktop-windows-x64 -D artifacts/windows
gh run download <run-id> --repo Aakash1337/Schedule -n schedule-desktop-linux-x64 -D artifacts/linux
```

On Windows, open the downloaded `*-setup.exe`, complete the installer, then launch **Schedule** from
the Start menu; the application starts and stops its private local services automatically. On Linux,
install the downloaded Debian package with `sudo apt install ./<package>.deb`, then open **Schedule**
from the application menu (or run `schedule-desktop`). Prefer those install-smoked NSIS and Debian
artifacts over MSI or AppImage for now.

Windows produces NSIS and MSI where the runner supports them. Linux produces AppImage and Debian
packages where the runner supports them. CI install-smokes NSIS and extracts/smokes the Debian package;
MSI and AppImage are built and uploaded but not separately install-smoked. The smoke validates the
complete immutable runtime contract at Tauri's `$RESOURCE/runtime` mapping (including hashes,
inventories, and launch files), then runs the bundled Node and PostgreSQL binaries with `--version`.
This validates packaged resource integrity and executable availability, then invokes the installed native
binary's bounded headless lifecycle hook twice against the same isolated data directory. That establishes
the embedded manifest anchor, startup, orderly shutdown, and restart path without pretending that an
arbitrary GUI/webview process proves readiness. Each invocation is shell-free, hidden on Windows, bounded
to 450 seconds, and reports only a numeric exit code on failure.

After the Windows lifecycle smoke, CI writes a unique marker under the real per-user data directory,
silently runs the NSIS uninstaller, requires the installed executable to be removed, and verifies that
the marker is unchanged. This makes preservation of `%LOCALAPPDATA%\com.aakash.schedule\data` an
enforced NSIS uninstall contract rather than an installer assumption. The check does not claim the same
behavior for MSI or Linux package-manager removal.

Runtime assembly performs no downloads. Release automation must supply production API/worker
deployment trees, pinned Node and PostgreSQL 17 directories, their exact versions and tree hashes,
and a target OS/architecture. The emitted `SCHEDULE_DESKTOP_RUNTIME_MANIFEST_SHA256` value must be
present while compiling the native binary; a release build without that anchor cannot start
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

This command is deliberately an acquisition step, not a package builder. The release workflow then
runs the same pinned Node and PostgreSQL builders for each target, stages the API and worker,
validates and assembles all four trees, embeds the manifest hash in the Tauri binary, and runs
installer plus first-launch smoke tests. A committed hash protects the selected bytes but does not
replace an independently verified upstream release-signature process.

The acquisition directory must remain private to the same user; this developer tool does not try to
defend against a same-user process modifying a published archive after it returns. The release
consumer re-hashes every final runtime-bundle file against its manifest before launch.
