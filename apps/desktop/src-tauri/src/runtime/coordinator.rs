//! Serialized owner for the pure runtime lifecycle reducer.
//!
//! The executor is deliberately an adapter boundary: production code can start
//! processes there while tests use a small fake.  This module performs no I/O.

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

use super::state::{Effect, Event, Failure, Incompatibility, Lifecycle, Phase, Rejection};

#[derive(Clone, Debug, Default)]
pub struct Cancellation(Arc<AtomicBool>);

impl Cancellation {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

/// Stable, externally clonable control for the currently active generation.
/// It is safe to retain across retries: it affects only a currently published
/// cancellation token and becomes a no-op after cleanup completes.
#[derive(Clone, Debug, Default)]
pub struct CancellationHandle(Arc<Mutex<CancellationSlots>>);

#[derive(Debug, Default)]
struct CancellationSlots {
    active: Option<Cancellation>,
    pre_armed: Option<Cancellation>,
}

impl CancellationHandle {
    pub fn cancel(&self) -> bool {
        let guard = self.0.lock().expect("cancellation handle poisoned");
        if let Some(token) = guard.active.as_ref().or(guard.pre_armed.as_ref()) {
            token.cancel();
            true
        } else {
            false
        }
    }

    /// Publish a cancellation token before a threaded host queues Start/Retry.
    /// Direct coordinator callers do not need this; `begin` creates a token
    /// when no pre-armed token exists.
    pub fn pre_arm(&self) {
        let mut guard = self.0.lock().expect("cancellation handle poisoned");
        if guard.active.is_none() && guard.pre_armed.is_none() {
            guard.pre_armed = Some(Cancellation::default());
        }
    }

    pub fn clear_pre_arm(&self) {
        self.0
            .lock()
            .expect("cancellation handle poisoned")
            .pre_armed = None;
    }

    fn activate(&self) -> Cancellation {
        let mut guard = self.0.lock().expect("cancellation handle poisoned");
        let cancellation = guard.pre_armed.take().unwrap_or_default();
        guard.active = Some(cancellation.clone());
        cancellation
    }

    fn clear_active(&self) {
        self.0.lock().expect("cancellation handle poisoned").active = None;
    }
}

/// Starts or stops one lifecycle effect. `StartApi` has started successfully
/// before `configure_bridge` is called; `clear_bridge` is called before
/// `StopApi` is submitted.
pub trait EffectExecutor {
    type Error;

