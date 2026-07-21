//! Production adapter for the desktop lifecycle effects.
//!
//! This module is intentionally independent of the Tauri application/host
//! wiring. It owns the verified runtime, credentials, children, and bridge
//! publication for one serialized coordinator.

use std::{
    fmt, fs,
    io::{self, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{
    bundle::RuntimeBundle,
    command::{CommandError, CommandOutput, CommandSpec, run_command_cancellable},
    coordinator::{Cancellation, EffectExecutor, EffectOutcome},
    credentials::{
        DesktopBearer, PgCredentialStore, PgNames, PgRolePasswords, PrivateRuntimeFiles,
        prepare_private_child, prepare_private_root, scavenge_stale_launch_secrets,
    },
    integrity::load_and_verify_runtime_bundle,
    journal::{self, JournalPhase, LifecycleJournal, RecoveryDecision},
    lock::RuntimeLock,
    manifest::RuntimeManifestExpectations,
    paths::RuntimePaths,
    portable::{PortableExportResult, parse_portable_output, validate_destination},
    postgres::{
        PgCommand, PgConnection, backup_plan, bootstrap_plan, fast_stop_plan, identity_plan,
        initdb_plan, parse_identity, pg_hba_conf, postgresql_conf, readiness_plan,
        restore_verify_plan, start_plan, validate_pg_version,
    },
    process::{
        OwnedProcess, ProcessGroupControl, ProcessRole, ProcessSpec, ReadinessSpec,
        platform_process_control, start_process_cancellable,
    },
    state::{Effect, Incompatibility},
};

const API_READY_PREFIX: &[u8] = b"SCHEDULE_DESKTOP_API_READY_V1 ";
const WORKER_READY_PREFIX: &[u8] = b"SCHEDULE_DESKTOP_WORKER_READY_V1 ";
const PROCESS_START_TIMEOUT: Duration = Duration::from_secs(45);
const DATABASE_READY_TIMEOUT: Duration = Duration::from_secs(45);
const DATABASE_READY_RETRY: Duration = Duration::from_millis(100);
const DATABASE_PROMOTION_RETRY_TIMEOUT: Duration = Duration::from_secs(3);
const DATABASE_PROMOTION_RETRY_INTERVAL: Duration = Duration::from_millis(50);
const DATABASE_COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
const PORTABLE_EXPORT_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const DATABASE_BACKUP_TIMEOUT: Duration = Duration::from_secs(300);
const MIGRATION_TIMEOUT: Duration = Duration::from_secs(300);
const GRACEFUL_PROCESS_STOP: Duration = Duration::from_secs(15);
const MAX_IDENTITY_BYTES: usize = 16 * 1024;
const MAX_READY_PAYLOAD_BYTES: usize = 32;
const BOOTSTRAP_MARKER: &str = "SCHEDULE_BOOTSTRAPPED_V1";
const BOOTSTRAP_MARKER_CONTENTS: &[u8] = b"schedule-bootstrap-v1\n";
const INITDB_MARKER: &str = "SCHEDULE_INITDB_COMPLETE_V1";
const INITDB_MARKER_CONTENTS: &[u8] = b"schedule-initdb-v1\n";
const INITIALIZING_DIRECTORY: &str = ".schedule-initializing-v1";
const MAX_MIGRATION_MANIFEST_BYTES: u64 = 1024 * 1024;
const MIGRATION_STATUS_PREFIX: &str = "SCHEDULE_MIGRATION_STATUS_V1 ";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct NativeExecutorError {
    code: &'static str,
}

impl NativeExecutorError {
    const fn new(code: &'static str) -> Self {
        Self { code }
    }

    pub(crate) const fn code(self) -> &'static str {
        self.code
    }
}

impl fmt::Display for NativeExecutorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl std::error::Error for NativeExecutorError {}

pub(crate) trait ApiBridgeControl: Send + Sync + 'static {
    fn configure(&self, port: u16, credential: String) -> Result<(), NativeExecutorError>;
    fn clear(&self) -> Result<(), NativeExecutorError>;
}

impl ApiBridgeControl for crate::bridge::DesktopApiForwarder {
    fn configure(&self, port: u16, credential: String) -> Result<(), NativeExecutorError> {
        crate::bridge::DesktopApiForwarder::configure(self, port, credential)
            .map_err(|_| NativeExecutorError::new("desktop.bridge_configure_failed"))
    }

    fn clear(&self) -> Result<(), NativeExecutorError> {
        crate::bridge::DesktopApiForwarder::clear(self)
            .map_err(|_| NativeExecutorError::new("desktop.bridge_clear_failed"))
    }
}

pub(crate) struct NativeExecutorConfig {
    pub(crate) paths: RuntimePaths,
    pub(crate) resource_root: PathBuf,
    pub(crate) runtime_version: String,
    pub(crate) manifest_sha256: String,
    pub(crate) manifest_expectations: RuntimeManifestExpectations,
    pub(crate) postgres_names: PgNames,
}

impl NativeExecutorConfig {
    pub(crate) fn validate(&self) -> Result<(), NativeExecutorError> {
        let data = &self.paths.data_root;
        let runtime = data.join("runtime");
        let private = data.join("private");
        let paths_match = self.paths.runtime_root == runtime
            && self.paths.runtime_versions_root == runtime.join("versions")
            && self.paths.runtime_version == runtime.join("versions").join(&self.runtime_version)
            && self.paths.postgres_data == data.join("postgresql").join("data")
            && self.paths.staging_root == runtime.join("staging")
            && self.paths.staging.parent() == Some(self.paths.staging_root.as_path())
            && self.paths.backups == data.join("backups")
            && self.paths.logs == data.join("logs")
            && self.paths.private_root == private
            && self.paths.credentials_store == private.join("postgresql-credentials.v1.json")
            && self.paths.temporary_secrets_root == private.join("temp")
            && self.paths.journal == runtime.join("journal.json")
            && self.paths.singleton_lock == runtime.join("singleton.lock");
        if !self.paths.data_root.is_absolute()
            || !self.resource_root.is_absolute()
            || !paths_match
            || !safe_version(&self.runtime_version)
            || self.manifest_sha256.len() != 64
            || !self
                .manifest_sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(NativeExecutorError::new("desktop.executor_config_invalid"));
        }
        Ok(())
    }
}

fn safe_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'+' | b':')
        })
}

/// Small injectable boundary used by deterministic lifecycle tests. Production
/// uses [`SystemOperations`], which owns every native resource.
pub(crate) trait NativeOperations {
    fn execute(
        &mut self,
        effect: Effect,
        cancellation: &Cancellation,
    ) -> Result<EffectOutcome, NativeExecutorError>;
    fn configure_bridge(&mut self, generation: u64) -> Result<(), NativeExecutorError>;
    fn clear_bridge(&mut self, generation: u64) -> Result<(), NativeExecutorError>;
    fn cancel(&mut self, generation: u64);
    fn portable_export(&mut self, _: PathBuf, _: &Cancellation) -> PortableExportResult {
        PortableExportResult::Unavailable
    }
}

pub(crate) struct NativeEffectExecutor<O> {
    operations: O,
}

impl<O> NativeEffectExecutor<O> {
    pub(crate) fn new(operations: O) -> Self {
        Self { operations }
    }

    #[cfg(test)]
    fn operations(&self) -> &O {
        &self.operations
    }
}

impl<O: NativeOperations> EffectExecutor for NativeEffectExecutor<O> {
    type Error = NativeExecutorError;

    fn execute(
        &mut self,
        effect: Effect,
        cancellation: &Cancellation,
    ) -> Result<EffectOutcome, Self::Error> {
        self.operations.execute(effect, cancellation)
    }

    fn configure_bridge(&mut self, generation: u64) -> Result<(), Self::Error> {
        self.operations.configure_bridge(generation)
    }

    fn clear_bridge(&mut self, generation: u64) -> Result<(), Self::Error> {
        self.operations.clear_bridge(generation)
    }

    fn cancel(&mut self, generation: u64) {
        self.operations.cancel(generation);
    }

    fn portable_export(
        &mut self,
        destination: PathBuf,
        cancellation: &Cancellation,
    ) -> PortableExportResult {
        self.operations.portable_export(destination, cancellation)
    }
}

struct LaunchSecrets {
    files: PrivateRuntimeFiles,
    initial_password: PathBuf,
    admin_pgpass: PathBuf,
    owner_pgpass: PathBuf,
    bootstrap_sql: PathBuf,
}

struct ApiTarget {
    port: u16,
    bearer: DesktopBearer,
}

pub(crate) struct SystemOperations<B: ApiBridgeControl> {
    config: NativeExecutorConfig,
    bridge: Arc<B>,
    process_control: Arc<dyn ProcessGroupControl>,
    runtime_lock: Option<RuntimeLock>,
    bundle: Option<RuntimeBundle>,
    credential_store: Option<PgCredentialStore>,
    passwords: Option<PgRolePasswords>,
    launch_secrets: Option<LaunchSecrets>,
    journal: Option<LifecycleJournal>,
    interrupted_migration: bool,
    had_prior_success: bool,
    database_port: Option<u16>,
    database_data: Option<PathBuf>,
    database: Option<OwnedProcess>,
    api: Option<OwnedProcess>,
    worker: Option<OwnedProcess>,
    api_target: Option<ApiTarget>,
}

impl<B: ApiBridgeControl> SystemOperations<B> {
    pub(crate) fn production(
        config: NativeExecutorConfig,
        bridge: Arc<B>,
    ) -> Result<(NativeEffectExecutor<Self>, Arc<dyn ProcessGroupControl>), NativeExecutorError>
    {
        config.validate()?;
        let process_control = platform_process_control();
        let operations = NativeEffectExecutor::new(Self {
            config,
            bridge,
            process_control: Arc::clone(&process_control),
            runtime_lock: None,
            bundle: None,
            credential_store: None,
            passwords: None,
            launch_secrets: None,
            journal: None,
            interrupted_migration: false,
            had_prior_success: false,
            database_port: None,
            database_data: None,
            database: None,
            api: None,
            worker: None,
            api_target: None,
        });
        Ok((operations, process_control))
    }

