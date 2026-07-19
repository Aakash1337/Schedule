//! Immutable bundled-runtime verification.
//!
//! `scripts/build-desktop-runtime.ts` hashes a component tree as sorted
//! `relative-path + NUL + bytes + NUL` records.  This module deliberately uses
//! the same small format so the desktop process can reject a modified bundle
//! before it starts any child process.

use std::{
    fmt,
    fs::{self, FileType},
    io::{self, Read},
    path::{Component, Path, PathBuf},
};

use sha2::{Digest, Sha256};

use super::bundle::{RuntimeBundle, resolve_verified_runtime_bundle};
use super::manifest::{
    RuntimeComponent, RuntimeComponentName, RuntimeManifest, RuntimeManifestExpectations,
    is_portable_relative_path,
};

const MANIFEST_FILE: &str = "runtime-manifest.json";
const MAX_MANIFEST_BYTES: u64 = 256 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeIntegrityError(String);

impl fmt::Display for RuntimeIntegrityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for RuntimeIntegrityError {}

pub fn embedded_manifest_sha256() -> Option<&'static str> {
    option_env!("SCHEDULE_DESKTOP_RUNTIME_MANIFEST_SHA256").filter(|value| !value.is_empty())
}

/// Load the manifest from the bundle itself before validating any launch path.
pub fn load_and_verify_runtime_bundle(
    root: &Path,
    expectations: &RuntimeManifestExpectations,
    expected_manifest_sha256: &str,
) -> Result<RuntimeBundle, RuntimeIntegrityError> {
    let root = canonical_runtime_root(root)?;
    let manifest_path = resolve(&root, MANIFEST_FILE)?;
    assert_regular_file(&manifest_path, "runtime manifest")?;
    let metadata =
        fs::metadata(&manifest_path).map_err(|_| error("runtime manifest cannot be inspected"))?;
    if metadata.len() > MAX_MANIFEST_BYTES {
        return Err(error("runtime manifest is too large"));
    }
    let bytes = fs::read(manifest_path).map_err(|_| error("runtime manifest cannot be read"))?;
    if !is_sha256(expected_manifest_sha256)
        || format!("{:x}", Sha256::digest(&bytes)) != expected_manifest_sha256
    {
        return Err(error("runtime manifest trust anchor does not match"));
    }
    let manifest = serde_json::from_slice::<RuntimeManifest>(&bytes)
        .map_err(|_| error("runtime manifest JSON is invalid"))?;
    verify_runtime_bundle(&root, &manifest, expectations)?;
    resolve_verified_runtime_bundle(&root, &manifest)
        .map_err(|_| error("verified runtime paths cannot be resolved"))
}

/// Establish one stable, non-link identity for the immutable root before any bundle access.
fn canonical_runtime_root(root: &Path) -> Result<PathBuf, RuntimeIntegrityError> {
    assert_directory(root, "runtime root")?;
    root.canonicalize()
        .map_err(|_| error("runtime root cannot be canonicalized"))
}

/// Verify target metadata, every required component tree, and the launch/SBOM/license files.
///
/// `root` must be the immutable Tauri resource directory containing the generated runtime
/// directory. Nothing in the manifest is allowed to resolve outside this root.
fn verify_runtime_bundle(
    root: &Path,
    manifest: &RuntimeManifest,
    expectations: &RuntimeManifestExpectations,
) -> Result<(), RuntimeIntegrityError> {
    manifest
        .validate(expectations)
        .map_err(|_| error("runtime manifest metadata is invalid"))?;
    assert_directory(root, "runtime root")?;
    // Walk the entire bundle once before choosing any launch path. This rejects a hidden
    // symlink, socket, or device even when it is not currently referenced by the manifest.
    let mut bundle_files = Vec::new();
    collect_files(root, root, &mut bundle_files)?;
    assert_regular_file(&resolve(root, MANIFEST_FILE)?, "runtime manifest")?;

    for component in &manifest.components {
        let component_name = component_root_name(&component.name);
        let component_root = resolve(root, component_name)?;
        assert_directory(&component_root, "runtime component root")?;
        let actual = hash_tree(&component_root)?;
        if actual != component.sha256 {
            return Err(error("runtime component hash does not match its manifest"));
        }
        if !launch_path(component).starts_with(&format!("{component_name}/")) {
            return Err(error(
                "runtime component launch file is outside its component root",
            ));
        }
        assert_regular_file(
            &resolve(root, launch_path(component))?,
            "runtime component launch file",
        )?;
        assert_regular_file(
            &resolve(root, &component.license_path)?,
            "runtime license inventory",
        )?;
        assert_regular_file(&resolve(root, &component.sbom_path)?, "runtime SBOM")?;
    }
    if format!(
        "{:x}",
        Sha256::digest(
            fs::read(resolve(root, "runtime-licenses.json")?)
                .map_err(|_| error("runtime license inventory cannot be read"))?
        )
    ) != manifest.artifacts.licenses_sha256
        || format!(
            "{:x}",
            Sha256::digest(
                fs::read(resolve(root, "runtime-sbom.json")?)
                    .map_err(|_| error("runtime SBOM cannot be read"))?
            )
        ) != manifest.artifacts.sbom_sha256
    {
        return Err(error("runtime inventory hash does not match its manifest"));
    }
    Ok(())
}

