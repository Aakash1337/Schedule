use std::{
    ffi::OsString,
    fmt,
    io::{self, Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender, TrySendError},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

#[path = "platform/mod.rs"]
mod platform;

const OUTPUT_CHUNK_BYTES: usize = 4 * 1024;
const MAX_READINESS_LINE_BYTES: usize = 16 * 1024;
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(20);
const FORCE_STOP_TIMEOUT: Duration = Duration::from_secs(2);

/// Stable process roles also define the only valid shutdown order.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProcessRole {
    Database,
    Api,
    Worker,
}

impl ProcessRole {
    const SHUTDOWN_ORDER: [Self; 3] = [Self::Worker, Self::Api, Self::Database];
}

/// A PID is diagnostic identity only. Lifecycle operations always retain the owned `Child` handle,
/// avoiding PID-reuse races in the default controller.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ChildIdentity {
    pub(crate) role: ProcessRole,
    pub(crate) pid: u32,
}

/// Errors deliberately expose a code and no source message, path, argument, environment value, or
/// captured child output. Those values can contain the per-launch desktop credential.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ProcessError {
    code: &'static str,
}

impl ProcessError {
    pub(crate) const fn new(code: &'static str) -> Self {
        Self { code }
    }

    pub(crate) const fn code(self) -> &'static str {
        self.code
    }
}

impl fmt::Display for ProcessError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl std::error::Error for ProcessError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum OutputStream {
    Stdout,
    Stderr,
}

/// The prefix is matched at the start of one complete bounded line. Only the bytes following it
/// are returned, so ordinary child output never crosses the supervisor boundary.
pub(crate) struct ReadinessSpec {
    stream: OutputStream,
    prefix: Vec<u8>,
    max_line_bytes: usize,
    max_payload_bytes: usize,
}

impl ReadinessSpec {
    pub(crate) fn stdout_prefix(
        prefix: impl Into<Vec<u8>>,
        max_line_bytes: usize,
        max_payload_bytes: usize,
    ) -> Self {
        Self {
            stream: OutputStream::Stdout,
            prefix: prefix.into(),
            max_line_bytes,
            max_payload_bytes,
        }
    }

    #[allow(dead_code)]
    pub(crate) fn stderr_prefix(
        prefix: impl Into<Vec<u8>>,
        max_line_bytes: usize,
        max_payload_bytes: usize,
    ) -> Self {
        Self {
            stream: OutputStream::Stderr,
            prefix: prefix.into(),
            max_line_bytes,
            max_payload_bytes,
        }
    }

    fn validate(&self) -> Result<(), ProcessError> {
        let valid_prefix = !self.prefix.is_empty()
            && self.prefix.len() < self.max_line_bytes
            && !self.prefix.contains(&b'\n')
            && !self.prefix.contains(&b'\r');
        let valid_bounds = self.max_line_bytes <= MAX_READINESS_LINE_BYTES
            && self.max_payload_bytes > 0
            && self.max_payload_bytes <= self.max_line_bytes.saturating_sub(self.prefix.len());
        (valid_prefix && valid_bounds)
            .then_some(())
            .ok_or_else(|| ProcessError::new("desktop.process_spec_invalid"))
    }
}

/// The command is intentionally not `Debug`: arguments and explicit environment values may be
/// sensitive. The program and working directory must be absolute to prevent PATH/CWD hijacking.
pub(crate) struct ProcessSpec {
    role: ProcessRole,
    program: PathBuf,
    working_directory: PathBuf,
    arguments: Vec<OsString>,
    environment: Vec<(OsString, OsString)>,
    readiness: Option<ReadinessSpec>,
    startup_timeout: Duration,
    desktop_shutdown_stdin: bool,
}

impl ProcessSpec {
    pub(crate) fn new(
        role: ProcessRole,
        program: impl Into<PathBuf>,
        working_directory: impl Into<PathBuf>,
        startup_timeout: Duration,
    ) -> Self {
        Self {
            role,
            program: program.into(),
            working_directory: working_directory.into(),
            arguments: Vec::new(),
            environment: Vec::new(),
            readiness: None,
            startup_timeout,
            desktop_shutdown_stdin: false,
        }
    }

    pub(crate) fn arg(mut self, argument: impl Into<OsString>) -> Self {
        self.arguments.push(argument.into());
        self
    }

    pub(crate) fn env(mut self, key: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.environment.push((key.into(), value.into()));
        self
    }

    pub(crate) fn readiness(mut self, readiness: ReadinessSpec) -> Self {
        self.readiness = Some(readiness);
        self
    }

    /// Opts an API or worker into the private desktop shutdown-line protocol.
    pub(crate) fn desktop_shutdown_stdin(mut self) -> Self {
        self.desktop_shutdown_stdin = true;
        self
    }

