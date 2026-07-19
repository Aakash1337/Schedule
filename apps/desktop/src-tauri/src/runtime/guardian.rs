//! Same-binary guardian used as the only pre-admission child of the desktop process.
//!
//! Launch details travel over the guardian's inherited standard input, never its command line,
//! environment, filesystem, or diagnostics. The one-byte COMMIT is accepted only after the
//! guardian has established the platform containment boundary.

use std::{
    ffi::{OsStr, OsString},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, ExitStatus, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU8, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

use zeroize::Zeroize;

use super::process::ProcessError;

const MODE: &str = "--schedule-runtime-guardian";
const MAGIC: &[u8; 8] = b"SCHGRD01";
const MAX_PACKET_BYTES: usize = 4 * 1024 * 1024;
const MAX_FIELD_BYTES: usize = 1024 * 1024;
const MAX_ARGUMENTS: usize = 256;
const MAX_ENVIRONMENT: usize = 256;
const COMMIT: u8 = b'C';
const ACK: &[u8; 8] = b"SCHACK01";
pub(super) const GRACEFUL: u8 = b'S';
pub(super) const FORCE: u8 = b'F';
const OPEN: u8 = 0;
const COMMITTING: u8 = 1;
const COMMITTED: u8 = 2;
const ABORTED: u8 = 3;
#[cfg(all(test, windows))]
const TEST_PRE_ACK_STALL: &str = "SCHEDULE_GUARDIAN_TEST_PRE_ACK_STALL";
#[cfg(test)]
const TEST_ACK_DELAY_MS: &str = "SCHEDULE_GUARDIAN_TEST_ACK_DELAY_MS";

/// Launch data deliberately has no `Debug`; fields can contain credentials.
pub(super) struct LaunchSpec {
    program: PathBuf,
    working_directory: PathBuf,
    arguments: Vec<OsString>,
    environment: Vec<(OsString, OsString)>,
    payload_stdin: bool,
}

impl LaunchSpec {
    pub(super) fn new(
        program: PathBuf,
        working_directory: PathBuf,
        arguments: Vec<OsString>,
        environment: Vec<(OsString, OsString)>,
        payload_stdin: bool,
    ) -> Self {
        Self {
            program,
            working_directory,
            arguments,
            environment,
            payload_stdin,
        }
    }
}

/// The parent keeps this endpoint for liveness. Admission and abort are atomic even if another
/// thread is stalled while writing the bounded configuration packet.
pub(super) struct GuardianChannel {
    writer: Mutex<ChildStdin>,
    admission: AtomicU8,
}

impl GuardianChannel {
    fn new(writer: ChildStdin) -> Self {
        Self {
            writer: Mutex::new(writer),
            admission: AtomicU8::new(OPEN),
        }
    }

    fn prepare(&self, mut packet: Vec<u8>) -> Result<(), ProcessError> {
        let result = (|| {
            let mut writer = self
                .writer
                .lock()
                .map_err(|_| ProcessError::new("desktop.process_control_failed"))?;
            writer
                .write_all(&packet)
                .and_then(|()| writer.flush())
                .map_err(|_| ProcessError::new("desktop.process_control_failed"))
        })();
        packet.zeroize();
        result
    }

    fn commit(&self) -> Result<(), ProcessError> {
        self.commit_with_post_admission(|| {})
    }

    fn commit_with_post_admission(
        &self,
        after_admission: impl FnOnce(),
    ) -> Result<(), ProcessError> {
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| ProcessError::new("desktop.process_control_failed"))?;
        if self
            .admission
            .compare_exchange(OPEN, COMMITTING, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            let _ = writer.write_all(&[FORCE]);
            let _ = writer.flush();
            return Err(ProcessError::new("desktop.process_group_failed"));
        }
        if writer
            .write_all(&[COMMIT])
            .and_then(|()| writer.flush())
            .is_err()
        {
            self.admission.store(ABORTED, Ordering::Release);
            return Err(ProcessError::new("desktop.process_control_failed"));
        }
        // Release the writer before publishing COMMITTED. A concurrent final seal can now always
        // acquire the pipe and send FORCE after it stores ABORTED. If it won just before this CAS,
        // the failed CAS path reacquires the writer and sends FORCE itself.
        drop(writer);
        if self
            .admission
            .compare_exchange(COMMITTING, COMMITTED, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            let _ = self.send(FORCE);
            return Err(ProcessError::new("desktop.process_group_failed"));
        }
        after_admission();
        Ok(())
    }

    pub(super) fn send(&self, command: u8) -> Result<(), ProcessError> {
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| ProcessError::new("desktop.process_control_failed"))?;
        writer
            .write_all(&[command])
            .and_then(|()| writer.flush())
            .map_err(|_| ProcessError::new("desktop.process_control_failed"))
    }

    /// Used by the final barrier: atomically prevents a not-yet-committed launch, then makes one
    /// non-blocking best-effort FORCE write. Process exit closing the pipe is the fail-safe.
    pub(super) fn abort_and_try_force(&self) {
        self.admission.store(ABORTED, Ordering::Release);
        if let Ok(mut writer) = self.writer.try_lock() {
            let _ = writer.write_all(&[FORCE]);
            let _ = writer.flush();
        }
    }
}

