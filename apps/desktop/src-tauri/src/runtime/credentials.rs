//! Runtime credentials and fail-closed private bootstrap files.
//!
//! Secrets deliberately have no `Debug`, `Display`, `Clone`, or serialization
//! implementation. PostgreSQL passwords are transferred through private files;
//! [`LibpqEnvironment`] contains only non-secret connection settings.

use std::{
    ffi::{OsStr, OsString},
    fmt,
    fs::{self, File},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};

use serde::{Deserialize, Deserializer, de};
use zeroize::Zeroizing;

use super::{paths::RuntimePaths, safe_pg_identifier};

#[cfg(not(windows))]
use std::fs::OpenOptions;

const SECRET_BYTES: usize = 32;
const MAX_PRIVATE_FILE_BYTES: usize = 1024 * 1024;
const MAX_CREDENTIAL_STORE_BYTES: usize = 1024;
const MAX_STALE_SECRET_FILES: usize = 16;
const MAX_TEMP_ROOT_ENTRIES: usize = 1024;
const LOOPBACK_HOST: &str = "127.0.0.1";
const CREDENTIAL_STORE_VERSION: u8 = 1;
const CREDENTIAL_STORE_FILE: &str = "postgresql-credentials.v1.json";
const PENDING_SUFFIX: &str = ".pending";
const LAUNCH_SECRET_PREFIX: &str = "schedule-runtime-secrets-";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CredentialError {
    EntropyUnavailable,
    InvalidInput,
    PrivateStorageUnavailable,
}

impl CredentialError {
    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::EntropyUnavailable => "desktop.credentials_entropy_unavailable",
            Self::InvalidInput => "desktop.credentials_invalid_input",
            Self::PrivateStorageUnavailable => "desktop.credentials_private_storage_unavailable",
        }
    }
}

impl fmt::Display for CredentialError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for CredentialError {}

struct SecretString(Zeroizing<String>);

impl SecretString {
    fn generate() -> Result<Self, CredentialError> {
        let mut random = Zeroizing::new([0_u8; SECRET_BYTES]);
        getrandom::fill(&mut *random).map_err(|_| CredentialError::EntropyUnavailable)?;
        Ok(Self(Zeroizing::new(base64url_no_pad(&*random))))
    }

    fn expose(&self) -> &str {
        self.0.as_str()
    }

    fn from_persisted(value: String) -> Result<Self, CredentialError> {
        let value = Zeroizing::new(value);
        let valid = value.len() == 43
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            && value
                .as_bytes()
                .last()
                .is_some_and(|byte| b"AEIMQUYcgkosw048".contains(byte));
        valid
            .then_some(Self(value))
            .ok_or(CredentialError::PrivateStorageUnavailable)
    }
}

/// Ephemeral desktop API credential. Generate a fresh value for every launch.
pub(crate) struct DesktopBearer(SecretString);

impl DesktopBearer {
    pub(crate) fn generate() -> Result<Self, CredentialError> {
        SecretString::generate().map(Self)
    }

    pub(crate) fn expose(&self) -> &str {
        self.0.expose()
    }
}

/// Cluster-lifetime PostgreSQL role passwords.
///
/// `generate_for_cluster_initialization` must only be called while creating a
/// new cluster. The coordinator must persist them through [`PgCredentialStore`]
/// before initializing PostgreSQL. Existing clusters reload that immutable
/// state and never regenerate role passwords.
pub(crate) struct PgRolePasswords {
    cluster_admin_password: SecretString,
    owner_password: SecretString,
    runtime_password: SecretString,
}

impl PgRolePasswords {
    pub(crate) fn generate_for_cluster_initialization() -> Result<Self, CredentialError> {
        Ok(Self {
            cluster_admin_password: SecretString::generate()?,
            owner_password: SecretString::generate()?,
            runtime_password: SecretString::generate()?,
        })
    }
}

struct StoredSecret(SecretString);

impl<'de> Deserialize<'de> for StoredSecret {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        SecretString::from_persisted(value)
            .map(Self)
            .map_err(|_| de::Error::custom("invalid persisted secret"))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CredentialStoreV1 {
    schema_version: u8,
    database: String,
    cluster_admin: String,
    owner: String,
    runtime: String,
    cluster_admin_password: StoredSecret,
    owner_password: StoredSecret,
    runtime_password: StoredSecret,
}

impl CredentialStoreV1 {
    fn parse(bytes: &[u8]) -> Result<Self, CredentialError> {
        let stored: Self = serde_json::from_slice(bytes)
            .map_err(|_| CredentialError::PrivateStorageUnavailable)?;
        let names = stored.names()?;
        let distinct_passwords = stored.cluster_admin_password.0.expose()
            != stored.owner_password.0.expose()
            && stored.cluster_admin_password.0.expose() != stored.runtime_password.0.expose()
            && stored.owner_password.0.expose() != stored.runtime_password.0.expose();
        if stored.schema_version != CREDENTIAL_STORE_VERSION
            || !distinct_passwords
            || encode_credentials(
                &names,
                &stored.cluster_admin_password.0,
                &stored.owner_password.0,
                &stored.runtime_password.0,
            )?
            .as_bytes()
                != bytes
        {
            return Err(CredentialError::PrivateStorageUnavailable);
        }
        Ok(stored)
    }

    fn names(&self) -> Result<PgNames, CredentialError> {
        PgNames::new(
            self.database.clone(),
            self.cluster_admin.clone(),
            self.owner.clone(),
            self.runtime.clone(),
        )
        .map_err(|_| CredentialError::PrivateStorageUnavailable)
    }

    fn into_passwords(self, expected_names: &PgNames) -> Result<PgRolePasswords, CredentialError> {
        if self.names()?.ne(expected_names) {
            return Err(CredentialError::PrivateStorageUnavailable);
        }
        Ok(PgRolePasswords {
            cluster_admin_password: self.cluster_admin_password.0,
            owner_password: self.owner_password.0,
            runtime_password: self.runtime_password.0,
        })
    }
}

/// Immutable, versioned PostgreSQL credentials stored beneath the private user-data root.
///
/// This protects the file with operating-system access controls; it does not encrypt it. The
/// caller must hold the desktop singleton lock while loading, recovering, or creating the store.
pub(crate) struct PgCredentialStore {
    path: PathBuf,
    pending: PathBuf,
}

impl PgCredentialStore {
    /// Prepares the private directory layout below an already-created, trusted per-user data root.
    pub(crate) fn prepare(paths: &RuntimePaths) -> Result<Self, CredentialError> {
        let expected_store = paths.private_root.join(CREDENTIAL_STORE_FILE);
        if paths.private_root.parent() != Some(paths.data_root.as_path())
            || paths.credentials_store != expected_store
            || paths.temporary_secrets_root != paths.private_root.join("temp")
        {
            return Err(CredentialError::InvalidInput);
        }

        reject_existing_directory(&paths.data_root)?;
        ensure_private_directory(&paths.private_root, &paths.data_root)?;
        ensure_private_directory(&paths.temporary_secrets_root, &paths.private_root)?;

        Ok(Self {
            pending: append_suffix(&paths.credentials_store, PENDING_SUFFIX)?,
            path: paths.credentials_store.clone(),
        })
    }

    /// Loads the store, publishing a complete interrupted `.pending` file when necessary.
    ///
    /// If both names exist, they must contain identical canonical bytes. Any ambiguity or schema
    /// drift fails closed instead of selecting one credential set.
    pub(crate) fn load(
        &self,
        expected_names: &PgNames,
    ) -> Result<Option<PgRolePasswords>, CredentialError> {
        self.validate_parent()?;
        let stored = read_optional_private_file(&self.path, MAX_CREDENTIAL_STORE_BYTES)?;
        let pending = read_optional_private_file(&self.pending, MAX_CREDENTIAL_STORE_BYTES)?;

        match (stored, pending) {
            (None, None) => Ok(None),
            (Some(stored), None) => parse_credentials(stored, expected_names),
            (None, Some(pending)) => {
                CredentialStoreV1::parse(&pending)?;
                publish_durable(&self.pending, &self.path)?;
                parse_credentials(
                    read_required_private_file(&self.path, MAX_CREDENTIAL_STORE_BYTES)?,
                    expected_names,
                )
            }
            (Some(stored), Some(pending)) => {
                CredentialStoreV1::parse(&stored)?;
                CredentialStoreV1::parse(&pending)?;
                if stored.as_slice() != pending.as_slice() {
                    return Err(CredentialError::PrivateStorageUnavailable);
                }
                fs::remove_file(&self.pending)
                    .map_err(|_| CredentialError::PrivateStorageUnavailable)?;
                sync_directory(
                    self.path
                        .parent()
                        .ok_or(CredentialError::PrivateStorageUnavailable)?,
                )?;
                parse_credentials(stored, expected_names)
            }
        }
    }

    /// Creates the canonical v1 store without replacing any existing or pending state.
    pub(crate) fn create_new(
        &self,
        names: &PgNames,
        passwords: &PgRolePasswords,
    ) -> Result<(), CredentialError> {
        self.validate_parent()?;
        reject_existing_destination(&self.path)?;
        reject_existing_destination(&self.pending)?;
        let contents = encode_credentials(
            names,
            &passwords.cluster_admin_password,
            &passwords.owner_password,
            &passwords.runtime_password,
        )?;
        let mut cleanup = TemporaryCleanup(Some(self.pending.clone()));
        let mut file = create_private_file(&self.pending)
            .map_err(|_| CredentialError::PrivateStorageUnavailable)?;
        file.write_all(contents.as_bytes())
            .and_then(|()| file.sync_all())
            .map_err(|_| CredentialError::PrivateStorageUnavailable)?;
        drop(file);
        publish_durable(&self.pending, &self.path)?;
        cleanup.0 = Some(self.path.clone());
        let stored = read_required_private_file(&self.path, MAX_CREDENTIAL_STORE_BYTES)?;
        CredentialStoreV1::parse(&stored)?;
        cleanup.0 = None;
        Ok(())
    }

