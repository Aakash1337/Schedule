use std::{
    collections::HashMap,
    process::Child,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use super::{
    ChildIdentity, ProcessError, ProcessGroupControl, ProcessRole,
    guardian::{FORCE, GRACEFUL, GuardianChannel},
};

pub(super) fn new_control() -> Arc<dyn ProcessGroupControl> {
    Arc::new(GuardianProcessControl::default())
}

#[derive(Default)]
struct GuardianProcessControl {
    sealed: AtomicBool,
    ownership: Mutex<Ownership>,
    spawn_finished: Condvar,
}

#[derive(Default)]
struct Ownership {
    pending_spawns: usize,
    guardians: HashMap<u32, (ProcessRole, Arc<GuardianChannel>)>,
}

impl ProcessGroupControl for GuardianProcessControl {
    fn reserve_spawn(&self) -> Result<(), ProcessError> {
        if self.sealed.load(Ordering::Acquire) {
            return Err(ProcessError::new("desktop.process_group_failed"));
        }
        let mut ownership = self
            .ownership
            .lock()
            .map_err(|_| ProcessError::new("desktop.process_group_failed"))?;
        if self.sealed.load(Ordering::Acquire) {
            return Err(ProcessError::new("desktop.process_group_failed"));
        }
        ownership.pending_spawns += 1;
        Ok(())
    }

    fn finish_spawn(&self) {
        if let Ok(mut ownership) = self.ownership.lock() {
            ownership.pending_spawns = ownership.pending_spawns.saturating_sub(1);
            self.spawn_finished.notify_all();
        }
    }

    fn attach(
        &self,
        identity: ChildIdentity,
        _child: &mut Child,
        channel: Arc<GuardianChannel>,
    ) -> Result<(), ProcessError> {
        if self.sealed.load(Ordering::Acquire) {
            channel.abort_and_try_force();
            return Err(ProcessError::new("desktop.process_group_failed"));
        }
        let mut ownership = self
            .ownership
            .lock()
            .map_err(|_| ProcessError::new("desktop.process_group_failed"))?;
        if self.sealed.load(Ordering::Acquire) || ownership.guardians.contains_key(&identity.pid) {
            channel.abort_and_try_force();
            return Err(ProcessError::new("desktop.process_group_failed"));
        }
        ownership
            .guardians
            .insert(identity.pid, (identity.role, channel));
        Ok(())
    }

    fn request_graceful_stop(
        &self,
        identity: ChildIdentity,
        _child: &mut Child,
    ) -> Result<(), ProcessError> {
        self.channel(identity)?.send(GRACEFUL)
    }

    fn force_stop(&self, identity: ChildIdentity, child: &mut Child) -> Result<(), ProcessError> {
        match self.channel(identity)?.send(FORCE) {
            Ok(()) => Ok(()),
            Err(_) if matches!(child.try_wait(), Ok(Some(_))) => Ok(()),
            Err(error) => Err(error),
        }
    }

    fn release(&self, identity: ChildIdentity) {
        if let Ok(mut ownership) = self.ownership.lock()
            && ownership.guardians.get(&identity.pid).map(|entry| entry.0) == Some(identity.role)
        {
            ownership.guardians.remove(&identity.pid);
        }
    }

    fn seal_and_force_stop_all(&self, pending_spawn_wait: Duration) -> Result<(), ProcessError> {
        self.sealed.store(true, Ordering::Release);
        // A thread suspended while holding the registry mutex cannot extend final exit. Closing
        // process handles on actual desktop exit remains the independent guardian liveness signal.
        let Ok(mut ownership) = self.ownership.try_lock() else {
            return Ok(());
        };
        // Abort admission before any bounded wait. Even a stalled packet writer can no longer
        // send COMMIT after the barrier returns.
        for (_, channel) in ownership.guardians.values() {
            channel.abort_and_try_force();
        }
        if ownership.pending_spawns != 0 && !pending_spawn_wait.is_zero() {
            ownership = self
                .spawn_finished
                .wait_timeout_while(ownership, pending_spawn_wait, |ownership| {
                    ownership.pending_spawns != 0
                })
                .map_err(|_| ProcessError::new("desktop.process_stop_failed"))?
                .0;
        }
        // Catch guardians registered during the wait. `attach` rejects once sealed, but this is
        // intentionally idempotent and keeps the final operation fail-safe.
        for (_, channel) in ownership.guardians.values() {
            channel.abort_and_try_force();
        }
        Ok(())
    }
}

impl GuardianProcessControl {
    fn channel(&self, identity: ChildIdentity) -> Result<Arc<GuardianChannel>, ProcessError> {
        let ownership = self
            .ownership
            .lock()
            .map_err(|_| ProcessError::new("desktop.process_stop_failed"))?;
        ownership
            .guardians
            .get(&identity.pid)
            .filter(|entry| entry.0 == identity.role)
            .map(|entry| Arc::clone(&entry.1))
            .ok_or_else(|| ProcessError::new("desktop.process_stop_failed"))
    }
}

#[cfg(test)]
mod tests {
    use std::{thread, time::Instant};

    use super::*;

    #[test]
    fn final_seal_never_waits_for_a_stalled_registry_owner() {
        let control = Arc::new(GuardianProcessControl::default());
        let ownership = control.ownership.lock().unwrap();
        let barrier = {
            let control = Arc::clone(&control);
            thread::spawn(move || {
                let started = Instant::now();
                control
                    .seal_and_force_stop_all(Duration::from_secs(1))
                    .unwrap();
                started.elapsed()
            })
        };
        assert!(barrier.join().unwrap() < Duration::from_secs(1));
        drop(ownership);
        assert!(control.reserve_spawn().is_err());
    }
}
