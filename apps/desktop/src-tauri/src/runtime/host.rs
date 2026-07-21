//! Threaded, UI-agnostic owner for the desktop runtime lifecycle.
//!
//! UI adapters enqueue intent and observe [`RuntimeStatus`]; effects always run
//! on this one worker thread.  The status intentionally contains no executor
//! errors, paths, credentials, or lifecycle control details.

use std::{
    panic::{AssertUnwindSafe, catch_unwind},
    sync::{
        Arc, Condvar, Mutex, RwLock,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread::{self, JoinHandle},
    time::Instant,
};

use super::{
    coordinator::{CancellationHandle, Coordinator, EffectExecutor},
    portable::{
        PortableExportResult, PortableImportInspectResult, PortableImportRequest,
        PortableImportResult,
    },
    state::Phase,
};

/// The only lifecycle detail safe to publish outside the runtime worker.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeState {
    Idle,
    Starting,
    Ready,
    Stopping,
    RecoverableFailure,
    IncompatibleData,
}

/// A redacted, thread-safe lifecycle snapshot for a future Tauri command.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RuntimeStatus {
    pub state: RuntimeState,
    pub generation: u64,
}

impl Default for RuntimeStatus {
    fn default() -> Self {
        Self {
            state: RuntimeState::Idle,
            generation: 0,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HostError {
    Unavailable,
    ShuttingDown,
    Busy,
}

/// Redacted terminal result for process-exit code. It deliberately excludes
/// executor errors and any lifecycle control material.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ShutdownOutcome {
    Clean,
    Incomplete,
    WorkerFailed,
}

enum Command {
    Start,
    Retry,
    Stop,
    Shutdown,
    PortableExport {
        destination: std::path::PathBuf,
        reply: mpsc::Sender<PortableExportResult>,
    },
    PortableImportInspect {
        source: std::path::PathBuf,
        reply: mpsc::Sender<PortableImportInspectResult>,
    },
    PortableImport {
        request: PortableImportRequest,
        reply: mpsc::Sender<PortableImportResult>,
    },
}

/// A completion seam: UI callbacks can retain this instead of waiting on the
/// runtime thread.  `wait` is deliberately opt-in for process-exit code.
#[derive(Clone, Default)]
pub struct RuntimeCompletion(Arc<CompletionState>);

#[derive(Default)]
struct CompletionState {
    outcome: Mutex<Option<ShutdownOutcome>>,
    wake: Condvar,
}

impl RuntimeCompletion {
    pub fn is_complete(&self) -> bool {
        self.0
            .outcome
            .lock()
            .expect("runtime completion poisoned")
            .is_some()
    }

    pub fn outcome(&self) -> Option<ShutdownOutcome> {
        *self.0.outcome.lock().expect("runtime completion poisoned")
    }

    pub fn wait(&self) -> ShutdownOutcome {
        let mut outcome = self.0.outcome.lock().expect("runtime completion poisoned");
        while outcome.is_none() {
            outcome = self
                .0
                .wake
                .wait(outcome)
                .expect("runtime completion poisoned");
        }
        outcome.expect("completion outcome was checked")
    }

    /// Waits no later than `deadline`, without polling the worker thread.
    pub fn wait_until(&self, deadline: Instant) -> Option<ShutdownOutcome> {
        let outcome = self.0.outcome.lock().expect("runtime completion poisoned");
        let (outcome, _) = self
            .0
            .wake
            .wait_timeout_while(
                outcome,
                deadline.saturating_duration_since(Instant::now()),
                |value| value.is_none(),
            )
            .expect("runtime completion poisoned");
        *outcome
    }

    fn complete(&self, outcome: ShutdownOutcome) {
        let mut current = self.0.outcome.lock().expect("runtime completion poisoned");
        if current.is_none() {
            *current = Some(outcome);
            self.0.wake.notify_all();
        }
    }
}

/// Serializes all runtime ownership on a dedicated thread.
pub struct RuntimeHost {
    commands: mpsc::Sender<Command>,
    cancellation: CancellationHandle,
    admission: Arc<Mutex<()>>,
    lifecycle_command_in_flight: Arc<AtomicBool>,
    portable_export_in_flight: Arc<AtomicBool>,
    portable_import_in_flight: Arc<AtomicBool>,
    status: Arc<RwLock<RuntimeStatus>>,
    shutdown_requested: Arc<AtomicBool>,
    completion: RuntimeCompletion,
    worker: Option<JoinHandle<()>>,
}

impl RuntimeHost {
    pub fn spawn<E>(executor: E) -> Self
    where
        E: EffectExecutor + Send + 'static,
        E::Error: Send + 'static,
    {
        let (commands, receiver) = mpsc::channel();
        let status = Arc::new(RwLock::new(RuntimeStatus::default()));
        let completion = RuntimeCompletion::default();
        let coordinator = Coordinator::new(executor);
        let cancellation = coordinator.cancellation_handle();
        let admission = Arc::new(Mutex::new(()));
        let lifecycle_command_in_flight = Arc::new(AtomicBool::new(false));
        let portable_export_in_flight = Arc::new(AtomicBool::new(false));
        let portable_import_in_flight = Arc::new(AtomicBool::new(false));
        let worker_status = status.clone();
        let worker_completion = completion.clone();
        let worker_lifecycle_command = lifecycle_command_in_flight.clone();
        let worker_portable_export = portable_export_in_flight.clone();
        let worker_portable_import = portable_import_in_flight.clone();
        let worker = thread::spawn(move || {
            let outcome = catch_unwind(AssertUnwindSafe(|| {
                let mut coordinator = coordinator;
                run_worker(
                    &mut coordinator,
                    receiver,
                    &worker_status,
                    &worker_lifecycle_command,
                    &worker_portable_export,
                    &worker_portable_import,
                )
            }))
            .unwrap_or(ShutdownOutcome::WorkerFailed);
            worker_lifecycle_command.store(false, Ordering::Release);
            worker_portable_export.store(false, Ordering::Release);
            worker_portable_import.store(false, Ordering::Release);
            worker_completion.complete(outcome);
        });
        Self {
            commands,
            cancellation,
            admission,
            lifecycle_command_in_flight,
            portable_export_in_flight,
            portable_import_in_flight,
            status,
            shutdown_requested: Arc::new(AtomicBool::new(false)),
            completion,
            worker: Some(worker),
        }
    }

    /// Queue the normal automatic startup path.
    pub fn auto_start(&self) -> Result<(), HostError> {
        self.start()
    }

    pub fn start(&self) -> Result<(), HostError> {
        self.send(Command::Start)
    }

    pub fn retry(&self) -> Result<(), HostError> {
        self.send(Command::Retry)
    }

    /// Cancellation is published before queuing the stop, so a synchronous
    /// executor already in progress can cooperate without waiting for this
    /// worker's command loop.
    pub fn stop(&self) -> Result<(), HostError> {
        self.cancel_then_send(Command::Stop)
    }

    /// Requests exactly one graceful shutdown and returns a non-blocking
    /// completion handle. Repeated calls share the same completion.
    pub fn shutdown(&self) -> Result<RuntimeCompletion, HostError> {
        let _admission = self.admission.lock().expect("runtime admission poisoned");
        self.cancellation.cancel();
        if self
            .shutdown_requested
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            if self.commands.send(Command::Shutdown).is_err() {
                return Err(HostError::Unavailable);
            }
        }
        Ok(self.completion.clone())
    }

    pub fn status(&self) -> RuntimeStatus {
        *self.status.read().expect("runtime status poisoned")
    }

    pub fn completion(&self) -> RuntimeCompletion {
        self.completion.clone()
    }

    pub fn portable_export(
        &self,
        destination: std::path::PathBuf,
    ) -> Result<mpsc::Receiver<PortableExportResult>, HostError> {
        let _admission = self.admission.lock().expect("runtime admission poisoned");
        if self.shutdown_requested.load(Ordering::Acquire) {
            return Err(HostError::ShuttingDown);
        }
        if self.status().state != RuntimeState::Ready {
            return Err(HostError::Unavailable);
        }
        if self.lifecycle_command_in_flight.load(Ordering::Acquire) {
            return Err(HostError::Busy);
        }
        if self.portable_import_in_flight.load(Ordering::Acquire) {
            return Err(HostError::Busy);
        }
        if self
            .portable_export_in_flight
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(HostError::Busy);
        }
        self.cancellation.pre_arm();
        let (reply, receiver) = mpsc::channel();
        if self
            .commands
            .send(Command::PortableExport { destination, reply })
            .is_err()
        {
            self.cancellation.clear_pre_arm();
            self.portable_export_in_flight
                .store(false, Ordering::Release);
            return Err(HostError::Unavailable);
        }
        Ok(receiver)
    }

