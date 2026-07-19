//! Shared, production-only construction of the native runtime.

use std::{path::PathBuf, sync::Arc};

use super::{
    credentials::PgNames,
    executor::{NativeExecutorConfig, SystemOperations},
    host::RuntimeHost,
    integrity::embedded_manifest_sha256,
    manifest::RuntimeManifestExpectations,
    paths::RuntimePaths,
    process::ProcessGroupControl,
};

pub(crate) const RUNTIME_VERSION: &str = "runtime-1";
const DATABASE_SCHEMA_VERSION: &str = "schema-1";
const STAGING_NONCE: &str = "desktop-launch";

pub(super) fn build_host(
    resource_root: PathBuf,
    data_root: PathBuf,
    bridge: Arc<crate::bridge::DesktopApiForwarder>,
) -> Result<(RuntimeHost, Arc<dyn ProcessGroupControl>), ()> {
    let manifest_sha256 = embedded_manifest_sha256().ok_or(())?;
    let paths = RuntimePaths::new(data_root, RUNTIME_VERSION, STAGING_NONCE).map_err(|_| ())?;
    let postgres_names = PgNames::new(
        "schedule",
        "schedule_admin",
        "schedule_owner",
        "schedule_runtime",
    )
    .map_err(|_| ())?;
    let (executor, containment) = SystemOperations::production(
        NativeExecutorConfig {
            paths,
            resource_root,
            runtime_version: RUNTIME_VERSION.into(),
            database_schema_version: DATABASE_SCHEMA_VERSION.into(),
            manifest_sha256: manifest_sha256.into(),
            manifest_expectations: RuntimeManifestExpectations::default(),
            postgres_names,
        },
        bridge,
    )
    .map_err(|_| ())?;
    Ok((RuntimeHost::spawn(executor), containment))
}
