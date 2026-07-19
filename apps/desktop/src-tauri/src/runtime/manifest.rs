//! Validation for the signed-at-build-time description of bundled desktop runtime files.
//!
//! The supervisor owns locating and hashing the files. This module deliberately only accepts
//! paths relative to the immutable resource directory, so a manifest can never redirect it into
//! user data or another part of the host filesystem.

use std::{collections::HashSet, fmt};

use serde::{Deserialize, Serialize};

pub const RUNTIME_MANIFEST_SCHEMA_VERSION: u32 = 1;
pub const BUNDLED_POSTGRESQL_MAJOR: u16 = 17;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeOs {
    Linux,
    Windows,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeArch {
    Aarch64,
    X86_64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeTarget {
    pub os: RuntimeOs,
    pub arch: RuntimeArch,
}

impl RuntimeTarget {
    pub fn current() -> Self {
        Self {
            os: match () {
                _ if cfg!(target_os = "windows") => RuntimeOs::Windows,
                _ if cfg!(target_os = "linux") => RuntimeOs::Linux,
                _ => panic!("unsupported desktop runtime operating system"),
            },
            arch: match () {
                _ if cfg!(target_arch = "aarch64") => RuntimeArch::Aarch64,
                _ if cfg!(target_arch = "x86_64") => RuntimeArch::X86_64,
                _ => panic!("unsupported desktop runtime architecture"),
            },
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeComponentName {
    Node,
    Api,
    Worker,
    Postgresql,
}

impl RuntimeComponentName {
    const ALL: [Self; 4] = [Self::Node, Self::Api, Self::Worker, Self::Postgresql];

    fn label(&self) -> &'static str {
        match self {
            Self::Node => "node",
            Self::Api => "api",
            Self::Worker => "worker",
            Self::Postgresql => "postgresql",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RuntimeLaunchPath {
    Executable { path: String },
    Entrypoint { path: String },
}

impl RuntimeLaunchPath {
    fn path(&self) -> &str {
        match self {
            Self::Executable { path } | Self::Entrypoint { path } => path,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeComponent {
    pub name: RuntimeComponentName,
    /// A concrete release identifier, never a semver range or channel name.
    pub version: String,
    /// Canonical lowercase hexadecimal SHA-256 of the complete component tree.
    pub sha256: String,
    pub launch: RuntimeLaunchPath,
    pub license_path: String,
    pub sbom_path: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeManifest {
    pub schema_version: u32,
    pub target: RuntimeTarget,
    pub postgresql_major: u16,
    pub components: Vec<RuntimeComponent>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeManifestExpectations {
    pub target: RuntimeTarget,
    pub postgresql_major: u16,
}

impl Default for RuntimeManifestExpectations {
    fn default() -> Self {
        Self {
            target: RuntimeTarget::current(),
            postgresql_major: BUNDLED_POSTGRESQL_MAJOR,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeManifestError(String);

impl fmt::Display for RuntimeManifestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for RuntimeManifestError {}

impl RuntimeManifest {
    pub fn validate(
        &self,
        expectations: &RuntimeManifestExpectations,
    ) -> Result<(), RuntimeManifestError> {
        if self.schema_version != RUNTIME_MANIFEST_SCHEMA_VERSION {
            return Err(error("unsupported runtime manifest schema"));
        }
        if self.target != expectations.target {
            return Err(error(
                "runtime manifest target does not match this application",
            ));
        }
        if self.postgresql_major != expectations.postgresql_major {
            return Err(error(
                "runtime manifest PostgreSQL major does not match this application",
            ));
        }

        let mut names = HashSet::new();
        let mut launch_paths = HashSet::new();
        for component in &self.components {
            if !names.insert(component.name.label()) {
                return Err(error("runtime manifest has duplicate components"));
            }
            validate_exact_version(&component.version)?;
            validate_sha256(&component.sha256)?;
            validate_relative_path(component.launch.path())?;
            validate_relative_path(&component.license_path)?;
            validate_relative_path(&component.sbom_path)?;
            if !launch_paths.insert(component.launch.path()) {
                return Err(error("runtime manifest has duplicate launch paths"));
            }
            match component.name {
                RuntimeComponentName::Node | RuntimeComponentName::Postgresql
                    if !matches!(component.launch, RuntimeLaunchPath::Executable { .. }) =>
                {
                    return Err(error("runtime executable component has an entrypoint path"));
                }
                RuntimeComponentName::Api | RuntimeComponentName::Worker
                    if !matches!(component.launch, RuntimeLaunchPath::Entrypoint { .. }) =>
                {
                    return Err(error("runtime entrypoint component has an executable path"));
                }
                _ => {}
            }
            if matches!(component.name, RuntimeComponentName::Postgresql)
                && postgresql_version_major(&component.version) != Some(self.postgresql_major)
            {
                return Err(error(
                    "PostgreSQL component version does not match manifest major",
                ));
            }
        }

        if names.len() != RuntimeComponentName::ALL.len()
            || RuntimeComponentName::ALL
                .iter()
                .any(|component| !names.contains(component.label()))
        {
            return Err(error("runtime manifest is missing a required component"));
        }
        Ok(())
    }
}

fn error(message: &'static str) -> RuntimeManifestError {
    RuntimeManifestError(message.to_owned())
}

fn validate_exact_version(version: &str) -> Result<(), RuntimeManifestError> {
    if version.is_empty()
        || !version.as_bytes().first().is_some_and(u8::is_ascii_digit)
        || !version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'+' | b'-' | b'_'))
    {
        return Err(error(
            "runtime component version is not an exact release identifier",
        ));
    }
    Ok(())
}

fn postgresql_version_major(version: &str) -> Option<u16> {
    version
        .split_once('.')
        .unwrap_or((version, ""))
        .0
        .parse()
        .ok()
}

fn validate_sha256(digest: &str) -> Result<(), RuntimeManifestError> {
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(error("runtime component SHA-256 is malformed"));
    }
    Ok(())
}

fn validate_relative_path(path: &str) -> Result<(), RuntimeManifestError> {
    if !is_portable_relative_path(path) {
        return Err(error("runtime manifest path is not a safe relative path"));
    }
    Ok(())
}

pub(super) fn is_portable_relative_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && path.split('/').all(|component| {
            let bytes = component.as_bytes();
            let base = component.split('.').next().unwrap_or_default();
            let reserved = matches!(
                base.to_ascii_uppercase().as_str(),
                "CON"
                    | "PRN"
                    | "AUX"
                    | "NUL"
                    | "COM1"
                    | "COM2"
                    | "COM3"
                    | "COM4"
                    | "COM5"
                    | "COM6"
                    | "COM7"
                    | "COM8"
                    | "COM9"
                    | "LPT1"
                    | "LPT2"
                    | "LPT3"
                    | "LPT4"
                    | "LPT5"
                    | "LPT6"
                    | "LPT7"
                    | "LPT8"
                    | "LPT9"
            );
            !bytes.is_empty()
                && component != "."
                && component != ".."
                && !component.ends_with(['.', ' '])
                && !reserved
                && bytes
                    .iter()
                    .all(|byte| (0x20..=0x7e).contains(byte) && !b"<>:\"\\|?*".contains(byte))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hash(character: char) -> String {
        std::iter::repeat_n(character, 64).collect()
    }

    fn component(
        name: RuntimeComponentName,
        version: &str,
        launch: RuntimeLaunchPath,
    ) -> RuntimeComponent {
        RuntimeComponent {
            name,
            version: version.to_owned(),
            sha256: hash('a'),
            launch,
            license_path: "licenses/component.txt".to_owned(),
            sbom_path: "sbom/component.spdx.json".to_owned(),
        }
    }

    fn valid_manifest() -> RuntimeManifest {
        RuntimeManifest {
            schema_version: RUNTIME_MANIFEST_SCHEMA_VERSION,
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
                        path: "node/node.exe".to_owned(),
                    },
                ),
                component(
                    RuntimeComponentName::Api,
                    "1.2.3",
                    RuntimeLaunchPath::Entrypoint {
                        path: "api/dist/server.js".to_owned(),
                    },
                ),
                component(
                    RuntimeComponentName::Worker,
                    "1.2.3",
                    RuntimeLaunchPath::Entrypoint {
                        path: "worker/dist/index.js".to_owned(),
                    },
                ),
                component(
                    RuntimeComponentName::Postgresql,
                    "17.4",
                    RuntimeLaunchPath::Executable {
                        path: "postgresql/bin/postgres.exe".to_owned(),
                    },
                ),
            ],
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
    fn accepts_complete_manifest_for_expected_target() {
        assert_eq!(valid_manifest().validate(&expectations()), Ok(()));
    }

    #[test]
    fn rejects_schema_target_and_postgresql_major_mismatches() {
        let mut manifest = valid_manifest();
        manifest.schema_version += 1;
        assert!(manifest.validate(&expectations()).is_err());

        let mut manifest = valid_manifest();
        manifest.target.os = RuntimeOs::Linux;
        assert!(manifest.validate(&expectations()).is_err());

        let mut manifest = valid_manifest();
        manifest.postgresql_major = 16;
        assert!(manifest.validate(&expectations()).is_err());
    }

    #[test]
    fn rejects_missing_or_duplicate_components() {
        let mut manifest = valid_manifest();
        manifest.components.pop();
        assert!(manifest.validate(&expectations()).is_err());

        let mut manifest = valid_manifest();
        manifest.components.push(manifest.components[0].clone());
        assert!(manifest.validate(&expectations()).is_err());
    }

    #[test]
    fn rejects_unsafe_paths_and_malformed_digests() {
        for path in [
            "/outside",
            "../outside",
            "node\\node.exe",
            "C:/outside",
            "node//node",
        ] {
            let mut manifest = valid_manifest();
            manifest.components[0].launch = RuntimeLaunchPath::Executable {
                path: path.to_owned(),
            };
            assert!(manifest.validate(&expectations()).is_err(), "{path}");
        }

        let mut manifest = valid_manifest();
        manifest.components[0].sha256 = hash('A');
        assert!(manifest.validate(&expectations()).is_err());
    }

    #[test]
    fn rejects_wrong_launch_kind_and_postgresql_version() {
        let mut manifest = valid_manifest();
        manifest.components[0].launch = RuntimeLaunchPath::Entrypoint {
            path: "node/node.js".to_owned(),
        };
        assert!(manifest.validate(&expectations()).is_err());

        let mut manifest = valid_manifest();
        manifest.components[3].version = "16.9".to_owned();
        assert!(manifest.validate(&expectations()).is_err());
    }
}