    fn cancelled(cancellation: &Cancellation) -> Result<(), NativeExecutorError> {
        (!cancellation.is_cancelled())
            .then_some(())
            .ok_or_else(|| NativeExecutorError::new("desktop.operation_cancelled"))
    }

    fn run_portable_export(
        &mut self,
        destination: PathBuf,
        cancellation: &Cancellation,
    ) -> PortableExportResult {
        let destination = match validate_destination(&destination) {
            Ok(value) => value,
            Err(code) => return PortableExportResult::Failed { code },
        };
        let result = (|| {
            Self::cancelled(cancellation)?;
            let bundle = self.require_bundle()?;
            let passwords = self.require_passwords()?;
            let port = self.database_port()?;
            let owner = passwords
                .owner_database_url(&self.config.postgres_names, port)
                .map_err(credential_error)?;
            let admin = passwords
                .cluster_admin_database_url(&self.config.postgres_names, port)
                .map_err(credential_error)?;
            let spec = CommandSpec::new(&bundle.node, &bundle.root, PORTABLE_EXPORT_TIMEOUT)
                .arg(&bundle.portable_export)
                .arg("export")
                .arg(destination.into_os_string())
                .env("NODE_ENV", "production")
                .env("DATABASE_URL", owner.expose())
                .env("SCHEDULE_ADMIN_DATABASE_URL", admin.expose())
                .env("SCHEDULE_NODE_EXECUTABLE", bundle.node.as_os_str())
                .env(
                    "SCHEDULE_MIGRATION_ENTRYPOINT",
                    bundle.migration.as_os_str(),
                )
                .env("SCHEDULE_APPLICATION_VERSION", &self.config.runtime_version)
                .output_bounds(512, 16 * 1024)
                .database_payload();
            let output = run_command_cancellable(spec, Arc::clone(&self.process_control), &|| {
                cancellation.is_cancelled()
            })
            .map_err(command_error)?;
            parse_portable_output(output.stdout()).map_err(NativeExecutorError::new)
        })();
        match result {
            Ok(size_bytes) => PortableExportResult::Created { size_bytes },
            Err(error)
                if matches!(
                    error.code(),
                    "desktop.operation_cancelled" | "desktop.command_cancelled"
                ) =>
            {
                PortableExportResult::Unavailable
            }
            Err(error) => PortableExportResult::Failed { code: error.code() },
        }
    }

    fn acquire_lock(&mut self) -> Result<EffectOutcome, NativeExecutorError> {
        prepare_private_root(&self.config.paths.data_root).map_err(credential_error)?;
        for child in [
            &self.config.paths.runtime_root,
            &self.config.paths.backups,
            &self.config.paths.logs,
        ] {
            prepare_private_child(child, &self.config.paths.data_root).map_err(credential_error)?;
        }
        let postgres_root = self.config.paths.data_root.join("postgresql");
        prepare_private_child(&postgres_root, &self.config.paths.data_root)
            .map_err(credential_error)?;
        self.runtime_lock = Some(
            RuntimeLock::acquire(&self.config.paths.singleton_lock)
                .map_err(|error| NativeExecutorError::new(error.code()))?,
        );
        Ok(EffectOutcome::Completed)
    }

    fn validate_runtime(&mut self, generation: u64) -> Result<EffectOutcome, NativeExecutorError> {
        self.require_lock()?;
        let bundle = load_and_verify_runtime_bundle(
            &self.config.resource_root,
            &self.config.manifest_expectations,
            &self.config.manifest_sha256,
        )
        .map_err(|_| NativeExecutorError::new("desktop.runtime_integrity_failed"))?;
        let store = PgCredentialStore::prepare(&self.config.paths).map_err(credential_error)?;
        scavenge_stale_launch_secrets(&self.config.paths.temporary_secrets_root)
            .map_err(credential_error)?;

        let migration_target = migration_manifest_digest(&bundle.migration_manifest)?;
        let selected = load_or_create_startup_journal(
            &self.config.paths.journal,
            generation,
            unix_seconds()?,
            &self.config.runtime_version,
            &migration_target,
        )?;
        self.interrupted_migration = selected.interrupted_migration;
        self.had_prior_success = selected.had_prior_success;
        let next = selected.journal;
        self.bundle = Some(bundle);
        self.credential_store = Some(store);
        self.journal = Some(next);
        Ok(EffectOutcome::Completed)
    }

    fn start_database(
        &mut self,
        cancellation: &Cancellation,
    ) -> Result<EffectOutcome, NativeExecutorError> {
        self.require_bundle()?;
        self.set_journal_phase(JournalPhase::StartingDatabase)?;
        Self::cancelled(cancellation)?;

        let final_data = self.config.paths.postgres_data.clone();
        let final_cluster = inspect_cluster(&final_data)?;
        if final_cluster == ClusterState::IncompatibleMajor {
            return Ok(EffectOutcome::Incompatible(
                Incompatibility::DatabaseMajorVersion,
            ));
        }
        if final_cluster == ClusterState::IncompatibleFormat {
            return Ok(EffectOutcome::Incompatible(Incompatibility::DatabaseFormat));
        }
        if missing_database_requires_recovery(
            final_cluster,
            self.had_prior_success,
            self.interrupted_migration,
        ) {
            // Never replace a database that a durable journal says previously
            // existed. Missing data requires an explicit restore/recovery flow.
            return Ok(EffectOutcome::Incompatible(Incompatibility::DatabaseFormat));
        }
        let (cluster, staged) = if final_cluster == ClusterState::New {
            let initializing = final_data
                .parent()
                .ok_or_else(|| NativeExecutorError::new("desktop.executor_state_invalid"))?
                .join(INITIALIZING_DIRECTORY);
            let mut state = inspect_cluster(&initializing)?;
            if state == ClusterState::IncompatibleMajor {
                return Ok(EffectOutcome::Incompatible(
                    Incompatibility::DatabaseMajorVersion,
                ));
            }
            if state == ClusterState::Existing
                && !validate_marker(
                    &initializing.join(INITDB_MARKER),
                    INITDB_MARKER_CONTENTS,
                    "desktop.initdb_marker_invalid",
                )?
            {
                reset_incomplete_cluster(&initializing)?;
                state = ClusterState::New;
            }
            if matches!(state, ClusterState::New | ClusterState::IncompatibleFormat)
                && initializing.exists()
            {
                reset_incomplete_cluster(&initializing)?;
                state = ClusterState::New;
            }
            self.database_data = Some(initializing);
            (state, true)
        } else {
            self.database_data = Some(final_data.clone());
            (final_cluster, false)
        };

        let passwords = self
            .credential_store
            .as_ref()
            .ok_or_else(|| NativeExecutorError::new("desktop.executor_state_invalid"))?
            .load(&self.config.postgres_names)
            .map_err(credential_error)?;
        let passwords = match passwords {
            Some(passwords) => passwords,
            None if cluster == ClusterState::Existing => {
                return Ok(EffectOutcome::Incompatible(Incompatibility::DatabaseFormat));
            }
            None => {
                let passwords = PgRolePasswords::generate_for_cluster_initialization()
                    .map_err(credential_error)?;
                self.credential_store
                    .as_ref()
                    .expect("credential store prepared")
                    .create_new(&self.config.postgres_names, &passwords)
                    .map_err(credential_error)?;
                passwords
            }
        };
        let port = allocate_loopback_port()?;
        let mut files = PrivateRuntimeFiles::create(&self.config.paths.temporary_secrets_root)
            .map_err(credential_error)?;
        let launch = LaunchSecrets {
            initial_password: files
                .write_initial_password(&passwords)
                .map_err(credential_error)?,
            admin_pgpass: files
                .write_admin_pgpass(port, &self.config.postgres_names, &passwords)
                .map_err(credential_error)?,
            owner_pgpass: files
                .write_owner_pgpass(port, &self.config.postgres_names, &passwords)
                .map_err(credential_error)?,
            bootstrap_sql: files
                .write_bootstrap_sql(&self.config.postgres_names, &passwords)
                .map_err(credential_error)?,
            files,
        };
        self.passwords = Some(passwords);
        self.launch_secrets = Some(launch);
        self.database_port = Some(port);

        if cluster == ClusterState::New {
            Self::cancelled(cancellation)?;
            self.initialize_cluster(cancellation)?;
        }
        self.write_postgres_configuration(port)?;
        Self::cancelled(cancellation)?;
        self.start_database_child(cancellation)?;
        self.await_database(cancellation)?;
        let marker = bootstrap_marker(self.database_data()?);
        let marker_present = validate_bootstrap_marker(&marker)?;
        if !marker_present && !staged && self.had_prior_success {
            return Ok(EffectOutcome::Incompatible(Incompatibility::DatabaseFormat));
        }
        if !marker_present {
            self.bootstrap_database(cancellation)?;
            publish_bootstrap_marker(&marker)?;
        }
        if staged {
            self.stop_database()?;
            if final_data.exists() {
                return Ok(EffectOutcome::Incompatible(Incompatibility::DatabaseFormat));
            }
            promote_database_directory(self.database_data()?, &final_data, cancellation)?;
            sync_directory(
                final_data
                    .parent()
                    .ok_or_else(|| NativeExecutorError::new("desktop.database_promote_failed"))?,
            )?;
            self.database_data = Some(final_data);
            Self::cancelled(cancellation)?;
            self.start_database_child(cancellation)?;
            self.await_database(cancellation)?;
        }
        Ok(EffectOutcome::Completed)
    }

    fn initialize_cluster(&self, cancellation: &Cancellation) -> Result<(), NativeExecutorError> {
        let bundle = self.require_bundle()?;
        let secrets = self.require_launch_secrets()?;
        let admin = PgConnection::new(
            self.database_port()?,
            "postgres",
            self.config.postgres_names.cluster_admin(),
            &secrets.admin_pgpass,
        )
        .map_err(pg_error)?;
        let plan = initdb_plan(
            postgres_bin(bundle)?,
            self.database_data()?,
            &admin,
            &secrets.initial_password,
        );
        self.run_pg(
            plan,
            &bundle.postgresql.initdb,
            DATABASE_COMMAND_TIMEOUT,
            4096,
            Some(cancellation),
        )?;
        publish_marker(
            &self.database_data()?.join(INITDB_MARKER),
            INITDB_MARKER_CONTENTS,
            "desktop.initdb_marker_invalid",
        )?;
        Ok(())
    }