    fn validate_parent(&self) -> Result<(), CredentialError> {
        let parent = self
            .path
            .parent()
            .ok_or(CredentialError::PrivateStorageUnavailable)?;
        if self.pending.parent() != Some(parent) {
            return Err(CredentialError::PrivateStorageUnavailable);
        }
        reject_private_directory(parent)
    }
}

fn parse_credentials(
    bytes: Zeroizing<Vec<u8>>,
    expected_names: &PgNames,
) -> Result<Option<PgRolePasswords>, CredentialError> {
    CredentialStoreV1::parse(&bytes)
        .and_then(|stored| stored.into_passwords(expected_names))
        .map(Some)
}

fn encode_credentials(
    names: &PgNames,
    cluster_admin: &SecretString,
    owner: &SecretString,
    runtime: &SecretString,
) -> Result<Zeroizing<String>, CredentialError> {
    // Reserve the complete bounded record before any secret enters the buffer. Reallocation would
    // free an old allocation whose secret bytes cannot then be zeroized.
    let mut contents = Zeroizing::new(String::with_capacity(MAX_CREDENTIAL_STORE_BYTES));
    let initial_capacity = contents.capacity();
    use std::fmt::Write as _;
    write!(
        contents,
        "{{\"schema_version\":{CREDENTIAL_STORE_VERSION},\"database\":\"{}\",\"cluster_admin\":\"{}\",\"owner\":\"{}\",\"runtime\":\"{}\",\"cluster_admin_password\":\"{}\",\"owner_password\":\"{}\",\"runtime_password\":\"{}\"}}\n",
        names.database,
        names.cluster_admin,
        names.owner,
        names.runtime,
        cluster_admin.expose(),
        owner.expose(),
        runtime.expose(),
    )
    .map_err(|_| CredentialError::PrivateStorageUnavailable)?;
    if contents.len() > MAX_CREDENTIAL_STORE_BYTES || contents.capacity() != initial_capacity {
        return Err(CredentialError::PrivateStorageUnavailable);
    }
    Ok(contents)
}

fn require_unchanged_capacity(
    contents: &String,
    initial_capacity: usize,
) -> Result<(), CredentialError> {
    (contents.capacity() == initial_capacity)
        .then_some(())
        .ok_or(CredentialError::PrivateStorageUnavailable)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PgNames {
    database: String,
    cluster_admin: String,
    owner: String,
    runtime: String,
}

impl PgNames {
    pub(crate) fn new(
        database: impl Into<String>,
        cluster_admin: impl Into<String>,
        owner: impl Into<String>,
        runtime: impl Into<String>,
    ) -> Result<Self, CredentialError> {
        let names = Self {
            database: database.into(),
            cluster_admin: cluster_admin.into(),
            owner: owner.into(),
            runtime: runtime.into(),
        };
        let valid_identifiers = [
            names.database.as_str(),
            names.cluster_admin.as_str(),
            names.owner.as_str(),
            names.runtime.as_str(),
        ]
        .into_iter()
        .all(safe_pg_identifier);
        let distinct_roles = names.cluster_admin != names.owner
            && names.cluster_admin != names.runtime
            && names.owner != names.runtime;
        if valid_identifiers && distinct_roles {
            Ok(names)
        } else {
            Err(CredentialError::InvalidInput)
        }
    }
}

/// Secret-free libpq settings. Authentication happens through `PGPASSFILE`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct LibpqEnvironment {
    host: OsString,
    port: OsString,
    database: OsString,
    user: OsString,
    pgpass_file: PathBuf,
}

impl LibpqEnvironment {
    pub(crate) fn new(
        port: u16,
        database: &str,
        user: &str,
        pgpass_file: impl Into<PathBuf>,
    ) -> Result<Self, CredentialError> {
        let pgpass_file = pgpass_file.into();
        if port == 0
            || !safe_pg_identifier(database)
            || !safe_pg_identifier(user)
            || !pgpass_file.is_absolute()
        {
            return Err(CredentialError::InvalidInput);
        }
        Ok(Self {
            host: LOOPBACK_HOST.into(),
            port: port.to_string().into(),
            database: database.into(),
            user: user.into(),
            pgpass_file,
        })
    }

