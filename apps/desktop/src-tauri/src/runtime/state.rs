//! Pure lifecycle state machine for the self-contained desktop runtime.
//!
//! The supervisor owns process execution. This module only decides the next
//! state and the effects to run, which keeps startup, retry, and shutdown
//! behavior deterministic and independently testable.

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Lifecycle {
    generation: u64,
    phase: Phase,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Phase {
    Idle,
    AcquiringLock,
    ValidatingRuntime,
    StartingDatabase,
    VerifyingDatabase,
    BackingUpDatabase,
    MigratingDatabase,
    StartingApi,
    StartingWorker,
    Ready,
    CleaningUp(CleanupTarget),
    RecoverableFailure(Failure),
    IncompatibleData(Incompatibility),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CleanupTarget {
    Idle,
    RecoverableFailure(Failure),
    IncompatibleData(Incompatibility),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Failure {
    Lock,
    Runtime,
    Database,
    Backup,
    Migration,
    Api,
    Worker,
    Unexpected,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Incompatibility {
    DatabaseMajorVersion,
    DatabaseFormat,
    Migration,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Event {
    Start,
    Retry,
    StopRequested,
    LockAcquired {
        generation: u64,
    },
    RuntimeStaged {
        generation: u64,
    },
    DatabaseStarted {
        generation: u64,
    },
    DatabaseVerified {
        generation: u64,
        needs_migration: bool,
    },
    BackupCompleted {
        generation: u64,
    },
    MigrationCompleted {
        generation: u64,
    },
    ApiStarted {
        generation: u64,
    },
    WorkerStarted {
        generation: u64,
    },
    CleanupCompleted {
        generation: u64,
    },
    Failed {
        generation: u64,
        failure: Failure,
    },
    IncompatibleData {
        generation: u64,
        incompatibility: Incompatibility,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Effect {
    AcquireLock { generation: u64 },
    ValidateAndStageRuntime { generation: u64 },
    StartDatabase { generation: u64 },
    VerifyDatabase { generation: u64 },
    BackupDatabase { generation: u64 },
    MigrateDatabase { generation: u64 },
    StartApi { generation: u64 },
    StartWorker { generation: u64 },
    StopWorker { generation: u64 },
    StopApi { generation: u64 },
    StopDatabase { generation: u64 },
    ReleaseLock { generation: u64 },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Transition {
    pub lifecycle: Lifecycle,
    pub effects: Vec<Effect>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Rejection {
    StaleGeneration { expected: u64, received: u64 },
    EventNotAllowed { phase: Phase },
    GenerationExhausted,
}

impl Default for Lifecycle {
    fn default() -> Self {
        Self {
            generation: 0,
            phase: Phase::Idle,
        }
    }
}

impl Lifecycle {
    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn phase(&self) -> &Phase {
        &self.phase
    }

    pub fn transition(&self, event: Event) -> Result<Transition, Rejection> {
        match event {
            Event::Start if self.phase == Phase::Idle => self.begin(),
            Event::Retry
                if matches!(
                    self.phase,
                    Phase::RecoverableFailure(_)
                        | Phase::IncompatibleData(Incompatibility::Migration)
                ) =>
            {
                self.begin()
            }
            Event::StopRequested => self.stop(),
            Event::LockAcquired { generation } => self.advance(
                generation,
                Phase::AcquiringLock,
                Phase::ValidatingRuntime,
                Effect::ValidateAndStageRuntime { generation },
            ),
            Event::RuntimeStaged { generation } => self.advance(
                generation,
                Phase::ValidatingRuntime,
                Phase::StartingDatabase,
                Effect::StartDatabase { generation },
            ),
            Event::DatabaseStarted { generation } => self.advance(
                generation,
                Phase::StartingDatabase,
                Phase::VerifyingDatabase,
                Effect::VerifyDatabase { generation },
            ),
            Event::DatabaseVerified {
                generation,
                needs_migration,
            } => {
                self.ensure_generation(generation)?;
                if self.phase != Phase::VerifyingDatabase {
                    return Err(self.not_allowed());
                }
                let (phase, effect) = if needs_migration {
                    (
                        Phase::BackingUpDatabase,
                        Effect::BackupDatabase { generation },
                    )
                } else {
                    (Phase::StartingApi, Effect::StartApi { generation })
                };
                Ok(self.move_to(phase, vec![effect]))
            }
            Event::BackupCompleted { generation } => self.advance(
                generation,
                Phase::BackingUpDatabase,
                Phase::MigratingDatabase,
                Effect::MigrateDatabase { generation },
            ),
            Event::MigrationCompleted { generation } => self.advance(
                generation,
                Phase::MigratingDatabase,
                Phase::StartingApi,
                Effect::StartApi { generation },
            ),
            Event::ApiStarted { generation } => self.advance(
                generation,
                Phase::StartingApi,
                Phase::StartingWorker,
                Effect::StartWorker { generation },
            ),
            Event::WorkerStarted { generation } => {
                self.advance_without_effect(generation, Phase::StartingWorker, Phase::Ready)
            }
            Event::CleanupCompleted { generation } => {
                self.ensure_generation(generation)?;
                let Phase::CleaningUp(target) = &self.phase else {
                    return Err(self.not_allowed());
                };
                let phase = match target {
                    CleanupTarget::Idle => Phase::Idle,
                    CleanupTarget::RecoverableFailure(failure) => {
                        Phase::RecoverableFailure(failure.clone())
                    }
                    CleanupTarget::IncompatibleData(incompatibility) => {
                        Phase::IncompatibleData(incompatibility.clone())
                    }
                };
                Ok(self.move_to(phase, Vec::new()))
            }
            Event::Failed {
                generation,
                failure,
            } => self.fail(generation, CleanupTarget::RecoverableFailure(failure)),
            Event::IncompatibleData {
                generation,
                incompatibility,
            } => self.fail(generation, CleanupTarget::IncompatibleData(incompatibility)),
            _ => Err(self.not_allowed()),
        }
    }

    fn begin(&self) -> Result<Transition, Rejection> {
        let generation = self
            .generation
            .checked_add(1)
            .ok_or(Rejection::GenerationExhausted)?;
        Ok(Transition {
            lifecycle: Self {
                generation,
                phase: Phase::AcquiringLock,
            },
            effects: vec![Effect::AcquireLock { generation }],
        })
    }

    fn advance(
        &self,
        generation: u64,
        expected: Phase,
        next: Phase,
        effect: Effect,
    ) -> Result<Transition, Rejection> {
        self.ensure_generation(generation)?;
        if self.phase != expected {
            return Err(self.not_allowed());
        }
        Ok(self.move_to(next, vec![effect]))
    }

    fn advance_without_effect(
        &self,
        generation: u64,
        expected: Phase,
        next: Phase,
    ) -> Result<Transition, Rejection> {
        self.ensure_generation(generation)?;
        if self.phase != expected {
            return Err(self.not_allowed());
        }
        Ok(self.move_to(next, Vec::new()))
    }

    fn stop(&self) -> Result<Transition, Rejection> {
        if matches!(
            self.phase,
            Phase::Idle
                | Phase::CleaningUp(_)
                | Phase::RecoverableFailure(_)
                | Phase::IncompatibleData(_)
        ) {
            return Err(self.not_allowed());
        }
        Ok(self.move_to(
            Phase::CleaningUp(CleanupTarget::Idle),
            self.cleanup_effects(),
        ))
    }

    fn fail(&self, generation: u64, target: CleanupTarget) -> Result<Transition, Rejection> {
        self.ensure_generation(generation)?;
        if matches!(
            self.phase,
            Phase::Idle
                | Phase::CleaningUp(_)
                | Phase::RecoverableFailure(_)
                | Phase::IncompatibleData(_)
        ) {
            return Err(self.not_allowed());
        }
        Ok(self.move_to(Phase::CleaningUp(target), self.cleanup_effects()))
    }

    fn ensure_generation(&self, received: u64) -> Result<(), Rejection> {
        if self.generation == received {
            Ok(())
        } else {
            Err(Rejection::StaleGeneration {
                expected: self.generation,
                received,
            })
        }
    }

    fn not_allowed(&self) -> Rejection {
        Rejection::EventNotAllowed {
            phase: self.phase.clone(),
        }
    }

    fn move_to(&self, phase: Phase, effects: Vec<Effect>) -> Transition {
        Transition {
            lifecycle: Self {
                generation: self.generation,
                phase,
            },
            effects,
        }
    }

    fn cleanup_effects(&self) -> Vec<Effect> {
        let generation = self.generation;
        let mut effects = Vec::new();
        if matches!(self.phase, Phase::StartingWorker | Phase::Ready) {
            effects.push(Effect::StopWorker { generation });
        }
        if matches!(
            self.phase,
            Phase::StartingApi | Phase::StartingWorker | Phase::Ready
        ) {
            effects.push(Effect::StopApi { generation });
        }
        if matches!(
            self.phase,
            Phase::StartingDatabase
                | Phase::VerifyingDatabase
                | Phase::BackingUpDatabase
                | Phase::MigratingDatabase
                | Phase::StartingApi
                | Phase::StartingWorker
                | Phase::Ready
        ) {
            effects.push(Effect::StopDatabase { generation });
        }
        // Release is deliberately idempotent. A stop can race a successful
        // lock acquisition, so omitting it while AcquiringLock could orphan
        // the per-user runtime lock.
        effects.push(Effect::ReleaseLock { generation });
        effects
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn next(lifecycle: Lifecycle, event: Event) -> Lifecycle {
        lifecycle.transition(event).unwrap().lifecycle
    }

    fn started_then(events: &[Event]) -> Lifecycle {
        events
            .iter()
            .cloned()
            .fold(next(Lifecycle::default(), Event::Start), next)
    }

    #[test]
    fn starts_with_a_fresh_generation_and_lock_effect() {
        let transition = Lifecycle::default().transition(Event::Start).unwrap();
        assert_eq!(transition.lifecycle.generation(), 1);
        assert_eq!(transition.lifecycle.phase(), &Phase::AcquiringLock);
        assert_eq!(
            transition.effects,
            vec![Effect::AcquireLock { generation: 1 }]
        );
    }

    #[test]
    fn startup_without_migration_reaches_ready_in_order() {
        let mut lifecycle = Lifecycle::default();
        lifecycle = next(lifecycle, Event::Start);
        let generation = lifecycle.generation();
        let expected = [
            (Event::LockAcquired { generation }, Phase::ValidatingRuntime),
            (Event::RuntimeStaged { generation }, Phase::StartingDatabase),
            (
                Event::DatabaseStarted { generation },
                Phase::VerifyingDatabase,
            ),
            (
                Event::DatabaseVerified {
                    generation,
                    needs_migration: false,
                },
                Phase::StartingApi,
            ),
            (Event::ApiStarted { generation }, Phase::StartingWorker),
            (Event::WorkerStarted { generation }, Phase::Ready),
        ];

        for (event, phase) in expected {
            let transition = lifecycle.transition(event).unwrap();
            assert_eq!(transition.lifecycle.phase(), &phase);
            lifecycle = transition.lifecycle;
        }
    }

    #[test]
    fn startup_with_migration_backs_up_before_migrating() {
        let mut lifecycle = Lifecycle::default();
        for event in [
            Event::Start,
            Event::LockAcquired { generation: 1 },
            Event::RuntimeStaged { generation: 1 },
            Event::DatabaseStarted { generation: 1 },
        ] {
            lifecycle = next(lifecycle, event);
        }
        let backup = lifecycle
            .transition(Event::DatabaseVerified {
                generation: 1,
                needs_migration: true,
            })
            .unwrap();
        assert_eq!(backup.lifecycle.phase(), &Phase::BackingUpDatabase);
        assert_eq!(
            backup.effects,
            vec![Effect::BackupDatabase { generation: 1 }]
        );

        let migration = backup
            .lifecycle
            .transition(Event::BackupCompleted { generation: 1 })
            .unwrap();
        assert_eq!(migration.lifecycle.phase(), &Phase::MigratingDatabase);
        assert_eq!(
            migration.effects,
            vec![Effect::MigrateDatabase { generation: 1 }]
        );
    }

    #[test]
    fn stale_events_are_rejected_without_advancing() {
        let lifecycle = next(Lifecycle::default(), Event::Start);
        assert_eq!(
            lifecycle.transition(Event::LockAcquired { generation: 0 }),
            Err(Rejection::StaleGeneration {
                expected: 1,
                received: 0
            })
        );
        assert_eq!(lifecycle.phase(), &Phase::AcquiringLock);
    }

    #[test]
    fn out_of_order_events_are_rejected() {
        let lifecycle = next(Lifecycle::default(), Event::Start);
        assert_eq!(
            lifecycle.transition(Event::ApiStarted { generation: 1 }),
            Err(Rejection::EventNotAllowed {
                phase: Phase::AcquiringLock
            })
        );
    }

    #[test]
    fn stop_shuts_down_started_services_in_reverse_order() {
        let lifecycle = started_then(&[
            Event::LockAcquired { generation: 1 },
            Event::RuntimeStaged { generation: 1 },
            Event::DatabaseStarted { generation: 1 },
            Event::DatabaseVerified {
                generation: 1,
                needs_migration: false,
            },
            Event::ApiStarted { generation: 1 },
            Event::WorkerStarted { generation: 1 },
        ]);
        let transition = lifecycle.transition(Event::StopRequested).unwrap();
        assert_eq!(
            transition.lifecycle.phase(),
            &Phase::CleaningUp(CleanupTarget::Idle)
        );
        assert_eq!(
            transition.effects,
            vec![
                Effect::StopWorker { generation: 1 },
                Effect::StopApi { generation: 1 },
                Effect::StopDatabase { generation: 1 },
                Effect::ReleaseLock { generation: 1 },
            ]
        );
        assert_eq!(
            transition
                .lifecycle
                .transition(Event::CleanupCompleted { generation: 1 })
                .unwrap()
                .lifecycle
                .phase(),
            &Phase::Idle
        );
    }

    #[test]
    fn failures_cleanup_and_only_recoverable_ones_can_retry() {
        let lifecycle = next(
            next(Lifecycle::default(), Event::Start),
            Event::LockAcquired { generation: 1 },
        );
        let failure = lifecycle
            .transition(Event::Failed {
                generation: 1,
                failure: Failure::Runtime,
            })
            .unwrap();
        assert_eq!(
            failure.lifecycle.phase(),
            &Phase::CleaningUp(CleanupTarget::RecoverableFailure(Failure::Runtime))
        );
        assert_eq!(failure.effects, vec![Effect::ReleaseLock { generation: 1 }]);
        assert!(matches!(
            failure.lifecycle.transition(Event::Retry),
            Err(Rejection::EventNotAllowed { .. })
        ));

        let cleaned = failure
            .lifecycle
            .transition(Event::CleanupCompleted { generation: 1 })
            .unwrap();
        assert_eq!(
            cleaned.lifecycle.phase(),
            &Phase::RecoverableFailure(Failure::Runtime)
        );
        let retry = cleaned.lifecycle.transition(Event::Retry).unwrap();
        assert_eq!(retry.lifecycle.generation(), 2);
        assert_eq!(retry.effects, vec![Effect::AcquireLock { generation: 2 }]);
        assert!(matches!(
            Lifecycle::default().transition(Event::Retry),
            Err(Rejection::EventNotAllowed { .. })
        ));
    }

    #[test]
    fn incompatible_data_is_terminal_and_releases_started_database() {
        let mut lifecycle = Lifecycle::default();
        for event in [
            Event::Start,
            Event::LockAcquired { generation: 1 },
            Event::RuntimeStaged { generation: 1 },
            Event::DatabaseStarted { generation: 1 },
        ] {
            lifecycle = next(lifecycle, event);
        }
        let transition = lifecycle
            .transition(Event::IncompatibleData {
                generation: 1,
                incompatibility: Incompatibility::DatabaseMajorVersion,
            })
            .unwrap();
        assert_eq!(
            transition.lifecycle.phase(),
            &Phase::CleaningUp(CleanupTarget::IncompatibleData(
                Incompatibility::DatabaseMajorVersion
            ))
        );
        assert_eq!(
            transition.effects,
            vec![
                Effect::StopDatabase { generation: 1 },
                Effect::ReleaseLock { generation: 1 },
            ]
        );
        assert!(matches!(
            transition.lifecycle.transition(Event::Retry),
            Err(Rejection::EventNotAllowed { .. })
        ));
        let cleaned = transition
            .lifecycle
            .transition(Event::CleanupCompleted { generation: 1 })
            .unwrap();
        assert_eq!(
            cleaned.lifecycle.phase(),
            &Phase::IncompatibleData(Incompatibility::DatabaseMajorVersion)
        );
    }

    #[test]
    fn completion_events_after_stop_are_rejected() {
        let lifecycle = next(Lifecycle::default(), Event::Start);
        let stopping = lifecycle
            .transition(Event::StopRequested)
            .unwrap()
            .lifecycle;
        assert!(matches!(
            stopping.transition(Event::LockAcquired { generation: 1 }),
            Err(Rejection::EventNotAllowed { .. })
        ));
    }

    #[test]
    fn stop_cleans_up_every_in_progress_start_idempotently() {
        let release = vec![Effect::ReleaseLock { generation: 1 }];
        let stop_database = vec![
            Effect::StopDatabase { generation: 1 },
            Effect::ReleaseLock { generation: 1 },
        ];
        let stop_api = vec![
            Effect::StopApi { generation: 1 },
            Effect::StopDatabase { generation: 1 },
            Effect::ReleaseLock { generation: 1 },
        ];
        let stop_worker = vec![
            Effect::StopWorker { generation: 1 },
            Effect::StopApi { generation: 1 },
            Effect::StopDatabase { generation: 1 },
            Effect::ReleaseLock { generation: 1 },
        ];
        let scenarios = vec![
            (started_then(&[]), release.clone()),
            (
                started_then(&[Event::LockAcquired { generation: 1 }]),
                release,
            ),
            (
                started_then(&[
                    Event::LockAcquired { generation: 1 },
                    Event::RuntimeStaged { generation: 1 },
                ]),
                stop_database.clone(),
            ),
            (
                started_then(&[
                    Event::LockAcquired { generation: 1 },
                    Event::RuntimeStaged { generation: 1 },
                    Event::DatabaseStarted { generation: 1 },
                ]),
                stop_database.clone(),
            ),
            (
                started_then(&[
                    Event::LockAcquired { generation: 1 },
                    Event::RuntimeStaged { generation: 1 },
                    Event::DatabaseStarted { generation: 1 },
                    Event::DatabaseVerified {
                        generation: 1,
                        needs_migration: true,
                    },
                ]),
                stop_database.clone(),
            ),
            (
                started_then(&[
                    Event::LockAcquired { generation: 1 },
                    Event::RuntimeStaged { generation: 1 },
                    Event::DatabaseStarted { generation: 1 },
                    Event::DatabaseVerified {
                        generation: 1,
                        needs_migration: true,
                    },
                    Event::BackupCompleted { generation: 1 },
                ]),
                stop_database,
            ),
            (
                started_then(&[
                    Event::LockAcquired { generation: 1 },
                    Event::RuntimeStaged { generation: 1 },
                    Event::DatabaseStarted { generation: 1 },
                    Event::DatabaseVerified {
                        generation: 1,
                        needs_migration: false,
                    },
                ]),
                stop_api,
            ),
            (
                started_then(&[
                    Event::LockAcquired { generation: 1 },
                    Event::RuntimeStaged { generation: 1 },
                    Event::DatabaseStarted { generation: 1 },
                    Event::DatabaseVerified {
                        generation: 1,
                        needs_migration: false,
                    },
                    Event::ApiStarted { generation: 1 },
                ]),
                stop_worker,
            ),
        ];

        for (lifecycle, expected) in scenarios {
            assert_eq!(
                lifecycle.transition(Event::StopRequested).unwrap().effects,
                expected
            );
        }
    }

    #[test]
    fn failure_cleanup_uses_the_same_race_safe_effects() {
        let acquiring_lock = started_then(&[])
            .transition(Event::Failed {
                generation: 1,
                failure: Failure::Lock,
            })
            .unwrap();
        assert_eq!(
            acquiring_lock.effects,
            vec![Effect::ReleaseLock { generation: 1 }]
        );

        let starting_api = started_then(&[
            Event::LockAcquired { generation: 1 },
            Event::RuntimeStaged { generation: 1 },
            Event::DatabaseStarted { generation: 1 },
            Event::DatabaseVerified {
                generation: 1,
                needs_migration: false,
            },
        ])
        .transition(Event::Failed {
            generation: 1,
            failure: Failure::Api,
        })
        .unwrap();
        assert_eq!(
            starting_api.effects,
            vec![
                Effect::StopApi { generation: 1 },
                Effect::StopDatabase { generation: 1 },
                Effect::ReleaseLock { generation: 1 },
            ]
        );
    }
}
