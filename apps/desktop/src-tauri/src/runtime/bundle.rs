//! Secret-free launch paths resolved from an already verified runtime bundle.
//!
//! The manifest is intentionally not a general path lookup API.  The desktop runtime has a
//! small fixed surface, so resolve exactly those files after integrity verification and hand the
//! executor absolute paths that cannot escape the immutable resource directory.

use std::{
    fmt, fs,
    path::{Path, PathBuf},
};

use super::integrity::is_link_or_reparse;
use super::manifest::{RuntimeComponentName, RuntimeLaunchPath, RuntimeManifest, RuntimeOs};

const MIGRATION_ENTRYPOINT: &str = "api/node_modules/@schedule/database/dist/migrate.js";
const MIGRATION_MANIFEST: &str =
    "api/node_modules/@schedule/database/drizzle/meta/_migration_manifest.json";

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PostgreSqlPrograms {
    pub(crate) postgres: PathBuf,
    pub(crate) initdb: PathBuf,
    pub(crate) psql: PathBuf,
    pub(crate) pg_isready: PathBuf,
    pub(crate) pg_dump: PathBuf,
    pub(crate) pg_restore: PathBuf,
    pub(crate) pg_ctl: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RuntimeBundle {
    pub(crate) root: PathBuf,
    pub(crate) node: PathBuf,
    pub(crate) api: PathBuf,
    pub(crate) worker: PathBuf,
    pub(crate) postgresql: PostgreSqlPrograms,
    pub(crate) migration: PathBuf,
    pub(crate) migration_manifest: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RuntimeBundleError(&'static str);

impl fmt::Display for RuntimeBundleError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.0)
    }
}

impl std::error::Error for RuntimeBundleError {}

/// Resolve the fixed executables and entrypoints beneath integrity's canonical verified root.
pub(super) fn resolve_verified_runtime_bundle(
    root: &Path,
    manifest: &RuntimeManifest,
) -> Result<RuntimeBundle, RuntimeBundleError> {
    let executable_suffix = match manifest.target.os {
        RuntimeOs::Windows => ".exe",
        RuntimeOs::Linux => "",
    };

    let node = component_launch(
        manifest,
        RuntimeComponentName::Node,
        RuntimeLaunchPathKind::Executable,
        &format!("node/node{executable_suffix}"),
        root,
    )?;
    let api = component_launch(
        manifest,
        RuntimeComponentName::Api,
        RuntimeLaunchPathKind::Entrypoint,
        "api/dist/server.js",
        root,
    )?;
    let worker = component_launch(
        manifest,
        RuntimeComponentName::Worker,
        RuntimeLaunchPathKind::Entrypoint,
        "worker/dist/index.js",
        root,
    )?;
    let postgres = component_launch(
        manifest,
        RuntimeComponentName::Postgresql,
        RuntimeLaunchPathKind::Executable,
        &format!("postgresql/bin/postgres{executable_suffix}"),
        root,
    )?;
    let bin =
        |name: &str| resolve_regular(root, &format!("postgresql/bin/{name}{executable_suffix}"));

    Ok(RuntimeBundle {
        root: root.to_owned(),
        node,
        api,
        worker,
        postgresql: PostgreSqlPrograms {
            postgres,
            initdb: bin("initdb")?,
            psql: bin("psql")?,
            pg_isready: bin("pg_isready")?,
            pg_dump: bin("pg_dump")?,
            pg_restore: bin("pg_restore")?,
            pg_ctl: bin("pg_ctl")?,
        },
        migration: resolve_regular(root, MIGRATION_ENTRYPOINT)?,
        migration_manifest: resolve_regular(root, MIGRATION_MANIFEST)?,
    })
}

#[derive(Clone, Copy)]
enum RuntimeLaunchPathKind {
    Executable,
    Entrypoint,
}

fn component_launch(
    manifest: &RuntimeManifest,
    name: RuntimeComponentName,
    kind: RuntimeLaunchPathKind,
    expected: &str,
    root: &Path,
) -> Result<PathBuf, RuntimeBundleError> {
    let component = manifest
        .components
        .iter()
        .find(|component| component.name == name)
        .ok_or(RuntimeBundleError("runtime component is missing"))?;
    let path = match (&component.launch, kind) {
        (RuntimeLaunchPath::Executable { path }, RuntimeLaunchPathKind::Executable)
        | (RuntimeLaunchPath::Entrypoint { path }, RuntimeLaunchPathKind::Entrypoint) => path,
        _ => {
            return Err(RuntimeBundleError(
                "runtime component launch kind is invalid",
            ));
        }
    };
    if path != expected {
        return Err(RuntimeBundleError(
            "runtime component launch path is invalid",
        ));
    }
    resolve_regular(root, path)
}