    pub(crate) fn values(&self) -> [(&'static str, &OsStr); 6] {
        [
            ("PGHOST", &self.host),
            ("PGPORT", &self.port),
            ("PGDATABASE", &self.database),
            ("PGUSER", &self.user),
            ("PGPASSFILE", self.pgpass_file.as_os_str()),
            ("PGCONNECT_TIMEOUT", OsStr::new("5")),
        ]
    }
}

/// A unique private directory removed with all files created through this API.
pub(crate) struct PrivateRuntimeFiles {
    directory: PathBuf,
    files: Vec<PathBuf>,
}

impl PrivateRuntimeFiles {
    pub(crate) fn create(parent: &Path) -> Result<Self, CredentialError> {
        reject_link_components(parent)?;
        if !parent
            .metadata()
            .map_err(|_| CredentialError::PrivateStorageUnavailable)?
            .is_dir()
        {
            return Err(CredentialError::PrivateStorageUnavailable);
        }

        for _ in 0..16 {
            let name = random_file_name("schedule-runtime-secrets")?;
            let directory = parent.join(name);
            match create_private_directory(&directory) {
                Ok(()) => {
                    if reject_link_or_reparse(&directory)
                        .and_then(|()| sync_directory(parent))
                        .is_err()
                    {
                        let _ = fs::remove_dir(&directory);
                        return Err(CredentialError::PrivateStorageUnavailable);
                    }
                    return Ok(Self {
                        directory,
                        files: Vec::new(),
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(_) => {
                    let _ = fs::remove_dir(&directory);
                    return Err(CredentialError::PrivateStorageUnavailable);
                }
            }
        }
        Err(CredentialError::PrivateStorageUnavailable)
    }

    pub(crate) fn directory(&self) -> &Path {
        &self.directory
    }

    /// Deletes every temporary secret file and then its private directory.
    ///
    /// Call this after the database tools have closed the files so cleanup
    /// failures can be surfaced. `Drop` still retries best-effort.
    pub(crate) fn cleanup(mut self) -> Result<(), CredentialError> {
        self.cleanup_inner()
    }

    /// Creates the one-line `initdb --pwfile` input for the cluster administrator.
    pub(crate) fn write_initial_password(
        &mut self,
        passwords: &PgRolePasswords,
    ) -> Result<PathBuf, CredentialError> {
        let mut contents = Zeroizing::new(String::with_capacity(45));
        let initial_capacity = contents.capacity();
        contents.push_str(passwords.cluster_admin_password.expose());
        contents.push('\n');
        require_unchanged_capacity(&contents, initial_capacity)?;
        self.write_named("initial-password", contents.as_bytes())
    }

    pub(crate) fn write_admin_pgpass(
        &mut self,
        port: u16,
        names: &PgNames,
        passwords: &PgRolePasswords,
    ) -> Result<PathBuf, CredentialError> {
        if port == 0 {
            return Err(CredentialError::InvalidInput);
        }
        let mut contents = Zeroizing::new(String::with_capacity(512));
        let initial_capacity = contents.capacity();
        use std::fmt::Write as _;
        for database in ["postgres", names.database.as_str()] {
            write!(
                contents,
                "{LOOPBACK_HOST}:{port}:{database}:{}:{}\n",
                names.cluster_admin,
                passwords.cluster_admin_password.expose(),
            )
            .map_err(|_| CredentialError::PrivateStorageUnavailable)?;
        }
        require_unchanged_capacity(&contents, initial_capacity)?;
        self.write_named("admin.pgpass", contents.as_bytes())
    }

    pub(crate) fn write_owner_pgpass(
        &mut self,
        port: u16,
        names: &PgNames,
        passwords: &PgRolePasswords,
    ) -> Result<PathBuf, CredentialError> {
        self.write_pgpass(
            "owner.pgpass",
            port,
            &names.database,
            &names.owner,
            &passwords.owner_password,
        )
    }

    pub(crate) fn write_runtime_pgpass(
        &mut self,
        port: u16,
        names: &PgNames,
        passwords: &PgRolePasswords,
    ) -> Result<PathBuf, CredentialError> {
        self.write_pgpass(
            "runtime.pgpass",
            port,
            &names.database,
            &names.runtime,
            &passwords.runtime_password,
        )
    }

    /// Creates SQL using only validated identifiers and generated password characters.
    pub(crate) fn write_bootstrap_sql(
        &mut self,
        names: &PgNames,
        passwords: &PgRolePasswords,
    ) -> Result<PathBuf, CredentialError> {
        let mut sql = Zeroizing::new(String::with_capacity(4096));
        let initial_capacity = sql.capacity();
        use std::fmt::Write as _;
        write!(
            sql,
            "CREATE ROLE {} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '{}';\n\
             CREATE ROLE {} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '{}';\n\
             CREATE DATABASE {} OWNER {} TEMPLATE template0 ENCODING 'UTF8';\n\
             REVOKE ALL ON DATABASE {} FROM PUBLIC;\n\
             GRANT CONNECT ON DATABASE {} TO {};\n\
             \\connect {}\n\
             REVOKE CREATE ON SCHEMA public FROM PUBLIC;\n\
             GRANT USAGE, CREATE ON SCHEMA public TO {};\n\
             GRANT USAGE ON SCHEMA public TO {};\n\
             GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO {};\n\
             GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO {};\n\
             ALTER DEFAULT PRIVILEGES FOR ROLE {} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {};\n\
             ALTER DEFAULT PRIVILEGES FOR ROLE {} IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO {};\n",
            names.owner,
            passwords.owner_password.expose(),
            names.runtime,
            passwords.runtime_password.expose(),
            names.database,
            names.owner,
            names.database,
            names.database,
            names.runtime,
            names.database,
            names.owner,
            names.runtime,
            names.runtime,
            names.runtime,
            names.owner,
            names.runtime,
            names.owner,
            names.runtime,
        )
        .map_err(|_| CredentialError::PrivateStorageUnavailable)?;
        require_unchanged_capacity(&sql, initial_capacity)?;
        self.write_named("bootstrap.sql", sql.as_bytes())
    }

    fn write_pgpass(
        &mut self,
        file_name: &'static str,
        port: u16,
        database: &str,
        user: &str,
        password: &SecretString,
    ) -> Result<PathBuf, CredentialError> {
        if port == 0 || !safe_pg_identifier(database) || !safe_pg_identifier(user) {
            return Err(CredentialError::InvalidInput);
        }
        let mut contents = Zeroizing::new(String::with_capacity(256));
        let initial_capacity = contents.capacity();
        use std::fmt::Write as _;
        write!(
            contents,
            "{LOOPBACK_HOST}:{port}:{database}:{user}:{}\n",
            password.expose(),
        )
        .map_err(|_| CredentialError::PrivateStorageUnavailable)?;
        require_unchanged_capacity(&contents, initial_capacity)?;
        self.write_named(file_name, contents.as_bytes())
    }

    fn write_named(
        &mut self,
        file_name: &'static str,
        contents: &[u8],
    ) -> Result<PathBuf, CredentialError> {
        if contents.len() > MAX_PRIVATE_FILE_BYTES {
            return Err(CredentialError::InvalidInput);
        }
        reject_link_or_reparse(&self.directory)?;
        let destination = self.directory.join(file_name);
        reject_existing_destination(&destination)?;

        let temporary = self.directory.join(random_file_name(".pending")?);
        let mut cleanup = TemporaryCleanup(Some(temporary.clone()));
        let mut file = create_private_file(&temporary)
            .map_err(|_| CredentialError::PrivateStorageUnavailable)?;
        file.write_all(contents)
            .and_then(|()| file.sync_all())
            .map_err(|_| CredentialError::PrivateStorageUnavailable)?;
        drop(file);

        publish(&temporary, &destination)?;
        cleanup.0 = Some(destination.clone());
        reject_regular_private_file(&destination)?;
        cleanup.0 = None;
        self.files.push(destination.clone());
        Ok(destination)
    }

    fn cleanup_inner(&mut self) -> Result<(), CredentialError> {
        let mut retained = Vec::new();
        while let Some(path) = self.files.pop() {
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => retained.push(path),
            }
        }
        retained.reverse();
        self.files = retained;
        if !self.files.is_empty() {
            return Err(CredentialError::PrivateStorageUnavailable);
        }
        match fs::remove_dir(&self.directory) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(CredentialError::PrivateStorageUnavailable),
        }
    }
}

impl Drop for PrivateRuntimeFiles {
    fn drop(&mut self) {
        let _ = self.cleanup_inner();
    }
}

/// Removes only recognized, directly-contained launch-secret directories.
///
/// The caller must hold the desktop singleton lock: that is what proves every matching directory
/// is stale. This function intentionally does not depend on the lock type so lifecycle ownership
/// remains with the coordinator. It never follows links and never recursively removes a tree.
pub(crate) fn scavenge_stale_launch_secrets(parent: &Path) -> Result<usize, CredentialError> {
    reject_private_directory(parent)?;
    let mut stale = Vec::new();
    for (index, entry) in fs::read_dir(parent)
        .map_err(|_| CredentialError::PrivateStorageUnavailable)?
        .enumerate()
    {
        if index == MAX_TEMP_ROOT_ENTRIES {
            return Err(CredentialError::PrivateStorageUnavailable);
        }
        let entry = entry.map_err(|_| CredentialError::PrivateStorageUnavailable)?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !valid_random_name(&name, LAUNCH_SECRET_PREFIX) {
            continue;
        }

        let directory = entry.path();
        reject_private_directory(&directory)?;
        let mut files = Vec::new();
        for child in
            fs::read_dir(&directory).map_err(|_| CredentialError::PrivateStorageUnavailable)?
        {
            if files.len() == MAX_STALE_SECRET_FILES {
                return Err(CredentialError::PrivateStorageUnavailable);
            }
            let child = child.map_err(|_| CredentialError::PrivateStorageUnavailable)?;
            let child_name = child.file_name();
            let Some(child_name) = child_name.to_str() else {
                return Err(CredentialError::PrivateStorageUnavailable);
            };
            if !valid_launch_secret_file_name(child_name) {
                return Err(CredentialError::PrivateStorageUnavailable);
            }
            let child = child.path();
            reject_regular_private_file(&child)?;
            files.push(child);
        }
        stale.push((directory, files));
    }

    let count = stale.len();
    for (directory, files) in stale {
        for file in files {
            fs::remove_file(file).map_err(|_| CredentialError::PrivateStorageUnavailable)?;
        }
        fs::remove_dir(directory).map_err(|_| CredentialError::PrivateStorageUnavailable)?;
    }
    sync_directory(parent)?;
    Ok(count)
}

fn valid_launch_secret_file_name(name: &str) -> bool {
    matches!(
        name,
        "initial-password" | "admin.pgpass" | "owner.pgpass" | "runtime.pgpass" | "bootstrap.sql"
    ) || valid_random_name(name, ".pending-")
}

fn valid_random_name(name: &str, prefix: &str) -> bool {
    name.strip_prefix(prefix).is_some_and(|suffix| {
        suffix.len() == 32
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

struct TemporaryCleanup(Option<PathBuf>);

impl Drop for TemporaryCleanup {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = fs::remove_file(path);
        }
    }
}

fn base64url_no_pad(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let value = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        output.push(ALPHABET[((value >> 18) & 63) as usize] as char);
        output.push(ALPHABET[((value >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            output.push(ALPHABET[((value >> 6) & 63) as usize] as char);
        }
        if chunk.len() > 2 {
            output.push(ALPHABET[(value & 63) as usize] as char);
        }
    }
    output
}

fn random_file_name(prefix: &str) -> Result<String, CredentialError> {
    let mut random = Zeroizing::new([0_u8; 16]);
    getrandom::fill(&mut *random).map_err(|_| CredentialError::EntropyUnavailable)?;
    let mut name = String::with_capacity(prefix.len() + 33);
    name.push_str(prefix);
    name.push('-');
    for byte in random.iter() {
        use std::fmt::Write as _;
        write!(name, "{byte:02x}").expect("formatting into String cannot fail");
    }
    Ok(name)
}

fn append_suffix(path: &Path, suffix: &str) -> Result<PathBuf, CredentialError> {
    let name = path
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or(CredentialError::InvalidInput)?;
    Ok(path.with_file_name(format!("{name}{suffix}")))
}

fn read_optional_private_file(
    path: &Path,
    limit: usize,
) -> Result<Option<Zeroizing<Vec<u8>>>, CredentialError> {
    match fs::symlink_metadata(path) {
        Ok(_) => read_required_private_file(path, limit).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(CredentialError::PrivateStorageUnavailable),
    }
}

fn read_required_private_file(
    path: &Path,
    limit: usize,
) -> Result<Zeroizing<Vec<u8>>, CredentialError> {
    reject_regular_private_file(path)?;
    let metadata = fs::metadata(path).map_err(|_| CredentialError::PrivateStorageUnavailable)?;
    if metadata.len() > limit as u64 {
        return Err(CredentialError::PrivateStorageUnavailable);
    }
    let mut contents = Zeroizing::new(Vec::with_capacity(metadata.len() as usize));
    File::open(path)
        .and_then(|file| file.take(limit as u64 + 1).read_to_end(&mut contents))
        .map_err(|_| CredentialError::PrivateStorageUnavailable)?;
    if contents.len() > limit {
        return Err(CredentialError::PrivateStorageUnavailable);
    }
    reject_regular_private_file(path)?;
    Ok(contents)
}

fn reject_existing_directory(path: &Path) -> Result<(), CredentialError> {
    reject_link_components(path)?;
    let metadata = fs::metadata(path).map_err(|_| CredentialError::PrivateStorageUnavailable)?;
    metadata
        .is_dir()
        .then_some(())
        .ok_or(CredentialError::PrivateStorageUnavailable)
}

fn ensure_private_directory(path: &Path, parent: &Path) -> Result<(), CredentialError> {
    if path.parent() != Some(parent) {
        return Err(CredentialError::InvalidInput);
    }
    reject_existing_directory(parent)?;
    match create_private_directory(path) {
        Ok(()) => sync_directory(parent)?,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(CredentialError::PrivateStorageUnavailable),
    }
    reject_private_directory(path)
}

fn reject_private_directory(path: &Path) -> Result<(), CredentialError> {
    reject_link_or_reparse(path)?;
    let metadata =
        fs::symlink_metadata(path).map_err(|_| CredentialError::PrivateStorageUnavailable)?;
    if !metadata.is_dir() {
        return Err(CredentialError::PrivateStorageUnavailable);
    }
    verify_private_directory_permissions(path, &metadata)
}

fn reject_existing_destination(path: &Path) -> Result<(), CredentialError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Err(CredentialError::PrivateStorageUnavailable),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(CredentialError::PrivateStorageUnavailable),
    }
}

fn reject_regular_private_file(path: &Path) -> Result<(), CredentialError> {
    reject_link_or_reparse(path)?;
    let metadata =
        fs::symlink_metadata(path).map_err(|_| CredentialError::PrivateStorageUnavailable)?;
    if !metadata.is_file() {
        return Err(CredentialError::PrivateStorageUnavailable);
    }
    verify_private_file_permissions(path, &metadata)
}

fn reject_link_components(path: &Path) -> Result<(), CredentialError> {
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()
            .map_err(|_| CredentialError::PrivateStorageUnavailable)?
            .join(path)
    };
    let mut current = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => continue,
            Component::ParentDir => return Err(CredentialError::PrivateStorageUnavailable),
            _ => current.push(component.as_os_str()),
        }
        reject_link_or_reparse(&current)?;
    }
    Ok(())
}

#[cfg(unix)]
fn create_private_directory(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    let mut builder = fs::DirBuilder::new();
    builder.mode(0o700).create(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    let mode = fs::symlink_metadata(path)?.permissions().mode() & 0o777;
    if mode != 0o700 {
        return Err(std::io::Error::other("private directory mode rejected"));
    }
    Ok(())
}

#[cfg(not(windows))]
fn create_private_file(path: &Path) -> std::io::Result<File> {
    #[cfg(unix)]
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let file = options.open(path)?;
    #[cfg(unix)]
    {
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        if file.metadata()?.permissions().mode() & 0o777 != 0o600 {
            return Err(std::io::Error::other("private file mode rejected"));
        }
    }
    Ok(file)
}

#[cfg(not(windows))]
fn reject_link_or_reparse(path: &Path) -> Result<(), CredentialError> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| CredentialError::PrivateStorageUnavailable)?;
    if metadata.file_type().is_symlink() {
        Err(CredentialError::PrivateStorageUnavailable)
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn verify_private_file_permissions(
    _path: &Path,
    metadata: &fs::Metadata,
) -> Result<(), CredentialError> {
    use std::os::unix::fs::PermissionsExt;
    (metadata.permissions().mode() & 0o777 == 0o600)
        .then_some(())
        .ok_or(CredentialError::PrivateStorageUnavailable)
}

#[cfg(unix)]
fn verify_private_directory_permissions(
    _path: &Path,
    metadata: &fs::Metadata,
) -> Result<(), CredentialError> {
    use std::os::unix::fs::PermissionsExt;
    (metadata.permissions().mode() & 0o777 == 0o700)
        .then_some(())
        .ok_or(CredentialError::PrivateStorageUnavailable)
}

#[cfg(not(any(unix, windows)))]
fn create_private_directory(_path: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "private directories unsupported",
    ))
}