    fn write_postgres_configuration(&self, port: u16) -> Result<(), NativeExecutorError> {
        let config = postgresql_conf(port, &self.config.paths.logs).map_err(pg_error)?;
        let hba = pg_hba_conf(
            self.config.postgres_names.cluster_admin(),
            self.config.postgres_names.owner(),
            self.config.postgres_names.runtime(),
            self.config.postgres_names.database(),
        )
        .map_err(pg_error)?;
        replace_regular_file(
            &self.database_data()?.join("postgresql.conf"),
            config.as_bytes(),
        )?;
        replace_regular_file(&self.database_data()?.join("pg_hba.conf"), hba.as_bytes())
    }

    fn start_database_child(
        &mut self,
        cancellation: &Cancellation,
    ) -> Result<(), NativeExecutorError> {
        if self.database.is_some() {
            return Err(NativeExecutorError::new("desktop.executor_state_invalid"));
        }
        let bundle = self.require_bundle()?;
        let connection = self.admin_connection(self.config.postgres_names.database())?;
        let plan = start_plan(postgres_bin(bundle)?, self.database_data()?, &connection);
        ensure_program(&plan, &bundle.postgresql.postgres)?;
        let mut spec = ProcessSpec::new(
            ProcessRole::Database,
            plan.program,
            &bundle.root,
            PROCESS_START_TIMEOUT,
        );
        for argument in plan.arguments {
            spec = spec.arg(argument);
        }
        for (key, value) in plan.environment {
            spec = spec.env(key, value);
        }
        spec = spec.classify_postgres_startup_stderr();
        let started =
            match start_process_cancellable(spec, Arc::clone(&self.process_control), &|| {
                cancellation.is_cancelled()
            }) {
                Ok(started) => started,
                Err(error) => {
                    if error.code() != "desktop.process_cancelled" {
                        eprintln!("SCHEDULE_DESKTOP_DATABASE_STARTUP=guardian_admission_failed");
                    }
                    return Err(process_error(error));
                }
            };
        self.database = Some(started.process);
        Ok(())
    }

    fn await_database(&mut self, cancellation: &Cancellation) -> Result<(), NativeExecutorError> {
        let postgres_bin = postgres_bin(self.require_bundle()?)?.to_owned();
        let pg_isready = self.require_bundle()?.postgresql.pg_isready.clone();
        let connection = self.admin_connection("postgres")?;
        let deadline = std::time::Instant::now() + DATABASE_READY_TIMEOUT;
        loop {
            Self::cancelled(cancellation)?;
            let (exited, exit_code, stderr_class) = {
                let database = self
                    .database
                    .as_mut()
                    .ok_or_else(|| NativeExecutorError::new("desktop.executor_state_invalid"))?;
                let exited = database.has_exited().map_err(process_error)?;
                let stderr_class = exited
                    .then(|| database.postgres_startup_stderr_class())
                    .flatten();
                (exited, database.exit_code_u32(), stderr_class)
            };
            if exited {
                match (exit_code, stderr_class) {
                    (Some(1), Some(class)) => eprintln!(
                        "SCHEDULE_DESKTOP_DATABASE_STARTUP=post_admission_exit:1:{}",
                        class
                    ),
                    (Some(code), _) => {
                        eprintln!("SCHEDULE_DESKTOP_DATABASE_STARTUP=post_admission_exit:{code}")
                    }
                    (None, _) => {
                        eprintln!("SCHEDULE_DESKTOP_DATABASE_STARTUP=post_admission_exit:unknown")
                    }
                }
                self.database.take();
                return Err(NativeExecutorError::new("desktop.database_exited_early"));
            }
            let plan = readiness_plan(&postgres_bin, &connection);
            if self
                .run_pg(
                    plan,
                    &pg_isready,
                    Duration::from_secs(6),
                    4096,
                    Some(cancellation),
                )
                .is_ok()
            {
                return Ok(());
            }
            if std::time::Instant::now() >= deadline {
                return Err(NativeExecutorError::new(
                    "desktop.database_readiness_timeout",
                ));
            }
            std::thread::sleep(DATABASE_READY_RETRY);
        }
    }

    fn bootstrap_database(&self, cancellation: &Cancellation) -> Result<(), NativeExecutorError> {
        let bundle = self.require_bundle()?;
        let secrets = self.require_launch_secrets()?;
        let connection = self.admin_connection("postgres")?;
        let plan = bootstrap_plan(postgres_bin(bundle)?, &connection, &secrets.bootstrap_sql);
        self.run_pg(
            plan,
            &bundle.postgresql.psql,
            DATABASE_COMMAND_TIMEOUT,
            16 * 1024,
            Some(cancellation),
        )?;
        Ok(())
    }

    fn verify_database(
        &mut self,
        cancellation: &Cancellation,
    ) -> Result<EffectOutcome, NativeExecutorError> {
        self.set_journal_phase(JournalPhase::VerifyingDatabase)?;
        let bundle = self.require_bundle()?;
        let connection = self.admin_connection(self.config.postgres_names.database())?;
        let plan = identity_plan(postgres_bin(bundle)?, &connection);
        let output = self.run_pg(
            plan,
            &bundle.postgresql.psql,
            DATABASE_COMMAND_TIMEOUT,
            MAX_IDENTITY_BYTES,
            Some(cancellation),
        )?;
        let stdout = std::str::from_utf8(output.stdout())
            .map_err(|_| NativeExecutorError::new("desktop.database_identity_invalid"))?;
        parse_identity(stdout, self.database_data()?, &connection)
            .map_err(|_| NativeExecutorError::new("desktop.database_identity_invalid"))?;

        if self.interrupted_migration {
            return Ok(EffectOutcome::Incompatible(Incompatibility::Migration));
        }

        match self.migration_status(cancellation)? {
            MigrationLedgerStatus::Exact => Ok(EffectOutcome::DatabaseVerified {
                needs_migration: false,
            }),
            MigrationLedgerStatus::Prefix => Ok(EffectOutcome::DatabaseVerified {
                needs_migration: true,
            }),
            MigrationLedgerStatus::Ahead | MigrationLedgerStatus::Divergent => {
                Ok(EffectOutcome::Incompatible(Incompatibility::Migration))
            }
        }
    }