pub(super) struct SpawnedGuardian {
    pub(super) child: Child,
    pub(super) channel: Arc<GuardianChannel>,
    packet: Vec<u8>,
}

impl SpawnedGuardian {
    pub(super) fn prepare(&mut self) -> Result<(), ProcessError> {
        self.channel.prepare(std::mem::take(&mut self.packet))
    }

    pub(super) fn commit(&self) -> Result<(), ProcessError> {
        self.channel.commit()
    }

    pub(super) fn into_parts(self) -> (Child, Arc<GuardianChannel>) {
        (self.child, self.channel)
    }
}

pub(super) fn await_ack<R: Read + Send + 'static>(
    mut reader: R,
    deadline: Instant,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<R, ProcessError> {
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut ack = [0_u8; ACK.len()];
        let valid = reader.read_exact(&mut ack).is_ok() && &ack == ACK;
        let _ = sender.send((valid, reader));
    });
    loop {
        if is_cancelled() {
            return Err(ProcessError::new("desktop.process_cancelled"));
        }
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            return Err(ProcessError::new("desktop.process_start_timeout"));
        };
        match receiver.recv_timeout(remaining.min(Duration::from_millis(20))) {
            Ok((true, reader)) => return Ok(reader),
            Ok((false, _)) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(ProcessError::new("desktop.process_group_failed"));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
}

pub(super) fn spawn(spec: LaunchSpec) -> Result<SpawnedGuardian, ProcessError> {
    let packet = encode(&spec)?;
    let mut command = guardian_command()?;
    let mut child = command
        .spawn()
        .map_err(|_| ProcessError::new("desktop.process_spawn_failed"))?;
    let Some(stdin) = child.stdin.take() else {
        let _ = child.kill();
        return Err(ProcessError::new("desktop.process_control_failed"));
    };
    Ok(SpawnedGuardian {
        child,
        channel: Arc::new(GuardianChannel::new(stdin)),
        packet,
    })
}

fn guardian_command() -> Result<Command, ProcessError> {
    let executable =
        std::env::current_exe().map_err(|_| ProcessError::new("desktop.process_spawn_failed"))?;
    let mut command = Command::new(executable);
    command
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(not(test))]
    command.arg(MODE);
    #[cfg(test)]
    command
        .arg("runtime::guardian::tests::guardian_subprocess_helper")
        .arg("--exact")
        .arg("--nocapture")
        .env("SCHEDULE_GUARDIAN_TEST", "1");
    Ok(command)
}

/// Must run before Tauri, GTK, or any other runtime thread is initialized.
pub(crate) fn run_if_requested() -> bool {
    let mut arguments = std::env::args_os();
    let requested = arguments.next().is_some()
        && arguments.next().as_deref() == Some(OsStr::new(MODE))
        && arguments.next().is_none();
    if requested {
        guardian_main();
    }
    requested
}

fn guardian_main() -> ! {
    let code = run_guardian().unwrap_or(1);
    std::process::exit(code)
}

fn run_guardian() -> Result<i32, ()> {
    platform::prepare_guardian()?;
    let mut input = io::stdin();
    platform::control_cloexec()?;
    let mut packet = read_packet(&mut input)?;
    let decoded = decode(&packet);
    packet.zeroize();
    platform::run_payload(decoded?, input)
}

struct DecodedSpec {
    program: OsString,
    working_directory: OsString,
    arguments: Vec<OsString>,
    environment: Vec<(OsString, OsString)>,
    payload_stdin: bool,
}