    fn execute(
        &mut self,
        effect: Effect,
        cancellation: &Cancellation,
    ) -> Result<EffectOutcome, Self::Error>;
    fn configure_bridge(&mut self, generation: u64) -> Result<(), Self::Error>;
    fn clear_bridge(&mut self, generation: u64) -> Result<(), Self::Error>;
    fn cancel(&mut self, generation: u64);
    fn portable_export(
        &mut self,
        _: std::path::PathBuf,
        _: &Cancellation,
    ) -> crate::runtime::portable::PortableExportResult {
        crate::runtime::portable::PortableExportResult::Unavailable
    }
    fn portable_import_inspect(
        &mut self,
        _: std::path::PathBuf,
        _: &Cancellation,
    ) -> crate::runtime::portable::PortableImportInspectResult {
        crate::runtime::portable::PortableImportInspectResult::Unavailable
    }
    fn portable_import(
        &mut self,
        _: crate::runtime::portable::PortableImportRequest,
        _: &Cancellation,
    ) -> crate::runtime::portable::PortableImportResult {
        crate::runtime::portable::PortableImportResult::Unavailable
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EffectOutcome {
    Completed,
    DatabaseVerified { needs_migration: bool },
    Incompatible(Incompatibility),
}

#[derive(Debug)]
pub enum CoordinatorError<E> {
    Effect {
        failure: Failure,
        source: E,
    },
    Cleanup {
        issue: CleanupIssue<E>,
    },
    EffectAndCleanup {
        failure: Failure,
        source: E,
        cleanup: CleanupIssue<E>,
    },
    Unexpected,
    UnexpectedAndCleanup {
        cleanup: CleanupIssue<E>,
    },
    Rejected(Rejection),
}

#[derive(Debug)]
pub enum CleanupIssue<E> {
    Executor(E),
    UnexpectedOutcome,
}

/// A single-threaded lifecycle owner.  Do not share it across threads; callers
/// may retain `cancellation()` to request a stop while an executor is working.
pub struct Coordinator<E> {
    lifecycle: Lifecycle,
    executor: E,
    cancellation: Option<Cancellation>,
    cancellation_handle: CancellationHandle,
    pending_cleanup: Option<Vec<Effect>>,
}

impl<E: EffectExecutor> Coordinator<E> {
    pub fn new(executor: E) -> Self {
        Self {
            lifecycle: Lifecycle::default(),
            executor,
            cancellation: None,
            cancellation_handle: CancellationHandle::default(),
            pending_cleanup: None,
        }
    }

    pub fn lifecycle(&self) -> &Lifecycle {
        &self.lifecycle
    }

    pub fn executor(&self) -> &E {
        &self.executor
    }

    pub fn executor_mut(&mut self) -> &mut E {
        &mut self.executor
    }

    pub fn cancellation_handle(&self) -> CancellationHandle {
        self.cancellation_handle.clone()
    }

    pub fn portable_export(
        &mut self,
        destination: std::path::PathBuf,
    ) -> crate::runtime::portable::PortableExportResult {
        if !matches!(self.lifecycle.phase(), Phase::Ready) {
            self.cancellation_handle.clear_pre_arm();
            return crate::runtime::portable::PortableExportResult::Unavailable;
        }
        let cancellation = self.cancellation_handle.activate();
        let result = self.executor.portable_export(destination, &cancellation);
        self.cancellation_handle.clear_active();
        result
    }

    pub fn portable_import_inspect(
        &mut self,
        source: std::path::PathBuf,
    ) -> crate::runtime::portable::PortableImportInspectResult {
        if !matches!(self.lifecycle.phase(), Phase::Ready) {
            self.cancellation_handle.clear_pre_arm();
            return crate::runtime::portable::PortableImportInspectResult::Unavailable;
        }
        let cancellation = self.cancellation_handle.activate();
        let result = self.executor.portable_import_inspect(source, &cancellation);
        self.cancellation_handle.clear_active();
        result
    }

    pub fn portable_import(
        &mut self,
        request: crate::runtime::portable::PortableImportRequest,
    ) -> crate::runtime::portable::PortableImportResult {
        if !matches!(self.lifecycle.phase(), Phase::Ready) {
            self.cancellation_handle.clear_pre_arm();
            return crate::runtime::portable::PortableImportResult::Unavailable;
        }
        let cancellation = self.cancellation_handle.activate();
        let result = self.executor.portable_import(request, &cancellation);
        self.cancellation_handle.clear_active();
        if matches!(
            result,
            crate::runtime::portable::PortableImportResult::ImportedRestartRequired
                | crate::runtime::portable::PortableImportResult::RecoveryRequired
        ) {
            let _ = self.apply(Event::Failed {
                generation: self.lifecycle.generation(),
                failure: Failure::Database,
            });
        }
        result
    }

    pub fn start(&mut self) -> Result<(), CoordinatorError<E::Error>> {
        self.begin(Event::Start)
    }

    pub fn retry(&mut self) -> Result<(), CoordinatorError<E::Error>> {
        if matches!(self.lifecycle.phase(), Phase::CleaningUp(_)) {
            self.retry_cleanup()
        } else {
            self.begin(Event::Retry)
        }
    }

    pub fn stop(&mut self) -> Result<(), CoordinatorError<E::Error>> {
        if matches!(self.lifecycle.phase(), Phase::CleaningUp(_)) {
            return self.retry_cleanup();
        }
        if matches!(
            self.lifecycle.phase(),
            Phase::Idle | Phase::RecoverableFailure(_) | Phase::IncompatibleData(_)
        ) {
            return Ok(());
        }
        let generation = self.lifecycle.generation();
        if let Some(cancellation) = &self.cancellation {
            cancellation.cancel();
        }
        self.executor.cancel(generation);
        self.apply(Event::StopRequested)
    }

    fn begin(&mut self, event: Event) -> Result<(), CoordinatorError<E::Error>> {
        let transition = match self.lifecycle.transition(event) {
            Ok(transition) => transition,
            Err(rejection) => {
                if self.cancellation.is_none() {
                    self.cancellation_handle.clear_pre_arm();
                }
                return Err(CoordinatorError::Rejected(rejection));
            }
        };
        self.lifecycle = transition.lifecycle;
        let cancellation = self.cancellation_handle.activate();
        self.cancellation = Some(cancellation);
        self.run(transition.effects)
    }

    fn apply(&mut self, event: Event) -> Result<(), CoordinatorError<E::Error>> {
        let transition = self
            .lifecycle
            .transition(event)
            .map_err(CoordinatorError::Rejected)?;
        self.lifecycle = transition.lifecycle;
        self.run(transition.effects)
    }

    fn run(&mut self, mut effects: Vec<Effect>) -> Result<(), CoordinatorError<E::Error>> {
        effects.reverse();
        while let Some(effect) = effects.pop() {
            if matches!(self.lifecycle.phase(), Phase::CleaningUp(_)) {
                return self.finish_cleanup(
                    std::iter::once(effect)
                        .chain(effects.into_iter().rev())
                        .collect(),
                );
            }
            if self.is_cancelled() {
                return self.stop();
            }
            let generation = effect_generation(&effect);
            let outcome = match self.executor.execute(
                effect.clone(),
                self.cancellation.as_ref().expect("active generation"),
            ) {
                Ok(outcome) => outcome,
                Err(_) if self.is_cancelled() => return self.stop(),
                Err(source) => return self.fail(generation, failure_for(&effect), source),
            };
            // Validate every outcome before it can trigger an observable side
            // effect such as bridge publication.
            let event = match completion_event(effect.clone(), outcome) {
                Ok(event) => event,
                Err(CompletionError::Incompatible(incompatibility)) => Event::IncompatibleData {
                    generation,
                    incompatibility,
                },
                Err(CompletionError::Unexpected) => return self.unexpected(generation),
            };
            // Do not briefly publish an API target after a late cancellation.
            // A successful acquisition is still released by the reducer's
            // idempotent cleanup effects below.
            if self.is_cancelled() {
                return self.stop();
            }
            if matches!(event, Event::ApiStarted { .. }) {
                if let Err(source) = self.executor.configure_bridge(generation) {
                    return self.fail(generation, Failure::Api, source);
                }
            }
            // A resource may have been acquired just before cancellation. The
            // reducer's cleanup effects are idempotent and release it safely.
            if self.is_cancelled() {
                return self.stop();
            }
            if matches!(event, Event::WorkerStarted { .. }) {
                let mut active = self
                    .cancellation_handle
                    .0
                    .lock()
                    .expect("cancellation handle poisoned");
                if self.is_cancelled() {
                    drop(active);
                    return self.stop();
                }
                let transition = self
                    .lifecycle
                    .transition(event)
                    .map_err(CoordinatorError::Rejected)?;
                self.lifecycle = transition.lifecycle;
                self.cancellation = None;
                active.active = None;
                effects = transition.effects;
                effects.reverse();
                continue;
            }
            let transition = self
                .lifecycle
                .transition(event)
                .map_err(CoordinatorError::Rejected)?;
            self.lifecycle = transition.lifecycle;
            effects = transition.effects;
            effects.reverse();
        }
        Ok(())
    }

    fn fail(
        &mut self,
        generation: u64,
        failure: Failure,
        source: E::Error,
    ) -> Result<(), CoordinatorError<E::Error>> {
        let transition = self
            .lifecycle
            .transition(Event::Failed {
                generation,
                failure: failure.clone(),
            })
            .map_err(CoordinatorError::Rejected)?;
        self.lifecycle = transition.lifecycle;
        match self.run(transition.effects) {
            Ok(()) => Err(CoordinatorError::Effect { failure, source }),
            Err(CoordinatorError::Cleanup { issue }) => Err(CoordinatorError::EffectAndCleanup {
                failure,
                source,
                cleanup: issue,
            }),
            Err(error) => Err(error),
        }
    }

    fn unexpected(&mut self, generation: u64) -> Result<(), CoordinatorError<E::Error>> {
        let transition = self
            .lifecycle
            .transition(Event::Failed {
                generation,
                failure: Failure::Unexpected,
            })
            .map_err(CoordinatorError::Rejected)?;
        self.lifecycle = transition.lifecycle;
        match self.run(transition.effects) {
            Ok(()) => Err(CoordinatorError::Unexpected),
            Err(CoordinatorError::Cleanup { issue }) => {
                Err(CoordinatorError::UnexpectedAndCleanup { cleanup: issue })
            }
            Err(error) => Err(error),
        }
    }

    fn retry_cleanup(&mut self) -> Result<(), CoordinatorError<E::Error>> {
        self.finish_cleanup(
            self.pending_cleanup
                .clone()
                .expect("pending cleanup effects"),
        )
    }

    fn finish_cleanup(&mut self, effects: Vec<Effect>) -> Result<(), CoordinatorError<E::Error>> {
        let generation = self.lifecycle.generation();
        // Cleanup must not inherit the cancelled startup token: cancellation
        // stops further acquisition, while every teardown operation must run.
        let cleanup_cancellation = Cancellation::default();
        self.pending_cleanup = Some(effects.clone());
        let mut first_issue = None;
        for effect in effects {
            if matches!(effect, Effect::StopApi { .. }) {
                if let Err(error) = self.executor.clear_bridge(generation) {
                    if first_issue.is_none() {
                        first_issue = Some(CleanupIssue::Executor(error));
                    }
                }
            }
            match self.executor.execute(effect, &cleanup_cancellation) {
                Ok(EffectOutcome::Completed) => {}
                Ok(_) => {
                    if first_issue.is_none() {
                        first_issue = Some(CleanupIssue::UnexpectedOutcome);
                    }
                }
                Err(error) => {
                    if first_issue.is_none() {
                        first_issue = Some(CleanupIssue::Executor(error));
                    }
                }
            }
        }
        if let Some(issue) = first_issue {
            return Err(CoordinatorError::Cleanup { issue });
        }
        let transition = self
            .lifecycle
            .transition(Event::CleanupCompleted { generation })
            .map_err(CoordinatorError::Rejected)?;
        self.lifecycle = transition.lifecycle;
        self.pending_cleanup = None;
        self.cancellation = None;
        self.cancellation_handle.clear_active();
        Ok(())
    }

    fn is_cancelled(&self) -> bool {
        self.cancellation
            .as_ref()
            .is_some_and(Cancellation::is_cancelled)
    }
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

fn failure_for(effect: &Effect) -> Failure {
    match effect {
        Effect::AcquireLock { .. } => Failure::Lock,
        Effect::ValidateAndStageRuntime { .. } => Failure::Runtime,
        Effect::StartDatabase { .. } | Effect::VerifyDatabase { .. } => Failure::Database,
        Effect::BackupDatabase { .. } => Failure::Backup,
        Effect::MigrateDatabase { .. } => Failure::Migration,
        Effect::StartApi { .. } => Failure::Api,
        Effect::StartWorker { .. } => Failure::Worker,
        _ => Failure::Unexpected,
    }
}

enum CompletionError {
    Incompatible(Incompatibility),
    Unexpected,
}

fn completion_event(effect: Effect, outcome: EffectOutcome) -> Result<Event, CompletionError> {
    let generation = effect_generation(&effect);
    match (effect, outcome) {
        (
            Effect::StartDatabase { .. } | Effect::VerifyDatabase { .. },
            EffectOutcome::Incompatible(
                incompatibility @ (Incompatibility::DatabaseMajorVersion
                | Incompatibility::DatabaseFormat),
            ),
        ) => Err(CompletionError::Incompatible(incompatibility)),
        (
            Effect::VerifyDatabase { .. },
            EffectOutcome::Incompatible(incompatibility @ Incompatibility::Migration),
        ) => Err(CompletionError::Incompatible(incompatibility)),
        (
            Effect::MigrateDatabase { .. },
            EffectOutcome::Incompatible(incompatibility @ Incompatibility::Migration),
        ) => Err(CompletionError::Incompatible(incompatibility)),
        (_, EffectOutcome::Incompatible(_)) => Err(CompletionError::Unexpected),
        (Effect::AcquireLock { .. }, EffectOutcome::Completed) => {
            Ok(Event::LockAcquired { generation })
        }
        (Effect::ValidateAndStageRuntime { .. }, EffectOutcome::Completed) => {
            Ok(Event::RuntimeStaged { generation })
        }
        (Effect::StartDatabase { .. }, EffectOutcome::Completed) => {
            Ok(Event::DatabaseStarted { generation })
        }
        (Effect::VerifyDatabase { .. }, EffectOutcome::DatabaseVerified { needs_migration }) => {
            Ok(Event::DatabaseVerified {
                generation,
                needs_migration,
            })
        }
        (Effect::BackupDatabase { .. }, EffectOutcome::Completed) => {
            Ok(Event::BackupCompleted { generation })
        }
        (Effect::MigrateDatabase { .. }, EffectOutcome::Completed) => {
            Ok(Event::MigrationCompleted { generation })
        }
        (Effect::StartApi { .. }, EffectOutcome::Completed) => Ok(Event::ApiStarted { generation }),
        (Effect::StartWorker { .. }, EffectOutcome::Completed) => {
            Ok(Event::WorkerStarted { generation })
        }
        _ => Err(CompletionError::Unexpected),
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        sync::{Arc, Barrier, Mutex, mpsc},
        thread,
    };

    use super::*;

    #[derive(Default)]
    struct Fake {
        calls: Vec<String>,
        outcomes: VecDeque<Result<EffectOutcome, &'static str>>,
        api_outcome: Option<EffectOutcome>,
        cancel_after: Option<&'static str>,
        configure_bridge_error: Option<&'static str>,
        cancel_in_configure_bridge: bool,
        clear_bridge_error: Option<&'static str>,
        reject_cancelled_work: bool,
        active_cancellation: Option<Cancellation>,
    }

    impl Fake {
        fn names(&self) -> Vec<&str> {
            self.calls.iter().map(String::as_str).collect()
        }
    }

    impl EffectExecutor for Fake {
        type Error = &'static str;
        fn execute(
            &mut self,
            effect: Effect,
            cancellation: &Cancellation,
        ) -> Result<EffectOutcome, Self::Error> {
            self.active_cancellation = Some(cancellation.clone());
            if self.reject_cancelled_work && cancellation.is_cancelled() {
                return Err("cancelled work");
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
            self.calls.push(name.into());
            if self.cancel_after == Some(name) {
                cancellation.cancel();
            }
            if name == "api" {
                if let Some(outcome) = self.api_outcome.take() {
                    return Ok(outcome);
                }
            }
            self.outcomes.pop_front().unwrap_or_else(|| {
                if name == "verify" {
                    Ok(EffectOutcome::DatabaseVerified {
                        needs_migration: false,
                    })
                } else {
                    Ok(EffectOutcome::Completed)
                }
            })
        }
        fn configure_bridge(&mut self, _: u64) -> Result<(), Self::Error> {
            self.calls.push("configure-bridge".into());
            if self.cancel_in_configure_bridge {
                self.active_cancellation
                    .as_ref()
                    .expect("API execution supplies cancellation")
                    .cancel();
            }
            self.configure_bridge_error.map_or(Ok(()), Err)
        }
        fn clear_bridge(&mut self, _: u64) -> Result<(), Self::Error> {
            self.calls.push("clear-bridge".into());
            self.clear_bridge_error.map_or(Ok(()), Err)
        }
        fn cancel(&mut self, _: u64) {
            self.calls.push("cancel".into());
        }
    }

    #[test]
    fn happy_path_is_serial_and_configures_bridge_after_api() {
        let mut coordinator = Coordinator::new(Fake::default());
        coordinator.start().unwrap();
        assert_eq!(coordinator.lifecycle().phase(), &Phase::Ready);
        assert_eq!(
            coordinator.executor().names(),
            [
                "lock",
                "runtime",
                "database",
                "verify",
                "api",
                "configure-bridge",
                "worker"
            ]
        );
    }

    #[test]
    fn unavailable_portable_export_clears_its_pre_armed_cancellation() {
        let mut coordinator = Coordinator::new(Fake::default());
        let cancellation = coordinator.cancellation_handle();
        cancellation.pre_arm();
        assert!(cancellation.cancel());

        assert_eq!(
            coordinator.portable_export(std::path::PathBuf::from("ignored.schedule")),
            crate::runtime::portable::PortableExportResult::Unavailable
        );
        assert!(!cancellation.cancel());
    }

    #[test]
    fn migration_branch_runs_backup_then_migration() {
        let fake = Fake {
            outcomes: VecDeque::from([
                Ok(EffectOutcome::Completed),
                Ok(EffectOutcome::Completed),
                Ok(EffectOutcome::Completed),
                Ok(EffectOutcome::DatabaseVerified {
                    needs_migration: true,
                }),
            ]),
            ..Default::default()
        };
        let mut coordinator = Coordinator::new(fake);
        coordinator.start().unwrap();
        assert_eq!(
            coordinator.executor().names(),
            [
                "lock",
                "runtime",
                "database",
                "verify",
                "backup",
                "migrate",
                "api",
                "configure-bridge",
                "worker"
            ]
        );
    }

    #[test]
    fn cancellation_during_every_startup_phase_releases_everything_acquired() {
        for phase in [
            "lock", "runtime", "database", "verify", "backup", "migrate", "api", "worker",
        ] {
            let mut fake = Fake {
                cancel_after: Some(phase),
                ..Default::default()
            };
            if matches!(phase, "verify" | "backup" | "migrate") {
                fake.outcomes = VecDeque::from([
                    Ok(EffectOutcome::Completed),
                    Ok(EffectOutcome::Completed),
                    Ok(EffectOutcome::Completed),
                    Ok(EffectOutcome::DatabaseVerified {
                        needs_migration: true,
                    }),
                ]);
            }
            let mut coordinator = Coordinator::new(fake);
            coordinator.start().unwrap();
            assert_eq!(coordinator.lifecycle().phase(), &Phase::Idle, "{phase}");
            assert!(coordinator.executor().names().contains(&"release-lock"));
        }
    }

    #[test]
    fn cancellation_after_late_lock_acquisition_is_cleaned() {
        let mut coordinator = Coordinator::new(Fake {
            cancel_after: Some("lock"),
            ..Default::default()
        });
        coordinator.start().unwrap();
        assert_eq!(
            coordinator.executor().names(),
            ["lock", "cancel", "release-lock"]
        );
    }

    #[test]
    fn cancellation_after_api_skips_bridge_and_cleanup_uses_a_live_token() {
        let mut coordinator = Coordinator::new(Fake {
            cancel_after: Some("api"),
            reject_cancelled_work: true,
            ..Default::default()
        });
        coordinator.start().unwrap();
        assert_eq!(
            coordinator.executor().names(),
            [
                "lock",
                "runtime",
                "database",
                "verify",
                "api",
                "cancel",
                "clear-bridge",
                "stop-api",
                "stop-database",
                "release-lock"
            ]
        );
        assert!(!coordinator.executor().names().contains(&"configure-bridge"));
    }

    #[test]
    fn bridge_configuration_failure_maps_to_api_and_cleans_started_resources() {
        let mut coordinator = Coordinator::new(Fake {
            configure_bridge_error: Some("bridge configure"),
            ..Default::default()
        });
        assert!(matches!(
            coordinator.start(),
            Err(CoordinatorError::Effect {
                failure: Failure::Api,
                source: "bridge configure"
            })
        ));
        assert_eq!(
            coordinator.lifecycle().phase(),
            &Phase::RecoverableFailure(Failure::Api)
        );
        assert_eq!(
            coordinator.executor().names(),
            [
                "lock",
                "runtime",
                "database",
                "verify",
                "api",
                "configure-bridge",
                "clear-bridge",
                "stop-api",
                "stop-database",
                "release-lock"
            ]
        );
        assert!(!coordinator.executor().names().contains(&"worker"));
    }

    #[test]
    fn cancellation_during_successful_bridge_configuration_cleans_before_worker_start() {
        let mut coordinator = Coordinator::new(Fake {
            cancel_in_configure_bridge: true,
            reject_cancelled_work: true,
            ..Default::default()
        });
        coordinator.start().unwrap();
        assert_eq!(coordinator.lifecycle().phase(), &Phase::Idle);
        assert_eq!(
            coordinator.executor().names(),
            [
                "lock",
                "runtime",
                "database",
                "verify",
                "api",
                "configure-bridge",
                "cancel",
                "clear-bridge",
                "stop-api",
                "stop-database",
                "release-lock"
            ]
        );
        assert!(!coordinator.executor().names().contains(&"worker"));
    }

    #[test]
    fn failures_map_to_existing_failure_states() {
        let mut coordinator = Coordinator::new(Fake {
            outcomes: VecDeque::from([Err("no lock")]),
            ..Default::default()
        });
        assert!(matches!(
            coordinator.start(),
            Err(CoordinatorError::Effect {
                failure: Failure::Lock,
                ..
            })
        ));
        assert_eq!(
            coordinator.lifecycle().phase(),
            &Phase::RecoverableFailure(Failure::Lock)
        );
        coordinator.stop().unwrap();
        assert_eq!(
            coordinator.lifecycle().phase(),
            &Phase::RecoverableFailure(Failure::Lock)
        );
    }

    #[test]
    fn cleanup_continues_after_an_error_and_keeps_the_first() {
        let fake = Fake {
            outcomes: VecDeque::from([
                Ok(EffectOutcome::Completed),
                Ok(EffectOutcome::Completed),
                Ok(EffectOutcome::Completed),
                Ok(EffectOutcome::DatabaseVerified {
                    needs_migration: false,
                }),
                Ok(EffectOutcome::Completed),
                Ok(EffectOutcome::Completed),
                Err("worker stop"),
                Err("api stop"),
                Ok(EffectOutcome::Completed),
                Ok(EffectOutcome::Completed),
            ]),
            ..Default::default()
        };
        let mut coordinator = Coordinator::new(fake);
        coordinator.start().unwrap();
        assert!(matches!(
            coordinator.stop(),
            Err(CoordinatorError::Cleanup {
                issue: CleanupIssue::Executor("worker stop")
            })
        ));
        assert_eq!(
            coordinator.executor().names(),
            [
                "lock",
                "runtime",
                "database",
                "verify",
                "api",
                "configure-bridge",
                "worker",
                "cancel",
                "stop-worker",
                "clear-bridge",
                "stop-api",
                "stop-database",
                "release-lock"
            ]
        );
        assert!(matches!(
            coordinator.lifecycle().phase(),
            Phase::CleaningUp(_)
        ));
        assert!(matches!(
            coordinator.start(),
            Err(CoordinatorError::Rejected(_))
        ));
        coordinator.retry().unwrap();
        assert_eq!(coordinator.lifecycle().phase(), &Phase::Idle);
    }

    #[test]
    fn cleanup_stops_api_even_when_clearing_the_bridge_fails() {
        let mut coordinator = Coordinator::new(Fake {
            clear_bridge_error: Some("bridge clear"),
            ..Default::default()
        });
        coordinator.start().unwrap();
        assert!(matches!(
            coordinator.stop(),
            Err(CoordinatorError::Cleanup {
                issue: CleanupIssue::Executor("bridge clear")
            })
        ));
        assert_eq!(
            coordinator.executor().names(),
            [
                "lock",
                "runtime",
                "database",
                "verify",
                "api",
                "configure-bridge",
                "worker",
                "cancel",
                "stop-worker",
                "clear-bridge",
                "stop-api",
                "stop-database",
                "release-lock"
            ]
        );
    }

    #[test]
    fn mismatched_executor_outcome_is_not_reported_as_success() {
        let mut coordinator = Coordinator::new(Fake {
            outcomes: VecDeque::from([Ok(EffectOutcome::DatabaseVerified {
                needs_migration: false,
            })]),
            ..Default::default()
        });
        assert!(matches!(
            coordinator.start(),
            Err(CoordinatorError::Unexpected)
        ));
        assert_eq!(
            coordinator.lifecycle().phase(),
            &Phase::RecoverableFailure(Failure::Unexpected)
        );
    }

    #[test]
    fn unexpected_failure_retains_a_cleanup_issue() {
        let mut coordinator = Coordinator::new(Fake {
            outcomes: VecDeque::from([
                Ok(EffectOutcome::DatabaseVerified {
                    needs_migration: false,
                }),
                Err("release failed"),
            ]),
            ..Default::default()
        });
        assert!(matches!(
            coordinator.start(),
            Err(CoordinatorError::UnexpectedAndCleanup {
                cleanup: CleanupIssue::Executor("release failed")
            })
        ));
        assert!(matches!(
            coordinator.lifecycle().phase(),
            Phase::CleaningUp(_)
        ));
    }

    struct GatedExecutor {
        entered: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
        calls: Arc<Mutex<Vec<&'static str>>>,
    }

    impl EffectExecutor for GatedExecutor {
        type Error = &'static str;

        fn execute(
            &mut self,
            effect: Effect,
            _: &Cancellation,
        ) -> Result<EffectOutcome, Self::Error> {
            let name = match effect {
                Effect::AcquireLock { .. } => "lock",
                Effect::ReleaseLock { .. } => "release-lock",
                _ => return Err("unexpected effect"),
            };
            self.calls.lock().unwrap().push(name);
            if name == "lock" {
                self.entered.send(()).unwrap();
                self.release.recv().unwrap();
            }
            Ok(EffectOutcome::Completed)
        }

        fn configure_bridge(&mut self, _: u64) -> Result<(), Self::Error> {
            Err("unexpected bridge configuration")
        }

        fn clear_bridge(&mut self, _: u64) -> Result<(), Self::Error> {
            Ok(())
        }

        fn cancel(&mut self, _: u64) {}
    }

    #[test]
    fn external_handle_cancels_a_generation_while_start_is_borrowed() {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let mut coordinator = Coordinator::new(GatedExecutor {
            entered: entered_tx,
            release: release_rx,
            calls: calls.clone(),
        });
        let handle = coordinator.cancellation_handle();
        assert!(!handle.cancel());

        thread::spawn(move || {
            let result = coordinator.start();
            done_tx
                .send((result, coordinator.lifecycle().phase().clone()))
                .unwrap();
        });
        entered_rx.recv().unwrap();
        assert!(handle.cancel());
        release_tx.send(()).unwrap();
        let (result, phase) = done_rx.recv().unwrap();
        assert!(result.is_ok());
        assert_eq!(phase, Phase::Idle);
        assert_eq!(*calls.lock().unwrap(), ["lock", "release-lock"]);
        assert!(!handle.cancel());
    }

    #[test]
    fn queued_before_start_cancellation_stops_before_the_first_startup_effect() {
        let mut coordinator = Coordinator::new(Fake {
            reject_cancelled_work: true,
            ..Default::default()
        });
        let handle = coordinator.cancellation_handle();
        handle.pre_arm();
        assert!(handle.cancel());
        coordinator.start().unwrap();
        assert_eq!(coordinator.lifecycle().phase(), &Phase::Idle);
        assert_eq!(coordinator.executor().names(), ["cancel", "release-lock"]);
        assert!(!handle.cancel());
    }

    struct ReadyGatedExecutor {
        entered: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
    }

    impl EffectExecutor for ReadyGatedExecutor {
        type Error = &'static str;

        fn execute(
            &mut self,
            effect: Effect,
            _: &Cancellation,
        ) -> Result<EffectOutcome, Self::Error> {
            match effect {
                Effect::VerifyDatabase { .. } => Ok(EffectOutcome::DatabaseVerified {
                    needs_migration: false,
                }),
                Effect::StartWorker { .. } => {
                    self.entered.send(()).unwrap();
                    self.release.recv().unwrap();
                    Ok(EffectOutcome::Completed)
                }
                _ => Ok(EffectOutcome::Completed),
            }
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
    fn cancellation_is_linearized_with_the_ready_handoff() {
        for _ in 0..32 {
            let (entered_tx, entered_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel();
            let (done_tx, done_rx) = mpsc::channel();
            let mut coordinator = Coordinator::new(ReadyGatedExecutor {
                entered: entered_tx,
                release: release_rx,
            });
            let handle = coordinator.cancellation_handle();
            thread::spawn(move || {
                let result = coordinator.start();
                done_tx
                    .send((result, coordinator.lifecycle().phase().clone()))
                    .unwrap();
            });
            entered_rx.recv().unwrap();

            let barrier = Arc::new(Barrier::new(2));
            let cancel_barrier = barrier.clone();
            let cancel_handle = handle.clone();
            let cancel = thread::spawn(move || {
                cancel_barrier.wait();
                cancel_handle.cancel()
            });
            barrier.wait();
            release_tx.send(()).unwrap();

            let cancelled = cancel.join().unwrap();
            let (result, phase) = done_rx.recv().unwrap();
            assert!(result.is_ok());
            if cancelled {
                assert_eq!(phase, Phase::Idle);
            } else {
                assert_eq!(phase, Phase::Ready);
            }
            assert!(!handle.cancel());
        }
    }

    #[test]
    fn invalid_api_outcomes_never_publish_the_bridge() {
        for api_outcome in [
            EffectOutcome::DatabaseVerified {
                needs_migration: false,
            },
            EffectOutcome::Incompatible(Incompatibility::DatabaseFormat),
        ] {
            let mut coordinator = Coordinator::new(Fake {
                outcomes: VecDeque::from([
                    Ok(EffectOutcome::Completed),
                    Ok(EffectOutcome::Completed),
                    Ok(EffectOutcome::Completed),
                    Ok(EffectOutcome::DatabaseVerified {
                        needs_migration: false,
                    }),
                ]),
                api_outcome: Some(api_outcome),
                ..Default::default()
            });
            let _ = coordinator.start();
            assert!(
                !coordinator.executor().names().contains(&"configure-bridge"),
                "{:?}",
                coordinator.executor().names()
            );
        }
    }

    #[test]
    fn incompatibility_outcomes_are_accepted_only_for_matching_effects() {
        let invalid = [
            (
                Effect::AcquireLock { generation: 1 },
                Incompatibility::DatabaseFormat,
            ),
            (
                Effect::StartApi { generation: 1 },
                Incompatibility::DatabaseFormat,
            ),
            (
                Effect::StartWorker { generation: 1 },
                Incompatibility::Migration,
            ),
            (
                Effect::MigrateDatabase { generation: 1 },
                Incompatibility::DatabaseFormat,
            ),
        ];
        for (effect, incompatibility) in invalid {
            assert!(matches!(
                completion_event(effect, EffectOutcome::Incompatible(incompatibility)),
                Err(CompletionError::Unexpected)
            ));
        }

        for (effect, incompatibility) in [
            (
                Effect::StartDatabase { generation: 1 },
                Incompatibility::DatabaseMajorVersion,
            ),
            (
                Effect::VerifyDatabase { generation: 1 },
                Incompatibility::DatabaseFormat,
            ),
            (
                Effect::VerifyDatabase { generation: 1 },
                Incompatibility::Migration,
            ),
            (
                Effect::MigrateDatabase { generation: 1 },
                Incompatibility::Migration,
            ),
        ] {
            assert!(matches!(
                completion_event(effect, EffectOutcome::Incompatible(incompatibility)),
                Err(CompletionError::Incompatible(_))
            ));
        }

        let mut coordinator = Coordinator::new(Fake {
            outcomes: VecDeque::from([Ok(EffectOutcome::Incompatible(
                Incompatibility::DatabaseFormat,
            ))]),
            ..Default::default()
        });
        assert!(matches!(
            coordinator.start(),
            Err(CoordinatorError::Unexpected)
        ));
        assert_eq!(
            coordinator.lifecycle().phase(),
            &Phase::RecoverableFailure(Failure::Unexpected)
        );
    }

    #[test]
    fn cancelled_executor_error_is_a_stop_not_a_component_failure() {
        let mut coordinator = Coordinator::new(Fake {
            outcomes: VecDeque::from([Err("cancelled lock")]),
            cancel_after: Some("lock"),
            ..Default::default()
        });
        coordinator.start().unwrap();
        assert_eq!(coordinator.lifecycle().phase(), &Phase::Idle);
        assert_eq!(
            coordinator.executor().names(),
            ["lock", "cancel", "release-lock"]
        );
    }

    #[test]
    fn cleanup_rejects_non_completed_outcomes() {
        let mut coordinator = Coordinator::new(Fake {
            outcomes: VecDeque::from([
                Ok(EffectOutcome::Completed),
                Ok(EffectOutcome::Completed),
                Ok(EffectOutcome::Completed),
                Ok(EffectOutcome::DatabaseVerified {
                    needs_migration: false,
                }),
                Ok(EffectOutcome::Completed),
                Ok(EffectOutcome::Completed),
                Ok(EffectOutcome::DatabaseVerified {
                    needs_migration: false,
                }),
            ]),
            ..Default::default()
        });
        coordinator.start().unwrap();
        assert!(matches!(
            coordinator.stop(),
            Err(CoordinatorError::Cleanup {
                issue: CleanupIssue::UnexpectedOutcome
            })
        ));
        assert!(matches!(
            coordinator.lifecycle().phase(),
            Phase::CleaningUp(_)
        ));
    }

    #[test]
    fn primary_failure_and_cleanup_failure_are_both_retained() {
        let mut coordinator = Coordinator::new(Fake {
            outcomes: VecDeque::from([
                Ok(EffectOutcome::Completed),
                Ok(EffectOutcome::Completed),
                Ok(EffectOutcome::Completed),
                Ok(EffectOutcome::DatabaseVerified {
                    needs_migration: false,
                }),
                Err("api primary"),
            ]),
            clear_bridge_error: Some("bridge cleanup"),
            ..Default::default()
        });
        assert!(matches!(
            coordinator.start(),
            Err(CoordinatorError::EffectAndCleanup {
                failure: Failure::Api,
                source: "api primary",
                cleanup: CleanupIssue::Executor("bridge cleanup"),
            })
        ));
        assert!(matches!(
            coordinator.lifecycle().phase(),
            Phase::CleaningUp(_)
        ));
    }

    #[test]
    fn incompatibility_is_terminal() {
        let fake = Fake {
            outcomes: VecDeque::from([
                Ok(EffectOutcome::Completed),
                Ok(EffectOutcome::Completed),
                Ok(EffectOutcome::Completed),
                Ok(EffectOutcome::Incompatible(Incompatibility::DatabaseFormat)),
            ]),
            ..Default::default()
        };
        let mut coordinator = Coordinator::new(fake);
        coordinator.start().unwrap();
        assert_eq!(
            coordinator.lifecycle().phase(),
            &Phase::IncompatibleData(Incompatibility::DatabaseFormat)
        );
        assert!(matches!(
            coordinator.retry(),
            Err(CoordinatorError::Rejected(_))
        ));
    }

    #[test]
    fn duplicate_stop_is_harmless_and_duplicate_retry_is_rejected() {
        let mut coordinator = Coordinator::new(Fake::default());
        coordinator.stop().unwrap();
        coordinator.stop().unwrap();
        assert!(matches!(
            coordinator.retry(),
            Err(CoordinatorError::Rejected(_))
        ));
    }

    #[test]
    fn bridge_is_cleared_before_api_stops() {
        let mut coordinator = Coordinator::new(Fake::default());
        coordinator.start().unwrap();
        coordinator.stop().unwrap();
        let calls = coordinator.executor().names();
        let clear = calls
            .iter()
            .position(|call| *call == "clear-bridge")
            .unwrap();
        let stop_api = calls.iter().position(|call| *call == "stop-api").unwrap();
        assert!(clear < stop_api);
    }
}
