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
    bootstrap::build_host,
    host::{
        HostError, RuntimeCompletion, RuntimeHost, RuntimeState, RuntimeStatus, ShutdownOutcome,
    },
    process::ProcessGroupControl,
};

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
#[serde(tag = "result", rename_all = "snake_case")]
pub(crate) enum RuntimeRetryResult {
    Accepted { generation: u64 },
    Busy { generation: u64 },
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
    containment: Option<Arc<dyn ProcessGroupControl>>,
    close_exit_scheduled: AtomicBool,
    final_exit_wait_started: AtomicBool,
}

impl DesktopRuntimeAdapter {
    pub(crate) fn setup(app: &AppHandle, bridge: Arc<crate::bridge::DesktopApiForwarder>) -> Self {
        let (owner, containment) = match setup_input(app, bridge) {
            Ok((resource_root, data_root, bridge)) => {
                match build_host(resource_root, data_root, bridge) {
                    Ok((host, containment)) => {
                        let host = Arc::new(host);
                        // Auto-start only queues work on the worker thread; it never blocks setup.
                        let _ = host.auto_start();
                        (RuntimeOwner::Running(host), Some(containment))
                    }
                    Err(_) => (RuntimeOwner::SetupFailure, None),
                }
            }
            Err(_) => (RuntimeOwner::SetupFailure, None),
        };
        Self {
            owner: Mutex::new(owner),
            containment,
            close_exit_scheduled: AtomicBool::new(false),
            final_exit_wait_started: AtomicBool::new(false),
        }
    }

    pub(crate) fn status(&self) -> DesktopRuntimeStatus {
        match &*self.owner.lock().expect("runtime adapter poisoned") {
            RuntimeOwner::Running(host)
                if host.completion().outcome() == Some(ShutdownOutcome::WorkerFailed) =>
            {
                DesktopRuntimeStatus::setup_failure()
            }
            RuntimeOwner::Running(host) => DesktopRuntimeStatus::from_host(host.status()),
            RuntimeOwner::SetupFailure => DesktopRuntimeStatus::setup_failure(),
        }
    }

    pub(crate) fn retry(&self) -> RuntimeRetryResult {
        let mut owner = self.owner.lock().expect("runtime adapter poisoned");
        match &mut *owner {
            RuntimeOwner::Running(host) => {
                let generation = host.status().generation;
                match host.retry() {
                    Ok(()) => RuntimeRetryResult::Accepted { generation },
                    Err(HostError::Busy) => RuntimeRetryResult::Busy { generation },
                    Err(HostError::Unavailable | HostError::ShuttingDown) => {
                        RuntimeRetryResult::Unavailable
                    }
                }
            }
            RuntimeOwner::SetupFailure => RuntimeRetryResult::Unavailable,
        }
    }