    pub fn portable_import_inspect(
        &self,
        source: std::path::PathBuf,
    ) -> Result<mpsc::Receiver<PortableImportInspectResult>, HostError> {
        let _admission = self.admission.lock().expect("runtime admission poisoned");
        self.admit_portable_import()?;
        self.cancellation.pre_arm();
        let (reply, receiver) = mpsc::channel();
        if self
            .commands
            .send(Command::PortableImportInspect { source, reply })
            .is_err()
        {
            self.cancellation.clear_pre_arm();
            self.portable_import_in_flight
                .store(false, Ordering::Release);
            return Err(HostError::Unavailable);
        }
        Ok(receiver)
    }

    pub fn portable_import(
        &self,
        request: PortableImportRequest,
    ) -> Result<mpsc::Receiver<PortableImportResult>, HostError> {
        let _admission = self.admission.lock().expect("runtime admission poisoned");
        self.admit_portable_import()?;
        self.cancellation.pre_arm();
        let (reply, receiver) = mpsc::channel();
        if self
            .commands
            .send(Command::PortableImport { request, reply })
            .is_err()
        {
            self.cancellation.clear_pre_arm();
            self.portable_import_in_flight
                .store(false, Ordering::Release);
            return Err(HostError::Unavailable);
        }
        Ok(receiver)
    }