fn resolve_regular(root: &Path, relative: &str) -> Result<PathBuf, RuntimeBundleError> {
    let mut path = root.to_owned();
    for component in relative.split('/') {
        path.push(component);
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| RuntimeBundleError("runtime bundle file is missing"))?;
        if is_link_or_reparse(&metadata) {
            return Err(RuntimeBundleError(
                "runtime bundle contains a link or reparse point",
            ));
        }
    }
    let metadata = fs::symlink_metadata(&path)
        .map_err(|_| RuntimeBundleError("runtime bundle file is missing"))?;
    if is_link_or_reparse(&metadata) || !metadata.is_file() {
        return Err(RuntimeBundleError(
            "runtime bundle path is not a regular file",
        ));
    }
    let canonical = dunce::canonicalize(&path)
        .map_err(|_| RuntimeBundleError("runtime bundle file cannot be canonicalized"))?;
    if !canonical.starts_with(root) {
        return Err(RuntimeBundleError("runtime bundle path escapes its root"));
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;
    use crate::runtime::manifest::{
        RuntimeArch, RuntimeArtifacts, RuntimeComponent, RuntimeManifest, RuntimeOs, RuntimeTarget,
    };

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let id = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root =
                std::env::temp_dir().join(format!("schedule-bundle-{}-{id}", std::process::id()));
            fs::create_dir_all(&root).unwrap();
            Self(root)
        }

        fn write(&self, relative: &str) {
            let path = self.0.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, relative).unwrap();
        }

        fn canonical_root(&self) -> PathBuf {
            dunce::canonicalize(&self.0).unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn manifest(os: RuntimeOs) -> RuntimeManifest {
        let suffix = if os == RuntimeOs::Windows { ".exe" } else { "" };
        RuntimeManifest {
            schema_version: 1,
            target: RuntimeTarget {
                os,
                arch: RuntimeArch::X86_64,
            },
            postgresql_major: 17,
            components: vec![
                component(
                    RuntimeComponentName::Node,
                    RuntimeLaunchPath::Executable {
                        path: format!("node/node{suffix}"),
                    },
                ),
                component(
                    RuntimeComponentName::Api,
                    RuntimeLaunchPath::Entrypoint {
                        path: "api/dist/server.js".into(),
                    },
                ),
                component(
                    RuntimeComponentName::Worker,
                    RuntimeLaunchPath::Entrypoint {
                        path: "worker/dist/index.js".into(),
                    },
                ),
                component(
                    RuntimeComponentName::Postgresql,
                    RuntimeLaunchPath::Executable {
                        path: format!("postgresql/bin/postgres{suffix}"),
                    },
                ),
            ],
            artifacts: RuntimeArtifacts {
                licenses_sha256: "a".repeat(64),
                sbom_sha256: "b".repeat(64),
            },
        }
    }

    fn component(name: RuntimeComponentName, launch: RuntimeLaunchPath) -> RuntimeComponent {
        RuntimeComponent {
            name,
            version: "17.0.0".into(),
            sha256: "a".repeat(64),
            launch,
            license_path: "licenses.txt".into(),
            sbom_path: "sbom.json".into(),
        }
    }

    fn populate(fixture: &Fixture, os: RuntimeOs) {
        let suffix = if os == RuntimeOs::Windows { ".exe" } else { "" };
        for path in [
            format!("node/node{suffix}"),
            "api/dist/server.js".into(),
            "worker/dist/index.js".into(),
            format!("postgresql/bin/postgres{suffix}"),
            format!("postgresql/bin/initdb{suffix}"),
            format!("postgresql/bin/psql{suffix}"),
            format!("postgresql/bin/pg_isready{suffix}"),
            format!("postgresql/bin/pg_dump{suffix}"),
            format!("postgresql/bin/pg_restore{suffix}"),
            format!("postgresql/bin/pg_ctl{suffix}"),
            MIGRATION_ENTRYPOINT.into(),
            MIGRATION_MANIFEST.into(),
        ] {
            fixture.write(&path);
        }
    }

    #[test]
    fn resolves_all_absolute_runtime_paths_for_each_platform_suffix() {
        for os in [RuntimeOs::Windows, RuntimeOs::Linux] {
            let fixture = Fixture::new();
            populate(&fixture, os.clone());
            let bundle =
                resolve_verified_runtime_bundle(&fixture.canonical_root(), &manifest(os)).unwrap();
            assert!(bundle.root.is_absolute());
            for path in [
                bundle.node,
                bundle.api,
                bundle.worker,
                bundle.postgresql.postgres,
                bundle.postgresql.initdb,
                bundle.postgresql.psql,
                bundle.postgresql.pg_isready,
                bundle.postgresql.pg_dump,
                bundle.postgresql.pg_restore,
                bundle.postgresql.pg_ctl,
                bundle.migration,
                bundle.migration_manifest,
            ] {
                assert!(path.is_absolute());
                assert!(path.starts_with(&bundle.root));
            }
        }
    }

    #[test]
    fn rejects_missing_wrong_kind_or_wrong_suffix_paths() {
        let fixture = Fixture::new();
        populate(&fixture, RuntimeOs::Linux);
        fs::remove_file(fixture.0.join(MIGRATION_ENTRYPOINT)).unwrap();
        assert!(
            resolve_verified_runtime_bundle(&fixture.canonical_root(), &manifest(RuntimeOs::Linux))
                .is_err()
        );

        let fixture = Fixture::new();
        populate(&fixture, RuntimeOs::Linux);
        fs::remove_file(fixture.0.join("postgresql/bin/pg_ctl")).unwrap();
        fs::create_dir_all(fixture.0.join("postgresql/bin/pg_ctl")).unwrap();
        assert!(
            resolve_verified_runtime_bundle(&fixture.canonical_root(), &manifest(RuntimeOs::Linux))
                .is_err()
        );

        let fixture = Fixture::new();
        populate(&fixture, RuntimeOs::Linux);
        let mut bad = manifest(RuntimeOs::Linux);
        bad.components[0].launch = RuntimeLaunchPath::Executable {
            path: "node/node.exe".into(),
        };
        assert!(resolve_verified_runtime_bundle(&fixture.canonical_root(), &bad).is_err());
    }

    #[test]
    fn rejects_escaping_or_symlinked_paths() {
        let fixture = Fixture::new();
        populate(&fixture, RuntimeOs::Linux);
        let mut bad = manifest(RuntimeOs::Linux);
        bad.components[1].launch = RuntimeLaunchPath::Entrypoint {
            path: "../outside.js".into(),
        };
        assert!(resolve_verified_runtime_bundle(&fixture.canonical_root(), &bad).is_err());

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let outside = fixture
                .0
                .parent()
                .unwrap()
                .join("schedule-bundle-outside.js");
            fs::write(&outside, "outside").unwrap();
            fs::remove_file(fixture.0.join(MIGRATION_ENTRYPOINT)).unwrap();
            symlink(&outside, fixture.0.join(MIGRATION_ENTRYPOINT)).unwrap();
            assert!(
                resolve_verified_runtime_bundle(
                    &fixture.canonical_root(),
                    &manifest(RuntimeOs::Linux)
                )
                .is_err()
            );
            let _ = fs::remove_file(outside);
        }
    }

    #[cfg(windows)]
    #[test]
    fn rejects_windows_reparse_points_when_symlink_creation_is_available() {
        use std::os::windows::fs::symlink_file;

        let fixture = Fixture::new();
        populate(&fixture, RuntimeOs::Windows);
        let target = fixture.0.join("reparse-target");
        fs::write(&target, "target").unwrap();
        let migration = fixture.0.join(MIGRATION_ENTRYPOINT);
        fs::remove_file(&migration).unwrap();
        if let Err(error) = symlink_file(&target, &migration) {
            assert!(
                error.kind() == std::io::ErrorKind::PermissionDenied
                    || error.raw_os_error() == Some(1314)
            );
            eprintln!("Windows reparse negative test skipped: {error}");
            return;
        }
        assert!(
            resolve_verified_runtime_bundle(
                &fixture.canonical_root(),
                &manifest(RuntimeOs::Windows)
            )
            .is_err()
        );
    }
}