    /// Safe from close and exit callbacks: it only queues shutdown work.
    pub(crate) fn request_shutdown(&self) -> Option<RuntimeCompletion> {
        match &*self.owner.lock().expect("runtime adapter poisoned") {
            RuntimeOwner::Running(host) => {
                Some(host.shutdown().unwrap_or_else(|_| host.completion()))
            }
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
        let host = match &*self.owner.lock().expect("runtime adapter poisoned") {
            RuntimeOwner::Running(host) => Some(host.clone()),
            RuntimeOwner::SetupFailure => None,
        };
        if let Some(host) = host {
            let _ =
                shutdown_and_contain(&host, self.containment.as_deref(), Instant::now() + limit);
        } else if let Some(containment) = &self.containment {
            let _ = containment.seal_and_force_stop_all(limit);
        }
    }
}

pub(crate) fn shutdown_and_contain(
    host: &RuntimeHost,
    containment: Option<&dyn ProcessGroupControl>,
    deadline: Instant,
) -> bool {
    let clean = host
        .shutdown()
        .ok()
        .and_then(|completion| completion.wait_until(deadline))
        == Some(ShutdownOutcome::Clean);
    let contained = containment
        .map(|control| {
            control
                .seal_and_force_stop_all(deadline.saturating_duration_since(Instant::now()))
                .is_ok()
        })
        .unwrap_or(true);
    clean && contained
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

pub(crate) fn schedule_close(app: AppHandle, adapter: Arc<DesktopRuntimeAdapter>) {
    let Some(completion) = adapter.begin_close() else {
        return;
    };
    thread::spawn(move || {
        if let Some(completion) = completion {
            let _ = completion.wait_until(Instant::now() + NORMAL_CLOSE_WAIT);
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

    #[derive(Default)]
    struct SealingControl {
        sealed: AtomicBool,
    }

    impl ProcessGroupControl for SealingControl {
        fn seal_and_force_stop_all(
            &self,
            _: Duration,
        ) -> Result<(), crate::runtime::process::ProcessError> {
            self.sealed.store(true, Ordering::Release);
            Ok(())
        }
    }

    struct PanickingExecutor;

    impl EffectExecutor for PanickingExecutor {
        type Error = ();

        fn execute(&mut self, _: Effect, _: &Cancellation) -> Result<EffectOutcome, Self::Error> {
            panic!("intentional worker failure")
        }
        fn configure_bridge(&mut self, _: u64) -> Result<(), Self::Error> {
            Ok(())
        }
        fn clear_bridge(&mut self, _: u64) -> Result<(), Self::Error> {
            Ok(())
        }
        fn cancel(&mut self, _: u64) {}
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
            containment: None,
            close_exit_scheduled: AtomicBool::new(false),
            final_exit_wait_started: AtomicBool::new(false),
        }
    }

    #[test]
    fn setup_failure_is_fatal_redacted_and_not_retryable() {
        let adapter = DesktopRuntimeAdapter {
            owner: Mutex::new(RuntimeOwner::SetupFailure),
            containment: None,
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
        assert_eq!(
            adapter.retry(),
            RuntimeRetryResult::Accepted { generation: 0 }
        );
        assert_eq!(adapter.retry(), RuntimeRetryResult::Busy { generation: 0 });
        adapter.request_shutdown().unwrap().wait();
    }

    #[test]
    fn retry_result_carries_the_generation_observed_before_admission() {
        assert_eq!(
            serde_json::to_value(RuntimeRetryResult::Accepted { generation: 7 }).unwrap(),
            serde_json::json!({ "result": "accepted", "generation": 7 })
        );
        assert_eq!(
            serde_json::to_value(RuntimeRetryResult::Unavailable).unwrap(),
            serde_json::json!({ "result": "unavailable" })
        );
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
            containment: None,
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
            containment: None,
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
        assert_eq!(
            completion.wait_until(Instant::now() + Duration::from_millis(1)),
            None
        );
        assert!(started.elapsed() < Duration::from_secs(1));
        release_tx.send(()).unwrap();
        completion.wait();
    }

    #[test]
    fn final_exit_seals_containment_after_its_deadline() {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let host = RuntimeHost::spawn(BlockingExecutor {
            entered: entered_tx,
            release: release_rx,
        });
        host.auto_start().unwrap();
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let completion = host.completion();
        let containment = Arc::new(SealingControl::default());
        let adapter = DesktopRuntimeAdapter {
            owner: Mutex::new(RuntimeOwner::Running(Arc::new(host))),
            containment: Some(containment.clone()),
            close_exit_scheduled: AtomicBool::new(false),
            final_exit_wait_started: AtomicBool::new(false),
        };

        adapter.bounded_shutdown(Duration::from_millis(1));
        assert!(containment.sealed.load(Ordering::Acquire));
        release_tx.send(()).unwrap();
        completion.wait();
    }

    #[test]
    fn held_spawn_reservation_cannot_extend_final_exit_deadline() {
        let containment = crate::runtime::process::platform_process_control();
        let reservation =
            crate::runtime::process::ProcessSpawnReservation::new(Arc::clone(&containment))
                .unwrap();
        let adapter = DesktopRuntimeAdapter {
            owner: Mutex::new(RuntimeOwner::SetupFailure),
            containment: Some(Arc::clone(&containment)),
            close_exit_scheduled: AtomicBool::new(false),
            final_exit_wait_started: AtomicBool::new(false),
        };

        let started = Instant::now();
        adapter.bounded_shutdown(Duration::from_millis(10));
        assert!(started.elapsed() < Duration::from_secs(1));
        drop(reservation);
        assert!(crate::runtime::process::ProcessSpawnReservation::new(containment).is_err());
    }

    #[test]
    fn worker_panic_becomes_fatal_and_retry_stays_unavailable() {
        let host = RuntimeHost::spawn(PanickingExecutor);
        let completion = host.completion();
        let adapter = adapter_with(host);
        match &*adapter.owner.lock().unwrap() {
            RuntimeOwner::Running(host) => host.auto_start().unwrap(),
            RuntimeOwner::SetupFailure => unreachable!(),
        }
        assert_eq!(completion.wait(), ShutdownOutcome::WorkerFailed);
        assert_eq!(adapter.status(), DesktopRuntimeStatus::setup_failure());
        assert_eq!(adapter.retry(), RuntimeRetryResult::Unavailable);
        assert_eq!(
            adapter.request_shutdown().unwrap().outcome(),
            Some(ShutdownOutcome::WorkerFailed)
        );
    }

    #[test]
    fn production_constructor_rejects_missing_trust_anchor_without_paths() {
        let bridge = Arc::new(crate::bridge::DesktopApiForwarder::new().unwrap());
        if crate::runtime::integrity::embedded_manifest_sha256().is_none() {
            assert!(
                build_host(PathBuf::from("relative"), PathBuf::from("relative"), bridge).is_err()
            );
        }
    }
}
