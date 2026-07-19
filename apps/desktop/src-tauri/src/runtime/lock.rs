use std::{
    fmt,
    fs::{self, File, OpenOptions},
    io,
    path::{Path, PathBuf},
};

use fs2::FileExt;

/// Stable, non-diagnostic failure categories for local-runtime coordination. Paths and operating
/// system messages are deliberately excluded because the lock location is user-specific.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct RuntimeLockError {
    code: &'static str,
}

impl RuntimeLockError {
    const fn already_running() -> Self {
        Self {
            code: "desktop.runtime_already_running",
        }
    }

    const fn io() -> Self {
        Self {
            code: "desktop.runtime_lock_io",
        }
    }

    pub(crate) const fn code(self) -> &'static str {
        self.code
    }
}

impl fmt::Display for RuntimeLockError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl std::error::Error for RuntimeLockError {}

/// An advisory, per-user single-instance lock. Holding this value keeps the file handle open and
/// therefore keeps the operating-system lock alive. The lock file itself is intentionally kept on
/// disk after release: deleting a coordination file creates a replacement race and is unnecessary
/// for advisory locking.
pub(crate) struct RuntimeLock {
    file: File,
    _path: PathBuf,
}

impl RuntimeLock {
    pub(crate) fn acquire(path: impl AsRef<Path>) -> Result<Self, RuntimeLockError> {
        let path = path.as_ref();
        let parent = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty());
        let Some(parent) = parent else {
            return Err(RuntimeLockError::io());
        };

        fs::create_dir_all(parent).map_err(|_| RuntimeLockError::io())?;
        reject_symlink(path)?;

        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .open(path)
            .map_err(|_| RuntimeLockError::io())?;

        // `OpenOptions` follows links on some platforms. Check again before locking or writing so
        // an existing symlink is never used as the runtime's coordination file.
        reject_symlink(path)?;

        match file.try_lock_exclusive() {
            Ok(()) => Ok(Self {
                file,
                _path: path.to_path_buf(),
            }),
            Err(error) if is_lock_contention(&error) => Err(RuntimeLockError::already_running()),
            Err(_) => Err(RuntimeLockError::io()),
        }
    }
}

fn is_lock_contention(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::WouldBlock
        // `LockFileEx` reports ERROR_LOCK_VIOLATION, which Rust does not map to
        // WouldBlock on every supported toolchain.
        || (cfg!(windows) && error.raw_os_error() == Some(33))
}

impl Drop for RuntimeLock {
    fn drop(&mut self) {
        // Only this owner retains the locked handle. The file remains in place, so no later owner
        // can have its lock file removed by an earlier instance during shutdown.
        let _ = self.file.unlock();
    }
}

fn reject_symlink(path: &Path) -> Result<(), RuntimeLockError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(RuntimeLockError::io()),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(RuntimeLockError::io()),
    }
}

#[cfg(test)]
mod tests {
    use std::{
        env, fs,
        path::PathBuf,
        process,
        sync::atomic::{AtomicUsize, Ordering},
    };

    use super::*;

    static TEST_SEQUENCE: AtomicUsize = AtomicUsize::new(0);

    fn unique_lock_path() -> PathBuf {
        let sequence = TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        env::temp_dir()
            .join(format!(
                "schedule-runtime-lock-{}-{sequence}",
                process::id()
            ))
            .join("nested")
            .join("singleton.lock")
    }

    #[test]
    fn creates_the_missing_parent_directory_and_keeps_the_lock_file() {
        let path = unique_lock_path();
        let lock = RuntimeLock::acquire(&path).unwrap();
        assert!(path.is_file());
        drop(lock);
        assert!(path.is_file());
        let _ = fs::remove_dir_all(path.ancestors().nth(2).unwrap());
    }

    #[test]
    fn only_one_contender_can_hold_a_lock_and_release_allows_reacquisition() {
        let path = unique_lock_path();
        let first = RuntimeLock::acquire(&path).unwrap();

        let second = match RuntimeLock::acquire(&path) {
            Ok(_) => panic!("second contender acquired the runtime lock"),
            Err(error) => error,
        };
        assert_eq!(second.code(), "desktop.runtime_already_running");

        drop(first);
        let reacquired = RuntimeLock::acquire(&path).unwrap();
        drop(reacquired);
        let _ = fs::remove_dir_all(path.ancestors().nth(2).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlinked_lock_file_without_exposing_its_destination() {
        use std::os::unix::fs::symlink;

        let path = unique_lock_path();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let target = path.parent().unwrap().join("target.lock");
        fs::write(&target, "not a lock").unwrap();
        symlink(&target, &path).unwrap();

        let error = match RuntimeLock::acquire(&path) {
            Ok(_) => panic!("symlinked lock file was accepted"),
            Err(error) => error,
        };
        assert_eq!(error.code(), "desktop.runtime_lock_io");
        assert!(!format!("{error:?} {error}").contains("target.lock"));
        let _ = fs::remove_dir_all(path.ancestors().nth(2).unwrap());
    }
}