/// Hash a safe directory tree in the exact deterministic format used by the TypeScript builder.
pub fn hash_tree(root: &Path) -> Result<String, RuntimeIntegrityError> {
    assert_directory(root, "runtime component root")?;
    let mut files = Vec::new();
    collect_files(root, root, &mut files)?;
    // JavaScript's default string sort compares UTF-16 code units. Match it exactly so
    // non-ASCII dependency filenames hash identically in the packager and supervisor.
    files.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));

    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 8192];
    for relative in files {
        digest.update(relative.as_bytes());
        digest.update([0]);
        let mut file =
            fs::File::open(root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR)))
                .map_err(|_| error("runtime component file cannot be read"))?;
        loop {
            let read = file
                .read(&mut buffer)
                .map_err(|_| error("runtime component file cannot be read"))?;
            if read == 0 {
                break;
            }
            digest.update(&buffer[..read]);
        }
        digest.update([0]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn collect_files(
    root: &Path,
    directory: &Path,
    files: &mut Vec<String>,
) -> Result<(), RuntimeIntegrityError> {
    let mut entries = fs::read_dir(directory)
        .map_err(|_| error("runtime component directory cannot be read"))?
        .collect::<Result<Vec<_>, io::Error>>()
        .map_err(|_| error("runtime component directory cannot be read"))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| error("runtime component entry cannot be inspected"))?;
        let file_type = metadata.file_type();
        if is_link_or_reparse(&metadata) {
            return Err(error("runtime bundle contains a link or reparse point"));
        }
        if file_type.is_dir() {
            collect_files(root, &path, files)?;
        } else if file_type.is_file() {
            let relative = path
                .strip_prefix(root)
                .map_err(|_| error("runtime component path escapes its root"))?;
            files.push(normalized_relative(relative)?);
        } else {
            return Err(error("runtime bundle contains a non-regular file"));
        }
    }
    Ok(())
}

fn component_root_name(name: &RuntimeComponentName) -> &'static str {
    match name {
        RuntimeComponentName::Node => "node",
        RuntimeComponentName::Api => "api",
        RuntimeComponentName::Worker => "worker",
        RuntimeComponentName::Postgresql => "postgresql",
    }
}

fn launch_path(component: &RuntimeComponent) -> &str {
    match &component.launch {
        super::manifest::RuntimeLaunchPath::Executable { path }
        | super::manifest::RuntimeLaunchPath::Entrypoint { path } => path,
    }
}

fn resolve(root: &Path, relative: &str) -> Result<PathBuf, RuntimeIntegrityError> {
    let relative_path = Path::new(relative);
    if !is_portable_relative_path(relative)
        || relative_path.is_absolute()
        || relative_path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(error("runtime manifest path is not a safe relative path"));
    }
    let mut current = root.to_owned();
    for component in relative_path.components() {
        let Component::Normal(component) = component else {
            return Err(error("runtime manifest path is not a safe relative path"));
        };
        current.push(component);
        // `symlink_metadata`, unlike `metadata`, never follows the final component. Checking
        // each prefix prevents an otherwise safe-looking path from traversing an intermediate
        // symlink outside the immutable runtime root.
        let metadata =
            fs::symlink_metadata(&current).map_err(|_| error("runtime bundle file is missing"))?;
        if is_link_or_reparse(&metadata) {
            return Err(error("runtime bundle contains a link or reparse point"));
        }
    }
    Ok(current)
}

fn normalized_relative(path: &Path) -> Result<String, RuntimeIntegrityError> {
    let components = path
        .components()
        .map(|component| match component {
            Component::Normal(value) => value
                .to_str()
                .filter(|value| !value.is_empty() && !value.contains('\\') && !value.contains(':'))
                .map(str::to_owned)
                .ok_or_else(|| error("runtime component path is not portable")),
            _ => Err(error("runtime component path escapes its root")),
        })
        .collect::<Result<Vec<_>, _>>()?;
    if components.is_empty() {
        return Err(error("runtime component path is empty"));
    }
    let relative = components.join("/");
    if !is_portable_relative_path(&relative) {
        return Err(error("runtime component path is not portable"));
    }
    Ok(relative)
}

