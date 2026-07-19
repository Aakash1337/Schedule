use std::{
    collections::HashMap,
    ffi::c_void,
    mem::size_of,
    os::windows::{io::AsRawHandle, process::CommandExt},
    process::{Child, Command},
    ptr,
    sync::Mutex,
};

use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE},
    System::{
        Console::{CTRL_BREAK_EVENT, GenerateConsoleCtrlEvent},
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
        },
        JobObjects::{
            AssignProcessToJobObject, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject,
        },
        Threading::{
            CREATE_NEW_PROCESS_GROUP, CREATE_SUSPENDED, OpenThread, ResumeThread,
            THREAD_SUSPEND_RESUME,
        },
    },
};

use super::super::{ChildIdentity, ProcessError, ProcessGroupControl, ProcessRole};

#[derive(Default)]
pub(super) struct WindowsProcessControl {
    jobs: Mutex<HashMap<u32, OwnedHandle>>,
}

impl ProcessGroupControl for WindowsProcessControl {
    fn configure_command(
        &self,
        _role: ProcessRole,
        command: &mut Command,
    ) -> Result<(), ProcessError> {
        command.creation_flags(CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP);
        Ok(())
    }

    fn attach(&self, identity: ChildIdentity, child: &mut Child) -> Result<(), ProcessError> {
        let job = create_kill_on_close_job()?;
        let process = child.as_raw_handle() as HANDLE;
        // SAFETY: the owned Child keeps its process handle valid throughout this call.
        if unsafe { AssignProcessToJobObject(job.0, process) } == 0 {
            return Err(ProcessError::new("desktop.process_group_failed"));
        }

        let primary_thread = suspended_thread(identity.pid)?;
        {
            let mut jobs = self
                .jobs
                .lock()
                .map_err(|_| ProcessError::new("desktop.process_group_failed"))?;
            if jobs.contains_key(&identity.pid) {
                return Err(ProcessError::new("desktop.process_group_failed"));
            }
            jobs.insert(identity.pid, job);
        }

        // The child cannot execute or create descendants until after Job assignment and ownership
        // registration. Failure removes/closes its kill-on-close Job before returning an error.
        if unsafe { ResumeThread(primary_thread.0) } == u32::MAX {
            self.remove_job(identity.pid);
            return Err(ProcessError::new("desktop.process_group_failed"));
        }
        Ok(())
    }

    fn request_graceful_stop(
        &self,
        identity: ChildIdentity,
        _child: &mut Child,
    ) -> Result<(), ProcessError> {
        if !self.has_job(identity.pid)? {
            return Err(ProcessError::new("desktop.process_stop_failed"));
        }
        // Console-less children may reject this event. Treat delivery as best-effort so the
        // supervisor still provides its bounded graceful window before terminating the Job.
        let _ = unsafe { GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, identity.pid) };
        Ok(())
    }

    fn force_stop(&self, identity: ChildIdentity, child: &mut Child) -> Result<(), ProcessError> {
        let jobs = self
            .jobs
            .lock()
            .map_err(|_| ProcessError::new("desktop.process_stop_failed"))?;
        let Some(job) = jobs.get(&identity.pid) else {
            return child
                .kill()
                .map_err(|_| ProcessError::new("desktop.process_stop_failed"));
        };
        // SAFETY: the map owns this valid Job handle for the duration of the call.
        if unsafe { TerminateJobObject(job.0, 1) } == 0 {
            Err(ProcessError::new("desktop.process_stop_failed"))
        } else {
            Ok(())
        }
    }

    fn release(&self, identity: ChildIdentity) {
        self.remove_job(identity.pid);
    }
}

impl WindowsProcessControl {
    fn has_job(&self, pid: u32) -> Result<bool, ProcessError> {
        self.jobs
            .lock()
            .map(|jobs| jobs.contains_key(&pid))
            .map_err(|_| ProcessError::new("desktop.process_stop_failed"))
    }

    fn remove_job(&self, pid: u32) {
        if let Ok(mut jobs) = self.jobs.lock() {
            jobs.remove(&pid);
        }
    }
}

fn create_kill_on_close_job() -> Result<OwnedHandle, ProcessError> {
    // SAFETY: null security attributes and name request a private unnamed Job Object.
    let handle = unsafe {
        windows_sys::Win32::System::JobObjects::CreateJobObjectW(ptr::null(), ptr::null())
    };
    let job = OwnedHandle::new(handle)?;
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    // SAFETY: `limits` has the exact structure and size required by the selected info class.
    let configured = unsafe {
        SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast::<c_void>(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if configured == 0 {
        return Err(ProcessError::new("desktop.process_group_failed"));
    }
    Ok(job)
}

fn suspended_thread(pid: u32) -> Result<OwnedHandle, ProcessError> {
    // SAFETY: the snapshot owns a stable kernel enumeration handle until this function returns.
    let snapshot = OwnedHandle::new(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) })?;
    let mut entry = THREADENTRY32 {
        dwSize: size_of::<THREADENTRY32>() as u32,
        ..Default::default()
    };
    // SAFETY: `entry` is correctly sized and writable.
    if unsafe { Thread32First(snapshot.0, &mut entry) } == 0 {
        return Err(ProcessError::new("desktop.process_group_failed"));
    }
    loop {
        if entry.th32OwnerProcessID == pid {
            // SAFETY: the enumerated thread ID belongs to the suspended child. No inheritance is
            // requested, and only resume access is needed.
            return OwnedHandle::new(unsafe {
                OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID)
            });
        }
        // SAFETY: same initialized entry and live snapshot as above.
        if unsafe { Thread32Next(snapshot.0, &mut entry) } == 0 {
            return Err(ProcessError::new("desktop.process_group_failed"));
        }
    }
}

struct OwnedHandle(HANDLE);

impl OwnedHandle {
    fn new(handle: HANDLE) -> Result<Self, ProcessError> {
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            Err(ProcessError::new("desktop.process_group_failed"))
        } else {
            Ok(Self(handle))
        }
    }
}

// Windows kernel handles may be transferred between threads; access remains synchronized by the
// controller's mutex and CloseHandle is called exactly once by this owner.
unsafe impl Send for OwnedHandle {}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY: `OwnedHandle::new` accepts only valid handles and this owner closes exactly once.
        let _ = unsafe { CloseHandle(self.0) };
    }
}