    fn admit_portable_import(&self) -> Result<(), HostError> {
        if self.shutdown_requested.load(Ordering::Acquire) {
            return Err(HostError::ShuttingDown);
        }
        if self.status().state != RuntimeState::Ready {
            return Err(HostError::Unavailable);
        }
        if self.lifecycle_command_in_flight.load(Ordering::Acquire)
            || self.portable_export_in_flight.load(Ordering::Acquire)
        {
            return Err(HostError::Busy);
        }
        self.portable_import_in_flight
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| ())
            .map_err(|_| HostError::Busy)
    }

    /// Intended for non-UI process exit. UI callbacks should use `shutdown`
    /// and observe `RuntimeCompletion` rather than blocking.
    pub fn join(mut self) -> ShutdownOutcome {
        let _ = self.shutdown();
        let outcome = self.completion.wait();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        outcome
    }

    fn send(&self, command: Command) -> Result<(), HostError> {
        let _admission = self.admission.lock().expect("runtime admission poisoned");
        if self.shutdown_requested.load(Ordering::Acquire) {
            return Err(HostError::ShuttingDown);
        }
        if self.portable_export_in_flight.load(Ordering::Acquire)
            || self.portable_import_in_flight.load(Ordering::Acquire)
        {
            return Err(HostError::Busy);
        }
        if self
            .lifecycle_command_in_flight
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(HostError::Busy);
        }
        self.cancellation.pre_arm();
        self.commands.send(command).map_err(|_| {
            self.cancellation.clear_pre_arm();
            self.lifecycle_command_in_flight
                .store(false, Ordering::Release);
            HostError::Unavailable
        })
    }

    fn cancel_then_send(&self, command: Command) -> Result<(), HostError> {
        let _admission = self.admission.lock().expect("runtime admission poisoned");
        if self.shutdown_requested.load(Ordering::Acquire) {
            return Err(HostError::ShuttingDown);
        }
        self.cancellation.cancel();
        self.commands
            .send(command)
            .map_err(|_| HostError::Unavailable)
    }
}