fn assert_directory(path: &Path, label: &'static str) -> Result<(), RuntimeIntegrityError> {
    match safe_file_type(path)? {
        file_type if file_type.is_dir() => Ok(()),
        _ => Err(error(label)),
    }
}

fn assert_regular_file(path: &Path, label: &'static str) -> Result<(), RuntimeIntegrityError> {
    match safe_file_type(path)? {
        file_type if file_type.is_file() => Ok(()),
        _ => Err(error(label)),
    }
}

fn safe_file_type(path: &Path) -> Result<FileType, RuntimeIntegrityError> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| error("runtime bundle file is missing"))?;
    if is_link_or_reparse(&metadata) {
        return Err(error("runtime bundle contains a link or reparse point"));
    }
    Ok(metadata.file_type())
}

pub(super) fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;

        metadata.file_attributes() & 0x0400 != 0 // FILE_ATTRIBUTE_REPARSE_POINT
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn error(message: &'static str) -> RuntimeIntegrityError {
    RuntimeIntegrityError(message.to_owned())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
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
        RuntimeArch, RuntimeArtifacts, RuntimeLaunchPath, RuntimeOs, RuntimeTarget,
    };

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let id = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = std::env::temp_dir()
                .join(format!("schedule-integrity-{}-{id}", std::process::id()));
            fs::create_dir_all(&root).unwrap();
            Self(root)
        }

        fn write(&self, relative: &str, value: &str) {
            let path = self.0.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, value).unwrap();
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn component(
        name: RuntimeComponentName,
        version: &str,
        launch: RuntimeLaunchPath,
        sha256: String,
    ) -> RuntimeComponent {
        RuntimeComponent {
            name,
            version: version.into(),
            sha256,
            launch,
            license_path: "runtime-licenses.json".into(),
            sbom_path: "runtime-sbom.json".into(),
        }
    }

    fn fixture_manifest(root: &Path) -> RuntimeManifest {
        for (path, value) in [
            ("node/node.exe", "node"),
            ("api/dist/server.js", "api"),
            ("worker/dist/index.js", "worker"),
            ("postgresql/bin/postgres.exe", "postgres"),
            ("postgresql/bin/initdb.exe", "initdb"),
            ("postgresql/bin/psql.exe", "psql"),
            ("postgresql/bin/pg_isready.exe", "pg_isready"),
            ("postgresql/bin/pg_dump.exe", "pg_dump"),
            ("postgresql/bin/pg_restore.exe", "pg_restore"),
            ("postgresql/bin/pg_ctl.exe", "pg_ctl"),
            (
                "api/node_modules/@schedule/database/dist/migrate.js",
                "migrate",
            ),
            (MANIFEST_FILE, "manifest"),
            ("runtime-licenses.json", "licenses"),
            ("runtime-sbom.json", "sbom"),
        ] {
            fs::create_dir_all(root.join(path).parent().unwrap()).unwrap();
            fs::write(root.join(path), value).unwrap();
        }
        RuntimeManifest {
            schema_version: 1,
            target: RuntimeTarget {
                os: RuntimeOs::Windows,
                arch: RuntimeArch::X86_64,
            },
            postgresql_major: 17,
            components: vec![
                component(
                    RuntimeComponentName::Node,
                    "24.0.0",
                    RuntimeLaunchPath::Executable {
                        path: "node/node.exe".into(),
                    },
                    hash_tree(&root.join("node")).unwrap(),
                ),
                component(
                    RuntimeComponentName::Api,
                    "1.0.0",
                    RuntimeLaunchPath::Entrypoint {
                        path: "api/dist/server.js".into(),
                    },
                    hash_tree(&root.join("api")).unwrap(),
                ),
                component(
                    RuntimeComponentName::Worker,
                    "1.0.0",
                    RuntimeLaunchPath::Entrypoint {
                        path: "worker/dist/index.js".into(),
                    },
                    hash_tree(&root.join("worker")).unwrap(),
                ),
                component(
                    RuntimeComponentName::Postgresql,
                    "17.4",
                    RuntimeLaunchPath::Executable {
                        path: "postgresql/bin/postgres.exe".into(),
                    },
                    hash_tree(&root.join("postgresql")).unwrap(),
                ),
            ],
            artifacts: RuntimeArtifacts {
                licenses_sha256: format!("{:x}", Sha256::digest(b"licenses")),
                sbom_sha256: format!("{:x}", Sha256::digest(b"sbom")),
            },
        }
    }

    fn expectations() -> RuntimeManifestExpectations {
        RuntimeManifestExpectations {
            target: RuntimeTarget {
                os: RuntimeOs::Windows,
                arch: RuntimeArch::X86_64,
            },
            postgresql_major: 17,
        }
    }

    #[test]
    fn hashes_like_builder_and_verifies_complete_bundle() {
        let fixture = Fixture::new();
        let manifest = fixture_manifest(&fixture.0);
        fs::write(
            fixture.0.join(MANIFEST_FILE),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        let manifest_bytes = fs::read(fixture.0.join(MANIFEST_FILE)).unwrap();
        let trust_anchor = format!("{:x}", Sha256::digest(manifest_bytes));
        assert_eq!(
            hash_tree(&fixture.0.join("node")).unwrap(),
            manifest.components[0].sha256
        );
        assert_eq!(
            verify_runtime_bundle(&fixture.0, &manifest, &expectations()),
            Ok(())
        );
        let bundle =
            load_and_verify_runtime_bundle(&fixture.0, &expectations(), &trust_anchor).unwrap();
        assert_eq!(
            bundle.node,
            fixture.0.join("node/node.exe").canonicalize().unwrap()
        );
    }

    #[test]
    fn component_tree_hash_matches_the_typescript_golden_bundle() {
        let fixture = Fixture::new();
        fixture.write("a.txt", "alpha");
        fixture.write("nested/b.txt", "beta");
        assert_eq!(
            hash_tree(&fixture.0).unwrap(),
            "bddbe9c2eadc41a9f84c19d9c16b98ee2ad029b1f807000abee5d1635251565f"
        );
    }

    #[test]
    fn rejects_a_self_rewritten_manifest_without_the_embedded_anchor() {
        let fixture = Fixture::new();
        let mut manifest = fixture_manifest(&fixture.0);
        let original = serde_json::to_vec(&manifest).unwrap();
        let trust_anchor = format!("{:x}", Sha256::digest(&original));
        manifest.components[1].version = "1.0.1".into();
        fs::write(
            fixture.0.join(MANIFEST_FILE),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        assert!(
            load_and_verify_runtime_bundle(&fixture.0, &expectations(), &trust_anchor).is_err()
        );
    }

    #[test]
    fn runtime_errors_do_not_echo_caller_paths() {
        let root = PathBuf::from("runtime-root-with-sensitive-name");
        let error =
            load_and_verify_runtime_bundle(&root, &expectations(), &"0".repeat(64)).unwrap_err();
        assert!(!error.to_string().contains("sensitive-name"));
    }

    #[test]
    fn rejects_modified_component_or_missing_inventory() {
        let fixture = Fixture::new();
        let manifest = fixture_manifest(&fixture.0);
        fixture.write("api/dist/server.js", "modified");
        assert!(verify_runtime_bundle(&fixture.0, &manifest, &expectations()).is_err());

        let fixture = Fixture::new();
        let manifest = fixture_manifest(&fixture.0);
        fs::remove_file(fixture.0.join("runtime-sbom.json")).unwrap();
        assert!(verify_runtime_bundle(&fixture.0, &manifest, &expectations()).is_err());
    }

    #[test]
    fn rejects_escaping_launch_path_before_accessing_it() {
        let fixture = Fixture::new();
        let mut manifest = fixture_manifest(&fixture.0);
        manifest.components[0].launch = RuntimeLaunchPath::Executable {
            path: "../outside".into(),
        };
        assert!(verify_runtime_bundle(&fixture.0, &manifest, &expectations()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_in_component_tree() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let manifest = fixture_manifest(&fixture.0);
        symlink("node.exe", fixture.0.join("node/link")).unwrap();
        assert!(hash_tree(&fixture.0.join("node")).is_err());
        assert!(verify_runtime_bundle(&fixture.0, &manifest, &expectations()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_runtime_root_link_before_reading_the_manifest() {
        use std::os::unix::fs::symlink;

        let fixture = Fixture::new();
        let manifest = fixture_manifest(&fixture.0);
        fs::write(
            fixture.0.join(MANIFEST_FILE),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        let anchor = format!(
            "{:x}",
            Sha256::digest(fs::read(fixture.0.join(MANIFEST_FILE)).unwrap())
        );
        let link = fixture.0.with_extension("link");
        symlink(&fixture.0, &link).unwrap();
        assert!(load_and_verify_runtime_bundle(&link, &expectations(), &anchor).is_err());
        fs::remove_file(link).unwrap();
    }
}
