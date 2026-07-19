//! Crash-recovery journal for the bundled runtime.
//!
//! This file deliberately records only lifecycle facts.  It must never contain
//! database passwords, desktop bearer tokens, request data, or child-process
//! environments.  A journal is written to a per-user mutable directory, never
//! beside the immutable application runtime.

use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};

pub const JOURNAL_SCHEMA_VERSION: u8 = 1;
const MAX_VERSION_LENGTH: usize = 128;
const TEMP_SUFFIX: &str = ".next";

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JournalPhase {
    Initializing,
    StartingDatabase,
    VerifyingDatabase,
    BackingUpDatabase,
    MigratingDatabase,
    StartingApi,
    StartingWorker,
    Ready,
    Stopping,
}

impl JournalPhase {
    fn is_interrupted_setup(&self) -> bool {
        matches!(
            self,
            Self::Initializing | Self::StartingDatabase | Self::VerifyingDatabase
        )
    }
}

/// Strict, versioned, secret-free state left by a desktop start attempt.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LifecycleJournal {
    pub schema_version: u8,
    pub attempt: Attempt,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prior_success: Option<SuccessfulRuntime>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Attempt {
    pub id: u64,
    pub started_at_unix_seconds: u64,
    pub phase: JournalPhase,
    pub runtime_version: String,
    pub database_schema_version: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SuccessfulRuntime {
    pub runtime_version: String,
    pub database_schema_version: String,
    pub completed_at_unix_seconds: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RecoveryDecision {
    /// A clean shutdown or a missing journal requires ordinary startup.
    StartNormally,
    /// No irreversible database step began; stale child processes may be
    /// stopped and the normal startup sequence can be retried.
    RetryInterruptedStartup,
    /// A backup is required before retrying migration.  The supervisor must
    /// not run migrations merely because this decision was returned.
    RestoreOrRetryMigration {
        prior_success: Option<SuccessfulRuntime>,
    },
    /// Ready/Stopping can mean the app or OS died after processes started.
    /// Stop known children, then start normally.
    CleanupThenStart,
}

impl LifecycleJournal {
    pub fn new(
        attempt_id: u64,
        started_at_unix_seconds: u64,
        runtime_version: String,
        database_schema_version: String,
        prior_success: Option<SuccessfulRuntime>,
    ) -> Result<Self, JournalError> {
        let journal = Self {
            schema_version: JOURNAL_SCHEMA_VERSION,
            attempt: Attempt {
                id: attempt_id,
                started_at_unix_seconds,
                phase: JournalPhase::Initializing,
                runtime_version,
                database_schema_version,
            },
            prior_success,
        };
        journal.validate()?;
        Ok(journal)
    }

    pub fn set_phase(&mut self, phase: JournalPhase) {
        self.attempt.phase = phase;
    }

    pub fn mark_success(&mut self, completed_at_unix_seconds: u64) {
        self.prior_success = Some(SuccessfulRuntime {
            runtime_version: self.attempt.runtime_version.clone(),
            database_schema_version: self.attempt.database_schema_version.clone(),
            completed_at_unix_seconds,
        });
        self.attempt.phase = JournalPhase::Ready;
    }

    pub fn recovery_decision(&self) -> RecoveryDecision {
        if self.attempt.phase.is_interrupted_setup() {
            RecoveryDecision::RetryInterruptedStartup
        } else if matches!(
            self.attempt.phase,
            JournalPhase::BackingUpDatabase | JournalPhase::MigratingDatabase
        ) {
            RecoveryDecision::RestoreOrRetryMigration {
                prior_success: self.prior_success.clone(),
            }
        } else {
            RecoveryDecision::CleanupThenStart
        }
    }

    pub fn validate(&self) -> Result<(), JournalError> {
        if self.schema_version != JOURNAL_SCHEMA_VERSION {
            return Err(JournalError::UnsupportedSchema(self.schema_version));
        }
        validate_version("attempt.runtime_version", &self.attempt.runtime_version)?;
        validate_version(
            "attempt.database_schema_version",
            &self.attempt.database_schema_version,
        )?;
        if let Some(prior) = &self.prior_success {
            validate_version("prior_success.runtime_version", &prior.runtime_version)?;
            validate_version(
                "prior_success.database_schema_version",
                &prior.database_schema_version,
            )?;
        }
        Ok(())
    }
}

pub fn decide_recovery(journal: Option<&LifecycleJournal>) -> RecoveryDecision {
    journal.map_or(
        RecoveryDecision::StartNormally,
        LifecycleJournal::recovery_decision,
    )
}

#[derive(Debug)]
pub enum JournalError {
    Io(io::Error),
    Json(serde_json::Error),
    UnsupportedSchema(u8),
    InvalidVersion { field: &'static str },
}

impl std::fmt::Display for JournalError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "journal I/O failed: {error}"),
            Self::Json(error) => write!(formatter, "invalid lifecycle journal: {error}"),
            Self::UnsupportedSchema(version) => {
                write!(formatter, "unsupported journal schema {version}")
            }
            Self::InvalidVersion { field } => write!(formatter, "invalid journal {field}"),
        }
    }
}

