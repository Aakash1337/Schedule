use std::{fmt, path::PathBuf};

/// All writable desktop runtime locations derived from the application's user-data root.
///
/// Installation resources are deliberately absent from this layout: bundled binaries are
/// read-only, while PostgreSQL state, logs, recovery material, and coordination files live
/// beneath `data_root`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RuntimePaths {
    pub(crate) data_root: PathBuf,
    pub(crate) runtime_root: PathBuf,
    pub(crate) runtime_versions_root: PathBuf,
    pub(crate) runtime_version: PathBuf,
    pub(crate) postgres_data: PathBuf,
    pub(crate) staging_root: PathBuf,
    pub(crate) staging: PathBuf,
    pub(crate) backups: PathBuf,
    pub(crate) logs: PathBuf,
    pub(crate) journal: PathBuf,
    pub(crate) singleton_lock: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RuntimePathError {
    component: &'static str,
}

impl fmt::Display for RuntimePathError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "invalid {} path component", self.component)
    }
}

impl std::error::Error for RuntimePathError {}

impl RuntimePaths {
    pub(crate) fn new(
        data_root: impl Into<PathBuf>,
        runtime_version: &str,
        staging_nonce: &str,
    ) -> Result<Self, RuntimePathError> {
        validate_component(runtime_version, "runtime version")?;
        validate_component(staging_nonce, "staging nonce")?;

        let data_root = data_root.into();
        let runtime_root = data_root.join("runtime");
        let runtime_versions_root = runtime_root.join("versions");

        Ok(Self {
            runtime_version: runtime_versions_root.join(runtime_version),
            postgres_data: data_root.join("postgresql").join("data"),
            staging: runtime_root.join("staging").join(staging_nonce),
            backups: data_root.join("backups"),
            logs: data_root.join("logs"),
            journal: runtime_root.join("journal.json"),
            singleton_lock: runtime_root.join("singleton.lock"),
            data_root,
            runtime_root: runtime_root.clone(),
            runtime_versions_root,
            staging_root: runtime_root.join("staging"),
        })
    }
}

fn validate_component(value: &str, component: &'static str) -> Result<(), RuntimePathError> {
    let is_safe = !value.is_empty()
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'));

    is_safe.then_some(()).ok_or(RuntimePathError { component })
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::RuntimePaths;

    #[test]
    fn derives_every_mutable_location_from_the_injected_data_root() {
        let root = PathBuf::from("user-data");
        let paths = RuntimePaths::new(&root, "postgres-17.4", "launch_123").unwrap();

        assert_eq!(paths.data_root, root);
        assert_eq!(paths.runtime_root, PathBuf::from("user-data/runtime"));
        assert_eq!(
            paths.runtime_versions_root,
            PathBuf::from("user-data/runtime/versions")
        );
        assert_eq!(
            paths.runtime_version,
            PathBuf::from("user-data/runtime/versions/postgres-17.4")
        );
        assert_eq!(
            paths.postgres_data,
            PathBuf::from("user-data/postgresql/data")
        );
        assert_eq!(
            paths.staging_root,
            PathBuf::from("user-data/runtime/staging")
        );
        assert_eq!(
            paths.staging,
            PathBuf::from("user-data/runtime/staging/launch_123")
        );
        assert_eq!(paths.backups, PathBuf::from("user-data/backups"));
        assert_eq!(paths.logs, PathBuf::from("user-data/logs"));
        assert_eq!(
            paths.journal,
            PathBuf::from("user-data/runtime/journal.json")
        );
        assert_eq!(
            paths.singleton_lock,
            PathBuf::from("user-data/runtime/singleton.lock")
        );
    }

    #[test]
    fn accepts_safe_version_and_nonce_components() {
        assert!(RuntimePaths::new("data", "v17.4-linux_x64", "abc-123_DEF.9").is_ok());
    }

    #[test]
    fn rejects_path_traversal_separators_and_control_characters() {
        for unsafe_component in [
            "",
            ".",
            "..",
            "../escape",
            "child/escape",
            r"child\\escape",
            "line\nbreak",
            "nul\0byte",
            "space value",
        ] {
            assert!(RuntimePaths::new("data", unsafe_component, "safe").is_err());
            assert!(RuntimePaths::new("data", "safe", unsafe_component).is_err());
        }
    }
}
