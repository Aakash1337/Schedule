use std::{
    ffi::{OsStr, OsString},
    fmt,
    io::{self, Read},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender, TrySendError},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

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
            && self.max_payload_bytes <= self.max_line_bytes - self.prefix.len();
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

    fn validate(&self) -> Result<(), ProcessError> {
        if !self.program.is_absolute()
            || !self.working_directory.is_absolute()
            || self.startup_timeout.is_zero()
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
            .stdin(Stdio::null())
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
    exited: bool,
}

impl OwnedProcess {
    pub(crate) fn identity(&self) -> ChildIdentity {
        self.identity
    }

    pub(crate) fn has_exited(&mut self) -> Result<bool, ProcessError> {
        if self.exited {
            return Ok(true);
        }
        self.exited = self
            .child
            .try_wait()
            .map_err(|_| ProcessError::new("desktop.process_status_failed"))?
            .is_some();
        if self.exited {
            self.release_readers();
        }
        Ok(self.exited)
    }

    pub(crate) fn stop(&mut self, graceful_timeout: Duration) -> Result<(), ProcessError> {
        if self.has_exited()? {
            return Ok(());
        }

        let graceful_result = self
            .control
            .request_graceful_stop(self.identity, &mut self.child);
        if graceful_result.is_ok() && self.wait_until(Instant::now() + graceful_timeout)? {
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
}

impl Drop for OwnedProcess {
    fn drop(&mut self) {
        if !self.exited {
            let _ = self.control.force_stop(self.identity, &mut self.child);
            let _ = self.wait_until(Instant::now() + FORCE_STOP_TIMEOUT);
        }
        self.release_readers();
    }
}

pub(crate) fn start_process(
    spec: ProcessSpec,
    control: Arc<dyn ProcessGroupControl>,
) -> Result<StartedProcess, ProcessError> {
    spec.validate()?;
    let mut command = spec.command();
    control.configure_command(spec.role, &mut command)?;

    let mut child = command
        .spawn()
        .map_err(|_| ProcessError::new("desktop.process_spawn_failed"))?;
    let identity = ChildIdentity {
        role: spec.role,
        pid: child.id(),
    };
    if control.attach(identity, &mut child).is_err() {
        terminate_unowned_child(&mut child);
        return Err(ProcessError::new("desktop.process_group_failed"));
    }

    let stdout = child.stdout.take().ok_or_else(|| {
        terminate_unowned_child(&mut child);
        ProcessError::new("desktop.process_output_failed")
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        terminate_unowned_child(&mut child);
        ProcessError::new("desktop.process_output_failed")
    })?;

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
        exited: false,
    };
    let readiness = if spec.readiness.is_some() {
        match await_readiness(&mut process, ready_receiver, spec.startup_timeout) {
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

enum ReadinessEvent {
    Matched(Vec<u8>),
    Invalid,
    Ended,
}

fn await_readiness(
    process: &mut OwnedProcess,
    receiver: Receiver<ReadinessEvent>,
    timeout: Duration,
) -> Result<ReadyPayload, ProcessError> {
    let deadline = Instant::now() + timeout;
    loop {
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
    use std::{env, sync::Mutex, thread};

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
                thread::sleep(Duration::from_millis(250));
            }
            Ok("sleep") => thread::sleep(Duration::from_secs(2)),
            _ => {}
        }
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

    #[derive(Default)]
    struct RecordingControl {
        configured: Mutex<Vec<ProcessRole>>,
        attached: Mutex<Vec<ProcessRole>>,
        stopped: Mutex<Vec<ProcessRole>>,
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