impl std::error::Error for JournalError {}

impl From<io::Error> for JournalError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_json::Error> for JournalError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

/// Reads and validates a journal.  Unknown fields are rejected so a future
/// schema is never silently interpreted by an older desktop binary.
pub fn load(path: &Path) -> Result<Option<LifecycleJournal>, JournalError> {
    match fs::read(path) {
        Ok(bytes) => {
            let journal: LifecycleJournal = serde_json::from_slice(&bytes)?;
            journal.validate()?;
            Ok(Some(journal))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// Durably replaces `path` using a same-directory temporary file.
///
/// The data file is synced before rename and the parent is synced afterwards
/// where the platform permits it. Unix rename and Windows `MoveFileExW` replace
/// the old journal without first deleting it, so a crash leaves either the old
/// durable state or the new durable state.
pub fn store(path: &Path, journal: &LifecycleJournal) -> Result<(), JournalError> {
    journal.validate()?;
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "journal needs a parent directory",
        )
    })?;
    fs::create_dir_all(parent)?;
    let temporary = temporary_path(path);
    // The singleton lock is held before journal writes, so a leftover temporary
    // file can only belong to an interrupted earlier attempt. `create_new`
    // below remains the final guard against an unexpected concurrent writer.
    match fs::remove_file(&temporary) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let payload = serde_json::to_vec(journal)?;

    let write_result = (|| -> Result<(), JournalError> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&payload)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        drop(file);
        replace_target(&temporary, path)?;
        sync_directory(parent);
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

fn temporary_path(path: &Path) -> PathBuf {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    path.with_file_name(format!(".{name}{TEMP_SUFFIX}"))
}

#[cfg(not(windows))]
fn replace_target(temporary: &Path, target: &Path) -> io::Result<()> {
    fs::rename(temporary, target)
}

#[cfg(windows)]
fn replace_target(temporary: &Path, target: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    let temporary = wide(temporary);
    let target = wide(target);
    // SAFETY: Both buffers are NUL-terminated and remain alive for the duration
    // of the call. The singleton lock guarantees one journal writer.
    let replaced = unsafe {
        MoveFileExW(
            temporary.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if replaced == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn sync_directory(parent: &Path) {
    // Directory fsync is unsupported on Windows and some filesystems. The
    // journal remains valid even if this durability enhancement is unavailable.
    if let Ok(directory) = File::open(parent) {
        let _ = directory.sync_all();
    }
}

fn validate_version(field: &'static str, value: &str) -> Result<(), JournalError> {
    let valid = !value.is_empty()
        && value.len() <= MAX_VERSION_LENGTH
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'+' | b':')
        });
    if valid {
        Ok(())
    } else {
        Err(JournalError::InvalidVersion { field })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn journal() -> LifecycleJournal {
        LifecycleJournal::new(7, 100, "1.2.3".into(), "2026071901".into(), None).unwrap()
    }

    fn temporary_dir() -> PathBuf {
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("schedule-journal-{id}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn rejects_unknown_or_invalid_content() {
        let path = temporary_dir().join("journal.json");
        fs::write(&path, br#"{"schema_version":1,"attempt":{"id":1,"started_at_unix_seconds":0,"phase":"ready","runtime_version":"x","database_schema_version":"1"},"token":"never"}"#).unwrap();
        assert!(matches!(load(&path), Err(JournalError::Json(_))));
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn durable_replace_round_trips_without_a_temp_file() {
        let directory = temporary_dir();
        let path = directory.join("journal.json");
        let mut value = journal();
        store(&path, &value).unwrap();
        value.set_phase(JournalPhase::MigratingDatabase);
        store(&path, &value).unwrap();
        assert_eq!(load(&path).unwrap(), Some(value));
        assert!(!temporary_path(&path).exists());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn interrupted_migration_requires_explicit_recovery() {
        let mut value = journal();
        value.set_phase(JournalPhase::MigratingDatabase);
        assert_eq!(
            decide_recovery(Some(&value)),
            RecoveryDecision::RestoreOrRetryMigration {
                prior_success: None
            }
        );
        value.mark_success(200);
        assert_eq!(
            decide_recovery(Some(&value)),
            RecoveryDecision::CleanupThenStart
        );
    }

    #[test]
    fn startup_interruption_retries_and_missing_journal_starts_normally() {
        assert_eq!(decide_recovery(None), RecoveryDecision::StartNormally);
        assert_eq!(
            decide_recovery(Some(&journal())),
            RecoveryDecision::RetryInterruptedStartup
        );
    }

    #[test]
    fn versions_cannot_smuggle_control_data() {
        assert!(matches!(
            LifecycleJournal::new(1, 1, "1.0\nTOKEN=x".into(), "1".into(), None),
            Err(JournalError::InvalidVersion { .. })
        ));
    }
}