impl DecodedSpec {
    fn command(&self) -> Command {
        let mut command = Command::new(&self.program);
        command
            .args(&self.arguments)
            .current_dir(Path::new(&self.working_directory))
            .env_clear()
            .envs(self.environment.iter().map(|(key, value)| (key, value)))
            .stdin(if self.payload_stdin {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        command
    }
}

fn encode(spec: &LaunchSpec) -> Result<Vec<u8>, ProcessError> {
    if spec.arguments.len() > MAX_ARGUMENTS || spec.environment.len() > MAX_ENVIRONMENT {
        return Err(ProcessError::new("desktop.process_spec_invalid"));
    }
    let mut body = Vec::new();
    let encoded = (|| {
        body.push(u8::from(spec.payload_stdin));
        push_u32(&mut body, spec.arguments.len())?;
        push_u32(&mut body, spec.environment.len())?;
        push_os(&mut body, spec.program.as_os_str())?;
        push_os(&mut body, spec.working_directory.as_os_str())?;
        for argument in &spec.arguments {
            push_os(&mut body, argument)?;
        }
        for (key, value) in &spec.environment {
            push_os(&mut body, key)?;
            push_os(&mut body, value)?;
        }
        Ok(())
    })();
    if let Err(error) = encoded {
        body.zeroize();
        return Err(error);
    }
    if body.len() > MAX_PACKET_BYTES {
        body.zeroize();
        return Err(ProcessError::new("desktop.process_spec_invalid"));
    }
    let mut packet = Vec::with_capacity(MAGIC.len() + 4 + body.len());
    packet.extend_from_slice(MAGIC);
    packet.extend_from_slice(&(body.len() as u32).to_le_bytes());
    packet.extend_from_slice(&body);
    body.zeroize();
    Ok(packet)
}

fn read_packet(reader: &mut impl Read) -> Result<Vec<u8>, ()> {
    let mut header = [0_u8; 12];
    reader.read_exact(&mut header).map_err(|_| ())?;
    if &header[..8] != MAGIC {
        header.zeroize();
        return Err(());
    }
    let length = u32::from_le_bytes(header[8..12].try_into().map_err(|_| ())?) as usize;
    header.zeroize();
    if length == 0 || length > MAX_PACKET_BYTES {
        return Err(());
    }
    let mut packet = vec![0_u8; length];
    if reader.read_exact(&mut packet).is_err() {
        packet.zeroize();
        return Err(());
    }
    Ok(packet)
}

fn decode(packet: &[u8]) -> Result<DecodedSpec, ()> {
    let mut cursor = Cursor::new(packet);
    let payload_stdin = match cursor.byte()? {
        0 => false,
        1 => true,
        _ => return Err(()),
    };
    let argument_count = cursor.u32()? as usize;
    let environment_count = cursor.u32()? as usize;
    if argument_count > MAX_ARGUMENTS || environment_count > MAX_ENVIRONMENT {
        return Err(());
    }
    let program = cursor.os()?;
    let working_directory = cursor.os()?;
    if !Path::new(&program).is_absolute() || !Path::new(&working_directory).is_absolute() {
        return Err(());
    }
    let arguments = (0..argument_count)
        .map(|_| cursor.os())
        .collect::<Result<Vec<_>, _>>()?;
    let environment = (0..environment_count)
        .map(|_| Ok((cursor.os()?, cursor.os()?)))
        .collect::<Result<Vec<_>, ()>>()?;
    if !cursor.done() {
        return Err(());
    }
    let mut keys = Vec::with_capacity(environment.len());
    for (key, _) in &environment {
        let key = key
            .to_str()
            .filter(|key| {
                !key.is_empty()
                    && key.as_bytes()[0].is_ascii_uppercase()
                    && key.bytes().all(|byte| {
                        byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'
                    })
            })
            .ok_or(())?;
        let normalized = key.to_ascii_uppercase();
        if keys.contains(&normalized) {
            return Err(());
        }
        keys.push(normalized);
    }
    Ok(DecodedSpec {
        program,
        working_directory,
        arguments,
        environment,
        payload_stdin,
    })
}

struct Cursor<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Cursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn byte(&mut self) -> Result<u8, ()> {
        let byte = *self.bytes.get(self.offset).ok_or(())?;
        self.offset += 1;
        Ok(byte)
    }

    fn u32(&mut self) -> Result<u32, ()> {
        let end = self.offset.checked_add(4).ok_or(())?;
        let value = u32::from_le_bytes(
            self.bytes
                .get(self.offset..end)
                .ok_or(())?
                .try_into()
                .map_err(|_| ())?,
        );
        self.offset = end;
        Ok(value)
    }

    fn os(&mut self) -> Result<OsString, ()> {
        let length = self.u32()? as usize;
        if length > MAX_FIELD_BYTES {
            return Err(());
        }
        let end = self.offset.checked_add(length).ok_or(())?;
        let value = decode_os(self.bytes.get(self.offset..end).ok_or(())?)?;
        self.offset = end;
        Ok(value)
    }

    fn done(&self) -> bool {
        self.offset == self.bytes.len()
    }
}

fn push_u32(target: &mut Vec<u8>, value: usize) -> Result<(), ProcessError> {
    let value =
        u32::try_from(value).map_err(|_| ProcessError::new("desktop.process_spec_invalid"))?;
    target.extend_from_slice(&value.to_le_bytes());
    Ok(())
}

fn push_os(target: &mut Vec<u8>, value: &OsStr) -> Result<(), ProcessError> {
    let mut bytes = encode_os(value)?;
    if target.len().saturating_add(4).saturating_add(bytes.len()) > MAX_PACKET_BYTES {
        bytes.zeroize();
        return Err(ProcessError::new("desktop.process_spec_invalid"));
    }
    push_u32(target, bytes.len())?;
    target.extend_from_slice(&bytes);
    bytes.zeroize();
    Ok(())
}

#[cfg(unix)]
fn encode_os(value: &OsStr) -> Result<Vec<u8>, ProcessError> {
    use std::os::unix::ffi::OsStrExt;
    if value.as_bytes().len() > MAX_FIELD_BYTES {
        Err(ProcessError::new("desktop.process_spec_invalid"))
    } else {
        Ok(value.as_bytes().to_vec())
    }
}

#[cfg(unix)]
fn decode_os(value: &[u8]) -> Result<OsString, ()> {
    use std::os::unix::ffi::OsStringExt;
    Ok(OsString::from_vec(value.to_vec()))
}

#[cfg(windows)]
fn encode_os(value: &OsStr) -> Result<Vec<u8>, ProcessError> {
    use std::os::windows::ffi::OsStrExt;
    let mut bytes = Vec::new();
    for unit in value.encode_wide() {
        if bytes.len() > MAX_FIELD_BYTES - 2 {
            bytes.zeroize();
            return Err(ProcessError::new("desktop.process_spec_invalid"));
        }
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    Ok(bytes)
}

#[cfg(windows)]
fn decode_os(value: &[u8]) -> Result<OsString, ()> {
    use std::os::windows::ffi::OsStringExt;
    if value.len() % 2 != 0 {
        return Err(());
    }
    let mut wide = value
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect::<Vec<_>>();
    let decoded = OsString::from_wide(&wide);
    wide.zeroize();
    Ok(decoded)
}

fn status_code(status: ExitStatus) -> i32 {
    status.code().unwrap_or(1)
}

enum ControlEvent {
    Graceful,
    Force,
}

fn control_reader(mut input: impl Read + Send + 'static) -> mpsc::Receiver<ControlEvent> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        loop {
            let mut command = [0_u8; 1];
            match input.read_exact(&mut command) {
                Ok(()) if command[0] == GRACEFUL => {
                    if sender.send(ControlEvent::Graceful).is_err() {
                        return;
                    }
                }
                Ok(()) if command[0] == FORCE => {
                    let _ = sender.send(ControlEvent::Force);
                    return;
                }
                Ok(()) | Err(_) => {
                    let _ = sender.send(ControlEvent::Force);
                    return;
                }
            }
        }
    });
    receiver
}

