//! Hidden installed-runtime lifecycle smoke entrypoint.

use std::{
    ffi::OsString,
    fs, io,
    path::{Path, PathBuf},
    sync::Arc,
    thread,
    time::{Duration, Instant},
};

use super::{
    bootstrap::build_host,
    host::{RuntimeState, ShutdownOutcome},
    tauri_adapter::shutdown_and_contain,
};

pub(crate) const INVALID_ARGUMENTS: i32 = 2;
pub(crate) const SETUP_OR_TRUST_ANCHOR_FAILURE: i32 = 10;
pub(crate) const STARTUP_OR_WORKER_FAILURE: i32 = 11;
pub(crate) const INCOMPATIBLE_DATA: i32 = 12;
pub(crate) const STARTUP_TIMEOUT: i32 = 13;
pub(crate) const SHUTDOWN_OR_CONTAINMENT_FAILURE: i32 = 14;
const STARTUP_WAIT: Duration = Duration::from_secs(300);
const SHUTDOWN_WAIT: Duration = Duration::from_secs(120);
const POLL_INTERVAL: Duration = Duration::from_millis(20);
const SENTINEL: &str = "--schedule-runtime-smoke";

struct SmokeRoots {
    runtime_root: PathBuf,
    data_root: PathBuf,
}

struct DataDirectory {
    path: PathBuf,
    identity: PathBuf,
}

/// Returns whether this invocation was consumed. A malformed smoke invocation
/// is deliberately not allowed to fall through into the GUI.
pub(crate) fn run_if_requested() -> bool {
    let args: Vec<OsString> = std::env::args_os().collect();
    if args.get(1).is_none_or(|arg| arg != SENTINEL) {
        return false;
    }
    let code = parse_roots(&args).map_or(INVALID_ARGUMENTS, run);
    std::process::exit(code);
}

fn parse_roots(args: &[OsString]) -> Result<SmokeRoots, ()> {
    if args.len() != 6
        || args.get(1).is_none_or(|value| value != SENTINEL)
        || args.get(2).is_none_or(|value| value != "--runtime-root")
        || args.get(4).is_none_or(|value| value != "--data-root")
    {
        return Err(());
    }
    let runtime_root = canonical_directory(PathBuf::from(&args[3]))?;
    let data_root = validated_data_directory(PathBuf::from(&args[5]))?;
    if overlaps(&runtime_root, &data_root.identity) {
        return Err(());
    }
    Ok(SmokeRoots {
        runtime_root,
        data_root: data_root.path,
    })
}

fn canonical_directory(path: PathBuf) -> Result<PathBuf, ()> {
    if !path.is_absolute() || !regular_directory(&path) {
        return Err(());
    }
    fs::canonicalize(path).map_err(|_| ())
}

fn validated_data_directory(path: PathBuf) -> Result<DataDirectory, ()> {
    if !path.is_absolute() {
        return Err(());
    }
    let identity = match fs::symlink_metadata(&path) {
        Ok(_) => canonical_directory(path.clone())?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let name = path.file_name().ok_or(())?.to_owned();
            let parent = canonical_directory(path.parent().ok_or(())?.to_owned())?;
            let candidate = parent.join(name);
            match fs::symlink_metadata(&candidate) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => candidate,
                _ => return Err(()),
            }
        }
        Err(_) => return Err(()),
    };
    // Keep the caller's ordinary absolute spelling for runtime storage. On
    // Windows, fs::canonicalize adds a verbatim prefix that cannot be walked
    // component-by-component by the private-directory trust checks.
    Ok(DataDirectory { path, identity })
}

fn regular_directory(path: &Path) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return false;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return false;
        }
    }
    true
}

fn overlaps(left: &Path, right: &Path) -> bool {
    left == right || left.starts_with(right) || right.starts_with(left)
}

fn run(roots: SmokeRoots) -> i32 {
    let bridge = match crate::bridge::DesktopApiForwarder::new() {
        Ok(bridge) => Arc::new(bridge),
        Err(_) => return SETUP_OR_TRUST_ANCHOR_FAILURE,
    };
    let (host, containment) = match build_host(roots.runtime_root, roots.data_root, bridge) {
        Ok(value) => value,
        Err(_) => return SETUP_OR_TRUST_ANCHOR_FAILURE,
    };
    let startup = if host.auto_start().is_err() {
        STARTUP_OR_WORKER_FAILURE
    } else {
        await_ready(&host)
    };
    let contained = shutdown_and_contain(
        &host,
        Some(containment.as_ref()),
        Instant::now() + SHUTDOWN_WAIT,
    );
    if !contained {
        SHUTDOWN_OR_CONTAINMENT_FAILURE
    } else {
        startup
    }
}

fn await_ready(host: &super::host::RuntimeHost) -> i32 {
    let deadline = Instant::now() + STARTUP_WAIT;
    loop {
        if let Some(result) = startup_result(host.status().state, host.completion().outcome()) {
            return result;
        }
        if Instant::now() >= deadline {
            return STARTUP_TIMEOUT;
        }
        thread::sleep(POLL_INTERVAL);
    }
}