impl Drop for RuntimeHost {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

const SHUTDOWN_CLEANUP_RETRIES: usize = 2;

fn run_worker<E: EffectExecutor>(
    coordinator: &mut Coordinator<E>,
    receiver: mpsc::Receiver<Command>,
    status: &RwLock<RuntimeStatus>,
    lifecycle_command_in_flight: &AtomicBool,
    portable_export_in_flight: &AtomicBool,
    portable_import_in_flight: &AtomicBool,
) -> ShutdownOutcome {
    while let Ok(command) = receiver.recv() {
        let mut publish_from_lifecycle = true;
        match command {
            Command::Start => {
                publish(
                    status,
                    RuntimeState::Starting,
                    coordinator.lifecycle().generation(),
                );
                let _ = coordinator.start();
                lifecycle_command_in_flight.store(false, Ordering::Release);
            }
            Command::Retry => {
                publish(
                    status,
                    RuntimeState::Starting,
                    coordinator.lifecycle().generation(),
                );
                let _ = coordinator.retry();
                lifecycle_command_in_flight.store(false, Ordering::Release);
            }
            Command::Stop => {
                publish(
                    status,
                    RuntimeState::Stopping,
                    coordinator.lifecycle().generation(),
                );
                let _ = coordinator.stop();
            }
            Command::Shutdown => {
                publish(
                    status,
                    RuntimeState::Stopping,
                    coordinator.lifecycle().generation(),
                );
                let outcome = shutdown_coordinator(coordinator);
                publish_lifecycle(status, coordinator);
                return outcome;
            }
            Command::PortableExport { destination, reply } => {
                let result = coordinator.portable_export(destination);
                portable_export_in_flight.store(false, Ordering::Release);
                let _ = reply.send(result);
            }
            Command::PortableImportInspect { source, reply } => {
                let result = coordinator.portable_import_inspect(source);
                portable_import_in_flight.store(false, Ordering::Release);
                let _ = reply.send(result);
            }
            Command::PortableImport { request, reply } => {
                let result = coordinator.portable_import(request);
                if matches!(
                    result,
                    PortableImportResult::ImportedRestartRequired
                        | PortableImportResult::RecoveryRequired
                ) {
                    publish(
                        status,
                        RuntimeState::RecoverableFailure,
                        coordinator.lifecycle().generation(),
                    );
                    publish_from_lifecycle = false;
                }
                portable_import_in_flight.store(false, Ordering::Release);
                let _ = reply.send(result);
            }
        }
        if publish_from_lifecycle {
            publish_lifecycle(status, coordinator);
        }
    }
    ShutdownOutcome::Incomplete
}

fn shutdown_coordinator<E: EffectExecutor>(coordinator: &mut Coordinator<E>) -> ShutdownOutcome {
    for _ in 0..=SHUTDOWN_CLEANUP_RETRIES {
        if coordinator.stop().is_ok()
            && !matches!(coordinator.lifecycle().phase(), Phase::CleaningUp(_))
        {
            return ShutdownOutcome::Clean;
        }
    }
    ShutdownOutcome::Incomplete
}

fn publish_lifecycle<E: EffectExecutor>(
    status: &RwLock<RuntimeStatus>,
    coordinator: &Coordinator<E>,
) {
    let lifecycle = coordinator.lifecycle();
    let state = match lifecycle.phase() {
        Phase::Idle => RuntimeState::Idle,
        Phase::Ready => RuntimeState::Ready,
        Phase::CleaningUp(_) => RuntimeState::Stopping,
        Phase::RecoverableFailure(_) => RuntimeState::RecoverableFailure,
        Phase::IncompatibleData(_) => RuntimeState::IncompatibleData,
        Phase::AcquiringLock
        | Phase::ValidatingRuntime
        | Phase::StartingDatabase
        | Phase::VerifyingDatabase
        | Phase::BackingUpDatabase
        | Phase::MigratingDatabase
        | Phase::StartingApi
        | Phase::StartingWorker => RuntimeState::Starting,
    };
    publish(status, state, lifecycle.generation());
}

fn publish(status: &RwLock<RuntimeStatus>, state: RuntimeState, generation: u64) {
    *status.write().expect("runtime status poisoned") = RuntimeStatus { state, generation };
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{Arc, Mutex, mpsc},
        thread,
        time::{Duration, Instant},
    };

