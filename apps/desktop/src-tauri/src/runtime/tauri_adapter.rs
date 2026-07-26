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
const PORTABLE_IMPORT_TOKEN_TTL: Duration = Duration::from_secs(15 * 60);
const RUNTIME_DATA_DIRECTORY: &str = "data";

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopRuntimeStatus {
    phase: &'static str,
    message: &'static str,
    generation: u64,
    automatic_backup_recovery: bool,
}

impl DesktopRuntimeStatus {
    fn setup_failure() -> Self {
        Self {
            phase: "fatal_failure",
            message: "Schedule could not initialize its local runtime. Restart or reinstall Schedule.",
            generation: 0,
            automatic_backup_recovery: false,
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
            automatic_backup_recovery: status.automatic_backup_recovery,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub(crate) enum RuntimeRetryResult {
    Accepted { generation: u64 },
    Busy { generation: u64 },
    Cancelled,
    Unavailable,
}

enum RuntimeOwner {
    Running(Arc<RuntimeHost>),
    SetupFailure,
}

struct PendingPortableImport {
    token: String,
    source: PathBuf,
    archive_id: String,
    archive_sha256: String,
    generation: u64,
    expires_at: Instant,
}

/// The process-wide Tauri state. It owns the only runtime host and never exposes
/// executor failures, paths, credentials, or child process details to the UI.
pub(crate) struct DesktopRuntimeAdapter {
    owner: Mutex<RuntimeOwner>,
    containment: Option<Arc<dyn ProcessGroupControl>>,
    close_exit_scheduled: AtomicBool,
    final_exit_wait_started: AtomicBool,
    portable_export_in_flight: AtomicBool,
    portable_import_in_flight: AtomicBool,
    automatic_backup_recovery_confirmation_in_flight: AtomicBool,
    pending_portable_import: Mutex<Option<PendingPortableImport>>,
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
            portable_export_in_flight: AtomicBool::new(false),
            portable_import_in_flight: AtomicBool::new(false),
            automatic_backup_recovery_confirmation_in_flight: AtomicBool::new(false),
            pending_portable_import: Mutex::new(None),
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

    pub(crate) fn restore_automatic_backup(&self) -> RuntimeRetryResult {
        let mut owner = self.owner.lock().expect("runtime adapter poisoned");
        match &mut *owner {
            RuntimeOwner::Running(host) => {
                let generation = host.status().generation;
                match host.restore_automatic_backup() {
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

    pub(crate) fn begin_automatic_backup_recovery_confirmation(
        &self,
    ) -> Result<(), RuntimeRetryResult> {
        if !self.status().automatic_backup_recovery {
            return Err(RuntimeRetryResult::Unavailable);
        }
        self.automatic_backup_recovery_confirmation_in_flight
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| ())
            .map_err(|_| {
                let generation = self.status().generation;
                RuntimeRetryResult::Busy { generation }
            })
    }

    pub(crate) fn finish_automatic_backup_recovery_confirmation(
        &self,
        confirmed: bool,
    ) -> RuntimeRetryResult {
        let result = if confirmed {
            self.restore_automatic_backup()
        } else {
            RuntimeRetryResult::Cancelled
        };
        self.automatic_backup_recovery_confirmation_in_flight
            .store(false, Ordering::Release);
        result
    }

    pub(crate) fn abandon_automatic_backup_recovery_confirmation(&self) {
        self.automatic_backup_recovery_confirmation_in_flight
            .store(false, Ordering::Release);
    }

    pub(crate) fn begin_portable_export(&self) -> Result<(), crate::runtime::PortableExportResult> {
        let ready = match &*self.owner.lock().expect("runtime adapter poisoned") {
            RuntimeOwner::Running(host) => {
                host.status().state == RuntimeState::Ready
                    && host.completion().outcome() != Some(ShutdownOutcome::WorkerFailed)
            }
            RuntimeOwner::SetupFailure => false,
        };
        if !ready {
            return Err(crate::runtime::PortableExportResult::Unavailable);
        }
        if self.portable_import_in_flight.load(Ordering::Acquire) {
            return Err(crate::runtime::PortableExportResult::Busy);
        }
        self.portable_export_in_flight
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| ())
            .map_err(|_| crate::runtime::PortableExportResult::Busy)
    }

    pub(crate) fn abandon_portable_export(&self) {
        self.portable_export_in_flight
            .store(false, Ordering::Release);
    }

    pub(crate) fn finish_portable_export(
        &self,
        destination: Option<PathBuf>,
    ) -> crate::runtime::portable::PortableExportResult {
        let result = match destination {
            None => crate::runtime::portable::PortableExportResult::Cancelled,
            Some(destination) => {
                let host = match &*self.owner.lock().expect("runtime adapter poisoned") {
                    RuntimeOwner::SetupFailure => None,
                    RuntimeOwner::Running(host) => Some(Arc::clone(host)),
                };
                match host {
                    None => crate::runtime::portable::PortableExportResult::Unavailable,
                    Some(host) => match host.portable_export(destination) {
                        Ok(receiver) => receiver
                            .recv()
                            .unwrap_or(crate::runtime::portable::PortableExportResult::Unavailable),
                        Err(HostError::Busy) => {
                            crate::runtime::portable::PortableExportResult::Busy
                        }
                        Err(HostError::Unavailable | HostError::ShuttingDown) => {
                            crate::runtime::portable::PortableExportResult::Unavailable
                        }
                    },
                }
            }
        };
        self.portable_export_in_flight
            .store(false, Ordering::Release);
        result
    }

    pub(crate) fn begin_portable_import_select(
        &self,
    ) -> Result<(), crate::runtime::portable::PortableImportSelectResult> {
        let ready = match &*self.owner.lock().expect("runtime adapter poisoned") {
            RuntimeOwner::Running(host) => {
                host.status().state == RuntimeState::Ready
                    && host.completion().outcome() != Some(ShutdownOutcome::WorkerFailed)
            }
            RuntimeOwner::SetupFailure => false,
        };
        if !ready {
            return Err(crate::runtime::portable::PortableImportSelectResult::Unavailable);
        }
        if self.portable_export_in_flight.load(Ordering::Acquire) {
            return Err(crate::runtime::portable::PortableImportSelectResult::Busy);
        }
        self.portable_import_in_flight
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| crate::runtime::portable::PortableImportSelectResult::Busy)?;
        *self
            .pending_portable_import
            .lock()
            .expect("portable import state poisoned") = None;
        Ok(())
    }

    pub(crate) fn abandon_portable_import(&self) {
        self.portable_import_in_flight
            .store(false, Ordering::Release);
    }

    pub(crate) fn finish_portable_import_select(
        &self,
        source: Option<PathBuf>,
    ) -> crate::runtime::portable::PortableImportSelectResult {
        let result = match source {
            None => crate::runtime::portable::PortableImportSelectResult::Cancelled,
            Some(source) => {
                let (host, generation) =
                    match &*self.owner.lock().expect("runtime adapter poisoned") {
                        RuntimeOwner::SetupFailure => (None, 0),
                        RuntimeOwner::Running(host) => {
                            (Some(Arc::clone(host)), host.status().generation)
                        }
                    };
                match host {
                    None => crate::runtime::portable::PortableImportSelectResult::Unavailable,
                    Some(host) => match host.portable_import_inspect(source.clone()) {
                        Ok(receiver) => match receiver.recv() {
                            Ok(
                                crate::runtime::portable::PortableImportInspectResult::Inspected(
                                    preview,
                                ),
                            ) => match portable_import_token() {
                                Ok(token) => {
                                    *self
                                        .pending_portable_import
                                        .lock()
                                        .expect("portable import state poisoned") =
                                        Some(PendingPortableImport {
                                            token: token.clone(),
                                            source,
                                            archive_id: preview.archive_id.clone(),
                                            archive_sha256: preview.archive_sha256.clone(),
                                            generation,
                                            expires_at: Instant::now() + PORTABLE_IMPORT_TOKEN_TTL,
                                        });
                                    crate::runtime::portable::PortableImportSelectResult::Selected {
                                        token,
                                        preview,
                                    }
                                }
                                Err(code) => {
                                    crate::runtime::portable::PortableImportSelectResult::Failed {
                                        code,
                                    }
                                }
                            },
                            Ok(crate::runtime::portable::PortableImportInspectResult::Failed {
                                code,
                            }) => crate::runtime::portable::PortableImportSelectResult::Failed {
                                code,
                            },
                            Ok(
                                crate::runtime::portable::PortableImportInspectResult::Unavailable,
                            )
                            | Err(_) => {
                                crate::runtime::portable::PortableImportSelectResult::Unavailable
                            }
                        },
                        Err(HostError::Busy) => {
                            crate::runtime::portable::PortableImportSelectResult::Busy
                        }
                        Err(HostError::Unavailable | HostError::ShuttingDown) => {
                            crate::runtime::portable::PortableImportSelectResult::Unavailable
                        }
                    },
                }
            }
        };
        self.portable_import_in_flight
            .store(false, Ordering::Release);
        result
    }

    pub(crate) fn confirm_portable_import(
        &self,
        token: String,
    ) -> crate::runtime::portable::PortableImportResult {
        if self.portable_export_in_flight.load(Ordering::Acquire)
            || self
                .portable_import_in_flight
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        {
            return crate::runtime::portable::PortableImportResult::Busy;
        }
        let result = (|| {
            let (host, generation) = match &*self.owner.lock().expect("runtime adapter poisoned") {
                RuntimeOwner::SetupFailure => {
                    return crate::runtime::portable::PortableImportResult::Unavailable;
                }
                RuntimeOwner::Running(host) => (Arc::clone(host), host.status().generation),
            };
            if host.status().state != RuntimeState::Ready {
                return crate::runtime::portable::PortableImportResult::Unavailable;
            }
            let request = {
                let pending = self
                    .pending_portable_import
                    .lock()
                    .expect("portable import state poisoned");
                let valid = pending.as_ref().is_some_and(|pending| {
                    pending.token == token
                        && pending.generation == generation
                        && Instant::now() <= pending.expires_at
                });
                if !valid {
                    return crate::runtime::portable::PortableImportResult::Failed {
                        code: "desktop.portable_import_token_invalid",
                    };
                }
                let pending = pending.as_ref().expect("portable import token was checked");
                crate::runtime::portable::PortableImportRequest {
                    source: pending.source.clone(),
                    expected_archive_id: pending.archive_id.clone(),
                    expected_archive_sha256: pending.archive_sha256.clone(),
                }
            };
            match host.portable_import(request) {
                Ok(receiver) => {
                    *self
                        .pending_portable_import
                        .lock()
                        .expect("portable import state poisoned") = None;
                    receiver
                        .recv()
                        .unwrap_or(crate::runtime::portable::PortableImportResult::Unavailable)
                }
                Err(HostError::Busy) => crate::runtime::portable::PortableImportResult::Busy,
                Err(HostError::Unavailable | HostError::ShuttingDown) => {
                    *self
                        .pending_portable_import
                        .lock()
                        .expect("portable import state poisoned") = None;
                    crate::runtime::portable::PortableImportResult::Unavailable
                }
            }
        })();
        self.portable_import_in_flight
            .store(false, Ordering::Release);
        result
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

fn portable_import_token() -> Result<String, &'static str> {
    let mut bytes = [0_u8; 24];
    getrandom::fill(&mut bytes).map_err(|_| "desktop.portable_import_token_unavailable")?;
    let mut token = String::with_capacity(bytes.len() * 2);
    use std::fmt::Write as _;
    for byte in bytes {
        write!(token, "{byte:02x}").map_err(|_| "desktop.portable_import_token_unavailable")?;
    }
    Ok(token)
}

pub(super) fn shutdown_and_contain(
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
    // WebView creates the Tauri app-data directory before setup runs. Keep the
    // service runtime in its own child so Rust can create and verify a private
    // root instead of inheriting the browser profile directory's permissions.
    let data_root = runtime_data_root(app.path().app_local_data_dir().map_err(|_| ())?);
    Ok((resource_root, data_root, bridge))
}

fn runtime_resource_root(resource_dir: PathBuf) -> PathBuf {
    resource_dir.join("runtime")
}

fn runtime_data_root(app_local_data_dir: PathBuf) -> PathBuf {
    app_local_data_dir.join(RUNTIME_DATA_DIRECTORY)
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
        recovery::AutomaticBackupRecoveryResult,
        state::{Effect, Incompatibility},
    };

    #[derive(Default)]
    struct FakeExecutor;
    struct RecoveryExecutor;

    struct BlockingExecutor {
        entered: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
    }

    struct ImportExecutor {
        requests: Arc<Mutex<Vec<crate::runtime::portable::PortableImportRequest>>>,
        export_gate: Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>,
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

    impl EffectExecutor for RecoveryExecutor {
        type Error = ();

        fn execute(
            &mut self,
            effect: Effect,
            _: &Cancellation,
        ) -> Result<EffectOutcome, Self::Error> {
            Ok(if matches!(effect, Effect::VerifyDatabase { .. }) {
                EffectOutcome::Incompatible(Incompatibility::Migration)
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
        fn automatic_backup_recovery_available(&self) -> bool {
            true
        }
        fn restore_automatic_backup(
            &mut self,
            _: u64,
            _: &Cancellation,
        ) -> AutomaticBackupRecoveryResult {
            AutomaticBackupRecoveryResult::Unavailable
        }
    }

    impl EffectExecutor for ImportExecutor {
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

        fn portable_export(
            &mut self,
            _: PathBuf,
            _: &Cancellation,
        ) -> crate::runtime::portable::PortableExportResult {
            if let Some((entered, release)) = &self.export_gate {
                entered.send(()).unwrap();
                release.recv().unwrap();
            }
            crate::runtime::portable::PortableExportResult::Cancelled
        }

        fn portable_import_inspect(
            &mut self,
            _: PathBuf,
            _: &Cancellation,
        ) -> crate::runtime::portable::PortableImportInspectResult {
            crate::runtime::portable::PortableImportInspectResult::Inspected(
                crate::runtime::portable::PortableImportPreview {
                    archive_id: "archive-bound-to-preview".to_owned(),
                    archive_sha256: "a".repeat(64),
                    exported_at: "2026-07-21T00:00:00.000Z".to_owned(),
                    application_version: "0.1.0".to_owned(),
                    schema_version: 12,
                    size_bytes: 42,
                },
            )
        }

        fn portable_import(
            &mut self,
            request: crate::runtime::portable::PortableImportRequest,
            _: &Cancellation,
        ) -> crate::runtime::portable::PortableImportResult {
            self.requests.lock().unwrap().push(request);
            crate::runtime::portable::PortableImportResult::Imported
        }
    }

    fn adapter_with(host: RuntimeHost) -> DesktopRuntimeAdapter {
        DesktopRuntimeAdapter {
            owner: Mutex::new(RuntimeOwner::Running(Arc::new(host))),
            containment: None,
            close_exit_scheduled: AtomicBool::new(false),
            final_exit_wait_started: AtomicBool::new(false),
            portable_export_in_flight: AtomicBool::new(false),
            portable_import_in_flight: AtomicBool::new(false),
            automatic_backup_recovery_confirmation_in_flight: AtomicBool::new(false),
            pending_portable_import: Mutex::new(None),
        }
    }

    #[test]
    fn setup_failure_is_fatal_redacted_and_not_retryable() {
        let adapter = DesktopRuntimeAdapter {
            owner: Mutex::new(RuntimeOwner::SetupFailure),
            containment: None,
            close_exit_scheduled: AtomicBool::new(false),
            final_exit_wait_started: AtomicBool::new(false),
            portable_export_in_flight: AtomicBool::new(false),
            portable_import_in_flight: AtomicBool::new(false),
            automatic_backup_recovery_confirmation_in_flight: AtomicBool::new(false),
            pending_portable_import: Mutex::new(None),
        };
        assert_eq!(adapter.status(), DesktopRuntimeStatus::setup_failure());
        assert_eq!(adapter.retry(), RuntimeRetryResult::Unavailable);
        assert_eq!(
            adapter.restore_automatic_backup(),
            RuntimeRetryResult::Unavailable
        );
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
                automatic_backup_recovery: false,
            });
            assert!(ACCEPTED.contains(&status.phase), "{state:?}");
            assert_eq!(status.generation, 7);
            assert!(!status.automatic_backup_recovery);
        }
        let recovery = DesktopRuntimeStatus::from_host(RuntimeStatus {
            state: RuntimeState::IncompatibleData,
            generation: 8,
            automatic_backup_recovery: true,
        });
        assert!(recovery.automatic_backup_recovery);
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
    fn native_recovery_confirmation_is_single_flight_and_cancellable() {
        let adapter = adapter_with(RuntimeHost::spawn(RecoveryExecutor));
        let host = match &*adapter.owner.lock().unwrap() {
            RuntimeOwner::Running(host) => Arc::clone(host),
            RuntimeOwner::SetupFailure => unreachable!(),
        };
        host.start().unwrap();
        for _ in 0..100 {
            if adapter.status().automatic_backup_recovery {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        assert!(adapter.status().automatic_backup_recovery);
        assert_eq!(
            adapter.begin_automatic_backup_recovery_confirmation(),
            Ok(())
        );
        assert_eq!(
            adapter.begin_automatic_backup_recovery_confirmation(),
            Err(RuntimeRetryResult::Busy { generation: 1 })
        );
        assert_eq!(
            adapter.finish_automatic_backup_recovery_confirmation(false),
            RuntimeRetryResult::Cancelled
        );
        assert_eq!(
            adapter.begin_automatic_backup_recovery_confirmation(),
            Ok(())
        );
        adapter.abandon_automatic_backup_recovery_confirmation();
        adapter.request_shutdown().unwrap().wait();
    }

    #[test]
    fn portable_export_rejects_non_ready_and_releases_its_gate_after_cancel() {
        let host = RuntimeHost::spawn(FakeExecutor);
        let adapter = adapter_with(host);
        assert_eq!(
            adapter.begin_portable_export(),
            Err(crate::runtime::PortableExportResult::Unavailable)
        );
        let host = match &*adapter.owner.lock().unwrap() {
            RuntimeOwner::Running(host) => Arc::clone(host),
            RuntimeOwner::SetupFailure => unreachable!(),
        };
        host.auto_start().unwrap();
        for _ in 0..100 {
            if host.status().state == RuntimeState::Ready {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(host.status().state, RuntimeState::Ready);
        assert_eq!(adapter.begin_portable_export(), Ok(()));
        assert_eq!(
            adapter.begin_portable_export(),
            Err(crate::runtime::PortableExportResult::Busy)
        );
        assert_eq!(
            adapter.finish_portable_export(None),
            crate::runtime::PortableExportResult::Cancelled
        );
        assert_eq!(adapter.begin_portable_export(), Ok(()));
        adapter.abandon_portable_export();
        host.shutdown().unwrap().wait();
    }

    #[test]
    fn portable_import_confirmation_is_one_shot_and_bound_to_the_preview() {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let host = RuntimeHost::spawn(ImportExecutor {
            requests: Arc::clone(&requests),
            export_gate: None,
        });
        let adapter = adapter_with(host);
        let host = match &*adapter.owner.lock().unwrap() {
            RuntimeOwner::Running(host) => Arc::clone(host),
            RuntimeOwner::SetupFailure => unreachable!(),
        };
        host.auto_start().unwrap();
        for _ in 0..100 {
            if host.status().state == RuntimeState::Ready {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(host.status().state, RuntimeState::Ready);

        assert_eq!(adapter.begin_portable_import_select(), Ok(()));
        assert_eq!(
            adapter.begin_portable_export(),
            Err(crate::runtime::PortableExportResult::Busy)
        );
        let source = PathBuf::from("C:\\private\\approved.schedule");
        let token = match adapter.finish_portable_import_select(Some(source.clone())) {
            crate::runtime::portable::PortableImportSelectResult::Selected { token, preview } => {
                assert_eq!(preview.archive_id, "archive-bound-to-preview");
                assert_eq!(token.len(), 48);
                token
            }
            result => panic!("unexpected selection result: {result:?}"),
        };

        assert_eq!(
            adapter.confirm_portable_import("wrong-token".to_owned()),
            crate::runtime::portable::PortableImportResult::Failed {
                code: "desktop.portable_import_token_invalid"
            }
        );
        {
            let mut pending = adapter.pending_portable_import.lock().unwrap();
            pending.as_mut().unwrap().expires_at = Instant::now() - Duration::from_secs(1);
        }
        assert_eq!(
            adapter.confirm_portable_import(token.clone()),
            crate::runtime::portable::PortableImportResult::Failed {
                code: "desktop.portable_import_token_invalid"
            }
        );
        {
            let mut pending = adapter.pending_portable_import.lock().unwrap();
            let pending = pending.as_mut().unwrap();
            pending.expires_at = Instant::now() + PORTABLE_IMPORT_TOKEN_TTL;
            pending.generation += 1;
        }
        assert_eq!(
            adapter.confirm_portable_import(token.clone()),
            crate::runtime::portable::PortableImportResult::Failed {
                code: "desktop.portable_import_token_invalid"
            }
        );
        adapter
            .pending_portable_import
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .generation = host.status().generation;
        assert_eq!(
            adapter.confirm_portable_import(token.clone()),
            crate::runtime::portable::PortableImportResult::Imported
        );
        assert_eq!(
            requests.lock().unwrap().as_slice(),
            [crate::runtime::portable::PortableImportRequest {
                source,
                expected_archive_id: "archive-bound-to-preview".to_owned(),
                expected_archive_sha256: "a".repeat(64),
            }]
        );
        assert_eq!(
            adapter.confirm_portable_import(token),
            crate::runtime::portable::PortableImportResult::Failed {
                code: "desktop.portable_import_token_invalid"
            }
        );
        host.shutdown().unwrap().wait();
    }

    #[test]
    fn busy_import_confirmation_preserves_the_approved_token_for_retry() {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let (export_entered, entered) = mpsc::channel();
        let (release, export_release) = mpsc::channel();
        let host = RuntimeHost::spawn(ImportExecutor {
            requests: Arc::clone(&requests),
            export_gate: Some((export_entered, export_release)),
        });
        let adapter = adapter_with(host);
        let host = match &*adapter.owner.lock().unwrap() {
            RuntimeOwner::Running(host) => Arc::clone(host),
            RuntimeOwner::SetupFailure => unreachable!(),
        };
        host.auto_start().unwrap();
        for _ in 0..100 {
            if host.status().state == RuntimeState::Ready {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(adapter.begin_portable_import_select(), Ok(()));
        let token = match adapter
            .finish_portable_import_select(Some(PathBuf::from("C:\\private\\approved.schedule")))
        {
            crate::runtime::portable::PortableImportSelectResult::Selected { token, .. } => token,
            result => panic!("unexpected selection result: {result:?}"),
        };
        let export = host
            .portable_export(PathBuf::from("ignored.schedule"))
            .unwrap();
        entered.recv_timeout(Duration::from_secs(1)).unwrap();

        assert_eq!(
            adapter.confirm_portable_import(token.clone()),
            crate::runtime::portable::PortableImportResult::Busy
        );
        assert_eq!(
            adapter
                .pending_portable_import
                .lock()
                .unwrap()
                .as_ref()
                .map(|pending| pending.token.as_str()),
            Some(token.as_str())
        );

        release.send(()).unwrap();
        assert_eq!(
            export.recv_timeout(Duration::from_secs(1)).unwrap(),
            crate::runtime::portable::PortableExportResult::Cancelled
        );
        assert_eq!(
            adapter.confirm_portable_import(token),
            crate::runtime::portable::PortableImportResult::Imported
        );
        assert_eq!(requests.lock().unwrap().len(), 1);
        host.shutdown().unwrap().wait();
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
        assert_eq!(
            serde_json::to_value(RuntimeRetryResult::Cancelled).unwrap(),
            serde_json::json!({ "result": "cancelled" })
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
            portable_export_in_flight: AtomicBool::new(false),
            portable_import_in_flight: AtomicBool::new(false),
            automatic_backup_recovery_confirmation_in_flight: AtomicBool::new(false),
            pending_portable_import: Mutex::new(None),
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
            portable_export_in_flight: AtomicBool::new(false),
            portable_import_in_flight: AtomicBool::new(false),
            automatic_backup_recovery_confirmation_in_flight: AtomicBool::new(false),
            pending_portable_import: Mutex::new(None),
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
            portable_export_in_flight: AtomicBool::new(false),
            portable_import_in_flight: AtomicBool::new(false),
            automatic_backup_recovery_confirmation_in_flight: AtomicBool::new(false),
            pending_portable_import: Mutex::new(None),
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
            portable_export_in_flight: AtomicBool::new(false),
            portable_import_in_flight: AtomicBool::new(false),
            automatic_backup_recovery_confirmation_in_flight: AtomicBool::new(false),
            pending_portable_import: Mutex::new(None),
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

    #[test]
    fn storage_abi_is_stable_for_windows_and_linux() {
        let config: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tauri.conf.json"
        )))
        .unwrap();
        let app = tauri::test::mock_builder()
            .build(tauri::generate_context!())
            .unwrap();
        let resolved_app_data = app.path().app_local_data_dir().unwrap();
        let app_data = PathBuf::from("app-local-data");
        let runtime_data = runtime_data_root(app_data.clone());

        assert_eq!(config["identifier"], "com.aakash.schedule");
        assert_eq!(RUNTIME_DATA_DIRECTORY, "data");
        assert!(resolved_app_data.ends_with("com.aakash.schedule"));
        assert_eq!(
            runtime_data_root(resolved_app_data.clone()),
            resolved_app_data.join("data")
        );
        assert_eq!(runtime_data, app_data.join("data"));
        assert_ne!(runtime_data, app_data);
    }
}