fn await_commit(input: &mut impl Read) -> Result<(), ()> {
    let mut command = [0_u8; 1];
    input.read_exact(&mut command).map_err(|_| ())?;
    (command[0] == COMMIT).then_some(()).ok_or(())
}

fn acknowledge_ready() -> Result<(), ()> {
    let mut output = io::stderr().lock();
    output
        .write_all(ACK)
        .and_then(|()| output.flush())
        .map_err(|_| ())
}

#[cfg(test)]
fn delay_test_ack(spec: &DecodedSpec) {
    let delay = spec.environment.iter().find_map(|(key, value)| {
        (key == TEST_ACK_DELAY_MS)
            .then(|| value.to_str()?.parse::<u64>().ok())
            .flatten()
    });
    if let Some(delay) = delay {
        thread::sleep(Duration::from_millis(delay));
    }
}

#[cfg(unix)]
mod platform {
    use std::{fs, mem::MaybeUninit, os::unix::process::CommandExt};

    use super::*;

    pub(super) fn prepare_guardian() -> Result<(), ()> {
        // SAFETY: called in the fresh, single-threaded guardian before any payload exists.
        if unsafe { libc::setsid() } == -1 {
            return Err(());
        }
        #[cfg(target_os = "linux")]
        if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1) } == -1 {
            return Err(());
        }
        Ok(())
    }

    pub(super) fn control_cloexec() -> Result<(), ()> {
        // SAFETY: fd 0 is the inherited guardian control pipe. The guardian continues to use it,
        // while FD_CLOEXEC guarantees the payload cannot keep its liveness endpoint open.
        let flags = unsafe { libc::fcntl(0, libc::F_GETFD) };
        if flags == -1 || unsafe { libc::fcntl(0, libc::F_SETFD, flags | libc::FD_CLOEXEC) } == -1 {
            Err(())
        } else {
            Ok(())
        }
    }

    pub(super) fn run_payload(
        mut spec: DecodedSpec,
        mut input: impl Read + Send + 'static,
    ) -> Result<i32, ()> {
        #[cfg(test)]
        delay_test_ack(&spec);
        acknowledge_ready()?;
        await_commit(&mut input)?;
        let mut command = spec.command();
        let guardian_pid = unsafe { libc::getpid() };
        // Keep the payload in a distinct group inside the guardian's isolated session. This makes
        // graceful service termination precise; FORCE also walks adopted descendants on Linux.
        unsafe {
            command.pre_exec(move || {
                if libc::setpgid(0, 0) == -1 {
                    return Err(io::Error::last_os_error());
                }
                #[cfg(target_os = "linux")]
                {
                    if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) == -1 {
                        return Err(io::Error::last_os_error());
                    }
                    if libc::getppid() != guardian_pid {
                        return Err(io::Error::from_raw_os_error(libc::ECHILD));
                    }
                }
                Ok(())
            });
        }
        let mut child = command.spawn().map_err(|_| ())?;
        drop(command);
        let payload_pid = child.id();
        let mut payload_stdin = child.stdin.take();
        // Drop sensitive decoded launch values as soon as Command has copied them.
        spec.arguments.clear();
        spec.environment.clear();
        let receiver = control_reader(input);
        loop {
            if exited_without_reaping(payload_pid)? {
                force_descendants(payload_pid);
                let status = child.wait().map_err(|_| ())?;
                reap_all();
                return Ok(status_code(status));
            }
            match receiver.recv_timeout(Duration::from_millis(20)) {
                Ok(ControlEvent::Graceful) => {
                    if let Some(mut stdin) = payload_stdin.take() {
                        let _ = stdin.write_all(b"shutdown\n");
                        let _ = stdin.flush();
                    } else {
                        signal_group(payload_pid, libc::SIGTERM);
                    }
                }
                Ok(ControlEvent::Force) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                    force_descendants(payload_pid);
                    let _ = child.wait();
                    reap_all();
                    return Err(());
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
    }

    fn signal_group(pid: u32, signal: libc::c_int) {
        if let Ok(pid) = libc::pid_t::try_from(pid) {
            // SAFETY: payload created its own process group in this guardian's private session.
            let _ = unsafe { libc::kill(-pid, signal) };
        }
    }

    fn exited_without_reaping(pid: u32) -> Result<bool, ()> {
        let pid = libc::id_t::try_from(pid)
            .ok()
            .filter(|pid| *pid > 0)
            .ok_or(())?;
        let mut info = MaybeUninit::<libc::siginfo_t>::zeroed();
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                pid,
                info.as_mut_ptr(),
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if result == -1 {
            return Err(());
        }
        Ok(unsafe { info.assume_init().si_pid() } != 0)
    }

    fn force_descendants(payload_pid: u32) {
        signal_group(payload_pid, libc::SIGKILL);
        #[cfg(target_os = "linux")]
        {
            // A descendant can create another group/session. As a subreaper, the guardian owns
            // orphaned descendants; repeatedly walking /proc closes the fork/reparenting race.
            for _ in 0..8 {
                let descendants = descendant_pids(std::process::id());
                if descendants.is_empty() {
                    break;
                }
                for pid in descendants {
                    if let Ok(pid) = libc::pid_t::try_from(pid) {
                        let _ = unsafe { libc::kill(pid, libc::SIGKILL) };
                    }
                }
                thread::yield_now();
            }
        }
    }

    #[cfg(target_os = "linux")]
    fn descendant_pids(root: u32) -> Vec<u32> {
        let mut found = Vec::new();
        let mut pending = vec![root];
        while let Some(parent) = pending.pop() {
            let path = format!("/proc/{parent}/task/{parent}/children");
            if let Ok(children) = fs::read_to_string(path) {
                for child in children
                    .split_whitespace()
                    .filter_map(|value| value.parse().ok())
                {
                    if child != root && !found.contains(&child) {
                        found.push(child);
                        pending.push(child);
                    }
                }
            }
        }
        found
    }

    fn reap_all() {
        loop {
            let mut status = 0;
            // SAFETY: the guardian is the subreaper/parent and owns all waitable descendants.
            let result = unsafe { libc::waitpid(-1, &mut status, 0) };
            if result > 0 {
                continue;
            }
            if result == -1 && io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            return;
        }
    }
}