    fn validate(&self) -> Result<(), ProcessError> {
        if !self.program.is_absolute()
            || !self.working_directory.is_absolute()
            || self.startup_timeout.is_zero()
            || (self.desktop_shutdown_stdin && self.role == ProcessRole::Database)
        {
            return Err(ProcessError::new("desktop.process_spec_invalid"));
        }

        let mut normalized_keys = Vec::with_capacity(self.environment.len());
        for (key, _) in &self.environment {
            let key = key
                .to_str()
                .filter(|key| is_safe_environment_key(key))
                .ok_or_else(|| ProcessError::new("desktop.process_spec_invalid"))?;
            let normalized = key.to_ascii_uppercase();
            if normalized_keys.contains(&normalized) {
                return Err(ProcessError::new("desktop.process_spec_invalid"));
            }
            normalized_keys.push(normalized);
        }

        if let Some(readiness) = &self.readiness {
            readiness.validate()?;
        }
        Ok(())
    }

    fn command(&self) -> Command {
        let mut command = Command::new(&self.program);
        command
            .args(&self.arguments)
            .current_dir(&self.working_directory)
            .env_clear()
            .envs(self.environment.iter().map(|(key, value)| (key, value)))
            .stdin(if self.desktop_shutdown_stdin {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }
}

fn is_safe_environment_key(key: &str) -> bool {
    !key.is_empty()
        && key
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        && key.as_bytes()[0].is_ascii_uppercase()
}

/// Platform implementations may prepare a Unix process group or Windows Job Object before spawn,
/// attach the child afterward, and implement tree-aware graceful/forced termination. The fallback
/// never invokes a shell and always operates on the owned direct child handle.
pub(crate) trait ProcessGroupControl: Send + Sync {
    /// Reserves the configure/spawn/attach handoff against the final containment barrier.
    fn reserve_spawn(&self) -> Result<(), ProcessError> {
        Ok(())
    }

    fn finish_spawn(&self) {}

    fn configure_command(
        &self,
        _role: ProcessRole,
        _command: &mut Command,
    ) -> Result<(), ProcessError> {
        Ok(())
    }

    fn attach(&self, _identity: ChildIdentity, _child: &mut Child) -> Result<(), ProcessError> {
        Ok(())
    }

    fn request_graceful_stop(
        &self,
        _identity: ChildIdentity,
        child: &mut Child,
    ) -> Result<(), ProcessError> {
        child
            .kill()
            .map_err(|_| ProcessError::new("desktop.process_stop_failed"))
    }

    fn force_stop(&self, _identity: ChildIdentity, child: &mut Child) -> Result<(), ProcessError> {
        child
            .kill()
            .map_err(|_| ProcessError::new("desktop.process_stop_failed"))
    }

    /// Observes direct-child exit. Unix overrides this to avoid reaping the process-group leader
    /// until its descendants have been terminated, which keeps the numeric group ID from reuse.
    fn has_exited(
        &self,
        _identity: ChildIdentity,
        child: &mut Child,
    ) -> Result<bool, ProcessError> {
        child
            .try_wait()
            .map(|status| status.is_some())
            .map_err(|_| ProcessError::new("desktop.process_status_failed"))
    }

    /// Permanently rejects new ownership and force-stops every currently owned process tree.
    /// This is the final bounded-exit containment barrier, not an ordinary lifecycle operation.
    fn seal_and_force_stop_all(&self, _pending_spawn_wait: Duration) -> Result<(), ProcessError> {
        Ok(())
    }

    /// Releases platform ownership as the direct child exits. Unix callers invoke this before
    /// reaping so descendants are terminated while the leader still pins its PID/PGID.
    fn release(&self, _identity: ChildIdentity) {}
}

pub(crate) struct ProcessSpawnReservation {
    control: Arc<dyn ProcessGroupControl>,
    active: bool,
}

impl ProcessSpawnReservation {
    pub(crate) fn new(control: Arc<dyn ProcessGroupControl>) -> Result<Self, ProcessError> {
        control.reserve_spawn()?;
        Ok(Self {
            control,
            active: true,
        })
    }

    pub(crate) fn attach(
        mut self,
        identity: ChildIdentity,
        child: &mut Child,
    ) -> Result<(), ProcessError> {
        let result = self.control.attach(identity, child);
        self.finish();
        result
    }

    fn finish(&mut self) {
        if self.active {
            self.control.finish_spawn();
            self.active = false;
        }
    }
}

impl Drop for ProcessSpawnReservation {
    fn drop(&mut self) {
        self.finish();
    }
}

/// Creates the production tree-aware process controller for the current operating system.
pub(crate) fn platform_process_control() -> Arc<dyn ProcessGroupControl> {
    platform::new_control()
}

#[cfg(test)]
pub(crate) struct DirectChildControl;

#[cfg(test)]
impl ProcessGroupControl for DirectChildControl {}

/// Readiness payload intentionally has no `Debug` or `Display` implementation.
pub(crate) struct ReadyPayload(Vec<u8>);

impl ReadyPayload {
    pub(crate) fn as_bytes(&self) -> &[u8] {
        &self.0
    }
}

pub(crate) struct StartedProcess {
    pub(crate) process: OwnedProcess,
    pub(crate) readiness: Option<ReadyPayload>,
}

pub(crate) struct OwnedProcess {
    identity: ChildIdentity,
    child: Child,
    control: Arc<dyn ProcessGroupControl>,
    readers: Vec<JoinHandle<()>>,
    shutdown_stdin: Option<ChildStdin>,
    exited: bool,
    ownership_released: bool,
}

impl OwnedProcess {
    pub(crate) fn identity(&self) -> ChildIdentity {
        self.identity
    }

    pub(crate) fn has_exited(&mut self) -> Result<bool, ProcessError> {
        if self.exited {
            return Ok(true);
        }
        self.exited = self.control.has_exited(self.identity, &mut self.child)?;
        if self.exited {
            self.shutdown_stdin.take();
            // Unix releases/kills the group while the exited leader is still an unreaped zombie,
            // so its PID/PGID cannot be recycled between observation and the final group signal.
            self.release_ownership();
            self.child
                .wait()
                .map_err(|_| ProcessError::new("desktop.process_status_failed"))?;
            self.release_readers();
        }
        Ok(self.exited)
    }

    pub(crate) fn stop(&mut self, graceful_timeout: Duration) -> Result<(), ProcessError> {
        if self.has_exited()? {
            return Ok(());
        }

        let graceful_deadline = Instant::now() + graceful_timeout;
        if self.request_desktop_shutdown() && self.wait_until(graceful_deadline)? {
            return Ok(());
        }

        let graceful_result = self
            .control
            .request_graceful_stop(self.identity, &mut self.child);
        if graceful_result.is_ok() && self.wait_until(graceful_deadline)? {
            return Ok(());
        }

        if let Err(error) = self.control.force_stop(self.identity, &mut self.child) {
            if self.has_exited()? {
                return Ok(());
            }
            return Err(error);
        }
        if !self.wait_until(Instant::now() + FORCE_STOP_TIMEOUT)? {
            return Err(ProcessError::new("desktop.process_stop_timeout"));
        }
        Ok(())
    }

    fn wait_until(&mut self, deadline: Instant) -> Result<bool, ProcessError> {
        loop {
            if self.has_exited()? {
                return Ok(true);
            }
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                return Ok(false);
            };
            if remaining.is_zero() {
                return Ok(false);
            }
            thread::sleep(remaining.min(PROCESS_POLL_INTERVAL));
        }
    }

    fn release_readers(&mut self) {
        for reader in self.readers.drain(..) {
            // Descendants can inherit a pipe even after the direct child exits. Joining an output
            // thread here could then hang shutdown forever; finished readers are joined, and an
            // unfinished one is safely detached.
            if reader.is_finished() {
                let _ = reader.join();
            }
        }
    }

    fn release_ownership(&mut self) {
        if !self.ownership_released {
            self.control.release(self.identity);
            self.ownership_released = true;
        }
    }

    fn request_desktop_shutdown(&mut self) -> bool {
        let Some(mut stdin) = self.shutdown_stdin.take() else {
            return false;
        };
        let delivered = stdin
            .write_all(b"shutdown\n")
            .and_then(|()| stdin.flush())
            .is_ok();
        drop(stdin);
        delivered
    }
}

impl Drop for OwnedProcess {
    fn drop(&mut self) {
        self.shutdown_stdin.take();
        if !self.exited {
            let _ = self.control.force_stop(self.identity, &mut self.child);
            let _ = self.wait_until(Instant::now() + FORCE_STOP_TIMEOUT);
        }
        self.release_ownership();
        self.release_readers();
    }
}

pub(crate) fn start_process(
    spec: ProcessSpec,
    control: Arc<dyn ProcessGroupControl>,
) -> Result<StartedProcess, ProcessError> {
    start_process_cancellable(spec, control, &|| false)
}

pub(crate) fn start_process_cancellable(
    spec: ProcessSpec,
    control: Arc<dyn ProcessGroupControl>,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<StartedProcess, ProcessError> {
    spec.validate()?;
    if is_cancelled() {
        return Err(ProcessError::new("desktop.process_cancelled"));
    }
    let reservation = ProcessSpawnReservation::new(Arc::clone(&control))?;
    let mut command = spec.command();
    control.configure_command(spec.role, &mut command)?;

    let mut child = command
        .spawn()
        .map_err(|_| ProcessError::new("desktop.process_spawn_failed"))?;
    let identity = ChildIdentity {
        role: spec.role,
        pid: child.id(),
    };
    if reservation.attach(identity, &mut child).is_err() {
        terminate_unowned_child(&mut child);
        return Err(ProcessError::new("desktop.process_group_failed"));
    }
    if is_cancelled() {
        terminate_attached_child(&control, identity, &mut child);
        return Err(ProcessError::new("desktop.process_cancelled"));
    }

    let shutdown_stdin = if spec.desktop_shutdown_stdin {
        let Some(stdin) = child.stdin.take() else {
            terminate_attached_child(&control, identity, &mut child);
            return Err(ProcessError::new("desktop.process_control_failed"));
        };
        Some(stdin)
    } else {
        None
    };

    let Some(stdout) = child.stdout.take() else {
        terminate_attached_child(&control, identity, &mut child);
        return Err(ProcessError::new("desktop.process_output_failed"));
    };
    let Some(stderr) = child.stderr.take() else {
        terminate_attached_child(&control, identity, &mut child);
        return Err(ProcessError::new("desktop.process_output_failed"));
    };

    let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
    let readiness_complete = Arc::new(AtomicBool::new(false));
    let stdout_probe = spec
        .readiness
        .as_ref()
        .filter(|probe| probe.stream == OutputStream::Stdout);
    let stderr_probe = spec
        .readiness
        .as_ref()
        .filter(|probe| probe.stream == OutputStream::Stderr);
    let readers = vec![
        spawn_output_reader(
            stdout,
            stdout_probe,
            ready_sender.clone(),
            Arc::clone(&readiness_complete),
        ),
        spawn_output_reader(
            stderr,
            stderr_probe,
            ready_sender,
            Arc::clone(&readiness_complete),
        ),
    ];

    let mut process = OwnedProcess {
        identity,
        child,
        control,
        readers,
        shutdown_stdin,
        exited: false,
        ownership_released: false,
    };
    let readiness = if spec.readiness.is_some() {
        match await_readiness(
            &mut process,
            ready_receiver,
            spec.startup_timeout,
            is_cancelled,
        ) {
            Ok(payload) => Some(payload),
            Err(error) => {
                let _ = process.stop(Duration::ZERO);
                return Err(error);
            }
        }
    } else {
        None
    };

    Ok(StartedProcess { process, readiness })
}

fn terminate_unowned_child(child: &mut Child) {
    let _ = child.kill();
    let deadline = Instant::now() + FORCE_STOP_TIMEOUT;
    loop {
        if matches!(child.try_wait(), Ok(Some(_))) || Instant::now() >= deadline {
            return;
        }
        thread::sleep(PROCESS_POLL_INTERVAL);
    }
}

fn terminate_attached_child(
    control: &Arc<dyn ProcessGroupControl>,
    identity: ChildIdentity,
    child: &mut Child,
) {
    if control.force_stop(identity, child).is_err() {
        let _ = child.kill();
    }
    let deadline = Instant::now() + FORCE_STOP_TIMEOUT;
    loop {
        if matches!(control.has_exited(identity, child), Ok(true)) {
            control.release(identity);
            let _ = child.wait();
            return;
        }
        if Instant::now() >= deadline {
            control.release(identity);
            return;
        }
        thread::sleep(PROCESS_POLL_INTERVAL);
    }
}

enum ReadinessEvent {
    Matched(Vec<u8>),
    Invalid,
    Ended,
}

fn await_readiness(
    process: &mut OwnedProcess,
    receiver: Receiver<ReadinessEvent>,
    timeout: Duration,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<ReadyPayload, ProcessError> {
    let deadline = Instant::now() + timeout;
    loop {
        if is_cancelled() {
            return Err(ProcessError::new("desktop.process_cancelled"));
        }
        if process.has_exited()? {
            return Err(ProcessError::new("desktop.process_exited_early"));
        }
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| ProcessError::new("desktop.process_start_timeout"))?;
        match receiver.recv_timeout(remaining.min(PROCESS_POLL_INTERVAL)) {
            Ok(ReadinessEvent::Matched(payload)) => {
                if process.has_exited()? {
                    return Err(ProcessError::new("desktop.process_exited_early"));
                }
                return Ok(ReadyPayload(payload));
            }
            Ok(ReadinessEvent::Invalid) => {
                return Err(ProcessError::new("desktop.process_readiness_invalid"));
            }
            Ok(ReadinessEvent::Ended) => {
                return Err(ProcessError::new("desktop.process_exited_early"));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(ProcessError::new("desktop.process_output_failed"));
            }
            Err(mpsc::RecvTimeoutError::Timeout) if Instant::now() >= deadline => {
                return Err(ProcessError::new("desktop.process_start_timeout"));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
}

fn spawn_output_reader<R: Read + Send + 'static>(
    reader: R,
    readiness: Option<&ReadinessSpec>,
    sender: SyncSender<ReadinessEvent>,
    complete: Arc<AtomicBool>,
) -> JoinHandle<()> {
    let probe = readiness.map(|probe| {
        (
            probe.prefix.clone(),
            probe.max_line_bytes,
            probe.max_payload_bytes,
        )
    });
    thread::spawn(move || {
        let max_line_bytes = probe
            .as_ref()
            .map_or(MAX_READINESS_LINE_BYTES, |probe| probe.1);
        let mut scanner = BoundedLineScanner::new(max_line_bytes);
        let result = scanner.read(reader, |line| {
            let Some((prefix, _, max_payload_bytes)) = &probe else {
                return;
            };
            if let Some(payload) = line.strip_prefix(prefix.as_slice()) {
                if payload.is_empty() || payload.len() > *max_payload_bytes {
                    send_once(&complete, &sender, ReadinessEvent::Invalid);
                } else {
                    send_once(
                        &complete,
                        &sender,
                        ReadinessEvent::Matched(payload.to_vec()),
                    );
                }
            }
        });
        if probe.is_some() && !complete.load(Ordering::Acquire) {
            let event = if result.is_ok() {
                ReadinessEvent::Ended
            } else {
                ReadinessEvent::Invalid
            };
            send_once(&complete, &sender, event);
        }
    })
}

fn send_once(complete: &AtomicBool, sender: &SyncSender<ReadinessEvent>, event: ReadinessEvent) {
    if complete
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
    {
        match sender.try_send(event) {
            Ok(()) | Err(TrySendError::Disconnected(_)) => {}
            Err(TrySendError::Full(_)) => unreachable!("single readiness sender wins"),
        }
    }
}

struct BoundedLineScanner {
    line: Vec<u8>,
    max_line_bytes: usize,
    overflowed: bool,
}

impl BoundedLineScanner {
    fn new(max_line_bytes: usize) -> Self {
        Self {
            line: Vec::with_capacity(max_line_bytes.min(OUTPUT_CHUNK_BYTES)),
            max_line_bytes,
            overflowed: false,
        }
    }

    fn read<R: Read>(&mut self, mut reader: R, mut on_line: impl FnMut(&[u8])) -> io::Result<()> {
        let mut chunk = [0_u8; OUTPUT_CHUNK_BYTES];
        loop {
            let count = reader.read(&mut chunk)?;
            if count == 0 {
                if !self.line.is_empty() && !self.overflowed {
                    trim_carriage_return_and_emit(&self.line, &mut on_line);
                }
                return Ok(());
            }
            for &byte in &chunk[..count] {
                if byte == b'\n' {
                    if !self.overflowed {
                        trim_carriage_return_and_emit(&self.line, &mut on_line);
                    }
                    self.line.clear();
                    self.overflowed = false;
                } else if !self.overflowed {
                    if self.line.len() == self.max_line_bytes {
                        self.line.clear();
                        self.overflowed = true;
                    } else {
                        self.line.push(byte);
                    }
                }
            }
        }
    }
}

fn trim_carriage_return_and_emit(line: &[u8], on_line: &mut impl FnMut(&[u8])) {
    on_line(line.strip_suffix(b"\r").unwrap_or(line));
}

/// Owns at most one process per role and always stops worker, API, then database. Shutdown keeps
/// going after an individual failure so a broken child cannot strand the remaining local runtime.
pub(crate) struct ProcessSet {
    processes: Vec<OwnedProcess>,
}

impl ProcessSet {
    pub(crate) fn new() -> Self {
        Self {
            processes: Vec::with_capacity(ProcessRole::SHUTDOWN_ORDER.len()),
        }
    }

    pub(crate) fn insert(&mut self, process: OwnedProcess) -> Result<(), ProcessError> {
        if self
            .processes
            .iter()
            .any(|existing| existing.identity.role == process.identity.role)
        {
            return Err(ProcessError::new("desktop.process_role_duplicate"));
        }
        self.processes.push(process);
        Ok(())
    }

    pub(crate) fn shutdown_ordered(
        &mut self,
        graceful_timeout: Duration,
    ) -> Result<(), ProcessError> {
        let mut first_error = None;
        for role in ProcessRole::SHUTDOWN_ORDER {
            let process = self
                .processes
                .iter_mut()
                .find(|process| process.identity.role == role);
            if let Some(process) = process {
                if let Err(error) = process.stop(graceful_timeout) {
                    if first_error.is_none() {
                        first_error = Some(error);
                    }
                }
            }
        }
        first_error.map_or(Ok(()), Err)
    }
}

impl Drop for ProcessSet {
    fn drop(&mut self) {
        let _ = self.shutdown_ordered(Duration::ZERO);
    }
}

#[cfg(test)]
mod tests {
    use std::{
        env,
        ffi::OsStr,
        fs,
        sync::Mutex,
        thread,
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;

    const CHILD_MODE: &str = "SCHEDULE_PROCESS_TEST_MODE";
    const EXPLICIT_VALUE: &str = "SCHEDULE_EXPLICIT_VALUE";
    const READY_PREFIX: &[u8] = b"SCHEDULE_TEST_READY_V1 ";

    fn helper_spec(role: ProcessRole, mode: &str, timeout: Duration) -> ProcessSpec {
        let executable = env::current_exe().unwrap();
        let working_directory = env::current_dir().unwrap();
        ProcessSpec::new(role, executable, working_directory, timeout)
            .arg("subprocess_helper")
            .arg("--nocapture")
            .env(CHILD_MODE, mode)
    }

    #[test]
    fn subprocess_helper() {
        match env::var(CHILD_MODE).as_deref() {
            Ok("ready") => {
                let explicit = env::var(EXPLICIT_VALUE).unwrap_or_default();
                let path_is_absent = env::var_os("PATH").is_none();
                println!(
                    "{}{{\"explicit\":\"{}\",\"pathAbsent\":{}}}",
                    String::from_utf8_lossy(READY_PREFIX),
                    explicit,
                    path_is_absent
                );
                // Model a real service: readiness is valid only while the child remains alive.
                thread::sleep(Duration::from_secs(2));
            }
            Ok("sleep") => thread::sleep(Duration::from_secs(2)),
            Ok("await_shutdown") => {
                let mut line = String::new();
                if std::io::stdin().read_line(&mut line).is_err() || line != "shutdown\n" {
                    thread::sleep(Duration::from_secs(2));
                }
            }
            Ok("closed_stdin") => {
                close_standard_input();
                println!("{}closed", String::from_utf8_lossy(READY_PREFIX));
                thread::sleep(Duration::from_secs(2));
            }
            Ok("tree_parent") => {
                Command::new(env::current_exe().unwrap())
                    .arg("subprocess_helper")
                    .arg("--nocapture")
                    .env_clear()
                    .env(CHILD_MODE, "tree_descendant")
                    .env(EXPLICIT_VALUE, env::var_os(EXPLICIT_VALUE).unwrap())
                    .spawn()
                    .unwrap();
                println!("{}tree", String::from_utf8_lossy(READY_PREFIX));
                thread::sleep(Duration::from_secs(2));
            }
            Ok("tree_descendant") => {
                thread::sleep(Duration::from_millis(600));
                fs::write(env::var_os(EXPLICIT_VALUE).unwrap(), b"escaped").unwrap();
                thread::sleep(Duration::from_secs(2));
            }
            _ => {}
        }
    }

    #[cfg(windows)]
    fn close_standard_input() {
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::Console::{GetStdHandle, STD_INPUT_HANDLE},
        };

        // SAFETY: the helper process exclusively owns its inherited standard-input handle.
        let _ = unsafe { CloseHandle(GetStdHandle(STD_INPUT_HANDLE)) };
    }

    #[cfg(unix)]
    fn close_standard_input() {
        // SAFETY: the helper process exclusively owns descriptor zero.
        let _ = unsafe { libc::close(libc::STDIN_FILENO) };
    }

    #[test]
    fn starts_without_a_shell_clears_the_environment_and_parses_a_bounded_sentinel() {
        let spec = helper_spec(ProcessRole::Api, "ready", Duration::from_secs(2))
            .env(EXPLICIT_VALUE, "allowed")
            .readiness(ReadinessSpec::stdout_prefix(READY_PREFIX, 512, 256));
        let mut started = start_process(spec, Arc::new(DirectChildControl)).unwrap();
        assert_eq!(
            started.readiness.as_ref().unwrap().as_bytes(),
            br#"{"explicit":"allowed","pathAbsent":true}"#
        );
        started.process.stop(Duration::ZERO).unwrap();
    }

    #[test]
    fn rejects_relative_programs_duplicate_or_unsafe_environment_and_invalid_probes() {
        let cwd = env::current_dir().unwrap();
        let relative = ProcessSpec::new(ProcessRole::Api, "node", &cwd, Duration::from_secs(1));
        assert_eq!(
            relative.validate().unwrap_err().code(),
            "desktop.process_spec_invalid"
        );

        let duplicate = ProcessSpec::new(
            ProcessRole::Api,
            env::current_exe().unwrap(),
            &cwd,
            Duration::from_secs(1),
        )
        .env("TOKEN", "first")
        .env("TOKEN", "second");
        assert!(duplicate.validate().is_err());

        let unsafe_key = ProcessSpec::new(
            ProcessRole::Api,
            env::current_exe().unwrap(),
            &cwd,
            Duration::from_secs(1),
        )
        .env("not-allowed", "secret");
        assert!(unsafe_key.validate().is_err());

        let invalid_probe = helper_spec(ProcessRole::Api, "ready", Duration::from_secs(1))
            .readiness(ReadinessSpec::stdout_prefix(b"bad\nprefix", 128, 32));
        assert!(invalid_probe.validate().is_err());

        let oversized_prefix = helper_spec(ProcessRole::Api, "ready", Duration::from_secs(1))
            .readiness(ReadinessSpec::stdout_prefix(vec![b'x'; 129], 128, 32));
        assert!(oversized_prefix.validate().is_err());

        let database_control_pipe =
            helper_spec(ProcessRole::Database, "sleep", Duration::from_secs(1))
                .desktop_shutdown_stdin();
        assert!(database_control_pipe.validate().is_err());
    }

    #[test]
    fn line_scanner_discards_oversized_lines_without_growing_or_losing_later_lines() {
        let input = format!("{}\nSCHEDULE_TEST_READY_V1 ok\r\n", "x".repeat(65));
        let mut lines = Vec::new();
        let mut scanner = BoundedLineScanner::new(64);
        scanner
            .read(input.as_bytes(), |line| lines.push(line.to_vec()))
            .unwrap();

        assert_eq!(lines, vec![b"SCHEDULE_TEST_READY_V1 ok".to_vec()]);
        assert!(scanner.line.capacity() <= 64);
    }

    #[test]
    fn startup_timeout_terminates_and_reaps_the_child() {
        let spec = helper_spec(ProcessRole::Api, "sleep", Duration::from_millis(25))
            .readiness(ReadinessSpec::stdout_prefix(READY_PREFIX, 512, 256));
        let error = match start_process(spec, Arc::new(DirectChildControl)) {
            Ok(_) => panic!("sleeping child unexpectedly became ready"),
            Err(error) => error,
        };
        assert_eq!(error.code(), "desktop.process_start_timeout");
    }

    #[test]
    fn startup_cancellation_terminates_and_reaps_the_child() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let setter = Arc::clone(&cancelled);
        let thread = thread::spawn(move || {
            thread::sleep(Duration::from_millis(30));
            setter.store(true, Ordering::Release);
        });
        let control: Arc<dyn ProcessGroupControl> = Arc::new(DirectChildControl);
        let error = start_process_cancellable(
            helper_spec(ProcessRole::Api, "sleep", Duration::from_secs(2))
                .readiness(ReadinessSpec::stdout_prefix(READY_PREFIX, 512, 256)),
            control,
            &|| cancelled.load(Ordering::Acquire),
        )
        .err()
        .unwrap();
        thread.join().unwrap();
        assert_eq!(error.code(), "desktop.process_cancelled");
    }

    #[derive(Default)]
    struct RecordingControl {
        configured: Mutex<Vec<ProcessRole>>,
        attached: Mutex<Vec<ProcessRole>>,
        stopped: Mutex<Vec<ProcessRole>>,
        released: Mutex<Vec<ProcessRole>>,
    }

    impl ProcessGroupControl for RecordingControl {
        fn configure_command(
            &self,
            role: ProcessRole,
            _command: &mut Command,
        ) -> Result<(), ProcessError> {
            self.configured.lock().unwrap().push(role);
            Ok(())
        }

        fn attach(&self, identity: ChildIdentity, _child: &mut Child) -> Result<(), ProcessError> {
            self.attached.lock().unwrap().push(identity.role);
            Ok(())
        }

        fn request_graceful_stop(
            &self,
            identity: ChildIdentity,
            child: &mut Child,
        ) -> Result<(), ProcessError> {
            self.stopped.lock().unwrap().push(identity.role);
            child
                .kill()
                .map_err(|_| ProcessError::new("desktop.process_stop_failed"))
        }

        fn release(&self, identity: ChildIdentity) {
            self.released.lock().unwrap().push(identity.role);
        }
    }

    #[test]
    fn exposes_platform_control_seams_and_shuts_down_in_dependency_order() {
        let control = Arc::new(RecordingControl::default());
        let mut processes = ProcessSet::new();
        for role in [ProcessRole::Database, ProcessRole::Worker, ProcessRole::Api] {
            let started = start_process(
                helper_spec(role, "sleep", Duration::from_secs(1)),
                control.clone(),
            )
            .unwrap();
            processes.insert(started.process).unwrap();
        }

        processes
            .shutdown_ordered(Duration::from_millis(100))
            .unwrap();
        assert_eq!(
            *control.stopped.lock().unwrap(),
            vec![ProcessRole::Worker, ProcessRole::Api, ProcessRole::Database]
        );
        assert_eq!(control.configured.lock().unwrap().len(), 3);
        assert_eq!(control.attached.lock().unwrap().len(), 3);
        assert_eq!(control.released.lock().unwrap().len(), 3);
    }

    #[test]
    fn desktop_shutdown_pipe_delivers_one_line_without_platform_fallback() {
        let control = Arc::new(RecordingControl::default());
        let mut started = start_process(
            helper_spec(ProcessRole::Api, "await_shutdown", Duration::from_secs(1))
                .desktop_shutdown_stdin(),
            control.clone(),
        )
        .unwrap();

        started.process.stop(Duration::from_secs(1)).unwrap();
        assert!(started.process.has_exited().unwrap());
        assert!(control.stopped.lock().unwrap().is_empty());
    }

    #[test]
    fn broken_desktop_shutdown_pipe_falls_back_to_platform_control() {
        let control = Arc::new(RecordingControl::default());
        let mut started = start_process(
            helper_spec(ProcessRole::Worker, "closed_stdin", Duration::from_secs(2))
                .desktop_shutdown_stdin()
                .readiness(ReadinessSpec::stdout_prefix(READY_PREFIX, 512, 256)),
            control.clone(),
        )
        .unwrap();

        started.process.stop(Duration::from_millis(100)).unwrap();
        assert_eq!(*control.stopped.lock().unwrap(), vec![ProcessRole::Worker]);
    }

    #[test]
    fn post_attach_setup_failure_force_stops_and_releases_platform_ownership() {
        #[derive(Default)]
        struct SetupFailureControl {
            forced: Mutex<usize>,
            released: Mutex<usize>,
        }

        impl ProcessGroupControl for SetupFailureControl {
            fn attach(
                &self,
                _identity: ChildIdentity,
                child: &mut Child,
            ) -> Result<(), ProcessError> {
                child.stdout.take();
                Ok(())
            }

            fn force_stop(
                &self,
                _identity: ChildIdentity,
                child: &mut Child,
            ) -> Result<(), ProcessError> {
                *self.forced.lock().unwrap() += 1;
                child
                    .kill()
                    .map_err(|_| ProcessError::new("desktop.process_stop_failed"))
            }

            fn release(&self, _identity: ChildIdentity) {
                *self.released.lock().unwrap() += 1;
            }
        }

        let control = Arc::new(SetupFailureControl::default());
        let error = match start_process(
            helper_spec(ProcessRole::Api, "sleep", Duration::from_secs(1)),
            control.clone(),
        ) {
            Ok(_) => panic!("missing stdout unexpectedly passed process setup"),
            Err(error) => error,
        };
        assert_eq!(error.code(), "desktop.process_output_failed");
        assert_eq!(*control.forced.lock().unwrap(), 1);
        assert_eq!(*control.released.lock().unwrap(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn windows_job_assigns_before_readiness_and_stops_the_child() {
        let spec = helper_spec(ProcessRole::Api, "ready", Duration::from_secs(2))
            .readiness(ReadinessSpec::stdout_prefix(READY_PREFIX, 512, 256));
        let mut started = start_process(spec, platform_process_control()).unwrap();
        assert!(started.readiness.is_some());
        started.process.stop(Duration::ZERO).unwrap();
        assert!(started.process.has_exited().unwrap());
    }

    #[test]
    fn platform_control_stops_the_owned_descendant_tree() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let marker = env::temp_dir().join(format!(
            "schedule-process-tree-{}-{nonce}.marker",
            std::process::id()
        ));
        let _ = fs::remove_file(&marker);
        let spec = helper_spec(ProcessRole::Api, "tree_parent", Duration::from_secs(2))
            .env(EXPLICIT_VALUE, marker.as_os_str())
            .readiness(ReadinessSpec::stdout_prefix(READY_PREFIX, 512, 256));
        let mut started = start_process(spec, platform_process_control()).unwrap();

        started.process.stop(Duration::from_millis(200)).unwrap();
        thread::sleep(Duration::from_millis(750));
        let descendant_escaped = marker.exists();
        let _ = fs::remove_file(marker);
        assert!(!descendant_escaped);
    }

    #[test]
    fn final_containment_kills_owned_groups_and_rejects_late_spawns() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let marker = env::temp_dir().join(format!(
            "schedule-final-containment-{}-{nonce}.marker",
            std::process::id()
        ));
        let _ = fs::remove_file(&marker);
        let control = platform_process_control();
        let spec = helper_spec(ProcessRole::Api, "tree_parent", Duration::from_secs(2))
            .env(EXPLICIT_VALUE, marker.as_os_str())
            .readiness(ReadinessSpec::stdout_prefix(READY_PREFIX, 512, 256));
        let started = start_process(spec, Arc::clone(&control)).unwrap();

        control
            .seal_and_force_stop_all(Duration::from_secs(1))
            .unwrap();
        thread::sleep(Duration::from_millis(750));
        assert!(!marker.exists());
        let late = start_process(
            helper_spec(ProcessRole::Worker, "sleep", Duration::from_secs(1)),
            control,
        )
        .err()
        .unwrap();
        assert_eq!(late.code(), "desktop.process_group_failed");

        drop(started);
        let _ = fs::remove_file(marker);
    }

    #[test]
    fn final_containment_deadline_rejects_a_late_reserved_spawn() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let marker = env::temp_dir().join(format!(
            "schedule-late-spawn-{}-{nonce}.marker",
            std::process::id()
        ));
        let _ = fs::remove_file(&marker);
        let control = platform_process_control();
        let reservation = ProcessSpawnReservation::new(Arc::clone(&control)).unwrap();
        let spec = helper_spec(ProcessRole::Api, "tree_parent", Duration::from_secs(2))
            .env(EXPLICIT_VALUE, marker.as_os_str())
            .readiness(ReadinessSpec::stdout_prefix(READY_PREFIX, 512, 256));
        let mut command = spec.command();
        control
            .configure_command(ProcessRole::Api, &mut command)
            .unwrap();

        let started = Instant::now();
        control
            .seal_and_force_stop_all(Duration::from_millis(10))
            .unwrap();
        assert!(started.elapsed() < Duration::from_secs(1));

        let mut child = command.spawn().unwrap();
        let identity = ChildIdentity {
            role: ProcessRole::Api,
            pid: child.id(),
        };
        assert!(reservation.attach(identity, &mut child).is_err());
        terminate_unowned_child(&mut child);
        thread::sleep(Duration::from_millis(750));
        assert!(!marker.exists());
        assert!(ProcessSpawnReservation::new(control).is_err());
        let _ = fs::remove_file(marker);
    }

    #[test]
    fn process_errors_never_echo_sensitive_inputs() {
        let secret = "do-not-disclose-this-token";
        let spec = ProcessSpec::new(
            ProcessRole::Api,
            PathBuf::from("relative-program"),
            env::current_dir().unwrap(),
            Duration::from_secs(1),
        )
        .env("DESKTOP_API_TOKEN", secret);
        let error = spec.validate().unwrap_err();
        let rendered = format!("{error:?} {error}");
        assert!(!rendered.contains(secret));
        assert!(!rendered.contains("relative-program"));
        assert_eq!(
            rendered,
            "ProcessError { code: \"desktop.process_spec_invalid\" } desktop.process_spec_invalid"
        );
    }

    #[test]
    fn rejects_duplicate_owned_roles() {
        let control: Arc<dyn ProcessGroupControl> = Arc::new(DirectChildControl);
        let mut processes = ProcessSet::new();
        let first = start_process(
            helper_spec(ProcessRole::Api, "sleep", Duration::from_secs(1)),
            Arc::clone(&control),
        )
        .unwrap();
        let duplicate = start_process(
            helper_spec(ProcessRole::Api, "sleep", Duration::from_secs(1)),
            control,
        )
        .unwrap();
        processes.insert(first.process).unwrap();
        assert_eq!(
            processes.insert(duplicate.process).unwrap_err().code(),
            "desktop.process_role_duplicate"
        );
    }

    #[test]
    fn environment_key_rules_are_portable_and_explicit() {
        for allowed in ["PATH", "SYSTEMROOT", "PGDATA", "SCHEDULE_API_PORT", "A1"] {
            assert!(is_safe_environment_key(allowed), "{allowed}");
        }
        for denied in ["", "1STARTS_WITH_DIGIT", "MixedCase", "HAS-DASH", "A=B"] {
            assert!(!is_safe_environment_key(denied), "{denied}");
        }
        assert!(OsStr::new("TOKEN").to_str().is_some());
    }
}