    fn backup_database(
        &mut self,
        generation: u64,
        cancellation: &Cancellation,
    ) -> Result<EffectOutcome, NativeExecutorError> {
        self.set_journal_phase(JournalPhase::BackingUpDatabase)?;
        let bundle = self.require_bundle()?;
        let connection = self.owner_connection()?;
        let nonce = random_suffix()?;
        let pending = self
            .config
            .paths
            .backups
            .join(format!(".attempt-{generation}-{nonce}.pending"));
        let published = self
            .config
            .paths
            .backups
            .join(format!("attempt-{generation}-{nonce}.dump"));
        let mut cleanup = PendingFile(Some(pending.clone()));
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&pending)
            .map_err(|_| NativeExecutorError::new("desktop.backup_destination_exists"))?;
        let plan = backup_plan(postgres_bin(bundle)?, &pending, &connection);
        self.run_pg(
            plan,
            &bundle.postgresql.pg_dump,
            DATABASE_BACKUP_TIMEOUT,
            64 * 1024,
            Some(cancellation),
        )?;
        let metadata = fs::symlink_metadata(&pending)
            .map_err(|_| NativeExecutorError::new("desktop.backup_invalid"))?;
        if super::integrity::is_link_or_reparse(&metadata)
            || !metadata.is_file()
            || metadata.len() == 0
        {
            return Err(NativeExecutorError::new("desktop.backup_invalid"));
        }
        sync_backup_file(&pending, metadata.len())?;
        let verify = restore_verify_plan(postgres_bin(bundle)?, &pending);
        let catalog = self.run_pg(
            verify,
            &bundle.postgresql.pg_restore,
            DATABASE_BACKUP_TIMEOUT,
            1024 * 1024,
            Some(cancellation),
        )?;
        if catalog.stdout().is_empty() {
            return Err(NativeExecutorError::new("desktop.backup_invalid"));
        }
        publish_backup(&pending, &published)?;
        cleanup.0 = None;
        Ok(EffectOutcome::Completed)
    }

    fn migrate_database(
        &mut self,
        cancellation: &Cancellation,
    ) -> Result<EffectOutcome, NativeExecutorError> {
        self.set_journal_phase(JournalPhase::MigratingDatabase)?;
        let bundle = self.require_bundle()?;
        let password = self.require_passwords()?;
        let url = password
            .owner_database_url(&self.config.postgres_names, self.database_port()?)
            .map_err(credential_error)?;
        let spec = CommandSpec::new(&bundle.node, &bundle.root, MIGRATION_TIMEOUT)
            .arg(&bundle.migration)
            .env("NODE_ENV", "production")
            .env("DOTENV_CONFIG_QUIET", "true")
            .env("DATABASE_URL", url.expose())
            .output_bounds(64 * 1024, 64 * 1024);
        let outcome =
            match run_command_cancellable(spec, Arc::clone(&self.process_control), &|| {
                cancellation.is_cancelled()
            }) {
                Ok(_) => Ok(EffectOutcome::Completed),
                Err(error) if error.code() == "desktop.command_exit_failed" => {
                    Ok(EffectOutcome::Incompatible(Incompatibility::Migration))
                }
                Err(error) => Err(command_error(error)),
            }?;
        let outcome = if outcome == EffectOutcome::Completed
            && self.migration_status(cancellation)? != MigrationLedgerStatus::Exact
        {
            EffectOutcome::Incompatible(Incompatibility::Migration)
        } else {
            outcome
        };
        if outcome == EffectOutcome::Completed {
            self.cleanup_launch_secrets()?;
        }
        Ok(outcome)
    }

    fn migration_status(
        &self,
        cancellation: &Cancellation,
    ) -> Result<MigrationLedgerStatus, NativeExecutorError> {
        let bundle = self.require_bundle()?;
        let password = self.require_passwords()?;
        let url = password
            .owner_database_url(&self.config.postgres_names, self.database_port()?)
            .map_err(credential_error)?;
        let spec = CommandSpec::new(&bundle.node, &bundle.root, DATABASE_COMMAND_TIMEOUT)
            .arg(&bundle.migration)
            .arg("--status")
            .env("NODE_ENV", "production")
            .env("DOTENV_CONFIG_QUIET", "true")
            .env("DATABASE_URL", url.expose())
            .output_bounds(256, 256);
        let output = run_command_cancellable(spec, Arc::clone(&self.process_control), &|| {
            cancellation.is_cancelled()
        })
        .map_err(command_error)?;
        parse_migration_status(output.stdout())
    }

    fn start_api(
        &mut self,
        cancellation: &Cancellation,
    ) -> Result<EffectOutcome, NativeExecutorError> {
        self.set_journal_phase(JournalPhase::StartingApi)?;
        self.cleanup_launch_secrets()?;
        if self.api.is_some() || self.api_target.is_some() {
            return Err(NativeExecutorError::new("desktop.executor_state_invalid"));
        }
        let bundle = self.require_bundle()?;
        let password = self.require_passwords()?;
        let url = password
            .runtime_database_url(&self.config.postgres_names, self.database_port()?)
            .map_err(credential_error)?;
        let bearer = DesktopBearer::generate().map_err(credential_error)?;
        let spec = ProcessSpec::new(
            ProcessRole::Api,
            &bundle.node,
            &bundle.root,
            PROCESS_START_TIMEOUT,
        )
        .arg(&bundle.api)
        .env("NODE_ENV", "production")
        .env("LOG_LEVEL", "warn")
        .env("DATABASE_URL", url.expose())
        .env("API_HOST", "127.0.0.1")
        .env("API_PORT", "0")
        .env("API_TRUSTED_PROXIES", "")
        .env("PRODUCT_API_MODE", "desktop_authenticated")
        .env("DESKTOP_API_TOKEN", bearer.expose())
        .env("HOSTED_API_MODE", "disabled")
        .env("HOSTED_OIDC_PREFLIGHT_MODE", "disabled")
        .env("INTEGRATION_API_MODE", "disabled")
        .env("LOCAL_MODEL_ADVISOR_MODE", "disabled")
        .env("LOCAL_MODEL_PROPOSAL_MODE", "disabled")
        .readiness(ReadinessSpec::stdout_prefix(
            API_READY_PREFIX,
            128,
            MAX_READY_PAYLOAD_BYTES,
        ))
        .desktop_shutdown_stdin();
        let started = start_process_cancellable(spec, Arc::clone(&self.process_control), &|| {
            cancellation.is_cancelled()
        })
        .map_err(process_error)?;
        let port = parse_ready_port(
            started
                .readiness
                .as_ref()
                .ok_or_else(|| NativeExecutorError::new("desktop.api_readiness_invalid"))?
                .as_bytes(),
            "desktop.api_readiness_invalid",
        )?;
        self.api = Some(started.process);
        self.api_target = Some(ApiTarget { port, bearer });
        Ok(EffectOutcome::Completed)
    }

    fn start_worker(
        &mut self,
        cancellation: &Cancellation,
    ) -> Result<EffectOutcome, NativeExecutorError> {
        self.set_journal_phase(JournalPhase::StartingWorker)?;
        if self.worker.is_some() {
            return Err(NativeExecutorError::new("desktop.executor_state_invalid"));
        }
        let bundle = self.require_bundle()?;
        let password = self.require_passwords()?;
        let url = password
            .runtime_database_url(&self.config.postgres_names, self.database_port()?)
            .map_err(credential_error)?;
        let spec = ProcessSpec::new(
            ProcessRole::Worker,
            &bundle.node,
            &bundle.root,
            PROCESS_START_TIMEOUT,
        )
        .arg(&bundle.worker)
        .env("NODE_ENV", "production")
        .env("LOG_LEVEL", "warn")
        .env("DATABASE_URL", url.expose())
        .env("SCHEDULE_DESKTOP_WORKER", "1")
        .env("WORKER_DEPLOYMENT_HEALTH_MODE", "disabled")
        .env("NOTIFICATION_MATERIALIZATION_MODE", "disabled")
        .env("HOSTED_WORK_ITEM_SYNC_CLEANUP_MODE", "disabled")
        .env("WEBHOOK_DELIVERY_MODE", "disabled")
        .readiness(ReadinessSpec::stdout_prefix(
            WORKER_READY_PREFIX,
            128,
            MAX_READY_PAYLOAD_BYTES,
        ))
        .desktop_shutdown_stdin();
        let started = start_process_cancellable(spec, Arc::clone(&self.process_control), &|| {
            cancellation.is_cancelled()
        })
        .map_err(process_error)?;
        parse_ready_port(
            started
                .readiness
                .as_ref()
                .ok_or_else(|| NativeExecutorError::new("desktop.worker_readiness_invalid"))?
                .as_bytes(),
            "desktop.worker_readiness_invalid",
        )?;
        self.worker = Some(started.process);
        let completed = unix_seconds()?;
        self.journal
            .as_mut()
            .ok_or_else(|| NativeExecutorError::new("desktop.executor_state_invalid"))?
            .mark_success(completed);
        self.store_journal()?;
        Ok(EffectOutcome::Completed)
    }

    fn stop_process(process: &mut Option<OwnedProcess>) -> Result<(), NativeExecutorError> {
        let Some(owned) = process.as_mut() else {
            return Ok(());
        };
        owned.stop(GRACEFUL_PROCESS_STOP).map_err(process_error)?;
        process.take();
        Ok(())
    }

    fn stop_database(&mut self) -> Result<(), NativeExecutorError> {
        if self.database.is_none() {
            return Ok(());
        }
        let mut fast_stop_failed = false;
        if let (Some(bundle), Some(_)) = (&self.bundle, self.database_port) {
            let plan = fast_stop_plan(postgres_bin(bundle)?, self.database_data()?);
            fast_stop_failed = self
                .run_pg(
                    plan,
                    &bundle.postgresql.pg_ctl,
                    Duration::from_secs(35),
                    4096,
                    None,
                )
                .is_err();
        }
        let already_exited = fast_stop_failed
            && self
                .database
                .as_mut()
                .expect("database ownership checked")
                .has_exited()
                .unwrap_or(false);
        // Containment always runs even if PostgreSQL-aware shutdown failed.
        self.database
            .as_mut()
            .expect("database ownership checked")
            .stop(GRACEFUL_PROCESS_STOP)
            .map_err(process_error)?;
        if fast_stop_failed && !already_exited {
            // Retain the now-exited ownership record so a bounded cleanup retry
            // can prove it is stopped and then release it.
            return Err(NativeExecutorError::new(
                "desktop.database_fast_stop_failed",
            ));
        }
        self.database.take();
        Ok(())
    }

    fn configure_bridge_target(&mut self) -> Result<(), NativeExecutorError> {
        let target = self
            .api_target
            .as_ref()
            .ok_or_else(|| NativeExecutorError::new("desktop.executor_state_invalid"))?;
        self.bridge
            .configure(target.port, target.bearer.expose().to_owned())
    }

    fn clear_bridge_target(&mut self) -> Result<(), NativeExecutorError> {
        self.bridge.clear()
    }

    fn release(&mut self) -> Result<(), NativeExecutorError> {
        if self.worker.is_some() || self.api.is_some() || self.database.is_some() {
            return Err(NativeExecutorError::new("desktop.executor_state_invalid"));
        }
        self.api_target = None;
        self.passwords = None;
        self.database_port = None;
        self.database_data = None;
        self.cleanup_launch_secrets()?;
        self.runtime_lock = None;
        Ok(())
    }

    fn cleanup_launch_secrets(&mut self) -> Result<(), NativeExecutorError> {
        if let Some(secrets) = self.launch_secrets.as_mut() {
            secrets.files.cleanup_in_place().map_err(credential_error)?;
        }
        self.launch_secrets = None;
        Ok(())
    }

    fn set_journal_phase(&mut self, phase: JournalPhase) -> Result<(), NativeExecutorError> {
        if self.interrupted_migration {
            // Preserve the durable recovery-required phase across every restart.
            return Ok(());
        }
        self.journal
            .as_mut()
            .ok_or_else(|| NativeExecutorError::new("desktop.executor_state_invalid"))?
            .set_phase(phase);
        self.store_journal()
    }

    fn store_journal(&self) -> Result<(), NativeExecutorError> {
        journal::store(
            &self.config.paths.journal,
            self.journal
                .as_ref()
                .ok_or_else(|| NativeExecutorError::new("desktop.executor_state_invalid"))?,
        )
        .map_err(|_| NativeExecutorError::new("desktop.journal_store_failed"))
    }

    fn admin_connection(&self, database: &str) -> Result<PgConnection, NativeExecutorError> {
        PgConnection::new(
            self.database_port()?,
            database,
            self.config.postgres_names.cluster_admin(),
            &self.require_launch_secrets()?.admin_pgpass,
        )
        .map_err(pg_error)
    }

    fn owner_connection(&self) -> Result<PgConnection, NativeExecutorError> {
        PgConnection::new(
            self.database_port()?,
            self.config.postgres_names.database(),
            self.config.postgres_names.owner(),
            &self.require_launch_secrets()?.owner_pgpass,
        )
        .map_err(pg_error)
    }

    fn run_pg(
        &self,
        plan: PgCommand,
        expected_program: &Path,
        timeout: Duration,
        output_bound: usize,
        cancellation: Option<&Cancellation>,
    ) -> Result<CommandOutput, NativeExecutorError> {
        ensure_program(&plan, expected_program)?;
        let mut spec = CommandSpec::new(plan.program, &self.require_bundle()?.root, timeout)
            .database_payload()
            .output_bounds(output_bound, output_bound);
        for argument in plan.arguments {
            spec = spec.arg(argument);
        }
        for (key, value) in plan.environment {
            spec = spec.env(key, value);
        }
        run_command_cancellable(spec, Arc::clone(&self.process_control), &|| {
            cancellation.is_some_and(Cancellation::is_cancelled)
        })
        .map_err(command_error)
    }

    fn require_lock(&self) -> Result<&RuntimeLock, NativeExecutorError> {
        self.runtime_lock
            .as_ref()
            .ok_or_else(|| NativeExecutorError::new("desktop.executor_state_invalid"))
    }

    fn require_bundle(&self) -> Result<&RuntimeBundle, NativeExecutorError> {
        self.bundle
            .as_ref()
            .ok_or_else(|| NativeExecutorError::new("desktop.executor_state_invalid"))
    }

    fn require_passwords(&self) -> Result<&PgRolePasswords, NativeExecutorError> {
        self.passwords
            .as_ref()
            .ok_or_else(|| NativeExecutorError::new("desktop.executor_state_invalid"))
    }

    fn require_launch_secrets(&self) -> Result<&LaunchSecrets, NativeExecutorError> {
        self.launch_secrets
            .as_ref()
            .ok_or_else(|| NativeExecutorError::new("desktop.executor_state_invalid"))
    }

    fn database_port(&self) -> Result<u16, NativeExecutorError> {
        self.database_port
            .ok_or_else(|| NativeExecutorError::new("desktop.executor_state_invalid"))
    }

    fn database_data(&self) -> Result<&Path, NativeExecutorError> {
        self.database_data
            .as_deref()
            .ok_or_else(|| NativeExecutorError::new("desktop.executor_state_invalid"))
    }
}