fn startup_result(state: RuntimeState, completion: Option<ShutdownOutcome>) -> Option<i32> {
    match state {
        RuntimeState::Ready => Some(0),
        RuntimeState::IncompatibleData => Some(INCOMPATIBLE_DATA),
        RuntimeState::RecoverableFailure | RuntimeState::Stopping => {
            Some(STARTUP_OR_WORKER_FAILURE)
        }
        RuntimeState::Idle | RuntimeState::Starting if completion.is_some() => {
            Some(STARTUP_OR_WORKER_FAILURE)
        }
        RuntimeState::Idle | RuntimeState::Starting => None,
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    use super::*;

    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    struct TempRoots {
        base: PathBuf,
        runtime: PathBuf,
        data: PathBuf,
    }

    impl Drop for TempRoots {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    fn roots() -> TempRoots {
        static NEXT_ROOT: AtomicU64 = AtomicU64::new(0);

        let base = std::env::temp_dir().join(format!(
            "schedule-smoke-{}-{}",
            std::process::id(),
            NEXT_ROOT.fetch_add(1, Ordering::Relaxed),
        ));
        let runtime = base.join("runtime");
        let data = base.join("data");
        fs::create_dir(&base).unwrap();
        fs::create_dir_all(&runtime).unwrap();
        fs::create_dir_all(&data).unwrap();
        TempRoots {
            base,
            runtime,
            data,
        }
    }

    #[test]
    fn test_roots_are_unique_per_call() {
        let first = roots();
        let second = roots();

        assert_ne!(first.base, second.base);
        assert!(first.runtime.is_dir());
        assert!(second.data.is_dir());
    }

    #[test]
    fn exact_absolute_non_overlapping_roots_are_required() {
        let roots = roots();
        let parsed = parse_roots(&[
            OsString::from("schedule"),
            OsString::from(SENTINEL),
            OsString::from("--runtime-root"),
            roots.runtime.clone().into_os_string(),
            OsString::from("--data-root"),
            roots.data.clone().into_os_string(),
        ]);
        assert_eq!(parsed.unwrap().data_root, roots.data);
    }

    #[test]
    fn absent_data_root_below_an_existing_parent_is_accepted() {
        let roots = roots();
        let data = roots.base.join("fresh-data");
        let parsed = parse_roots(&[
            OsString::from("schedule"),
            OsString::from(SENTINEL),
            OsString::from("--runtime-root"),
            roots.runtime.clone().into_os_string(),
            OsString::from("--data-root"),
            data.clone().into_os_string(),
        ])
        .unwrap();

        assert!(!data.exists());
        assert_eq!(parsed.data_root, data);
    }

    #[test]
    fn grammar_rejects_reordering_duplicates_missing_trailing_and_relative_paths() {
        for values in [
            args(&[
                "schedule",
                SENTINEL,
                "--data-root",
                "C:\\data",
                "--runtime-root",
                "C:\\runtime",
            ]),
            args(&[
                "schedule",
                SENTINEL,
                "--runtime-root",
                "C:\\runtime",
                "--runtime-root",
                "C:\\data",
            ]),
            args(&["schedule", SENTINEL, "--runtime-root", "C:\\runtime"]),
            args(&[
                "schedule",
                SENTINEL,
                "--runtime-root",
                "C:\\runtime",
                "--data-root",
                "C:\\data",
                "extra",
            ]),
            args(&[
                "schedule",
                SENTINEL,
                "--runtime-root",
                "relative",
                "--data-root",
                "relative-data",
            ]),
        ] {
            assert!(parse_roots(&values).is_err());
        }
    }

    #[test]
    fn overlap_is_rejected_after_canonicalization() {
        let roots = roots();
        let data = roots.runtime.join("data");
        fs::create_dir_all(&data).unwrap();
        assert!(
            parse_roots(&[
                OsString::from("schedule"),
                OsString::from(SENTINEL),
                OsString::from("--runtime-root"),
                roots.runtime.clone().into_os_string(),
                OsString::from("--data-root"),
                data.into_os_string(),
            ])
            .is_err()
        );
    }

    #[test]
    fn exit_constants_are_stable() {
        assert_eq!(
            (
                INVALID_ARGUMENTS,
                SETUP_OR_TRUST_ANCHOR_FAILURE,
                STARTUP_OR_WORKER_FAILURE,
                INCOMPATIBLE_DATA,
                STARTUP_TIMEOUT,
                SHUTDOWN_OR_CONTAINMENT_FAILURE
            ),
            (2, 10, 11, 12, 13, 14)
        );
    }

    #[test]
    fn startup_wait_does_not_hide_terminal_states_or_completions() {
        assert_eq!(
            startup_result(RuntimeState::Stopping, None),
            Some(STARTUP_OR_WORKER_FAILURE)
        );
        assert_eq!(
            startup_result(RuntimeState::Starting, Some(ShutdownOutcome::Clean)),
            Some(STARTUP_OR_WORKER_FAILURE)
        );
        assert_eq!(
            startup_result(RuntimeState::Idle, Some(ShutdownOutcome::Incomplete)),
            Some(STARTUP_OR_WORKER_FAILURE)
        );
        assert_eq!(
            startup_result(
                RuntimeState::IncompatibleData,
                Some(ShutdownOutcome::WorkerFailed)
            ),
            Some(INCOMPATIBLE_DATA)
        );
    }
}