    use super::*;
    use crate::runtime::{
        coordinator::{Cancellation, EffectOutcome},
        state::Effect,
    };

    #[derive(Default)]
    struct Fake {
        calls: Arc<Mutex<Vec<&'static str>>>,
        block_lock: Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>,
        fail_first_lock: bool,
        panic_lock: bool,
        cleanup_failures: usize,
        portable_export_cancellations: Arc<Mutex<Vec<bool>>>,
    }

    impl EffectExecutor for Fake {
        type Error = &'static str;

        fn execute(
            &mut self,
            effect: Effect,
            cancellation: &Cancellation,
        ) -> Result<EffectOutcome, Self::Error> {
            let name = match effect {
                Effect::AcquireLock { .. } => "lock",
                Effect::ValidateAndStageRuntime { .. } => "runtime",
                Effect::StartDatabase { .. } => "database",
                Effect::VerifyDatabase { .. } => "verify",
                Effect::StartApi { .. } => "api",
                Effect::StartWorker { .. } => "worker",
                Effect::StopWorker { .. } => "stop-worker",
                Effect::StopApi { .. } => "stop-api",
                Effect::StopDatabase { .. } => "stop-database",
                Effect::ReleaseLock { .. } => "release-lock",
                Effect::BackupDatabase { .. } => "backup",
                Effect::MigrateDatabase { .. } => "migrate",
            };
            self.calls.lock().unwrap().push(name);
            if name == "lock" && self.panic_lock {
                panic!("executor panic");
            }
            if name == "lock" && self.fail_first_lock {
                self.fail_first_lock = false;
                return Err("first lock failed");
            }
            if name == "lock" && self.block_lock.is_some() {
                let (entered, release) = self.block_lock.as_ref().unwrap();
                entered.send(()).unwrap();
                release.recv().unwrap();
                if cancellation.is_cancelled() {
                    return Err("cancelled");
                }
            }
            if name == "stop-worker" && self.cleanup_failures > 0 {
                self.cleanup_failures -= 1;
                return Err("transient cleanup failure");
            }
            Ok(if name == "verify" {
                EffectOutcome::DatabaseVerified {
                    needs_migration: false,
                }
            } else {
                EffectOutcome::Completed
            })
        }

        fn configure_bridge(&mut self, _: u64) -> Result<(), Self::Error> {
            self.calls.lock().unwrap().push("bridge");
            Ok(())
        }
        fn clear_bridge(&mut self, _: u64) -> Result<(), Self::Error> {
            self.calls.lock().unwrap().push("clear-bridge");
            Ok(())
        }
        fn cancel(&mut self, _: u64) {
            self.calls.lock().unwrap().push("cancel");
        }

        fn portable_export(
            &mut self,
            _: std::path::PathBuf,
            cancellation: &Cancellation,
        ) -> PortableExportResult {
            self.portable_export_cancellations
                .lock()
                .unwrap()
                .push(cancellation.is_cancelled());
            PortableExportResult::Unavailable
        }
    }

    fn wait_for(host: &RuntimeHost, expected: RuntimeState) {
        for _ in 0..100 {
            if host.status().state == expected {
                return;
            }
            thread::sleep(Duration::from_millis(5));
        }
        panic!("timed out waiting for {expected:?}: {:?}", host.status());
    }

    fn ready_host_without_worker(
        commands: mpsc::Sender<Command>,
        cancellation: CancellationHandle,
    ) -> RuntimeHost {
        RuntimeHost {
            commands,
            cancellation,
            admission: Arc::new(Mutex::new(())),
            lifecycle_command_in_flight: Arc::new(AtomicBool::new(false)),
            portable_export_in_flight: Arc::new(AtomicBool::new(false)),
            portable_import_in_flight: Arc::new(AtomicBool::new(false)),
            status: Arc::new(RwLock::new(RuntimeStatus {
                state: RuntimeState::Ready,
                generation: 1,
            })),
            shutdown_requested: Arc::new(AtomicBool::new(false)),
            completion: RuntimeCompletion::default(),
            worker: None,
        }
    }