impl<B: ApiBridgeControl> NativeOperations for SystemOperations<B> {
    fn portable_export(
        &mut self,
        destination: PathBuf,
        cancellation: &Cancellation,
    ) -> PortableExportResult {
        self.run_portable_export(destination, cancellation)
    }

    fn execute(
        &mut self,
        effect: Effect,
        cancellation: &Cancellation,
    ) -> Result<EffectOutcome, NativeExecutorError> {
        let generation = effect_generation(&effect);
        match effect {
            Effect::AcquireLock { .. } => self.acquire_lock(),
            Effect::ValidateAndStageRuntime { .. } => self.validate_runtime(generation),
            Effect::StartDatabase { .. } => self.start_database(cancellation),
            Effect::VerifyDatabase { .. } => self.verify_database(cancellation),
            Effect::BackupDatabase { .. } => self.backup_database(generation, cancellation),
            Effect::MigrateDatabase { .. } => self.migrate_database(cancellation),
            Effect::StartApi { .. } => self.start_api(cancellation),
            Effect::StartWorker { .. } => self.start_worker(cancellation),
            Effect::StopWorker { .. } => {
                Self::stop_process(&mut self.worker)?;
                Ok(EffectOutcome::Completed)
            }
            Effect::StopApi { .. } => {
                Self::stop_process(&mut self.api)?;
                self.api_target = None;
                Ok(EffectOutcome::Completed)
            }
            Effect::StopDatabase { .. } => {
                self.stop_database()?;
                Ok(EffectOutcome::Completed)
            }
            Effect::ReleaseLock { .. } => {
                self.release()?;
                Ok(EffectOutcome::Completed)
            }
        }
    }

    fn configure_bridge(&mut self, _generation: u64) -> Result<(), NativeExecutorError> {
        self.configure_bridge_target()
    }

    fn clear_bridge(&mut self, _generation: u64) -> Result<(), NativeExecutorError> {
        self.clear_bridge_target()
    }

    fn cancel(&mut self, _generation: u64) {}
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ClusterState {
    New,
    Existing,
    IncompatibleMajor,
    IncompatibleFormat,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MigrationLedgerStatus {
    Exact,
    Prefix,
    Ahead,
    Divergent,
}

fn parse_migration_status(bytes: &[u8]) -> Result<MigrationLedgerStatus, NativeExecutorError> {
    let value = std::str::from_utf8(bytes)
        .map_err(|_| NativeExecutorError::new("desktop.migration_status_invalid"))?;
    let line = value
        .strip_suffix('\n')
        .and_then(|value| value.strip_suffix('\r').or(Some(value)))
        .ok_or_else(|| NativeExecutorError::new("desktop.migration_status_invalid"))?;
    match line.strip_prefix(MIGRATION_STATUS_PREFIX) {
        Some("exact") => Ok(MigrationLedgerStatus::Exact),
        Some("prefix") => Ok(MigrationLedgerStatus::Prefix),
        Some("ahead") => Ok(MigrationLedgerStatus::Ahead),
        Some("divergent") => Ok(MigrationLedgerStatus::Divergent),
        _ => Err(NativeExecutorError::new("desktop.migration_status_invalid")),
    }
}

fn migration_manifest_digest(path: &Path) -> Result<String, NativeExecutorError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| NativeExecutorError::new("desktop.runtime_integrity_failed"))?;
    if super::integrity::is_link_or_reparse(&metadata)
        || !metadata.is_file()
        || metadata.len() == 0
        || metadata.len() > MAX_MIGRATION_MANIFEST_BYTES
    {
        return Err(NativeExecutorError::new("desktop.runtime_integrity_failed"));
    }
    let bytes =
        fs::read(path).map_err(|_| NativeExecutorError::new("desktop.runtime_integrity_failed"))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

struct SelectedStartupJournal {
    journal: LifecycleJournal,
    interrupted_migration: bool,
    had_prior_success: bool,
    store: bool,
}

fn load_or_create_startup_journal(
    path: &Path,
    generation: u64,
    started_at: u64,
    runtime_version: &str,
    migration_target_hash: &str,
) -> Result<SelectedStartupJournal, NativeExecutorError> {
    let prior =
        journal::load(path).map_err(|_| NativeExecutorError::new("desktop.journal_load_failed"))?;
    let selected = select_startup_journal(
        prior,
        generation,
        started_at,
        runtime_version,
        migration_target_hash,
    )?;
    if selected.store {
        journal::store(path, &selected.journal)
            .map_err(|_| NativeExecutorError::new("desktop.journal_store_failed"))?;
    }
    Ok(selected)
}

fn select_startup_journal(
    prior: Option<LifecycleJournal>,
    generation: u64,
    started_at: u64,
    runtime_version: &str,
    migration_target_hash: &str,
) -> Result<SelectedStartupJournal, NativeExecutorError> {
    let interrupted_migration = prior.as_ref().is_some_and(|value| {
        matches!(
            value.recovery_decision(),
            RecoveryDecision::RestoreOrRetryMigration { .. }
        )
    });
    let had_prior_success = prior
        .as_ref()
        .and_then(|value| value.prior_success.as_ref())
        .is_some();
    if interrupted_migration {
        // Do not replace the only durable recovery-required fact with a normal
        // startup attempt. An explicit recovery flow must clear it later.
        return Ok(SelectedStartupJournal {
            journal: prior.ok_or_else(|| NativeExecutorError::new("desktop.journal_invalid"))?,
            interrupted_migration,
            had_prior_success,
            store: false,
        });
    }
    let prior_success = prior.and_then(|value| value.prior_success);
    let journal = LifecycleJournal::new(
        generation,
        started_at,
        runtime_version.to_owned(),
        migration_target_hash.to_owned(),
        prior_success,
    )
    .map_err(|_| NativeExecutorError::new("desktop.journal_invalid"))?;
    Ok(SelectedStartupJournal {
        journal,
        interrupted_migration,
        had_prior_success,
        store: true,
    })
}

fn inspect_cluster(path: &Path) -> Result<ClusterState, NativeExecutorError> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(ClusterState::New),
        Err(_) => return Err(NativeExecutorError::new("desktop.database_inspect_failed")),
        Ok(metadata) if super::integrity::is_link_or_reparse(&metadata) || !metadata.is_dir() => {
            return Ok(ClusterState::IncompatibleFormat);
        }
        Ok(_) => {}
    }
    let version = path.join("PG_VERSION");
    let metadata = match fs::symlink_metadata(&version) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let empty = fs::read_dir(path)
                .map_err(|_| NativeExecutorError::new("desktop.database_inspect_failed"))?
                .next()
                .is_none();
            return Ok(if empty {
                ClusterState::New
            } else {
                ClusterState::IncompatibleFormat
            });
        }
        Err(_) => return Err(NativeExecutorError::new("desktop.database_inspect_failed")),
    };
    if super::integrity::is_link_or_reparse(&metadata) || !metadata.is_file() || metadata.len() > 16
    {
        return Ok(ClusterState::IncompatibleFormat);
    }
    let contents = fs::read_to_string(version)
        .map_err(|_| NativeExecutorError::new("desktop.database_inspect_failed"))?;
    Ok(if validate_pg_version(&contents).is_ok() {
        ClusterState::Existing
    } else {
        ClusterState::IncompatibleMajor
    })
}

fn missing_database_requires_recovery(
    state: ClusterState,
    had_prior_success: bool,
    interrupted_migration: bool,
) -> bool {
    state == ClusterState::New && (had_prior_success || interrupted_migration)
}

