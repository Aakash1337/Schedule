//! Tauri-facing ownership and lifecycle adapter for the native runtime.

use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use super::{
    credentials::PgNames,
    executor::{NativeExecutorConfig, SystemOperations},
    host::{HostError, RuntimeCompletion, RuntimeHost, RuntimeState, RuntimeStatus},
    integrity::embedded_manifest_sha256,
    manifest::RuntimeManifestExpectations,
    paths::RuntimePaths,
};

const RUNTIME_VERSION: &str = "runtime-1";
const DATABASE_SCHEMA_VERSION: &str = "schema-1";
const STAGING_NONCE: &str = "desktop-launch";
const FINAL_SHUTDOWN_WAIT: Duration = Duration::from_secs(20);
const NORMAL_CLOSE_WAIT: Duration = Duration::from_secs(120);

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopRuntimeStatus {
    phase: &'static str,
    message: &'static str,
    generation: u64,
}

impl DesktopRuntimeStatus {
    fn setup_failure() -> Self {
        Self {
            phase: "fatal_failure",
            message: "Schedule could not initialize its local runtime. Restart or reinstall Schedule.",
            generation: 0,
        }
    }

    fn from_host(status: RuntimeStatus) -> Self {
        let (phase, message) = match status.state {
            RuntimeState::Idle | RuntimeState::Starting => {
                ("starting_services", "Starting local runtime…")
            }
            RuntimeState::Ready => ("ready", "Local runtime is ready."),
            RuntimeState::Stopping => ("starting_services", "Stopping local runtime…"),
            RuntimeState::RecoverableFailure => (
                "recoverable_failure",
                "Schedule could not start its local runtime.",
            ),
            RuntimeState::IncompatibleData => (
                "incompatible_data",
                "Local runtime data is incompatible with this version of Schedule.",
            ),
        };
        Self {
            phase,
            message,
            generation: status.generation,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RuntimeRetryResult {
    Accepted,
    Busy,
    Unavailable,
}

enum RuntimeOwner {
    Running(Arc<RuntimeHost>),
    SetupFailure,
}

/// The process-wide Tauri state. It owns the only runtime host and never exposes
/// executor failures, paths, credentials, or child process details to the UI.
pub(crate) struct DesktopRuntimeAdapter {
    owner: Mutex<RuntimeOwner>,
    close_exit_scheduled: AtomicBool,
    final_exit_wait_started: AtomicBool,
}

impl DesktopRuntimeAdapter {
    pub(crate) fn setup(app: &AppHandle, bridge: Arc<crate::bridge::DesktopApiForwarder>) -> Self {
        let owner = match setup_input(app, bridge) {
            Ok((resource_root, data_root, bridge)) => {
                match build_host(resource_root, data_root, bridge) {
                    Ok(host) => {
                        let host = Arc::new(host);
                        // Auto-start only queues work on the worker thread; it never blocks setup.
                        let _ = host.auto_start();
                        RuntimeOwner::Running(host)
                    }
                    Err(_) => RuntimeOwner::SetupFailure,
                }
            }
            Err(_) => RuntimeOwner::SetupFailure,
        };
        Self {
            owner: Mutex::new(owner),
            close_exit_scheduled: AtomicBool::new(false),
            final_exit_wait_started: AtomicBool::new(false),
        }
    }

    pub(crate) fn status(&self) -> DesktopRuntimeStatus {
        match &*self.owner.lock().expect("runtime adapter poisoned") {
            RuntimeOwner::Running(host) => DesktopRuntimeStatus::from_host(host.status()),
            RuntimeOwner::SetupFailure => DesktopRuntimeStatus::setup_failure(),
        }
    }

    pub(crate) fn retry(&self) -> RuntimeRetryResult {
        let mut owner = self.owner.lock().expect("runtime adapter poisoned");
        match &mut *owner {
            RuntimeOwner::Running(host) => match host.retry() {
                Ok(()) => RuntimeRetryResult::Accepted,
                Err(HostError::Busy) => RuntimeRetryResult::Busy,
                Err(HostError::Unavailable | HostError::ShuttingDown) => {
                    RuntimeRetryResult::Unavailable
                }
            },
            RuntimeOwner::SetupFailure => RuntimeRetryResult::Unavailable,
        }
    }

    /// Safe from close and exit callbacks: it only queues shutdown work.
    pub(crate) fn request_shutdown(&self) -> Option<RuntimeCompletion> {
        match &*self.owner.lock().expect("runtime adapter poisoned") {
            RuntimeOwner::Running(host) => host.shutdown().ok(),
            RuntimeOwner::SetupFailure => None,
        }
    }

    fn begin_close(&self) -> Option<Option<RuntimeCompletion>> {
        self.close_exit_scheduled
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| self.request_shutdown())
    }

    /// Exit callbacks are the only place the UI loop is allowed to wait. The
    /// worker itself owns PostgreSQL/API/worker teardown and bounded retries.
    pub(crate) fn bounded_shutdown(&self, limit: Duration) {
        if self
            .final_exit_wait_started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let Some(completion) = self.request_shutdown() else {
            return;
        };
        wait_bounded(&completion, limit);
    }
}

fn wait_bounded(completion: &RuntimeCompletion, limit: Duration) -> bool {
    let deadline = Instant::now() + limit;
    while !completion.is_complete() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    completion.is_complete()
}

fn setup_input(
    app: &AppHandle,
    bridge: Arc<crate::bridge::DesktopApiForwarder>,
) -> Result<(PathBuf, PathBuf, Arc<crate::bridge::DesktopApiForwarder>), ()> {
    let resource_root = runtime_resource_root(app.path().resource_dir().map_err(|_| ())?);
    let data_root = app.path().app_local_data_dir().map_err(|_| ())?;
    Ok((resource_root, data_root, bridge))
}

fn runtime_resource_root(resource_dir: PathBuf) -> PathBuf {
    resource_dir.join("runtime")
}

fn build_host(
    resource_root: PathBuf,
    data_root: PathBuf,
    bridge: Arc<crate::bridge::DesktopApiForwarder>,
) -> Result<RuntimeHost, ()> {
    let manifest_sha256 = embedded_manifest_sha256().ok_or(())?;
    let paths = RuntimePaths::new(data_root, RUNTIME_VERSION, STAGING_NONCE).map_err(|_| ())?;
    let postgres_names = PgNames::new(
        "schedule",
        "schedule_admin",
        "schedule_owner",
        "schedule_runtime",
    )
    .map_err(|_| ())?;
    let executor = SystemOperations::production(
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
    Ok(RuntimeHost::spawn(executor))
}

pub(crate) fn schedule_close(app: AppHandle, adapter: Arc<DesktopRuntimeAdapter>) {
    let Some(completion) = adapter.begin_close() else {
        return;
    };
    thread::spawn(move || {
        if let Some(completion) = completion {
            wait_bounded(&completion, NORMAL_CLOSE_WAIT);
        }
        app.exit(0);
    });
}

pub(crate) const fn final_shutdown_wait() -> Duration {
    FINAL_SHUTDOWN_WAIT
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use super::*;
    use crate::runtime::{
        coordinator::{Cancellation, EffectExecutor, EffectOutcome},
        state::Effect,
    };

    #[derive(Default)]
    struct FakeExecutor;

    struct BlockingExecutor {
        entered: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
    }

    impl EffectExecutor for BlockingExecutor {
        type Error = ();

        fn execute(
            &mut self,
            effect: Effect,
            _: &Cancellation,
        ) -> Result<EffectOutcome, Self::Error> {
            if matches!(effect, Effect::AcquireLock { .. }) {
                self.entered.send(()).unwrap();
                self.release.recv().unwrap();
            }
            Ok(if matches!(effect, Effect::VerifyDatabase { .. }) {
                EffectOutcome::DatabaseVerified {
                    needs_migration: false,
                }
            } else {
                EffectOutcome::Completed
            })
        }
        fn configure_bridge(&mut self, _: u64) -> Result<(), Self::Error> {
            Ok(())
        }
        fn clear_bridge(&mut self, _: u64) -> Result<(), Self::Error> {
            Ok(())
        }
        fn cancel(&mut self, _: u64) {}
    }

    impl EffectExecutor for FakeExecutor {
        type Error = ();

        fn execute(
            &mut self,
            effect: Effect,
            _: &Cancellation,
        ) -> Result<EffectOutcome, Self::Error> {
            Ok(if matches!(effect, Effect::VerifyDatabase { .. }) {
                EffectOutcome::DatabaseVerified {
                    needs_migration: false,
                }
            } else {
                EffectOutcome::Completed
            })
        }
        fn configure_bridge(&mut self, _: u64) -> Result<(), Self::Error> {
            Ok(())
        }
        fn clear_bridge(&mut self, _: u64) -> Result<(), Self::Error> {
            Ok(())
        }
        fn cancel(&mut self, _: u64) {}
    }

    fn adapter_with(host: RuntimeHost) -> DesktopRuntimeAdapter {
        DesktopRuntimeAdapter {
            owner: Mutex::new(RuntimeOwner::Running(Arc::new(host))),
            close_exit_scheduled: AtomicBool::new(false),
            final_exit_wait_started: AtomicBool::new(false),
        }
    }

    #[test]
    fn setup_failure_remains_a_recoverable_redacted_status() {
        let adapter = DesktopRuntimeAdapter {
            owner: Mutex::new(RuntimeOwner::SetupFailure),
            close_exit_scheduled: AtomicBool::new(false),
            final_exit_wait_started: AtomicBool::new(false),
        };
        assert_eq!(adapter.status(), DesktopRuntimeStatus::setup_failure());
        assert_eq!(adapter.retry(), RuntimeRetryResult::Unavailable);
    }

    #[test]
    fn status_mapping_is_redacted() {
        let adapter = adapter_with(RuntimeHost::spawn(FakeExecutor));
        assert_eq!(adapter.status().phase, "starting_services");
        assert_eq!(adapter.status().message, "Starting local runtime…");
        adapter.request_shutdown().unwrap().wait();
    }

    #[test]
    fn every_host_state_maps_to_a_frontend_runtime_phase() {
        const ACCEPTED: [&str; 6] = [
            "preparing_database",
            "migrating",
            "starting_services",
            "ready",
            "recoverable_failure",
            "incompatible_data",
        ];
        for state in [
            RuntimeState::Idle,
            RuntimeState::Starting,
            RuntimeState::Ready,
            RuntimeState::Stopping,
            RuntimeState::RecoverableFailure,
            RuntimeState::IncompatibleData,
        ] {
            let status = DesktopRuntimeStatus::from_host(RuntimeStatus {
                state,
                generation: 7,
            });
            assert!(ACCEPTED.contains(&status.phase), "{state:?}");
            assert_eq!(status.generation, 7);
        }
    }

    #[test]
    fn retry_admission_coalesces_duplicate_requests() {
        let adapter = adapter_with(RuntimeHost::spawn(FakeExecutor));
        assert_eq!(adapter.retry(), RuntimeRetryResult::Accepted);
        assert_eq!(adapter.retry(), RuntimeRetryResult::Busy);
        adapter.request_shutdown().unwrap().wait();
    }

    #[test]
    fn duplicate_shutdown_and_exit_are_one_shot() {
        let adapter = adapter_with(RuntimeHost::spawn(FakeExecutor));
        let first = adapter.request_shutdown().unwrap();
        let second = adapter.request_shutdown().unwrap();
        first.wait();
        assert!(second.is_complete());
        assert!(matches!(adapter.begin_close(), Some(Some(_))));
        assert!(adapter.begin_close().is_none());
    }

    #[test]
    fn setup_failure_admits_one_close_without_a_completion() {
        let adapter = DesktopRuntimeAdapter {
            owner: Mutex::new(RuntimeOwner::SetupFailure),
            close_exit_scheduled: AtomicBool::new(false),
            final_exit_wait_started: AtomicBool::new(false),
        };
        assert!(matches!(adapter.begin_close(), Some(None)));
        assert!(adapter.begin_close().is_none());
    }

    #[test]
    fn runtime_bundle_lives_under_the_dedicated_resource_namespace() {
        assert_eq!(
            runtime_resource_root(PathBuf::from("C:/Schedule/resources")),
            PathBuf::from("C:/Schedule/resources/runtime")
        );
    }

    #[test]
    fn final_shutdown_wait_is_bounded() {
        let adapter = DesktopRuntimeAdapter {
            owner: Mutex::new(RuntimeOwner::SetupFailure),
            close_exit_scheduled: AtomicBool::new(false),
            final_exit_wait_started: AtomicBool::new(false),
        };
        let started = Instant::now();
        adapter.bounded_shutdown(Duration::from_millis(1));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn pending_runtime_completion_obeys_the_deadline() {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let host = RuntimeHost::spawn(BlockingExecutor {
            entered: entered_tx,
            release: release_rx,
        });
        host.auto_start().unwrap();
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let completion = host.shutdown().unwrap();
        let started = Instant::now();
        assert!(!wait_bounded(&completion, Duration::from_millis(1)));
        assert!(started.elapsed() < Duration::from_secs(1));
        release_tx.send(()).unwrap();
        completion.wait();
    }

    #[test]
    fn production_constructor_rejects_missing_trust_anchor_without_paths() {
        let bridge = Arc::new(crate::bridge::DesktopApiForwarder::new().unwrap());
        if embedded_manifest_sha256().is_none() {
            assert!(
                build_host(PathBuf::from("relative"), PathBuf::from("relative"), bridge).is_err()
            );
        }
    }
}