    #[test]
    fn auto_start_serializes_a_complete_lifecycle() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let host = RuntimeHost::spawn(Fake {
            calls: calls.clone(),
            ..Default::default()
        });
        host.auto_start().unwrap();
        wait_for(&host, RuntimeState::Ready);
        assert_eq!(host.status().generation, 1);
        host.shutdown().unwrap().wait();
        assert_eq!(host.status().state, RuntimeState::Idle);
        assert_eq!(
            calls
                .lock()
                .unwrap()
                .iter()
                .filter(|&&x| x == "release-lock")
                .count(),
            1
        );
    }

    #[test]
    fn retry_is_serialized_after_a_redacted_failure() {
        let host = RuntimeHost::spawn(Fake {
            fail_first_lock: true,
            ..Default::default()
        });
        host.start().unwrap();
        wait_for(&host, RuntimeState::RecoverableFailure);
        assert_eq!(host.status().generation, 1);
        host.retry().unwrap();
        wait_for(&host, RuntimeState::Ready);
        assert_eq!(host.status().generation, 2);
        host.join();
    }

    #[test]
    fn stop_cancels_blocked_start_before_its_command_is_processed() {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let host = RuntimeHost::spawn(Fake {
            calls: calls.clone(),
            block_lock: Some((entered_tx, release_rx)),
            ..Default::default()
        });
        host.auto_start().unwrap();
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        host.stop().unwrap();
        release_tx.send(()).unwrap();
        wait_for(&host, RuntimeState::Idle);
        assert_eq!(
            calls.lock().unwrap().as_slice(),
            ["lock", "cancel", "release-lock"]
        );
        host.join();
    }

    #[test]
    fn status_is_redacted_and_copyable_across_threads() {
        let host = RuntimeHost::spawn(Fake::default());
        let status = host.status();
        assert_eq!(status, RuntimeStatus::default());
        host.auto_start().unwrap();
        wait_for(&host, RuntimeState::Ready);
        let observed = thread::scope(|scope| scope.spawn(|| host.status()).join().unwrap());
        assert_eq!(observed.state, RuntimeState::Ready);
        host.join();
    }

    #[test]
    fn duplicate_shutdown_is_exactly_once_and_never_deadlocks() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let host = RuntimeHost::spawn(Fake {
            calls: calls.clone(),
            ..Default::default()
        });
        host.auto_start().unwrap();
        wait_for(&host, RuntimeState::Ready);
        let first = host.shutdown().unwrap();
        let second = host.shutdown().unwrap();
        first.wait();
        assert!(second.is_complete());
        assert_eq!(
            calls
                .lock()
                .unwrap()
                .iter()
                .filter(|&&x| x == "stop-worker")
                .count(),
            1
        );
        assert_eq!(
            calls
                .lock()
                .unwrap()
                .iter()
                .filter(|&&x| x == "release-lock")
                .count(),
            1
        );
    }

    #[test]
    fn completion_allows_nonblocking_ui_shutdown_then_join() {
        let host = RuntimeHost::spawn(Fake::default());
        let completion = host.shutdown().unwrap();
        assert_eq!(completion.wait(), ShutdownOutcome::Clean);
        assert!(completion.is_complete());
        assert_eq!(host.join(), ShutdownOutcome::Clean);
    }

    #[test]
    fn completion_deadline_returns_without_polling() {
        let completion = RuntimeCompletion::default();
        assert_eq!(completion.wait_until(Instant::now()), None);
    }

    #[test]
    fn shutdown_cancels_an_in_flight_portable_export_and_keeps_one_reply() {
        struct ExportBlocker {
            entered: mpsc::Sender<()>,
        }
        impl EffectExecutor for ExportBlocker {
            type Error = ();
            fn execute(&mut self, effect: Effect, _: &Cancellation) -> Result<EffectOutcome, ()> {
                Ok(if matches!(effect, Effect::VerifyDatabase { .. }) {
                    EffectOutcome::DatabaseVerified {
                        needs_migration: false,
                    }
                } else {
                    EffectOutcome::Completed
                })
            }
            fn configure_bridge(&mut self, _: u64) -> Result<(), ()> {
                Ok(())
            }
            fn clear_bridge(&mut self, _: u64) -> Result<(), ()> {
                Ok(())
            }
            fn cancel(&mut self, _: u64) {}
            fn portable_export(
                &mut self,
                _: std::path::PathBuf,
                cancellation: &Cancellation,
            ) -> PortableExportResult {
                self.entered.send(()).unwrap();
                while !cancellation.is_cancelled() {
                    thread::sleep(Duration::from_millis(1));
                }
                PortableExportResult::Unavailable
            }
        }
        let (entered_tx, entered_rx) = mpsc::channel();
        let host = RuntimeHost::spawn(ExportBlocker {
            entered: entered_tx,
        });
        host.auto_start().unwrap();
        wait_for(&host, RuntimeState::Ready);
        let reply = host
            .portable_export(std::path::PathBuf::from("C:\\export.schedule"))
            .unwrap();
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let completion = host.shutdown().unwrap();
        assert_eq!(
            reply.recv_timeout(Duration::from_secs(1)).unwrap(),
            PortableExportResult::Unavailable
        );
        assert_eq!(completion.wait(), ShutdownOutcome::Clean);
    }

    #[test]
    fn shutdown_after_export_enqueue_cancels_before_export_activation() {
        let observed = Arc::new(Mutex::new(Vec::new()));
        let mut coordinator = Coordinator::new(Fake {
            portable_export_cancellations: observed.clone(),
            ..Default::default()
        });
        coordinator.start().unwrap();
        let cancellation = coordinator.cancellation_handle();
        let (commands, receiver) = mpsc::channel();
        let host = ready_host_without_worker(commands, cancellation.clone());

        host.lifecycle_command_in_flight
            .store(true, Ordering::Release);
        assert!(matches!(
            host.portable_export(std::path::PathBuf::from("C:\\busy.schedule")),
            Err(HostError::Busy)
        ));
        assert!(!cancellation.cancel());
        host.lifecycle_command_in_flight
            .store(false, Ordering::Release);

        let reply = host
            .portable_export(std::path::PathBuf::from("C:\\export.schedule"))
            .unwrap();
        assert!(host.portable_export_in_flight.load(Ordering::Acquire));
        assert_eq!(host.start(), Err(HostError::Busy));
        host.shutdown().unwrap();

        assert_eq!(
            run_worker(
                &mut coordinator,
                receiver,
                &host.status,
                &host.lifecycle_command_in_flight,
                &host.portable_export_in_flight,
                &host.portable_import_in_flight,
            ),
            ShutdownOutcome::Clean
        );
        assert_eq!(reply.recv().unwrap(), PortableExportResult::Unavailable);
        assert_eq!(reply.try_recv(), Err(mpsc::TryRecvError::Disconnected));
        assert_eq!(*observed.lock().unwrap(), [true]);
        assert!(!host.portable_export_in_flight.load(Ordering::Acquire));
        assert!(!cancellation.cancel());
    }

    #[test]
    fn failed_export_enqueue_clears_cancellation_and_admission() {
        let cancellation = CancellationHandle::default();
        let (commands, receiver) = mpsc::channel();
        drop(receiver);
        let host = ready_host_without_worker(commands, cancellation.clone());

        assert!(matches!(
            host.portable_export(std::path::PathBuf::from("C:\\export.schedule")),
            Err(HostError::Unavailable)
        ));
        assert!(!host.portable_export_in_flight.load(Ordering::Acquire));
        assert!(!cancellation.cancel());
    }

    #[test]
    fn panicking_worker_completes_with_a_redacted_failure() {
        let host = RuntimeHost::spawn(Fake {
            panic_lock: true,
            ..Default::default()
        });
        host.start().unwrap();
        assert_eq!(host.completion().wait(), ShutdownOutcome::WorkerFailed);
        assert_eq!(host.start(), Err(HostError::Unavailable));
        assert_eq!(host.retry(), Err(HostError::Unavailable));
        assert_eq!(host.join(), ShutdownOutcome::WorkerFailed);
    }

    #[test]
    fn shutdown_retries_a_transient_cleanup_failure() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let host = RuntimeHost::spawn(Fake {
            calls: calls.clone(),
            cleanup_failures: 1,
            ..Default::default()
        });
        host.start().unwrap();
        wait_for(&host, RuntimeState::Ready);
        assert_eq!(host.shutdown().unwrap().wait(), ShutdownOutcome::Clean);
        assert_eq!(
            calls
                .lock()
                .unwrap()
                .iter()
                .filter(|&&x| x == "stop-worker")
                .count(),
            2
        );
    }

    #[test]
    fn shutdown_reports_persistent_cleanup_failure_without_hanging() {
        let host = RuntimeHost::spawn(Fake {
            cleanup_failures: SHUTDOWN_CLEANUP_RETRIES + 2,
            ..Default::default()
        });
        host.start().unwrap();
        wait_for(&host, RuntimeState::Ready);
        let completion = host.shutdown().unwrap();
        assert_eq!(completion.wait(), ShutdownOutcome::Incomplete);
        assert_eq!(completion.outcome(), Some(ShutdownOutcome::Incomplete));
    }

    #[test]
    fn commands_after_shutdown_are_rejected() {
        let host = RuntimeHost::spawn(Fake::default());
        let completion = host.shutdown().unwrap();
        assert_eq!(host.start(), Err(HostError::ShuttingDown));
        assert_eq!(host.retry(), Err(HostError::ShuttingDown));
        assert_eq!(host.stop(), Err(HostError::ShuttingDown));
        assert_eq!(completion.wait(), ShutdownOutcome::Clean);
    }

    #[test]
    fn duplicate_lifecycle_commands_are_coalesced_before_they_can_share_a_token() {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let host = RuntimeHost::spawn(Fake {
            block_lock: Some((entered_tx, release_rx)),
            ..Default::default()
        });
        host.start().unwrap();
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(host.start(), Err(HostError::Busy));
        assert_eq!(host.retry(), Err(HostError::Busy));
        host.stop().unwrap();
        release_tx.send(()).unwrap();
        wait_for(&host, RuntimeState::Idle);
        assert!(host.start().is_ok());
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        release_tx.send(()).unwrap();
        wait_for(&host, RuntimeState::Ready);
        host.join();
    }

    #[test]
    fn start_and_shutdown_admission_are_linearized() {
        for _ in 0..32 {
            let host = RuntimeHost::spawn(Fake::default());
            let barrier = Arc::new(std::sync::Barrier::new(3));
            thread::scope(|scope| {
                let host = &host;
                let start_barrier = barrier.clone();
                let shutdown_barrier = barrier.clone();
                let start = scope.spawn(move || {
                    start_barrier.wait();
                    host.start()
                });
                let shutdown = scope.spawn(move || {
                    shutdown_barrier.wait();
                    host.shutdown()
                });
                barrier.wait();
                let _ = start.join().unwrap();
                let completion = shutdown.join().unwrap().unwrap();
                assert_eq!(completion.wait(), ShutdownOutcome::Clean);
            });
            assert_eq!(host.start(), Err(HostError::ShuttingDown));
            assert_eq!(host.join(), ShutdownOutcome::Clean);
        }
    }

    struct DropPanic;

    impl Drop for DropPanic {
        fn drop(&mut self) {
            panic!("executor drop panic");
        }
    }

    impl EffectExecutor for DropPanic {
        type Error = &'static str;

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

    #[test]
    fn panicking_executor_drop_still_completes() {
        let host = RuntimeHost::spawn(DropPanic);
        host.start().unwrap();
        wait_for(&host, RuntimeState::Ready);
        assert_eq!(
            host.shutdown().unwrap().wait(),
            ShutdownOutcome::WorkerFailed
        );
        assert_eq!(host.join(), ShutdownOutcome::WorkerFailed);
    }
}