fn replace_regular_file(path: &Path, contents: &[u8]) -> Result<(), NativeExecutorError> {
    let before = fs::symlink_metadata(path)
        .map_err(|_| NativeExecutorError::new("desktop.database_config_invalid"))?;
    if super::integrity::is_link_or_reparse(&before) || !before.is_file() {
        return Err(NativeExecutorError::new("desktop.database_config_invalid"));
    }
    let parent = path
        .parent()
        .ok_or_else(|| NativeExecutorError::new("desktop.database_config_invalid"))?;
    let temporary = parent.join(format!(".schedule-config-{}.next", random_suffix()?));
    let mut cleanup = PendingFile(Some(temporary.clone()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| NativeExecutorError::new("desktop.database_config_invalid"))?;
    file.write_all(contents)
        .and_then(|()| file.sync_all())
        .map_err(|_| NativeExecutorError::new("desktop.database_config_invalid"))?;
    drop(file);
    replace_file(&temporary, path)?;
    cleanup.0 = None;
    sync_directory(parent)?;
    let after = fs::symlink_metadata(path)
        .map_err(|_| NativeExecutorError::new("desktop.database_config_invalid"))?;
    if super::integrity::is_link_or_reparse(&after) || !after.is_file() {
        return Err(NativeExecutorError::new("desktop.database_config_invalid"));
    }
    Ok(())
}

fn bootstrap_marker(data: &Path) -> PathBuf {
    data.join(BOOTSTRAP_MARKER)
}

fn validate_bootstrap_marker(path: &Path) -> Result<bool, NativeExecutorError> {
    validate_marker(
        path,
        BOOTSTRAP_MARKER_CONTENTS,
        "desktop.bootstrap_marker_invalid",
    )
}

fn validate_marker(
    path: &Path,
    contents: &[u8],
    code: &'static str,
) -> Result<bool, NativeExecutorError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err(NativeExecutorError::new(code)),
    };
    if super::integrity::is_link_or_reparse(&metadata)
        || !metadata.is_file()
        || metadata.len() != contents.len() as u64
        || fs::read(path).map_err(|_| NativeExecutorError::new(code))? != contents
    {
        return Err(NativeExecutorError::new(code));
    }
    Ok(true)
}

fn publish_bootstrap_marker(path: &Path) -> Result<(), NativeExecutorError> {
    publish_marker(
        path,
        BOOTSTRAP_MARKER_CONTENTS,
        "desktop.bootstrap_marker_invalid",
    )
}

fn publish_marker(
    path: &Path,
    contents: &[u8],
    code: &'static str,
) -> Result<(), NativeExecutorError> {
    if validate_marker(path, contents, code)? {
        return Ok(());
    }
    let parent = path
        .parent()
        .ok_or_else(|| NativeExecutorError::new(code))?;
    let temporary = parent.join(format!(".schedule-bootstrap-{}.next", random_suffix()?));
    let mut cleanup = PendingFile(Some(temporary.clone()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| NativeExecutorError::new(code))?;
    file.write_all(contents)
        .and_then(|()| file.sync_all())
        .map_err(|_| NativeExecutorError::new(code))?;
    drop(file);
    fs::rename(&temporary, path).map_err(|_| NativeExecutorError::new(code))?;
    cleanup.0 = None;
    sync_directory(parent)?;
    validate_marker(path, contents, code).and_then(|valid| {
        valid
            .then_some(())
            .ok_or_else(|| NativeExecutorError::new(code))
    })
}

fn reset_incomplete_cluster(path: &Path) -> Result<(), NativeExecutorError> {
    let mut entries = 0_usize;
    validate_removable_tree(path, &mut entries)?;
    fs::remove_dir_all(path)
        .map_err(|_| NativeExecutorError::new("desktop.database_recovery_failed"))?;
    sync_directory(
        path.parent()
            .ok_or_else(|| NativeExecutorError::new("desktop.database_recovery_failed"))?,
    )
}

fn promote_database_directory(
    source: &Path,
    destination: &Path,
    cancellation: &Cancellation,
) -> Result<(), NativeExecutorError> {
    promote_database_directory_with(source, destination, cancellation, |source, destination| {
        fs::rename(source, destination)
    })
}

fn promote_database_directory_with(
    source: &Path,
    destination: &Path,
    cancellation: &Cancellation,
    mut rename: impl FnMut(&Path, &Path) -> io::Result<()>,
) -> Result<(), NativeExecutorError> {
    let deadline = std::time::Instant::now() + DATABASE_PROMOTION_RETRY_TIMEOUT;
    loop {
        if cancellation.is_cancelled() {
            return Err(NativeExecutorError::new("desktop.operation_cancelled"));
        }
        match rename(source, destination) {
            Ok(()) => return Ok(()),
            Err(error)
                if transient_database_promotion_error(&error)
                    && promotion_source_is_directory(source)
                    && promotion_destination_is_absent(destination)
                    && std::time::Instant::now() < deadline =>
            {
                std::thread::sleep(DATABASE_PROMOTION_RETRY_INTERVAL);
            }
            Err(_) => {
                return Err(NativeExecutorError::new("desktop.database_promote_failed"));
            }
        }
    }
}

fn promotion_source_is_directory(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.is_dir() && !super::integrity::is_link_or_reparse(&metadata))
}

fn promotion_destination_is_absent(path: &Path) -> bool {
    fs::symlink_metadata(path).is_err_and(|error| error.kind() == io::ErrorKind::NotFound)
}

#[cfg(windows)]
fn transient_database_promotion_error(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(5 | 32 | 33))
}

#[cfg(not(windows))]
fn transient_database_promotion_error(_error: &io::Error) -> bool {
    false
}

fn validate_removable_tree(path: &Path, entries: &mut usize) -> Result<(), NativeExecutorError> {
    *entries = entries.saturating_add(1);
    if *entries > 200_000 {
        return Err(NativeExecutorError::new("desktop.database_recovery_failed"));
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| NativeExecutorError::new("desktop.database_recovery_failed"))?;
    if super::integrity::is_link_or_reparse(&metadata) {
        return Err(NativeExecutorError::new("desktop.database_recovery_failed"));
    }
    if metadata.is_dir() {
        for entry in fs::read_dir(path)
            .map_err(|_| NativeExecutorError::new("desktop.database_recovery_failed"))?
        {
            validate_removable_tree(
                &entry
                    .map_err(|_| NativeExecutorError::new("desktop.database_recovery_failed"))?
                    .path(),
                entries,
            )?;
        }
    } else if !metadata.is_file() {
        return Err(NativeExecutorError::new("desktop.database_recovery_failed"));
    }
    Ok(())
}

struct PendingFile(Option<PathBuf>);

impl Drop for PendingFile {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = fs::remove_file(path);
        }
    }
}

fn sync_backup_file(path: &Path, expected_len: u64) -> Result<(), NativeExecutorError> {
    // FlushFileBuffers requires a write-capable handle on Windows even though
    // pg_dump has already finished writing the archive.
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|_| NativeExecutorError::new("desktop.backup_invalid"))?;
    if file
        .metadata()
        .map_err(|_| NativeExecutorError::new("desktop.backup_invalid"))?
        .len()
        != expected_len
    {
        return Err(NativeExecutorError::new("desktop.backup_invalid"));
    }
    file.sync_all()
        .map_err(|_| NativeExecutorError::new("desktop.backup_invalid"))
}

fn random_suffix() -> Result<String, NativeExecutorError> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|_| NativeExecutorError::new("desktop.random_unavailable"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(unix)]
fn publish_backup(source: &Path, destination: &Path) -> Result<(), NativeExecutorError> {
    let parent = destination
        .parent()
        .ok_or_else(|| NativeExecutorError::new("desktop.backup_publish_failed"))?;
    // A hard link atomically publishes without replacing a destination. Sync the
    // new name before removing the private pending name.
    fs::hard_link(source, destination)
        .map_err(|_| NativeExecutorError::new("desktop.backup_publish_failed"))?;
    sync_directory(parent)
        .map_err(|_| NativeExecutorError::new("desktop.backup_publish_failed"))?;
    fs::remove_file(source)
        .map_err(|_| NativeExecutorError::new("desktop.backup_publish_failed"))?;
    sync_directory(parent).map_err(|_| NativeExecutorError::new("desktop.backup_publish_failed"))
}

#[cfg(windows)]
fn publish_backup(source: &Path, destination: &Path) -> Result<(), NativeExecutorError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MOVEFILE_WRITE_THROUGH, MoveFileExW};
    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>()
    };
    let source = wide(source);
    let destination = wide(destination);
    // Omitting MOVEFILE_REPLACE_EXISTING makes publication create-only. The
    // write-through flag durably publishes the already-synced backup name.
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        Err(NativeExecutorError::new("desktop.backup_publish_failed"))
    } else {
        Ok(())
    }
}

#[cfg(not(any(unix, windows)))]
fn publish_backup(_source: &Path, _destination: &Path) -> Result<(), NativeExecutorError> {
    Err(NativeExecutorError::new("desktop.backup_publish_failed"))
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), NativeExecutorError> {
    fs::rename(source, destination)
        .map_err(|_| NativeExecutorError::new("desktop.database_config_invalid"))
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), NativeExecutorError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };
    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>()
    };
    let source = wide(source);
    let destination = wide(destination);
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        Err(NativeExecutorError::new("desktop.database_config_invalid"))
    } else {
        Ok(())
    }
}

fn sync_directory(path: &Path) -> Result<(), NativeExecutorError> {
    #[cfg(windows)]
    {
        let _ = path;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        fs::File::open(path)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| NativeExecutorError::new("desktop.directory_sync_failed"))
    }
}

fn postgres_bin(bundle: &RuntimeBundle) -> Result<&Path, NativeExecutorError> {
    bundle
        .postgresql
        .postgres
        .parent()
        .ok_or_else(|| NativeExecutorError::new("desktop.runtime_program_invalid"))
}

fn ensure_program(plan: &PgCommand, expected: &Path) -> Result<(), NativeExecutorError> {
    (plan.program == expected)
        .then_some(())
        .ok_or_else(|| NativeExecutorError::new("desktop.runtime_program_invalid"))
}

fn allocate_loopback_port() -> Result<u16, NativeExecutorError> {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .map_err(|_| NativeExecutorError::new("desktop.database_port_unavailable"))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ReadyPort {
    port: u16,
}

fn parse_ready_port(bytes: &[u8], code: &'static str) -> Result<u16, NativeExecutorError> {
    let payload =
        serde_json::from_slice::<ReadyPort>(bytes).map_err(|_| NativeExecutorError::new(code))?;
    if payload.port == 0
        || serde_json::to_vec(&payload).map_err(|_| NativeExecutorError::new(code))? != bytes
    {
        return Err(NativeExecutorError::new(code));
    }
    Ok(payload.port)
}

fn unix_seconds() -> Result<u64, NativeExecutorError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| NativeExecutorError::new("desktop.clock_invalid"))
}