#[cfg(not(any(unix, windows)))]
fn verify_private_file_permissions(
    _path: &Path,
    _metadata: &fs::Metadata,
) -> Result<(), CredentialError> {
    Err(CredentialError::PrivateStorageUnavailable)
}

#[cfg(not(any(unix, windows)))]
fn verify_private_directory_permissions(
    _path: &Path,
    _metadata: &fs::Metadata,
) -> Result<(), CredentialError> {
    Err(CredentialError::PrivateStorageUnavailable)
}

#[cfg(unix)]
fn publish(temporary: &Path, destination: &Path) -> Result<(), CredentialError> {
    // A hard link publishes the fully synced inode atomically and cannot replace
    // a concurrently-created destination. Remove the temporary name afterward.
    fs::hard_link(temporary, destination)
        .map_err(|_| CredentialError::PrivateStorageUnavailable)?;
    let directory = destination
        .parent()
        .ok_or(CredentialError::PrivateStorageUnavailable)?;
    if fs::remove_file(temporary).is_err() || sync_directory(directory).is_err() {
        let _ = fs::remove_file(destination);
        return Err(CredentialError::PrivateStorageUnavailable);
    }
    Ok(())
}

#[cfg(unix)]
fn publish_durable(temporary: &Path, destination: &Path) -> Result<(), CredentialError> {
    let directory = destination
        .parent()
        .ok_or(CredentialError::PrivateStorageUnavailable)?;
    fs::hard_link(temporary, destination)
        .map_err(|_| CredentialError::PrivateStorageUnavailable)?;
    if sync_directory(directory).is_err() {
        let _ = fs::remove_file(destination);
        return Err(CredentialError::PrivateStorageUnavailable);
    }
    fs::remove_file(temporary).map_err(|_| CredentialError::PrivateStorageUnavailable)?;
    sync_directory(directory)
}

#[cfg(not(any(unix, windows)))]
fn publish(_temporary: &Path, _destination: &Path) -> Result<(), CredentialError> {
    Err(CredentialError::PrivateStorageUnavailable)
}

#[cfg(not(any(unix, windows)))]
fn publish_durable(_temporary: &Path, _destination: &Path) -> Result<(), CredentialError> {
    Err(CredentialError::PrivateStorageUnavailable)
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), CredentialError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| CredentialError::PrivateStorageUnavailable)
}

#[cfg(not(any(unix, windows)))]
fn sync_directory(_path: &Path) -> Result<(), CredentialError> {
    Err(CredentialError::PrivateStorageUnavailable)
}

