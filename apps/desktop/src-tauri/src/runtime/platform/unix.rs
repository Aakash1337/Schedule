use std::{io, os::unix::process::CommandExt, process::Command};

use super::super::{ChildIdentity, ProcessError, ProcessGroupControl, ProcessRole};

pub(super) struct UnixProcessControl;

impl ProcessGroupControl for UnixProcessControl {
    fn configure_command(
        &self,
        _role: ProcessRole,
        command: &mut Command,
    ) -> Result<(), ProcessError> {
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

    fn request_graceful_stop(
        &self,
        identity: ChildIdentity,
        _child: &mut std::process::Child,
    ) -> Result<(), ProcessError> {
        signal_group(identity.pid, libc::SIGTERM)
    }

    fn force_stop(
        &self,
        identity: ChildIdentity,
        _child: &mut std::process::Child,
    ) -> Result<(), ProcessError> {
        signal_group(identity.pid, libc::SIGKILL)
    }

    fn release(&self, identity: ChildIdentity) {
        let _ = signal_group(identity.pid, libc::SIGKILL);
    }
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