fn effect_generation(effect: &Effect) -> u64 {
    match *effect {
        Effect::AcquireLock { generation }
        | Effect::ValidateAndStageRuntime { generation }
        | Effect::StartDatabase { generation }
        | Effect::VerifyDatabase { generation }
        | Effect::BackupDatabase { generation }
        | Effect::MigrateDatabase { generation }
        | Effect::StartApi { generation }
        | Effect::StartWorker { generation }
        | Effect::StopWorker { generation }
        | Effect::StopApi { generation }
        | Effect::StopDatabase { generation }
        | Effect::ReleaseLock { generation } => generation,
    }
}

fn credential_error(error: super::credentials::CredentialError) -> NativeExecutorError {
    NativeExecutorError::new(error.code())
}

fn pg_error(_error: super::postgres::PgError) -> NativeExecutorError {
    NativeExecutorError::new("desktop.database_operation_failed")
}

fn command_error(error: CommandError) -> NativeExecutorError {
    NativeExecutorError::new(error.code())
}

fn process_error(error: super::process::ProcessError) -> NativeExecutorError {
    NativeExecutorError::new(error.code())
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use crate::runtime::{
        bundle::PostgreSqlPrograms,
        process::{DirectChildControl, start_process_cancellable},
    };

    use super::*;

    #[test]
    fn parses_only_the_bounded_secret_free_migration_status_protocol() {
        for (wire, expected) in [
            (
                b"SCHEDULE_MIGRATION_STATUS_V1 exact\n".as_slice(),
                MigrationLedgerStatus::Exact,
            ),
            (
                b"SCHEDULE_MIGRATION_STATUS_V1 prefix\r\n".as_slice(),
                MigrationLedgerStatus::Prefix,
            ),
            (
                b"SCHEDULE_MIGRATION_STATUS_V1 ahead\n".as_slice(),
                MigrationLedgerStatus::Ahead,
            ),
            (
                b"SCHEDULE_MIGRATION_STATUS_V1 divergent\n".as_slice(),
                MigrationLedgerStatus::Divergent,
            ),
        ] {
            assert_eq!(parse_migration_status(wire).unwrap(), expected);
        }
        for invalid in [
            b"SCHEDULE_MIGRATION_STATUS_V1 exact".as_slice(),
            b"SCHEDULE_MIGRATION_STATUS_V1 exact\nextra\n".as_slice(),
            b"SCHEDULE_MIGRATION_STATUS_V1 unknown\n".as_slice(),
            b"postgresql://private:secret@localhost/schedule\n".as_slice(),
            &[0xff, b'\n'],
        ] {
            assert_eq!(
                parse_migration_status(invalid).unwrap_err().code(),
                "desktop.migration_status_invalid"
            );
        }
    }

    #[derive(Default)]
    struct FakeOperations {
        calls: Vec<&'static str>,
        bridge_configured: bool,
        cancelled: Vec<u64>,
    }

    impl NativeOperations for FakeOperations {
        fn execute(
            &mut self,
            effect: Effect,
            cancellation: &Cancellation,
        ) -> Result<EffectOutcome, NativeExecutorError> {
            if cancellation.is_cancelled() {
                return Err(NativeExecutorError::new("desktop.operation_cancelled"));
            }
            let name = match effect {
                Effect::AcquireLock { .. } => "lock",
                Effect::ValidateAndStageRuntime { .. } => "runtime",
                Effect::StartDatabase { .. } => "database",
                Effect::VerifyDatabase { .. } => "verify",
                Effect::BackupDatabase { .. } => "backup",
                Effect::MigrateDatabase { .. } => "migrate",
                Effect::StartApi { .. } => "api",
                Effect::StartWorker { .. } => "worker",
                Effect::StopWorker { .. } => "stop-worker",
                Effect::StopApi { .. } => "stop-api",
                Effect::StopDatabase { .. } => "stop-database",
                Effect::ReleaseLock { .. } => "release-lock",
            };
            self.calls.push(name);
            Ok(if name == "verify" {
                EffectOutcome::DatabaseVerified {
                    needs_migration: true,
                }
            } else {
                EffectOutcome::Completed
            })
        }

        fn configure_bridge(&mut self, _generation: u64) -> Result<(), NativeExecutorError> {
            self.bridge_configured = true;
            Ok(())
        }

        fn clear_bridge(&mut self, _generation: u64) -> Result<(), NativeExecutorError> {
            self.bridge_configured = false;
            Ok(())
        }

        fn cancel(&mut self, generation: u64) {
            self.cancelled.push(generation);
        }
    }

    #[derive(Default)]
    struct FakeBridge {
        target: Mutex<Option<(u16, String)>>,
    }

    impl ApiBridgeControl for FakeBridge {
        fn configure(&self, port: u16, credential: String) -> Result<(), NativeExecutorError> {
            *self.target.lock().unwrap() = Some((port, credential));
            Ok(())
        }

        fn clear(&self) -> Result<(), NativeExecutorError> {
            *self.target.lock().unwrap() = None;
            Ok(())
        }
    }

    #[test]
    fn executor_is_a_fakeable_effect_boundary() {
        let mut executor = NativeEffectExecutor::new(FakeOperations::default());
        let cancellation = Cancellation::default();
        assert_eq!(
            executor
                .execute(Effect::VerifyDatabase { generation: 7 }, &cancellation)
                .unwrap(),
            EffectOutcome::DatabaseVerified {
                needs_migration: true
            }
        );
        executor.configure_bridge(7).unwrap();
        executor.cancel(7);
        executor.clear_bridge(7).unwrap();
        assert_eq!(executor.operations().calls, ["verify"]);
        assert_eq!(executor.operations().cancelled, [7]);
        assert!(!executor.operations().bridge_configured);
    }

    #[test]
    fn fake_boundary_observes_cancellation_without_running_effects() {
        let mut executor = NativeEffectExecutor::new(FakeOperations::default());
        let cancellation = Cancellation::default();
        cancellation.cancel();
        let error = executor
            .execute(Effect::StartApi { generation: 1 }, &cancellation)
            .unwrap_err();
        assert_eq!(error.code(), "desktop.operation_cancelled");
        assert!(executor.operations().calls.is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn database_promotion_retries_transient_windows_failures() {
        for code in [5, 32, 33] {
            let root = std::env::temp_dir().join(format!(
                "schedule-promotion-retry-{code}-{}-{}",
                std::process::id(),
                random_suffix().unwrap()
            ));
            let source = root.join("source");
            let destination = root.join("destination");
            fs::create_dir_all(&source).unwrap();
            let mut attempts = 0;

            promote_database_directory_with(
                &source,
                &destination,
                &Cancellation::default(),
                |source, destination| {
                    attempts += 1;
                    if attempts < 3 {
                        Err(io::Error::from_raw_os_error(code))
                    } else {
                        fs::rename(source, destination)
                    }
                },
            )
            .unwrap();

            assert_eq!(attempts, 3);
            assert!(!source.exists());
            assert!(destination.is_dir());
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[cfg(windows)]
    #[test]
    fn database_promotion_observes_cancellation_between_retries() {
        let root = std::env::temp_dir().join(format!(
            "schedule-promotion-cancel-{}-{}",
            std::process::id(),
            random_suffix().unwrap()
        ));
        let source = root.join("source");
        let destination = root.join("destination");
        fs::create_dir_all(&source).unwrap();
        let cancellation = Cancellation::default();
        let mut attempts = 0;

        let error =
            promote_database_directory_with(&source, &destination, &cancellation, |_, _| {
                attempts += 1;
                cancellation.cancel();
                Err(io::Error::from_raw_os_error(32))
            })
            .unwrap_err();

        assert_eq!(error.code(), "desktop.operation_cancelled");
        assert_eq!(attempts, 1);
        assert!(source.is_dir());
        assert!(!destination.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn database_promotion_does_not_retry_nontransient_failures() {
        let root = std::env::temp_dir().join(format!(
            "schedule-promotion-nontransient-{}-{}",
            std::process::id(),
            random_suffix().unwrap()
        ));
        let source = root.join("source");
        let destination = root.join("destination");
        fs::create_dir_all(&source).unwrap();
        let mut attempts = 0;

        let error = promote_database_directory_with(
            &source,
            &destination,
            &Cancellation::default(),
            |_, _| {
                attempts += 1;
                Err(io::Error::new(io::ErrorKind::InvalidInput, "test"))
            },
        )
        .unwrap_err();

        assert_eq!(error.code(), "desktop.database_promote_failed");
        assert_eq!(attempts, 1);
        assert!(source.is_dir());
        assert!(!destination.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn database_promotion_fails_closed_if_the_destination_appears() {
        let root = std::env::temp_dir().join(format!(
            "schedule-promotion-collision-{}-{}",
            std::process::id(),
            random_suffix().unwrap()
        ));
        let source = root.join("source");
        let destination = root.join("destination");
        fs::create_dir_all(&source).unwrap();
        let mut attempts = 0;

        let error = promote_database_directory_with(
            &source,
            &destination,
            &Cancellation::default(),
            |_, destination| {
                attempts += 1;
                fs::create_dir(destination).unwrap();
                Err(io::Error::from_raw_os_error(32))
            },
        )
        .unwrap_err();

        assert_eq!(error.code(), "desktop.database_promote_failed");
        assert_eq!(attempts, 1);
        assert!(source.is_dir());
        assert!(destination.is_dir());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn readiness_payload_is_exact_bounded_json() {
        assert_eq!(
            parse_ready_port(br#"{"port":49321}"#, "bad").unwrap(),
            49_321
        );
        for invalid in [
            br#"{"port":0}"#.as_slice(),
            br#"{"port":49321,"extra":true}"#.as_slice(),
            br#"{ "port":49321}"#.as_slice(),
            br#"{"port":"49321"}"#.as_slice(),
            br#"{"port":49321}\n"#.as_slice(),
        ] {
            assert_eq!(parse_ready_port(invalid, "bad").unwrap_err().code(), "bad");
        }
    }

    #[test]
    fn interrupted_migration_journal_remains_recovery_required_across_restarts() {
        let root = std::env::temp_dir().join(format!(
            "schedule-executor-journal-recovery-{}-{}",
            std::process::id(),
            random_suffix().unwrap()
        ));
        fs::create_dir(&root).unwrap();
        let path = root.join("lifecycle.json");
        let mut interrupted =
            LifecycleJournal::new(1, 10, "runtime-old".into(), "schema-old".into(), None).unwrap();
        interrupted.mark_success(20);
        interrupted.set_phase(JournalPhase::MigratingDatabase);
        journal::store(&path, &interrupted).unwrap();

        let first =
            load_or_create_startup_journal(&path, 2, 30, "runtime-new", "schema-new").unwrap();
        assert!(first.interrupted_migration);
        assert!(first.had_prior_success);
        assert!(!first.store);
        assert_eq!(first.journal.attempt.phase, JournalPhase::MigratingDatabase);

        let second =
            load_or_create_startup_journal(&path, 3, 40, "runtime-new", "schema-new").unwrap();
        assert!(second.interrupted_migration);
        assert!(!second.store);
        assert_eq!(
            second.journal.attempt.phase,
            JournalPhase::MigratingDatabase
        );
        assert_eq!(
            journal::load(&path).unwrap().unwrap().attempt.phase,
            JournalPhase::MigratingDatabase
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_database_after_success_or_migration_never_becomes_a_new_install() {
        assert!(missing_database_requires_recovery(
            ClusterState::New,
            true,
            false
        ));
        assert!(missing_database_requires_recovery(
            ClusterState::New,
            false,
            true
        ));
        assert!(!missing_database_requires_recovery(
            ClusterState::New,
            false,
            false
        ));
        assert!(!missing_database_requires_recovery(
            ClusterState::Existing,
            true,
            true
        ));
    }

    #[test]
    fn cluster_inspection_distinguishes_new_major_and_format_states() {
        let root = std::env::temp_dir().join(format!(
            "schedule-executor-cluster-{}-{}",
            std::process::id(),
            unix_seconds().unwrap()
        ));
        let _ = fs::remove_dir_all(&root);
        assert_eq!(inspect_cluster(&root).unwrap(), ClusterState::New);
        fs::create_dir(&root).unwrap();
        assert_eq!(inspect_cluster(&root).unwrap(), ClusterState::New);
        fs::write(root.join("PG_VERSION"), "16\n").unwrap();
        assert_eq!(
            inspect_cluster(&root).unwrap(),
            ClusterState::IncompatibleMajor
        );
        fs::write(root.join("PG_VERSION"), "17\n").unwrap();
        assert_eq!(inspect_cluster(&root).unwrap(), ClusterState::Existing);
        fs::remove_file(root.join("PG_VERSION")).unwrap();
        fs::write(root.join("partial"), b"x").unwrap();
        assert_eq!(
            inspect_cluster(&root).unwrap(),
            ClusterState::IncompatibleFormat
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bootstrap_markers_publish_atomically_and_reject_tampering() {
        let root = std::env::temp_dir().join(format!(
            "schedule-executor-marker-{}-{}",
            std::process::id(),
            random_suffix().unwrap()
        ));
        fs::create_dir(&root).unwrap();
        let marker = root.join(BOOTSTRAP_MARKER);
        assert!(!validate_bootstrap_marker(&marker).unwrap());
        publish_bootstrap_marker(&marker).unwrap();
        assert!(validate_bootstrap_marker(&marker).unwrap());
        assert_eq!(fs::read(&marker).unwrap(), BOOTSTRAP_MARKER_CONTENTS);
        fs::write(&marker, b"tampered\n").unwrap();
        assert!(validate_bootstrap_marker(&marker).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn incomplete_staging_cleanup_is_bounded_and_never_follows_links() {
        let root = std::env::temp_dir().join(format!(
            "schedule-executor-incomplete-{}-{}",
            std::process::id(),
            random_suffix().unwrap()
        ));
        fs::create_dir_all(root.join("base/child")).unwrap();
        fs::write(root.join("base/child/partial"), b"x").unwrap();
        reset_incomplete_cluster(&root.join("base")).unwrap();
        assert!(!root.join("base").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn postgres_configuration_replacement_never_exposes_a_partial_destination() {
        let root = std::env::temp_dir().join(format!(
            "schedule-executor-config-replace-{}-{}",
            std::process::id(),
            random_suffix().unwrap()
        ));
        fs::create_dir(&root).unwrap();
        let path = root.join("postgresql.conf");
        fs::write(&path, b"old\n").unwrap();
        replace_regular_file(&path, b"complete-new-value\n").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"complete-new-value\n");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn backup_publication_is_create_only_and_preserves_complete_contents() {
        let root = std::env::temp_dir().join(format!(
            "schedule-executor-backup-publish-{}-{}",
            std::process::id(),
            random_suffix().unwrap()
        ));
        fs::create_dir(&root).unwrap();
        let first_source = root.join("first.pending");
        let second_source = root.join("second.pending");
        let destination = root.join("backup.dump");
        fs::write(&first_source, b"complete-one").unwrap();
        fs::write(&second_source, b"complete-two").unwrap();
        publish_backup(&first_source, &destination).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), b"complete-one");
        assert!(publish_backup(&second_source, &destination).is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"complete-one");
        assert_eq!(fs::read(&second_source).unwrap(), b"complete-two");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn completed_backup_can_be_durably_synced() {
        let root = std::env::temp_dir().join(format!(
            "schedule-executor-backup-sync-{}-{}",
            std::process::id(),
            random_suffix().unwrap()
        ));
        fs::create_dir(&root).unwrap();
        let backup = root.join("backup.dump");
        fs::write(&backup, b"complete-backup").unwrap();

        sync_backup_file(&backup, 15).unwrap();

        fs::remove_file(backup).unwrap();
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn failed_postgres_fast_stop_contains_the_process_and_requires_a_proving_retry() {
        let executable = std::env::current_exe().unwrap();
        let working_directory = std::env::current_dir().unwrap();
        let control: Arc<dyn ProcessGroupControl> = Arc::new(DirectChildControl);
        let started = start_process_cancellable(
            ProcessSpec::new(
                ProcessRole::Database,
                &executable,
                &working_directory,
                Duration::from_secs(1),
            )
            .arg("subprocess_helper")
            .arg("--nocapture")
            .env("SCHEDULE_PROCESS_TEST_MODE", "sleep"),
            Arc::clone(&control),
            &|| false,
        )
        .unwrap();
        let programs = PostgreSqlPrograms {
            postgres: executable.clone(),
            initdb: executable.clone(),
            psql: executable.clone(),
            pg_isready: executable.clone(),
            pg_dump: executable.clone(),
            pg_restore: executable.clone(),
            pg_ctl: executable.clone(),
        };
        let mut operations = SystemOperations {
            config: executor_config(),
            bridge: Arc::new(FakeBridge::default()),
            process_control: control,
            runtime_lock: None,
            bundle: Some(RuntimeBundle {
                root: working_directory.clone(),
                node: executable.clone(),
                api: executable.clone(),
                worker: executable.clone(),
                postgresql: programs,
                migration: executable.clone(),
                migration_manifest: executable.clone(),
                portable_export: executable,
            }),
            credential_store: None,
            passwords: None,
            launch_secrets: None,
            journal: None,
            interrupted_migration: false,
            had_prior_success: false,
            database_port: Some(54_321),
            database_data: Some(working_directory),
            database: Some(started.process),
            api: None,
            worker: None,
            api_target: None,
        };

        assert_eq!(
            operations.stop_database().unwrap_err().code(),
            "desktop.database_fast_stop_failed"
        );
        assert!(operations.database.as_mut().unwrap().has_exited().unwrap());
        operations.stop_database().unwrap();
        assert!(operations.database.is_none());
    }

    #[test]
    fn executor_errors_never_echo_injected_values() {
        let injected = "postgresql://private:secret@127.0.0.1/schedule";
        let rendered = format!(
            "{:?} {}",
            NativeExecutorError::new("desktop.executor_state_invalid"),
            NativeExecutorError::new("desktop.executor_state_invalid")
        );
        assert!(!rendered.contains(injected));
        assert_eq!(
            rendered,
            "NativeExecutorError { code: \"desktop.executor_state_invalid\" } desktop.executor_state_invalid"
        );
    }

    #[test]
    fn fake_bridge_owns_and_clears_its_target() {
        let bridge = FakeBridge::default();
        bridge.configure(40_001, "a".repeat(43)).unwrap();
        assert_eq!(bridge.target.lock().unwrap().as_ref().unwrap().0, 40_001);
        bridge.clear().unwrap();
        assert!(bridge.target.lock().unwrap().is_none());
    }

    fn executor_config() -> NativeExecutorConfig {
        let data = std::env::temp_dir().join("schedule-executor-config");
        NativeExecutorConfig {
            paths: RuntimePaths::new(&data, "runtime-1", "launch-1").unwrap(),
            resource_root: data.join("resources"),
            runtime_version: "runtime-1".into(),
            manifest_sha256: "a".repeat(64),
            manifest_expectations: RuntimeManifestExpectations::default(),
            postgres_names: PgNames::new(
                "schedule",
                "schedule_cluster_admin",
                "schedule_owner",
                "schedule_runtime",
            )
            .unwrap(),
        }
    }

    #[test]
    fn production_constructor_rejects_misdirected_or_malformed_configuration() {
        let bridge = Arc::new(FakeBridge::default());
        assert!(SystemOperations::production(executor_config(), Arc::clone(&bridge)).is_ok());

        let mut wrong_path = executor_config();
        wrong_path.paths.backups = std::env::temp_dir().join("elsewhere");
        assert_eq!(
            SystemOperations::production(wrong_path, Arc::clone(&bridge))
                .err()
                .unwrap()
                .code(),
            "desktop.executor_config_invalid"
        );

        let mut wrong_hash = executor_config();
        wrong_hash.manifest_sha256 = "G".repeat(64);
        assert_eq!(
            SystemOperations::production(wrong_hash, bridge)
                .err()
                .unwrap()
                .code(),
            "desktop.executor_config_invalid"
        );
    }
}