#[cfg(windows)]
mod windows_private {
    use super::*;
    use std::{
        mem::{MaybeUninit, size_of},
        os::windows::{ffi::OsStrExt, io::FromRawHandle},
        ptr,
    };
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE},
        Security::{
            ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_REVISION, ACL_SIZE_INFORMATION,
            AclSizeInformation, AddAccessAllowedAce, DACL_SECURITY_INFORMATION, EqualSid, GetAce,
            GetAclInformation, GetFileSecurityW, GetLengthSid, GetSecurityDescriptorControl,
            GetSecurityDescriptorDacl, GetTokenInformation, InitializeAcl,
            InitializeSecurityDescriptor, SE_DACL_PROTECTED, SECURITY_ATTRIBUTES,
            SECURITY_DESCRIPTOR, SetSecurityDescriptorControl, SetSecurityDescriptorDacl,
            TOKEN_QUERY, TOKEN_USER, TokenUser,
        },
        Storage::FileSystem::{
            CREATE_NEW, CreateDirectoryW, CreateFileW, FILE_ALL_ACCESS, FILE_ATTRIBUTE_NORMAL,
            FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_WRITE_THROUGH, GetFileAttributesW,
            INVALID_FILE_ATTRIBUTES, MOVEFILE_WRITE_THROUGH, MoveFileExW,
        },
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };

    const SECURITY_DESCRIPTOR_REVISION: u32 = 1;

    struct OwnedHandle(windows_sys::Win32::Foundation::HANDLE);

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    fn wide(path: &Path) -> std::io::Result<Vec<u16>> {
        let mut value: Vec<_> = path.as_os_str().encode_wide().collect();
        if value.contains(&0) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "path contains NUL",
            ));
        }
        value.push(0);
        Ok(value)
    }

    fn with_user_only_security<T>(
        operation: impl FnOnce(*const SECURITY_ATTRIBUTES, *mut core::ffi::c_void) -> std::io::Result<T>,
    ) -> std::io::Result<T> {
        with_user_only_security_control(true, operation)
    }

    fn with_user_only_security_control<T>(
        protect_dacl: bool,
        operation: impl FnOnce(*const SECURITY_ATTRIBUTES, *mut core::ffi::c_void) -> std::io::Result<T>,
    ) -> std::io::Result<T> {
        let mut token = ptr::null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let token = OwnedHandle(token);

        let mut needed = 0_u32;
        unsafe {
            GetTokenInformation(token.0, TokenUser, ptr::null_mut(), 0, &mut needed);
        }
        if needed < size_of::<TOKEN_USER>() as u32 {
            return Err(std::io::Error::last_os_error());
        }
        let words = (needed as usize).div_ceil(size_of::<usize>());
        let mut token_info = vec![0_usize; words];
        if unsafe {
            GetTokenInformation(
                token.0,
                TokenUser,
                token_info.as_mut_ptr().cast(),
                needed,
                &mut needed,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        let sid = unsafe { (*(token_info.as_ptr().cast::<TOKEN_USER>())).User.Sid };
        if sid.is_null() {
            return Err(std::io::Error::other("current user SID unavailable"));
        }
        let sid_length = unsafe { GetLengthSid(sid) } as usize;
        if sid_length == 0 {
            return Err(std::io::Error::last_os_error());
        }

        let acl_bytes =
            size_of::<ACL>() + size_of::<ACCESS_ALLOWED_ACE>() - size_of::<u32>() + sid_length;
        let mut acl_words = vec![0_u32; acl_bytes.div_ceil(size_of::<u32>())];
        let acl = acl_words.as_mut_ptr().cast::<ACL>();
        if unsafe { InitializeAcl(acl, acl_bytes as u32, ACL_REVISION) } == 0
            || unsafe { AddAccessAllowedAce(acl, ACL_REVISION, FILE_ALL_ACCESS, sid) } == 0
        {
            return Err(std::io::Error::last_os_error());
        }

        let mut descriptor = MaybeUninit::<SECURITY_DESCRIPTOR>::zeroed();
        let descriptor_ptr = descriptor.as_mut_ptr().cast();
        if unsafe { InitializeSecurityDescriptor(descriptor_ptr, SECURITY_DESCRIPTOR_REVISION) }
            == 0
            || unsafe { SetSecurityDescriptorDacl(descriptor_ptr, 1, acl, 0) } == 0
            || (protect_dacl
                && unsafe {
                    SetSecurityDescriptorControl(
                        descriptor_ptr,
                        SE_DACL_PROTECTED,
                        SE_DACL_PROTECTED,
                    )
                } == 0)
        {
            return Err(std::io::Error::last_os_error());
        }
        let mut attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor_ptr,
            bInheritHandle: 0,
        };
        operation(&mut attributes, sid)
    }

    fn verify_user_only_dacl(
        path: &[u16],
        expected_sid: *mut core::ffi::c_void,
    ) -> std::io::Result<()> {
        verify_user_only_dacl_control(path, expected_sid, true)
    }

    fn verify_user_only_dacl_control(
        path: &[u16],
        expected_sid: *mut core::ffi::c_void,
        require_protected: bool,
    ) -> std::io::Result<()> {
        let mut needed = 0_u32;
        unsafe {
            GetFileSecurityW(
                path.as_ptr(),
                DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                0,
                &mut needed,
            );
        }
        if needed < size_of::<SECURITY_DESCRIPTOR>() as u32 {
            return Err(std::io::Error::last_os_error());
        }
        let words = (needed as usize).div_ceil(size_of::<usize>());
        let mut descriptor = vec![0_usize; words];
        if unsafe {
            GetFileSecurityW(
                path.as_ptr(),
                DACL_SECURITY_INFORMATION,
                descriptor.as_mut_ptr().cast(),
                needed,
                &mut needed,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error());
        }

        let mut control = 0_u16;
        let mut revision = 0_u32;
        if unsafe {
            GetSecurityDescriptorControl(
                descriptor.as_mut_ptr().cast(),
                &mut control,
                &mut revision,
            )
        } == 0
            || (require_protected && control & SE_DACL_PROTECTED == 0)
        {
            return Err(std::io::Error::other("private DACL rejected"));
        }

        let mut present = 0;
        let mut defaulted = 0;
        let mut acl = ptr::null_mut();
        if unsafe {
            GetSecurityDescriptorDacl(
                descriptor.as_mut_ptr().cast(),
                &mut present,
                &mut acl,
                &mut defaulted,
            )
        } == 0
            || present == 0
            || acl.is_null()
        {
            return Err(std::io::Error::other("private DACL unavailable"));
        }
        let mut size = ACL_SIZE_INFORMATION::default();
        if unsafe {
            GetAclInformation(
                acl,
                (&mut size as *mut ACL_SIZE_INFORMATION).cast(),
                size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
        } == 0
            || size.AceCount != 1
        {
            return Err(std::io::Error::other("private DACL rejected"));
        }
        let mut raw_ace = ptr::null_mut();
        if unsafe { GetAce(acl, 0, &mut raw_ace) } == 0 || raw_ace.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let header = unsafe { &*raw_ace.cast::<ACE_HEADER>() };
        if header.AceType != 0 || usize::from(header.AceSize) < size_of::<ACCESS_ALLOWED_ACE>() {
            return Err(std::io::Error::other("private DACL rejected"));
        }
        let ace = unsafe { &*raw_ace.cast::<ACCESS_ALLOWED_ACE>() };
        let actual_sid = (&ace.SidStart as *const u32).cast_mut().cast();
        if ace.Mask != FILE_ALL_ACCESS || unsafe { EqualSid(actual_sid, expected_sid) } == 0 {
            return Err(std::io::Error::other("private DACL rejected"));
        }
        Ok(())
    }

    fn create_directory_control(path: &Path, protect_dacl: bool) -> std::io::Result<()> {
        let path = wide(path)?;
        with_user_only_security_control(protect_dacl, |security, sid| {
            if unsafe { CreateDirectoryW(path.as_ptr(), security) } == 0 {
                Err(std::io::Error::last_os_error())
            } else {
                verify_user_only_dacl_control(&path, sid, protect_dacl)
            }
        })
    }

    pub(super) fn create_directory(path: &Path) -> std::io::Result<()> {
        create_directory_control(path, true)
    }

    fn create_file_control(path: &Path, protect_dacl: bool) -> std::io::Result<File> {
        let path = wide(path)?;
        with_user_only_security_control(protect_dacl, |security, sid| {
            let handle = unsafe {
                CreateFileW(
                    path.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    0,
                    security,
                    CREATE_NEW,
                    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH,
                    ptr::null_mut(),
                )
            };
            if handle == INVALID_HANDLE_VALUE {
                Err(std::io::Error::last_os_error())
            } else {
                let file = unsafe { File::from_raw_handle(handle) };
                verify_user_only_dacl_control(&path, sid, protect_dacl)?;
                Ok(file)
            }
        })
    }

    pub(super) fn create_file(path: &Path) -> std::io::Result<File> {
        create_file_control(path, true)
    }

    #[cfg(test)]
    pub(super) fn create_unprotected_directory(path: &Path) -> std::io::Result<()> {
        create_directory_control(path, false)
    }

    #[cfg(test)]
    pub(super) fn create_unprotected_file(path: &Path) -> std::io::Result<File> {
        create_file_control(path, false)
    }

    pub(super) fn reject_reparse(path: &Path) -> Result<(), CredentialError> {
        let path = wide(path).map_err(|_| CredentialError::PrivateStorageUnavailable)?;
        let attributes = unsafe { GetFileAttributesW(path.as_ptr()) };
        if attributes == INVALID_FILE_ATTRIBUTES || attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            Err(CredentialError::PrivateStorageUnavailable)
        } else {
            Ok(())
        }
    }

    pub(super) fn verify_private(path: &Path) -> Result<(), CredentialError> {
        let path = wide(path).map_err(|_| CredentialError::PrivateStorageUnavailable)?;
        with_user_only_security(|_, sid| verify_user_only_dacl(&path, sid))
            .map_err(|_| CredentialError::PrivateStorageUnavailable)
    }

    pub(super) fn publish_file(
        temporary: &Path,
        destination: &Path,
    ) -> Result<(), CredentialError> {
        let temporary = wide(temporary).map_err(|_| CredentialError::PrivateStorageUnavailable)?;
        let destination =
            wide(destination).map_err(|_| CredentialError::PrivateStorageUnavailable)?;
        if unsafe {
            MoveFileExW(
                temporary.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            Err(CredentialError::PrivateStorageUnavailable)
        } else {
            Ok(())
        }
    }
}

#[cfg(windows)]
fn create_private_directory(path: &Path) -> std::io::Result<()> {
    windows_private::create_directory(path)
}

#[cfg(windows)]
fn create_private_file(path: &Path) -> std::io::Result<File> {
    windows_private::create_file(path)
}

#[cfg(windows)]
fn reject_link_or_reparse(path: &Path) -> Result<(), CredentialError> {
    windows_private::reject_reparse(path)
}

#[cfg(windows)]
fn verify_private_file_permissions(
    path: &Path,
    _metadata: &fs::Metadata,
) -> Result<(), CredentialError> {
    windows_private::verify_private(path)
}

#[cfg(windows)]
fn verify_private_directory_permissions(
    path: &Path,
    _metadata: &fs::Metadata,
) -> Result<(), CredentialError> {
    windows_private::verify_private(path)
}

#[cfg(windows)]
fn publish(temporary: &Path, destination: &Path) -> Result<(), CredentialError> {
    windows_private::publish_file(temporary, destination)
}

#[cfg(windows)]
fn publish_durable(temporary: &Path, destination: &Path) -> Result<(), CredentialError> {
    windows_private::publish_file(temporary, destination)
}

#[cfg(windows)]
fn sync_directory(_path: &Path) -> Result<(), CredentialError> {
    // File handles use FILE_FLAG_WRITE_THROUGH and publication uses
    // MOVEFILE_WRITE_THROUGH. Windows does not support fsync on directory handles.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use zeroize::Zeroize;

    fn test_parent() -> PathBuf {
        let path =
            std::env::temp_dir().join(random_file_name("schedule-credentials-test").unwrap());
        fs::create_dir(&path).unwrap();
        path
    }

    fn names() -> PgNames {
        PgNames::new(
            "schedule",
            "schedule_cluster_admin",
            "schedule_owner",
            "schedule_runtime",
        )
        .unwrap()
    }

    fn runtime_paths(parent: &Path) -> RuntimePaths {
        RuntimePaths::new(parent, "postgres-17.4", "launch-test").unwrap()
    }

    fn fixed_secret(fill: char, final_character: char) -> SecretString {
        SecretString::from_persisted(format!(
            "{}{}",
            fill.to_string().repeat(42),
            final_character
        ))
        .unwrap()
    }

    fn canonical_test_record() -> Zeroizing<String> {
        encode_credentials(
            &names(),
            &fixed_secret('a', 'A'),
            &fixed_secret('b', 'E'),
            &fixed_secret('c', 'I'),
        )
        .unwrap()
    }

    fn write_private(path: &Path, contents: &[u8]) {
        let mut file = create_private_file(path).unwrap();
        file.write_all(contents).unwrap();
        file.sync_all().unwrap();
    }

    #[test]
    fn generates_independent_url_safe_secrets() {
        let bearer = DesktopBearer::generate().unwrap();
        let passwords = PgRolePasswords::generate_for_cluster_initialization().unwrap();
        let secrets = [
            bearer.expose(),
            passwords.cluster_admin_password.expose(),
            passwords.owner_password.expose(),
            passwords.runtime_password.expose(),
        ];
        assert!(secrets.iter().all(|secret| {
            secret.len() == 43
                && secret
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        }));
        for (index, secret) in secrets.iter().enumerate() {
            assert!(!secrets[..index].contains(secret));
        }
    }

    #[test]
    fn secret_storage_zeroizes() {
        let mut secret = SecretString::generate().unwrap();
        secret.0.zeroize();
        assert!(secret.0.is_empty());
    }

    #[test]
    fn libpq_environment_has_no_raw_password() {
        let bearer = DesktopBearer::generate().unwrap();
        let passwords = PgRolePasswords::generate_for_cluster_initialization().unwrap();
        let pgpass_file = std::env::temp_dir().join("schedule-private-pgpass");
        let environment =
            LibpqEnvironment::new(54_321, "schedule", "schedule_runtime", &pgpass_file).unwrap();
        let rendered = environment
            .values()
            .into_iter()
            .map(|(key, value)| format!("{key}={}", value.to_string_lossy()))
            .collect::<Vec<_>>()
            .join("\n");
        for secret in [
            bearer.expose(),
            passwords.cluster_admin_password.expose(),
            passwords.owner_password.expose(),
            passwords.runtime_password.expose(),
        ] {
            assert!(!rendered.contains(secret));
        }
        assert!(rendered.contains(&format!("PGPASSFILE={}", pgpass_file.to_string_lossy())));
    }

    #[test]
    fn rejects_unsafe_postgres_identifiers() {
        let pgpass_file = std::env::temp_dir().join("schedule-private-pgpass");
        for invalid in [
            "",
            "9role",
            "Role",
            "role-name",
            "role\nname",
            &"x".repeat(64),
        ] {
            assert!(PgNames::new("schedule", "admin", invalid, "runtime").is_err());
            assert!(LibpqEnvironment::new(54_321, "schedule", invalid, &pgpass_file).is_err());
        }
        assert!(PgNames::new("schedule", "same", "same", "runtime").is_err());
        assert!(PgNames::new("schedule", "admin", "same", "same").is_err());
        assert!(LibpqEnvironment::new(54_321, "schedule", "runtime", "relative/pgpass").is_err());
    }

    #[test]
    fn writes_private_files_without_overwriting_and_cleans_up() {
        let parent = test_parent();
        let passwords = PgRolePasswords::generate_for_cluster_initialization().unwrap();
        let mut private = PrivateRuntimeFiles::create(&parent).unwrap();
        let directory = private.directory().to_owned();
        let initial = private.write_initial_password(&passwords).unwrap();
        let admin = private
            .write_admin_pgpass(54_321, &names(), &passwords)
            .unwrap();
        let owner = private
            .write_owner_pgpass(54_321, &names(), &passwords)
            .unwrap();
        let runtime = private
            .write_runtime_pgpass(54_321, &names(), &passwords)
            .unwrap();
        let sql = private.write_bootstrap_sql(&names(), &passwords).unwrap();
        assert!(
            initial.is_file()
                && admin.is_file()
                && owner.is_file()
                && runtime.is_file()
                && sql.is_file()
        );
        let admin_contents = Zeroizing::new(fs::read(&admin).unwrap());
        let admin_lines = admin_contents
            .split(|byte| *byte == b'\n')
            .collect::<Vec<_>>();
        assert_eq!(admin_lines.len(), 3);
        assert!(admin_lines[2].is_empty());
        assert!(admin_lines[0].starts_with(b"127.0.0.1:54321:postgres:schedule_cluster_admin:"));
        assert!(admin_lines[1].starts_with(b"127.0.0.1:54321:schedule:schedule_cluster_admin:"));
        for line in &admin_lines[..2] {
            assert!(line.ends_with(passwords.cluster_admin_password.expose().as_bytes()));
        }
        let sql_contents = Zeroizing::new(fs::read(&sql).unwrap());
        assert!(
            sql_contents
                .windows(passwords.owner_password.expose().len())
                .any(|window| window == passwords.owner_password.expose().as_bytes())
        );
        assert!(
            sql_contents
                .windows(passwords.runtime_password.expose().len())
                .any(|window| window == passwords.runtime_password.expose().as_bytes())
        );
        let sql_text = std::str::from_utf8(&sql_contents).unwrap();
        let restrictions =
            "LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS";
        assert_eq!(sql_text.matches(restrictions).count(), 2);
        assert!(sql_text.contains(
            "CREATE DATABASE schedule OWNER schedule_owner TEMPLATE template0 ENCODING 'UTF8';"
        ));
        assert!(sql_text.contains("REVOKE ALL ON DATABASE schedule FROM PUBLIC;"));
        let reconnect = sql_text.find("\\connect schedule\n").unwrap();
        let schema_revoke = sql_text
            .find("REVOKE CREATE ON SCHEMA public FROM PUBLIC;")
            .unwrap();
        assert!(reconnect < schema_revoke);
        for statement in [
            "GRANT USAGE, CREATE ON SCHEMA public TO schedule_owner;",
            "GRANT USAGE ON SCHEMA public TO schedule_runtime;",
            "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO schedule_runtime;",
            "GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO schedule_runtime;",
            "ALTER DEFAULT PRIVILEGES FOR ROLE schedule_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO schedule_runtime;",
            "ALTER DEFAULT PRIVILEGES FOR ROLE schedule_owner IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO schedule_runtime;",
        ] {
            assert!(sql_text.contains(statement), "missing: {statement}");
        }
        assert_eq!(
            private.write_initial_password(&passwords),
            Err(CredentialError::PrivateStorageUnavailable)
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
                0o700
            );
            for path in [&initial, &admin, &owner, &runtime, &sql] {
                assert_eq!(
                    fs::metadata(path).unwrap().permissions().mode() & 0o777,
                    0o600
                );
            }
        }

        private.cleanup().unwrap();
        assert!(!directory.exists());
        fs::remove_dir(parent).unwrap();
    }

    #[test]
    fn durable_store_round_trips_canonical_credentials_without_replacement() {
        let parent = test_parent();
        let paths = runtime_paths(&parent);
        let store = PgCredentialStore::prepare(&paths).unwrap();
        let names = names();
        let passwords = PgRolePasswords::generate_for_cluster_initialization().unwrap();
        store.create_new(&names, &passwords).unwrap();

        let loaded = store.load(&names).unwrap().unwrap();
        assert!(
            loaded.cluster_admin_password.expose() == passwords.cluster_admin_password.expose()
        );
        assert!(loaded.owner_password.expose() == passwords.owner_password.expose());
        assert!(loaded.runtime_password.expose() == passwords.runtime_password.expose());
        for incompatible_names in [
            PgNames::new(
                "schedule_v2",
                "schedule_cluster_admin",
                "schedule_owner",
                "schedule_runtime",
            ),
            PgNames::new(
                "schedule",
                "schedule_cluster_admin_v2",
                "schedule_owner",
                "schedule_runtime",
            ),
            PgNames::new(
                "schedule",
                "schedule_cluster_admin",
                "schedule_owner_v2",
                "schedule_runtime",
            ),
            PgNames::new(
                "schedule",
                "schedule_cluster_admin",
                "schedule_owner",
                "schedule_runtime_v2",
            ),
        ] {
            assert_eq!(
                store.load(&incompatible_names.unwrap()).err(),
                Some(CredentialError::PrivateStorageUnavailable)
            );
        }
        assert_eq!(
            store.create_new(&names, &passwords),
            Err(CredentialError::PrivateStorageUnavailable)
        );

        let bytes = Zeroizing::new(fs::read(&paths.credentials_store).unwrap());
        assert!(bytes.starts_with(b"{\"schema_version\":1,"));
        assert!(
            bytes
                .windows(b"\"database\":\"schedule\"".len())
                .any(|value| value == b"\"database\":\"schedule\"")
        );
        assert!(bytes.ends_with(b"}\n"));
        assert!(
            !append_suffix(&paths.credentials_store, PENDING_SUFFIX)
                .unwrap()
                .exists()
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&paths.private_root)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(&paths.credentials_store)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }

        fs::remove_file(&paths.credentials_store).unwrap();
        fs::remove_dir(&paths.temporary_secrets_root).unwrap();
        fs::remove_dir(&paths.private_root).unwrap();
        fs::remove_dir(parent).unwrap();
    }

    #[test]
    fn persisted_passwords_require_canonical_base64url_and_distinct_values() {
        assert!(SecretString::from_persisted(format!("{}B", "A".repeat(42))).is_err());
        assert!(SecretString::from_persisted(format!("{}!", "A".repeat(42))).is_err());
        for final_byte in b"AEIMQUYcgkosw048" {
            assert!(
                SecretString::from_persisted(format!(
                    "{}{}",
                    "A".repeat(42),
                    char::from(*final_byte)
                ))
                .is_ok()
            );
        }

        let repeated = SecretString::from_persisted("A".repeat(43)).unwrap();
        let duplicate_store =
            encode_credentials(&names(), &repeated, &repeated, &repeated).unwrap();
        assert!(CredentialStoreV1::parse(duplicate_store.as_bytes()).is_err());

        let generated = PgRolePasswords::generate_for_cluster_initialization().unwrap();
        let mut noncanonical = encode_credentials(
            &names(),
            &generated.cluster_admin_password,
            &generated.owner_password,
            &generated.runtime_password,
        )
        .unwrap();
        noncanonical.pop();
        assert!(CredentialStoreV1::parse(noncanonical.as_bytes()).is_err());

        let max_names = PgNames::new(
            format!("d{}", "a".repeat(62)),
            format!("a{}", "b".repeat(62)),
            format!("o{}", "c".repeat(62)),
            format!("r{}", "d".repeat(62)),
        )
        .unwrap();
        let encoded = encode_credentials(
            &max_names,
            &generated.cluster_admin_password,
            &generated.owner_password,
            &generated.runtime_password,
        )
        .unwrap();
        assert!(encoded.len() < MAX_CREDENTIAL_STORE_BYTES);
        assert!(encoded.capacity() >= MAX_CREDENTIAL_STORE_BYTES);
    }

    #[test]
    fn strict_v1_schema_rejects_malformed_records() {
        let canonical = canonical_test_record();
        let malformed_password = format!("{}!", "a".repeat(42));
        let valid_password = format!("{}A", "a".repeat(42));
        let cases = [
            canonical.replacen("\"schema_version\":1", "\"schema_version\":2", 1),
            canonical.replacen("\"schema_version\":1", "\"schema_version\":\"1\"", 1),
            canonical.replacen("\"database\":\"schedule\",", "", 1),
            canonical.replacen(
                "\"database\":\"schedule\"",
                "\"database\":\"schedule\",\"database\":\"schedule\"",
                1,
            ),
            canonical.replacen(&valid_password, &malformed_password, 1),
        ];
        for record in cases {
            let record = Zeroizing::new(record);
            assert!(CredentialStoreV1::parse(record.as_bytes()).is_err());
        }
    }

    #[test]
    fn recovers_only_an_exact_canonical_pending_store() {
        let parent = test_parent();
        let paths = runtime_paths(&parent);
        let store = PgCredentialStore::prepare(&paths).unwrap();
        let names = names();
        let passwords = PgRolePasswords::generate_for_cluster_initialization().unwrap();
        store.create_new(&names, &passwords).unwrap();
        let pending = append_suffix(&paths.credentials_store, PENDING_SUFFIX).unwrap();

        fs::rename(&paths.credentials_store, &pending).unwrap();
        assert!(
            store
                .load(&names)
                .unwrap()
                .unwrap()
                .runtime_password
                .expose()
                == passwords.runtime_password.expose()
        );
        assert!(paths.credentials_store.is_file());
        assert!(!pending.exists());

        fs::hard_link(&paths.credentials_store, &pending).unwrap();
        store.load(&names).unwrap().unwrap();
        assert!(!pending.exists());
        let final_before = Zeroizing::new(fs::read(&paths.credentials_store).unwrap());

        let other = PgRolePasswords::generate_for_cluster_initialization().unwrap();
        let different = encode_credentials(
            &names,
            &other.cluster_admin_password,
            &other.owner_password,
            &other.runtime_password,
        )
        .unwrap();
        let mut mismatched_pending = create_private_file(&pending).unwrap();
        mismatched_pending.write_all(different.as_bytes()).unwrap();
        mismatched_pending.sync_all().unwrap();
        drop(mismatched_pending);
        assert_eq!(
            store.load(&names).err(),
            Some(CredentialError::PrivateStorageUnavailable)
        );
        assert!(paths.credentials_store.exists() && pending.exists());
        assert!(fs::read(&paths.credentials_store).unwrap().as_slice() == final_before.as_slice());
        fs::remove_file(&pending).unwrap();

        for invalid in [b"{}\n".to_vec(), vec![b'x'; MAX_CREDENTIAL_STORE_BYTES + 1]] {
            write_private(&pending, &invalid);
            assert_eq!(
                store.load(&names).err(),
                Some(CredentialError::PrivateStorageUnavailable)
            );
            assert!(
                fs::read(&paths.credentials_store).unwrap().as_slice() == final_before.as_slice()
            );
            fs::remove_file(&pending).unwrap();
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let target = paths.private_root.join("pending-target");
            write_private(&target, b"not the pending store");
            symlink(&target, &pending).unwrap();
            assert_eq!(
                store.load(&names).err(),
                Some(CredentialError::PrivateStorageUnavailable)
            );
            assert!(
                fs::read(&paths.credentials_store).unwrap().as_slice() == final_before.as_slice()
            );
            fs::remove_file(&pending).unwrap();
            fs::remove_file(target).unwrap();
        }

        fs::remove_file(&paths.credentials_store).unwrap();
        fs::remove_dir(&paths.temporary_secrets_root).unwrap();
        fs::remove_dir(&paths.private_root).unwrap();
        fs::remove_dir(parent).unwrap();
    }

    #[test]
    fn rejects_noncanonical_or_unknown_v1_store_fields() {
        let parent = test_parent();
        let paths = runtime_paths(&parent);
        let store = PgCredentialStore::prepare(&paths).unwrap();
        let mut file = create_private_file(&paths.credentials_store).unwrap();
        let invalid = format!(
            "{{\"schema_version\":1,\"database\":\"schedule\",\"cluster_admin\":\"schedule_cluster_admin\",\"owner\":\"schedule_owner\",\"runtime\":\"schedule_runtime\",\"cluster_admin_password\":\"{}A\",\"owner_password\":\"{}E\",\"runtime_password\":\"{}I\",\"extra\":true}}\n",
            "a".repeat(42),
            "b".repeat(42),
            "c".repeat(42),
        );
        file.write_all(invalid.as_bytes()).unwrap();
        file.sync_all().unwrap();
        drop(file);
        assert_eq!(
            store.load(&names()).err(),
            Some(CredentialError::PrivateStorageUnavailable)
        );

        fs::remove_file(&paths.credentials_store).unwrap();
        fs::remove_dir(&paths.temporary_secrets_root).unwrap();
        fs::remove_dir(&paths.private_root).unwrap();
        fs::remove_dir(parent).unwrap();
    }

    #[test]
    fn scavenger_removes_only_valid_nonrecursive_stale_launch_material() {
        let parent = test_parent();
        let paths = runtime_paths(&parent);
        PgCredentialStore::prepare(&paths).unwrap();
        let passwords = PgRolePasswords::generate_for_cluster_initialization().unwrap();
        let mut private = PrivateRuntimeFiles::create(&paths.temporary_secrets_root).unwrap();
        let stale = private.directory().to_owned();
        private.write_initial_password(&passwords).unwrap();
        std::mem::forget(private);
        let unrelated = paths.temporary_secrets_root.join("keep-me");
        fs::create_dir(&unrelated).unwrap();

        assert_eq!(
            scavenge_stale_launch_secrets(&paths.temporary_secrets_root).unwrap(),
            1
        );
        assert!(!stale.exists());
        assert!(unrelated.exists());

        fs::remove_dir(unrelated).unwrap();
        fs::remove_dir(&paths.temporary_secrets_root).unwrap();
        fs::remove_dir(&paths.private_root).unwrap();
        fs::remove_dir(parent).unwrap();
    }

    #[test]
    fn scavenger_fails_closed_on_unrecognized_nested_content() {
        let parent = test_parent();
        let paths = runtime_paths(&parent);
        PgCredentialStore::prepare(&paths).unwrap();
        let private = PrivateRuntimeFiles::create(&paths.temporary_secrets_root).unwrap();
        let stale = private.directory().to_owned();
        std::mem::forget(private);
        fs::create_dir(stale.join("unexpected-directory")).unwrap();

        assert_eq!(
            scavenge_stale_launch_secrets(&paths.temporary_secrets_root),
            Err(CredentialError::PrivateStorageUnavailable)
        );
        assert!(stale.join("unexpected-directory").exists());

        fs::remove_dir(stale.join("unexpected-directory")).unwrap();
        fs::remove_dir(stale).unwrap();
        fs::remove_dir(&paths.temporary_secrets_root).unwrap();
        fs::remove_dir(&paths.private_root).unwrap();
        fs::remove_dir(parent).unwrap();
    }

    #[test]
    fn scavenger_bounds_fail_without_partial_deletion() {
        let parent = test_parent();
        let paths = runtime_paths(&parent);
        PgCredentialStore::prepare(&paths).unwrap();

        let private = PrivateRuntimeFiles::create(&paths.temporary_secrets_root).unwrap();
        let stale = private.directory().to_owned();
        std::mem::forget(private);
        let unrelated = (0..MAX_TEMP_ROOT_ENTRIES)
            .map(|index| {
                paths
                    .temporary_secrets_root
                    .join(format!("unrelated-{index}"))
            })
            .collect::<Vec<_>>();
        for path in &unrelated {
            fs::write(path, b"").unwrap();
        }
        assert_eq!(
            scavenge_stale_launch_secrets(&paths.temporary_secrets_root),
            Err(CredentialError::PrivateStorageUnavailable)
        );
        assert!(stale.exists());
        for path in unrelated {
            fs::remove_file(path).unwrap();
        }
        fs::remove_dir(stale).unwrap();

        let private = PrivateRuntimeFiles::create(&paths.temporary_secrets_root).unwrap();
        let stale = private.directory().to_owned();
        std::mem::forget(private);
        let files = (0..=MAX_STALE_SECRET_FILES)
            .map(|index| stale.join(format!(".pending-{index:032x}")))
            .collect::<Vec<_>>();
        for path in &files {
            write_private(path, b"secret");
        }
        assert_eq!(
            scavenge_stale_launch_secrets(&paths.temporary_secrets_root),
            Err(CredentialError::PrivateStorageUnavailable)
        );
        assert!(files.iter().all(|path| path.exists()));
        for path in files {
            fs::remove_file(path).unwrap();
        }
        fs::remove_dir(stale).unwrap();

        fs::remove_dir(&paths.temporary_secrets_root).unwrap();
        fs::remove_dir(&paths.private_root).unwrap();
        fs::remove_dir(parent).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn durable_store_rejects_insecure_roots_and_linked_files() {
        use std::os::unix::fs::{PermissionsExt, symlink};

        let parent = test_parent();
        let paths = runtime_paths(&parent);
        fs::create_dir(&paths.private_root).unwrap();
        fs::set_permissions(&paths.private_root, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(PgCredentialStore::prepare(&paths).is_err());
        fs::remove_dir(&paths.private_root).unwrap();

        let store = PgCredentialStore::prepare(&paths).unwrap();
        let target = paths.private_root.join("target");
        let mut target_file = create_private_file(&target).unwrap();
        target_file.write_all(b"not credentials").unwrap();
        drop(target_file);
        symlink(&target, &paths.credentials_store).unwrap();
        assert_eq!(
            store.load(&names()).err(),
            Some(CredentialError::PrivateStorageUnavailable)
        );
        fs::remove_file(&paths.credentials_store).unwrap();

        let credentials = PgRolePasswords::generate_for_cluster_initialization().unwrap();
        store.create_new(&names(), &credentials).unwrap();
        fs::set_permissions(&paths.credentials_store, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(store.load(&names()).is_err());
        fs::set_permissions(&paths.credentials_store, fs::Permissions::from_mode(0o600)).unwrap();

        fs::set_permissions(
            &paths.temporary_secrets_root,
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        assert!(scavenge_stale_launch_secrets(&paths.temporary_secrets_root).is_err());
        fs::set_permissions(
            &paths.temporary_secrets_root,
            fs::Permissions::from_mode(0o700),
        )
        .unwrap();

        let private = PrivateRuntimeFiles::create(&paths.temporary_secrets_root).unwrap();
        let stale = private.directory().to_owned();
        std::mem::forget(private);
        symlink(&target, stale.join("initial-password")).unwrap();
        assert!(scavenge_stale_launch_secrets(&paths.temporary_secrets_root).is_err());
        fs::remove_file(stale.join("initial-password")).unwrap();
        write_private(&stale.join("initial-password"), b"secret");
        fs::set_permissions(
            stale.join("initial-password"),
            fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        assert!(scavenge_stale_launch_secrets(&paths.temporary_secrets_root).is_err());

        fs::remove_file(stale.join("initial-password")).unwrap();
        fs::remove_dir(stale).unwrap();
        fs::remove_file(&paths.credentials_store).unwrap();
        fs::remove_file(target).unwrap();
        fs::remove_dir(&paths.temporary_secrets_root).unwrap();
        fs::remove_dir(&paths.private_root).unwrap();
        fs::remove_dir(parent).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_reparse_points_are_rejected_when_symlink_creation_is_available() {
        use std::os::windows::fs::{symlink_dir, symlink_file};

        let parent = test_parent();
        let paths = runtime_paths(&parent);
        let store = PgCredentialStore::prepare(&paths).unwrap();
        let target = paths.private_root.join("reparse-target");
        write_private(&target, b"target remains untouched");
        if let Err(error) = symlink_file(&target, &paths.credentials_store) {
            // Windows installations without Developer Mode or symlink privilege cannot exercise
            // this negative path locally; CI environments that permit symlinks run it fully.
            assert!(
                error.kind() == std::io::ErrorKind::PermissionDenied
                    || error.raw_os_error() == Some(1314)
            );
            eprintln!("Windows symlink/reparse negative test skipped: {error}");
            fs::remove_file(target).unwrap();
            fs::remove_dir(&paths.temporary_secrets_root).unwrap();
            fs::remove_dir(&paths.private_root).unwrap();
            fs::remove_dir(parent).unwrap();
            return;
        }
        assert!(store.load(&names()).is_err());
        fs::remove_file(&paths.credentials_store).unwrap();

        let passwords = PgRolePasswords::generate_for_cluster_initialization().unwrap();
        store.create_new(&names(), &passwords).unwrap();
        let final_before = Zeroizing::new(fs::read(&paths.credentials_store).unwrap());
        let pending = append_suffix(&paths.credentials_store, PENDING_SUFFIX).unwrap();
        symlink_file(&target, &pending).unwrap();
        assert!(store.load(&names()).is_err());
        assert!(fs::read(&paths.credentials_store).unwrap().as_slice() == final_before.as_slice());
        fs::remove_file(pending).unwrap();
        fs::remove_file(&paths.credentials_store).unwrap();

        let private = PrivateRuntimeFiles::create(&paths.temporary_secrets_root).unwrap();
        let stale = private.directory().to_owned();
        std::mem::forget(private);
        symlink_file(&target, stale.join("initial-password")).unwrap();
        assert!(scavenge_stale_launch_secrets(&paths.temporary_secrets_root).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"target remains untouched");
        fs::remove_file(stale.join("initial-password")).unwrap();
        fs::remove_dir(stale).unwrap();

        fs::remove_dir(&paths.temporary_secrets_root).unwrap();
        let actual_temp = paths.private_root.join("actual-temp");
        create_private_directory(&actual_temp).unwrap();
        symlink_dir(&actual_temp, &paths.temporary_secrets_root).unwrap();
        assert!(scavenge_stale_launch_secrets(&paths.temporary_secrets_root).is_err());
        fs::remove_dir(&paths.temporary_secrets_root).unwrap();
        fs::remove_dir(actual_temp).unwrap();
        fs::remove_file(target).unwrap();
        fs::remove_dir(&paths.private_root).unwrap();
        fs::remove_dir(parent).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_unprotected_user_only_dacls_are_rejected() {
        let parent = test_parent();
        let paths = runtime_paths(&parent);
        let store = PgCredentialStore::prepare(&paths).unwrap();

        fs::remove_dir(&paths.temporary_secrets_root).unwrap();
        windows_private::create_unprotected_directory(&paths.temporary_secrets_root).unwrap();
        assert_eq!(
            scavenge_stale_launch_secrets(&paths.temporary_secrets_root),
            Err(CredentialError::PrivateStorageUnavailable)
        );
        fs::remove_dir(&paths.temporary_secrets_root).unwrap();
        create_private_directory(&paths.temporary_secrets_root).unwrap();

        let contents = canonical_test_record();
        let mut file = windows_private::create_unprotected_file(&paths.credentials_store).unwrap();
        file.write_all(contents.as_bytes()).unwrap();
        file.sync_all().unwrap();
        drop(file);
        assert_eq!(
            store.load(&names()).err(),
            Some(CredentialError::PrivateStorageUnavailable)
        );

        fs::remove_file(&paths.credentials_store).unwrap();
        fs::remove_dir(&paths.temporary_secrets_root).unwrap();
        fs::remove_dir(&paths.private_root).unwrap();
        fs::remove_dir(parent).unwrap();
    }

    #[test]
    fn explicit_cleanup_surfaces_secret_file_deletion_failures() {
        let parent = test_parent();
        let passwords = PgRolePasswords::generate_for_cluster_initialization().unwrap();
        let mut private = PrivateRuntimeFiles::create(&parent).unwrap();
        let directory = private.directory().to_owned();
        let tracked = private.write_initial_password(&passwords).unwrap();
        fs::remove_file(&tracked).unwrap();
        fs::create_dir(&tracked).unwrap();
        assert_eq!(
            private.cleanup(),
            Err(CredentialError::PrivateStorageUnavailable)
        );
        fs::remove_dir(tracked).unwrap();
        fs::remove_dir(directory).unwrap();
        fs::remove_dir(parent).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlinked_parent() {
        use std::os::unix::fs::symlink;
        let root = test_parent();
        let actual = root.join("actual");
        let linked = root.join("linked");
        fs::create_dir(&actual).unwrap();
        symlink(&actual, &linked).unwrap();
        assert!(PrivateRuntimeFiles::create(&linked).is_err());
        fs::remove_file(linked).unwrap();
        fs::remove_dir(actual).unwrap();
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn errors_are_stable_and_secret_free() {
        let secret = SecretString::generate().unwrap();
        let private_path = r"C:\Users\private\schedule-credentials";
        for (error, code) in [
            (
                CredentialError::EntropyUnavailable,
                "desktop.credentials_entropy_unavailable",
            ),
            (
                CredentialError::InvalidInput,
                "desktop.credentials_invalid_input",
            ),
            (
                CredentialError::PrivateStorageUnavailable,
                "desktop.credentials_private_storage_unavailable",
            ),
        ] {
            let rendered = format!("{error:?}|{error}");
            assert!(rendered.contains(code));
            assert!(!rendered.contains(secret.expose()));
            assert!(!rendered.contains(private_path));
        }
    }
}