#[cfg(windows)]
mod platform {
    use std::{
        mem::size_of,
        os::windows::{io::AsRawHandle, process::CommandExt},
        ptr,
    };

    use windows_sys::Win32::{
        Foundation::{
            CloseHandle, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, SetHandleInformation,
        },
        System::{
            Console::{CTRL_BREAK_EVENT, GenerateConsoleCtrlEvent, GetStdHandle, STD_INPUT_HANDLE},
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First,
                Thread32Next,
            },
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
            },
            Threading::{
                CREATE_NEW_PROCESS_GROUP, CREATE_SUSPENDED, GetCurrentProcess, OpenThread,
                ResumeThread, THREAD_SUSPEND_RESUME,
            },
        },
    };

    use super::*;

    pub(super) fn prepare_guardian() -> Result<(), ()> {
        Ok(())
    }

    pub(super) fn control_cloexec() -> Result<(), ()> {
        let control = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
        if control.is_null()
            || control == INVALID_HANDLE_VALUE
            || unsafe { SetHandleInformation(control, HANDLE_FLAG_INHERIT, 0) } == 0
        {
            Err(())
        } else {
            Ok(())
        }
    }

    pub(super) fn run_payload(
        mut spec: DecodedSpec,
        mut input: impl Read + Send + 'static,
    ) -> Result<i32, ()> {
        let job = create_job()?;
        if unsafe { AssignProcessToJobObject(job.0, GetCurrentProcess()) } == 0 {
            return Err(());
        }
        let mut command = spec.command();
        command.creation_flags(CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP);
        let mut child = command.spawn().map_err(|_| ())?;
        drop(command);
        let process = child.as_raw_handle() as HANDLE;
        let mut inherited_job = 0;
        if unsafe { IsProcessInJob(process, job.0, &mut inherited_job) } == 0 || inherited_job == 0
        {
            return Err(());
        }
        let thread = primary_thread(child.id())?;
        let mut payload_stdin = child.stdin.take();
        #[cfg(test)]
        delay_test_ack(&spec);
        #[cfg(test)]
        let stall_before_ack = spec
            .environment
            .iter()
            .any(|(key, value)| key == TEST_PRE_ACK_STALL && value == "1");
        spec.arguments.clear();
        spec.environment.clear();
        #[cfg(test)]
        if stall_before_ack {
            let mut output = io::stdout().lock();
            output.write_all(b"SCHPID01").map_err(|_| ())?;
            output
                .write_all(&child.id().to_le_bytes())
                .and_then(|()| output.flush())
                .map_err(|_| ())?;
            thread::sleep(Duration::from_secs(5));
        }
        acknowledge_ready()?;
        // Until this exact byte arrives, the only executable payload is suspended inside the Job.
        if await_commit(&mut input).is_err() {
            terminate(&job);
            let _ = child.wait();
            return Err(());
        }
        if unsafe { ResumeThread(thread.0) } == u32::MAX {
            terminate(&job);
            let _ = child.wait();
            return Err(());
        }
        let receiver = control_reader(input);
        loop {
            if let Some(status) = child.try_wait().map_err(|_| ())? {
                // Keep the Job handle live through `process::exit`; kernel handle closure then
                // kills surviving descendants without changing the guardian's reported status.
                std::mem::forget(job);
                return Ok(status_code(status));
            }
            match receiver.recv_timeout(Duration::from_millis(20)) {
                Ok(ControlEvent::Graceful) => {
                    if let Some(mut stdin) = payload_stdin.take() {
                        let _ = stdin.write_all(b"shutdown\n");
                        let _ = stdin.flush();
                    } else {
                        let _ = unsafe { GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, child.id()) };
                    }
                }
                Ok(ControlEvent::Force) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                    terminate(&job);
                    let _ = child.wait();
                    return Err(());
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
    }

    fn create_job() -> Result<OwnedHandle, ()> {
        let job = OwnedHandle::new(unsafe { CreateJobObjectW(ptr::null(), ptr::null()) })?;
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } == 0
        {
            Err(())
        } else {
            Ok(job)
        }
    }

    fn primary_thread(pid: u32) -> Result<OwnedHandle, ()> {
        let snapshot = OwnedHandle::new(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) })?;
        let mut entry = THREADENTRY32 {
            dwSize: size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        if unsafe { Thread32First(snapshot.0, &mut entry) } == 0 {
            return Err(());
        }
        loop {
            if entry.th32OwnerProcessID == pid {
                return OwnedHandle::new(unsafe {
                    OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID)
                });
            }
            if unsafe { Thread32Next(snapshot.0, &mut entry) } == 0 {
                return Err(());
            }
        }
    }

    fn terminate(job: &OwnedHandle) {
        let _ = unsafe { TerminateJobObject(job.0, 1) };
    }

    struct OwnedHandle(HANDLE);

    impl OwnedHandle {
        fn new(handle: HANDLE) -> Result<Self, ()> {
            if handle.is_null() || handle == INVALID_HANDLE_VALUE {
                Err(())
            } else {
                Ok(Self(handle))
            }
        }
    }

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            let _ = unsafe { CloseHandle(self.0) };
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        env, fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;

    const MODE_ENV: &str = "SCHEDULE_GUARDIAN_PAYLOAD_MODE";
    const VALUE_ENV: &str = "SCHEDULE_GUARDIAN_PAYLOAD_VALUE";

    #[test]
    fn guardian_subprocess_helper() {
        if env::var("SCHEDULE_GUARDIAN_TEST").as_deref() == Ok("1") {
            guardian_main();
        }
    }

    #[test]
    fn payload_helper() {
        match env::var(MODE_ENV).as_deref() {
            Ok("marker") => {
                fs::write(env::var_os(VALUE_ENV).unwrap(), b"ran").unwrap();
            }
            Ok("delayed_marker") => {
                thread::sleep(Duration::from_millis(350));
                fs::write(env::var_os(VALUE_ENV).unwrap(), b"ran").unwrap();
            }
            Ok("tree") => {
                Command::new(env::current_exe().unwrap())
                    .arg("payload_helper")
                    .arg("--nocapture")
                    .env_clear()
                    .env(MODE_ENV, "delayed_marker")
                    .env(VALUE_ENV, env::var_os(VALUE_ENV).unwrap())
                    .spawn()
                    .unwrap();
                thread::sleep(Duration::from_secs(2));
            }
            Ok("stdio") => {
                print!("stdout");
                eprint!("stderr");
            }
            Ok("await_shutdown") => {
                let mut line = String::new();
                if io::stdin().read_line(&mut line).is_err() || line != "shutdown\n" {
                    std::process::exit(9);
                }
            }
            _ => {}
        }
    }

    fn payload(mode: &str, value: Option<&Path>) -> LaunchSpec {
        let mut environment = vec![(OsString::from(MODE_ENV), OsString::from(mode))];
        if let Some(value) = value {
            environment.push((OsString::from(VALUE_ENV), value.as_os_str().to_owned()));
        }
        LaunchSpec::new(
            env::current_exe().unwrap(),
            env::current_dir().unwrap(),
            vec![
                OsString::from("runtime::guardian::tests::payload_helper"),
                OsString::from("--exact"),
                OsString::from("--nocapture"),
            ],
            environment,
            mode == "await_shutdown",
        )
    }

    fn marker_path() -> PathBuf {
        env::temp_dir().join(format!(
            "schedule-guardian-marker-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn admit(mut spawned: SpawnedGuardian) -> SpawnedGuardian {
        let stderr = spawned.child.stderr.take().unwrap();
        spawned.prepare().unwrap();
        let stderr = await_ack(stderr, Instant::now() + Duration::from_secs(2), &|| false).unwrap();
        spawned.child.stderr = Some(stderr);
        spawned.commit().unwrap();
        spawned
    }

    #[test]
    fn closing_parent_endpoint_before_commit_never_executes_payload() {
        let marker = marker_path();
        let mut spawned = spawn(payload("marker", Some(&marker))).unwrap();
        drop(spawned.channel);
        drop(spawned.packet);
        assert!(spawned.child.wait().unwrap().code() != Some(0));
        assert!(!marker.exists());
    }

    #[test]
    fn aborted_admission_cannot_commit_or_execute_payload() {
        let marker = marker_path();
        let mut spawned = spawn(payload("marker", Some(&marker))).unwrap();
        spawned.prepare().unwrap();
        spawned.channel.abort_and_try_force();
        assert!(spawned.commit().is_err());
        let _ = spawned.child.wait();
        assert!(!marker.exists());
    }

    #[test]
    fn final_seal_aborts_a_registered_guardian_without_waiting_for_its_writer() {
        use crate::runtime::process::{
            ChildIdentity, ProcessRole, ProcessSpawnReservation, platform_process_control,
        };

        let marker = marker_path();
        let control = platform_process_control();
        let reservation = ProcessSpawnReservation::new(Arc::clone(&control)).unwrap();
        let mut spawned = spawn(payload("marker", Some(&marker))).unwrap();
        let identity = ChildIdentity {
            role: ProcessRole::Api,
            pid: spawned.child.id(),
        };
        reservation
            .attach(identity, &mut spawned.child, Arc::clone(&spawned.channel))
            .unwrap();
        let stderr = spawned.child.stderr.take().unwrap();
        spawned.prepare().unwrap();
        let stderr = await_ack(stderr, Instant::now() + Duration::from_secs(2), &|| false).unwrap();
        spawned.child.stderr = Some(stderr);
        spawned
            .channel
            .admission
            .compare_exchange(OPEN, COMMITTING, Ordering::AcqRel, Ordering::Acquire)
            .unwrap();
        let writer = spawned.channel.writer.lock().unwrap();
        let barrier = {
            let control = Arc::clone(&control);
            thread::spawn(move || {
                let started = std::time::Instant::now();
                control
                    .seal_and_force_stop_all(Duration::from_millis(10))
                    .unwrap();
                started.elapsed()
            })
        };
        let elapsed = barrier.join().unwrap();
        assert!(elapsed < Duration::from_secs(1));
        drop(writer);
        assert!(spawned.commit().is_err());
        let _ = spawned.child.wait();
        assert!(!marker.exists());
        control.release(identity);
    }

    #[test]
    fn final_seal_forces_a_commit_paused_after_admission_publication() {
        use crate::runtime::process::{
            ChildIdentity, ProcessRole, ProcessSpawnReservation, platform_process_control,
        };

        let marker = marker_path();
        let control = platform_process_control();
        let reservation = ProcessSpawnReservation::new(Arc::clone(&control)).unwrap();
        let mut spawned = spawn(payload("delayed_marker", Some(&marker))).unwrap();
        let identity = ChildIdentity {
            role: ProcessRole::Api,
            pid: spawned.child.id(),
        };
        reservation
            .attach(identity, &mut spawned.child, Arc::clone(&spawned.channel))
            .unwrap();
        let stderr = spawned.child.stderr.take().unwrap();
        spawned.prepare().unwrap();
        let stderr = await_ack(stderr, Instant::now() + Duration::from_secs(2), &|| false).unwrap();
        spawned.child.stderr = Some(stderr);

        let (admitted_sender, admitted_receiver) = mpsc::sync_channel(0);
        let (release_sender, release_receiver) = mpsc::sync_channel(0);
        let channel = Arc::clone(&spawned.channel);
        let commit = thread::spawn(move || {
            channel.commit_with_post_admission(|| {
                admitted_sender.send(()).unwrap();
                release_receiver.recv().unwrap();
            })
        });
        admitted_receiver.recv().unwrap();

        control
            .seal_and_force_stop_all(Duration::from_millis(10))
            .unwrap();
        release_sender.send(()).unwrap();
        commit.join().unwrap().unwrap();
        assert!(spawned.child.wait().unwrap().code() != Some(0));
        thread::sleep(Duration::from_millis(500));
        assert!(!marker.exists());
        control.release(identity);
    }

    #[test]
    fn control_endpoint_loss_kills_a_committed_payload_tree() {
        let marker = marker_path();
        let spawned = admit(spawn(payload("tree", Some(&marker))).unwrap());
        let (mut child, channel) = spawned.into_parts();
        drop(channel);
        assert!(child.wait().unwrap().code() != Some(0));
        thread::sleep(Duration::from_millis(500));
        assert!(!marker.exists());
    }

    #[cfg(windows)]
    #[test]
    fn guardian_loss_before_ack_cannot_orphan_the_suspended_payload() {
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
        };

        let mut spec = payload("marker", Some(&marker_path()));
        spec.environment
            .push((OsString::from(TEST_PRE_ACK_STALL), OsString::from("1")));
        let mut spawned = spawn(spec).unwrap();
        let mut stdout = spawned.child.stdout.take().unwrap();
        spawned.prepare().unwrap();
        let mut observed = Vec::new();
        while !observed.ends_with(b"SCHPID01") {
            let mut byte = [0_u8; 1];
            stdout.read_exact(&mut byte).unwrap();
            observed.push(byte[0]);
            assert!(observed.len() < 16 * 1024);
        }
        let mut pid = [0_u8; 4];
        stdout.read_exact(&mut pid).unwrap();
        let payload_pid = u32::from_le_bytes(pid);

        spawned.child.kill().unwrap();
        let _ = spawned.child.wait();
        drop(spawned.channel);
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, payload_pid) };
            if process.is_null() {
                break;
            }
            let _ = unsafe { CloseHandle(process) };
            assert!(
                std::time::Instant::now() < deadline,
                "suspended payload survived guardian"
            );
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn malformed_and_oversized_packets_fail_closed() {
        for bytes in [
            vec![0_u8; 12],
            {
                let mut bytes = MAGIC.to_vec();
                bytes.extend_from_slice(&((MAX_PACKET_BYTES + 1) as u32).to_le_bytes());
                bytes
            },
            {
                let mut bytes = MAGIC.to_vec();
                bytes.extend_from_slice(&32_u32.to_le_bytes());
                bytes.extend_from_slice(&[0_u8; 4]);
                bytes
            },
        ] {
            let mut command = guardian_command().unwrap();
            let mut child = command.spawn().unwrap();
            let mut stdin = child.stdin.take().unwrap();
            stdin.write_all(&bytes).unwrap();
            drop(stdin);
            assert!(child.wait().unwrap().code() != Some(0));
        }
    }
}
