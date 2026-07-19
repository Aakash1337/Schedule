//! Runtime credentials and fail-closed private bootstrap files.
//!
//! Secrets deliberately have no `Debug`, `Display`, `Clone`, or serialization
//! implementation. PostgreSQL passwords are transferred through private files;
//! [`LibpqEnvironment`] contains only non-secret connection settings.

use std::{
    ffi::{OsStr, OsString},
    fmt,
    fs::{self, File},
    io::Write,
    path::{Component, Path, PathBuf},
};

use zeroize::Zeroizing;

use super::safe_pg_identifier;

#[cfg(not(windows))]
use std::fs::OpenOptions;

const SECRET_BYTES: usize = 32;
const MAX_PRIVATE_FILE_BYTES: usize = 1024 * 1024;
const LOOPBACK_HOST: &str = "127.0.0.1";

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
/// new cluster. Before [`PrivateRuntimeFiles`] is cleaned up, the coordinator
/// must persist these values in a separately protected durable credential
/// store. Existing clusters must reload that durable state, never regenerate
/// role passwords. That persistent store is intentionally outside this module.
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
        contents.push_str(passwords.cluster_admin_password.expose());
        contents.push('\n');
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
        let mut contents = Zeroizing::new(String::with_capacity(256));
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
        let mut sql = Zeroizing::new(String::with_capacity(1536));
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
        let mut contents = Zeroizing::new(String::with_capacity(128));
        use std::fmt::Write as _;
        write!(
            contents,
            "{LOOPBACK_HOST}:{port}:{database}:{user}:{}\n",
            password.expose(),
        )
        .map_err(|_| CredentialError::PrivateStorageUnavailable)?;
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
    verify_private_file_permissions(&metadata)
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
fn verify_private_file_permissions(metadata: &fs::Metadata) -> Result<(), CredentialError> {
    use std::os::unix::fs::PermissionsExt;
    (metadata.permissions().mode() & 0o777 == 0o600)
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
fn verify_private_file_permissions(_metadata: &fs::Metadata) -> Result<(), CredentialError> {
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

#[cfg(not(any(unix, windows)))]
fn publish(_temporary: &Path, _destination: &Path) -> Result<(), CredentialError> {
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
            GetAclInformation, GetFileSecurityW, GetLengthSid, GetSecurityDescriptorDacl,
            GetTokenInformation, InitializeAcl, InitializeSecurityDescriptor, SE_DACL_PROTECTED,
            SECURITY_ATTRIBUTES, SECURITY_DESCRIPTOR, SetSecurityDescriptorControl,
            SetSecurityDescriptorDacl, TOKEN_QUERY, TOKEN_USER, TokenUser,
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
            || unsafe {
                SetSecurityDescriptorControl(descriptor_ptr, SE_DACL_PROTECTED, SE_DACL_PROTECTED)
            } == 0
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

    pub(super) fn create_directory(path: &Path) -> std::io::Result<()> {
        let path = wide(path)?;
        with_user_only_security(|security, sid| {
            if unsafe { CreateDirectoryW(path.as_ptr(), security) } == 0 {
                Err(std::io::Error::last_os_error())
            } else {
                verify_user_only_dacl(&path, sid)
            }
        })
    }

    pub(super) fn create_file(path: &Path) -> std::io::Result<File> {
        let path = wide(path)?;
        with_user_only_security(|security, sid| {
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
                verify_user_only_dacl(&path, sid)?;
                Ok(file)
            }
        })
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
fn verify_private_file_permissions(_metadata: &fs::Metadata) -> Result<(), CredentialError> {
    // Creation uses an explicit DACL containing exactly one full-access ACE for
    // the current process user. Any failure to construct it aborts creation.
    Ok(())
}

#[cfg(windows)]
fn publish(temporary: &Path, destination: &Path) -> Result<(), CredentialError> {
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
        assert_eq!(
            CredentialError::PrivateStorageUnavailable.to_string(),
            "desktop.credentials_private_storage_unavailable"
        );
        assert_eq!(
            format!("{:?}", CredentialError::EntropyUnavailable),
            "EntropyUnavailable"
        );
    }
}
