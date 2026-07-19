use std::{
    collections::HashMap,
    io,
    mem::MaybeUninit,
    os::unix::process::CommandExt,
    process::{Child, Command},
    sync::{Condvar, Mutex},
};

use super::super::{ChildIdentity, ProcessError, ProcessGroupControl, ProcessRole};

#[derive(Default)]
pub(super) struct UnixProcessControl {
    ownership: Mutex<UnixOwnership>,
    spawn_finished: Condvar,
}

#[derive(Default)]
struct UnixOwnership {
    sealed: bool,
    pending_spawns: usize,
    groups: HashMap<u32, ProcessRole>,
}

impl ProcessGroupControl for UnixProcessControl {
    fn reserve_spawn(&self) -> Result<(), ProcessError> {
        let mut ownership = self
            .ownership
            .lock()
            .map_err(|_| ProcessError::new("desktop.process_group_failed"))?;
        if ownership.sealed {
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

    fn configure_command(
        &self,
        _role: ProcessRole,
        command: &mut Command,
    ) -> Result<(), ProcessError> {
        if self
            .ownership
            .lock()
            .map_err(|_| ProcessError::new("desktop.process_group_failed"))?
            .sealed
        {
            return Err(ProcessError::new("desktop.process_group_failed"));
        }
        #[cfg(any(target_os = "linux", target_os = "android"))]
        let expected_parent = unsafe { libc::getpid() };

        // SAFETY: only async-signal-safe libc operations run between fork and exec. `setsid`
        // creates an isolated process group; Linux/Android additionally ask the kernel to kill the
        // direct child if its parent disappears, then close the race around installing that rule.
        unsafe {
            command.pre_exec(move || {
                if libc::setsid() == -1 {
                    return Err(io::Error::last_os_error());
                }
                #[cfg(any(target_os = "linux", target_os = "android"))]
                {
                    if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) == -1 {
                        return Err(io::Error::last_os_error());
                    }
                    if libc::getppid() != expected_parent {
                        return Err(io::Error::from_raw_os_error(libc::ECHILD));
                    }
                }
                Ok(())
            });
        }
        Ok(())
    }

    fn attach(&self, identity: ChildIdentity, _child: &mut Child) -> Result<(), ProcessError> {
        let mut ownership = match self.ownership.lock() {
            Ok(ownership) => ownership,
            Err(_) => {
                let _ = signal_group(identity.pid, libc::SIGKILL);
                return Err(ProcessError::new("desktop.process_group_failed"));
            }
        };
        if ownership.sealed || ownership.groups.contains_key(&identity.pid) {
            let _ = signal_group(identity.pid, libc::SIGKILL);
            return Err(ProcessError::new("desktop.process_group_failed"));
        }
        ownership.groups.insert(identity.pid, identity.role);
        Ok(())
    }

    fn request_graceful_stop(
        &self,
        identity: ChildIdentity,
        _child: &mut std::process::Child,
    ) -> Result<(), ProcessError> {
        self.signal_owned(identity, libc::SIGTERM)
    }

    fn force_stop(
        &self,
        identity: ChildIdentity,
        _child: &mut std::process::Child,
    ) -> Result<(), ProcessError> {
        self.signal_owned(identity, libc::SIGKILL)
    }

    fn release(&self, identity: ChildIdentity) {
        if let Ok(mut ownership) = self.ownership.lock() {
            if ownership.groups.get(&identity.pid) == Some(&identity.role) {
                let _ = signal_group(identity.pid, libc::SIGKILL);
                ownership.groups.remove(&identity.pid);
            }
        }
    }

    fn has_exited(
        &self,
        identity: ChildIdentity,
        _child: &mut Child,
    ) -> Result<bool, ProcessError> {
        let ownership = self
            .ownership
            .lock()
            .map_err(|_| ProcessError::new("desktop.process_status_failed"))?;
        if ownership.groups.get(&identity.pid) != Some(&identity.role) {
            return Err(ProcessError::new("desktop.process_status_failed"));
        }
        exited_without_reaping(identity.pid)
    }

    fn seal_and_force_stop_all(
        &self,
        pending_spawn_wait: std::time::Duration,
    ) -> Result<(), ProcessError> {
        let mut ownership = self
            .ownership
            .lock()
            .map_err(|_| ProcessError::new("desktop.process_stop_failed"))?;
        ownership.sealed = true;
        if ownership.pending_spawns != 0 && !pending_spawn_wait.is_zero() {
            ownership = self
                .spawn_finished
                .wait_timeout_while(ownership, pending_spawn_wait, |ownership| {
                    ownership.pending_spawns != 0
                })
                .map_err(|_| ProcessError::new("desktop.process_stop_failed"))?
                .0;
        }
        let mut failed = false;
        for pid in ownership.groups.keys().copied() {
            failed |= signal_group(pid, libc::SIGKILL).is_err();
        }
        if failed {
            Err(ProcessError::new("desktop.process_stop_failed"))
        } else {
            Ok(())
        }
    }
}

impl UnixProcessControl {
    fn signal_owned(
        &self,
        identity: ChildIdentity,
        signal: libc::c_int,
    ) -> Result<(), ProcessError> {
        let ownership = self
            .ownership
            .lock()
            .map_err(|_| ProcessError::new("desktop.process_stop_failed"))?;
        if ownership.groups.get(&identity.pid) != Some(&identity.role) {
            return Err(ProcessError::new("desktop.process_stop_failed"));
        }
        signal_group(identity.pid, signal)
    }
}

fn exited_without_reaping(pid: u32) -> Result<bool, ProcessError> {
    let pid = libc::id_t::try_from(pid)
        .ok()
        .filter(|pid| *pid > 0)
        .ok_or_else(|| ProcessError::new("desktop.process_status_failed"))?;
    let mut info = MaybeUninit::<libc::siginfo_t>::zeroed();
    // SAFETY: `info` points to writable storage of the required type. `WNOWAIT` leaves an exited
    // leader waitable (and therefore its PID/PGID allocated) until ownership release has killed
    // every descendant. A zero si_pid means the child is still running under WNOHANG.
    let result = unsafe {
        libc::waitid(
            libc::P_PID,
            pid,
            info.as_mut_ptr(),
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    if result == -1 {
        return Err(ProcessError::new("desktop.process_status_failed"));
    }
    // SAFETY: successful waitid initializes the siginfo object, including the zero/no-event case.
    Ok(unsafe { info.assume_init().si_pid() } != 0)
}

fn signal_group(pid: u32, signal: libc::c_int) -> Result<(), ProcessError> {
    let pid = libc::pid_t::try_from(pid)
        .ok()
        .filter(|pid| *pid > 0)
        .ok_or_else(|| ProcessError::new("desktop.process_stop_failed"))?;
    // SAFETY: `configure_command` makes the child's process-group ID equal its PID. A negative PID
    // targets only that owned group; ESRCH means the whole group is already gone.
    let result = unsafe { libc::kill(-pid, signal) };
    if result == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(ProcessError::new("desktop.process_stop_failed"))
    }
}
