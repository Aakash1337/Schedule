//! Bounded, shell-free helpers for one-shot bundled-runtime commands.
//!
//! This module deliberately does not expose command lines or captured output through error
//! formatting: PostgreSQL connection settings and migration diagnostics can contain credentials.

use std::{
    cell::Cell,
    ffi::OsString,
    fmt,
    io::Read,
    path::PathBuf,
    process::Child,
    sync::{
        Arc,
        mpsc::{self, Receiver, SyncSender},
    },
    thread,
    time::{Duration, Instant},
};

use super::{
    guardian::{self, GuardianChannel, LaunchSpec},
    process::{
        ChildIdentity, ProcessError, ProcessGroupControl, ProcessRole, ProcessSpawnReservation,
    },
};

const READ_CHUNK_BYTES: usize = 4 * 1024;
const MAX_CAPTURE_BYTES: usize = 1024 * 1024;
const POLL_INTERVAL: Duration = Duration::from_millis(10);
const OUTPUT_SETTLE_TIMEOUT: Duration = Duration::from_millis(250);

/// A one-shot command. It is intentionally not `Debug`: arguments and environment values can be
/// sensitive. The program and working directory must be absolute, and no inherited environment
/// or shell is used.
pub(crate) struct CommandSpec {
    program: PathBuf,
    working_directory: PathBuf,
    arguments: Vec<OsString>,
    environment: Vec<(OsString, OsString)>,
    timeout: Duration,
    max_stdout_bytes: usize,
    max_stderr_bytes: usize,
    database_payload: bool,
}

impl CommandSpec {
    pub(crate) fn new(
        program: impl Into<PathBuf>,
        working_directory: impl Into<PathBuf>,
        timeout: Duration,
    ) -> Self {
        Self {
            program: program.into(),
            working_directory: working_directory.into(),
            arguments: Vec::new(),
            environment: Vec::new(),
            timeout,
            max_stdout_bytes: 64 * 1024,
            max_stderr_bytes: 64 * 1024,
            database_payload: false,
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

    pub(crate) fn output_bounds(mut self, stdout: usize, stderr: usize) -> Self {
        self.max_stdout_bytes = stdout;
        self.max_stderr_bytes = stderr;
        self
    }

    pub(crate) fn database_payload(mut self) -> Self {
        self.database_payload = true;
        self
    }

    fn validate(&self) -> Result<(), CommandError> {
        if !self.program.is_absolute()
            || !self.working_directory.is_absolute()
            || self.timeout.is_zero()
            || self.max_stdout_bytes == 0
            || self.max_stderr_bytes == 0
            || self.max_stdout_bytes > MAX_CAPTURE_BYTES
            || self.max_stderr_bytes > MAX_CAPTURE_BYTES
        {
            return Err(CommandError::new("desktop.command_spec_invalid"));
        }

        let mut keys = Vec::with_capacity(self.environment.len());
        for (key, _) in &self.environment {
            let key = key
                .to_str()
                .filter(|key| is_safe_environment_key(key))
                .ok_or_else(|| CommandError::new("desktop.command_spec_invalid"))?;
            let normalized = key.to_ascii_uppercase();
            if keys.contains(&normalized) {
                return Err(CommandError::new("desktop.command_spec_invalid"));
            }
            keys.push(normalized);
        }
        Ok(())
    }

    fn launch_spec(&self) -> LaunchSpec {
        LaunchSpec::new(
            self.program.clone(),
            self.working_directory.clone(),
            self.arguments.clone(),
            self.environment.clone(),
            false,
            self.database_payload,
        )
    }
}

fn is_safe_environment_key(key: &str) -> bool {
    !key.is_empty()
        && key.as_bytes()[0].is_ascii_uppercase()
        && key
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

/// Errors contain only stable public codes; they never contain command, path, environment, or
/// captured child output.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct CommandError {
    code: &'static str,
}

impl CommandError {
    const fn new(code: &'static str) -> Self {
        Self { code }
    }

    pub(crate) const fn code(self) -> &'static str {
        self.code
    }
}

impl fmt::Display for CommandError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl std::error::Error for CommandError {}

/// Successful bounded output. This deliberately has no `Debug` implementation.
pub(crate) struct CommandOutput {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

impl CommandOutput {
    pub(crate) fn stdout(&self) -> &[u8] {
        &self.stdout
    }

    pub(crate) fn stderr(&self) -> &[u8] {
        &self.stderr
    }
}

#[derive(Clone, Copy)]
enum Stream {
    Stdout,
    Stderr,
}

enum OutputEvent {
    Bytes(Stream, Vec<u8>),
    Ended,
    Failed,
}

struct AttachedCommandOwnership<'a> {
    control: &'a dyn ProcessGroupControl,
    identity: ChildIdentity,
    _guardian_channel: Arc<GuardianChannel>,
    released: Cell<bool>,
}

impl AttachedCommandOwnership<'_> {
    fn release(&self) {
        if !self.released.replace(true) {
            self.control.release(self.identity);
        }
    }
}

impl Drop for AttachedCommandOwnership<'_> {
    fn drop(&mut self) {
        self.release();
    }
}

/// Run a bounded initdb/psql/pg_dump/pg_restore/migration helper. A controller is injected so a
/// platform process group or Job Object can stop descendants on timeout, nonzero exit, or output
/// overflow. The direct child is always reaped; reader threads are only joined if already done,
/// because a descendant may retain an inherited output pipe after its parent exits. Every
/// successfully attached platform owner is released exactly once before return.
pub(super) fn run_command(
    spec: CommandSpec,
    control: Arc<dyn ProcessGroupControl>,
) -> Result<CommandOutput, CommandError> {
    run_command_cancellable(spec, control, &|| false)
}

pub(super) fn run_command_cancellable(
    spec: CommandSpec,
    control: Arc<dyn ProcessGroupControl>,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<CommandOutput, CommandError> {
    spec.validate()?;
    if is_cancelled() {
        return Err(CommandError::new("desktop.command_cancelled"));
    }
    let deadline = Instant::now() + spec.timeout;
    let reservation =
        ProcessSpawnReservation::new(Arc::clone(&control)).map_err(map_process_error)?;
    let mut spawned = guardian::spawn(spec.launch_spec()).map_err(map_process_error)?;
    let mut child = spawned.child;
    let identity = ChildIdentity {
        role: ProcessRole::Database,
        pid: child.id(),
    };
    let guardian_channel = Arc::clone(&spawned.channel);
    if reservation
        .attach(identity, &mut child, Arc::clone(&guardian_channel))
        .is_err()
    {
        stop_unattached(&control, identity, &mut child);
        return Err(CommandError::new("desktop.command_group_failed"));
    }
    spawned.child = child;
    let ownership = AttachedCommandOwnership {
        control: control.as_ref(),
        identity,
        _guardian_channel: guardian_channel,
        released: Cell::new(false),
    };
    if is_cancelled() {
        stop_and_reap(&control, &ownership, identity, &mut spawned.child);
        return Err(CommandError::new("desktop.command_cancelled"));
    }

    // Command output is bounded by `collect_output`; begin draining before COMMIT so even a payload
    // that writes immediately cannot fill the inherited guardian pipes during admission.
    let Some(stdout) = spawned.child.stdout.take() else {
        stop_and_reap(&control, &ownership, identity, &mut spawned.child);
        return Err(CommandError::new("desktop.command_output_failed"));
    };
    let Some(stderr) = spawned.child.stderr.take() else {
        stop_and_reap(&control, &ownership, identity, &mut spawned.child);
        return Err(CommandError::new("desktop.command_output_failed"));
    };
    if spawned.prepare().is_err() {
        stop_and_reap(&control, &ownership, identity, &mut spawned.child);
        return Err(CommandError::new("desktop.command_group_failed"));
    }
    let stderr = match guardian::await_ack(stderr, deadline, is_cancelled) {
        Ok(stderr) => stderr,
        Err(error) => {
            stop_and_reap(&control, &ownership, identity, &mut spawned.child);
            return Err(map_guardian_start_error(error));
        }
    };
    let (sender, receiver) = mpsc::sync_channel(16);
    let readers = [
        drain_stream(stdout, Stream::Stdout, sender.clone()),
        drain_stream(stderr, Stream::Stderr, sender),
    ];

    if spawned.commit().is_err() {
        stop_and_reap(&control, &ownership, identity, &mut spawned.child);
        return Err(CommandError::new("desktop.command_group_failed"));
    }
    let (mut child, _guardian_channel) = spawned.into_parts();

    let result = collect_output(
        &mut child,
        identity,
        &control,
        &ownership,
        receiver,
        deadline,
        spec.max_stdout_bytes,
        spec.max_stderr_bytes,
        is_cancelled,
    );
    // Never block on a reader: a descendant can keep a pipe handle open after the child exits.
    for reader in readers {
        if reader.is_finished() {
            let _ = reader.join();
        }
    }
    drop(ownership);
    result
}

fn collect_output(
    child: &mut Child,
    identity: ChildIdentity,
    control: &Arc<dyn ProcessGroupControl>,
    ownership: &AttachedCommandOwnership<'_>,
    receiver: Receiver<OutputEvent>,
    deadline: Instant,
    stdout_limit: usize,
    stderr_limit: usize,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<CommandOutput, CommandError> {
    let mut stdout = Vec::with_capacity(stdout_limit.min(READ_CHUNK_BYTES));
    let mut stderr = Vec::with_capacity(stderr_limit.min(READ_CHUNK_BYTES));
    let mut ended = 0;
    let mut exited_at = None;

    loop {
        if is_cancelled() {
            stop_and_reap(control, ownership, identity, child);
            return Err(CommandError::new("desktop.command_cancelled"));
        }
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            stop_and_reap(control, ownership, identity, child);
            return Err(CommandError::new("desktop.command_timeout"));
        };
        match receiver.recv_timeout(remaining.min(POLL_INTERVAL)) {
            Ok(OutputEvent::Bytes(Stream::Stdout, bytes)) => {
                if let Err(error) = append_bounded(&mut stdout, bytes, stdout_limit) {
                    stop_and_reap(control, ownership, identity, child);
                    return Err(error);
                }
            }
            Ok(OutputEvent::Bytes(Stream::Stderr, bytes)) => {
                if let Err(error) = append_bounded(&mut stderr, bytes, stderr_limit) {
                    stop_and_reap(control, ownership, identity, child);
                    return Err(error);
                }
            }
            Ok(OutputEvent::Ended) => ended += 1,
            Ok(OutputEvent::Failed) => {
                stop_and_reap(control, ownership, identity, child);
                return Err(CommandError::new("desktop.command_output_failed"));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }

        if exited_at.is_none() {
            match control.has_exited(identity, child) {
                Ok(true) => exited_at = Some(Instant::now()),
                Ok(false) => {}
                Err(_) => {
                    stop_and_reap(control, ownership, identity, child);
                    return Err(CommandError::new("desktop.command_status_failed"));
                }
            }
        }
        if let Some(exited_at) = exited_at {
            // Give normal readers a short bounded chance to flush. Do not wait indefinitely for
            // inherited pipe handles held by descendants.
            if ended >= 2 {
                ownership.release();
                let status = child
                    .wait()
                    .map_err(|_| CommandError::new("desktop.command_status_failed"))?;
                return if status.success() {
                    Ok(CommandOutput { stdout, stderr })
                } else {
                    stop_and_reap(control, ownership, identity, child);
                    Err(CommandError::new("desktop.command_exit_failed"))
                };
            }
            if exited_at.elapsed() >= OUTPUT_SETTLE_TIMEOUT {
                // A descendant may still own the inherited pipes after the direct child exits.
                // Stop the prepared group before reporting the malformed command lifecycle.
                stop_and_reap(control, ownership, identity, child);
                return Err(CommandError::new("desktop.command_output_failed"));
            }
        }
        if Instant::now() >= deadline {
            stop_and_reap(control, ownership, identity, child);
            return Err(CommandError::new("desktop.command_timeout"));
        }
    }
}

fn append_bounded(target: &mut Vec<u8>, bytes: Vec<u8>, limit: usize) -> Result<(), CommandError> {
    if bytes.len() > limit.saturating_sub(target.len()) {
        return Err(CommandError::new("desktop.command_output_limit"));
    }
    target.extend_from_slice(&bytes);
    Ok(())
}

fn drain_stream<R: Read + Send + 'static>(
    mut reader: R,
    stream: Stream,
    sender: SyncSender<OutputEvent>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut buffer = [0_u8; READ_CHUNK_BYTES];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => {
                    let _ = sender.send(OutputEvent::Ended);
                    return;
                }
                Ok(count) => {
                    if sender
                        .send(OutputEvent::Bytes(stream, buffer[..count].to_vec()))
                        .is_err()
                    {
                        return;
                    }
                }
                Err(_) => {
                    let _ = sender.send(OutputEvent::Failed);
                    return;
                }
            }
        }
    })
}

fn stop_and_reap(
    control: &Arc<dyn ProcessGroupControl>,
    ownership: &AttachedCommandOwnership<'_>,
    identity: ChildIdentity,
    child: &mut Child,
) {
    if control.force_stop(identity, child).is_err() {
        ownership.release();
        kill_direct_child(child);
        return;
    }
    let until = Instant::now() + Duration::from_secs(2);
    while Instant::now() < until {
        if matches!(control.has_exited(identity, child), Ok(true)) {
            ownership.release();
            let _ = child.wait();
            return;
        }
        thread::sleep(POLL_INTERVAL);
    }
    ownership.release();
    kill_direct_child(child);
}

fn stop_unattached(
    control: &Arc<dyn ProcessGroupControl>,
    identity: ChildIdentity,
    child: &mut Child,
) {
    let _ = control.force_stop(identity, child);
    kill_direct_child(child);
}

fn kill_direct_child(child: &mut Child) {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return;
    }
    if child.kill().is_ok() {
        let _ = child.wait();
    } else {
        let _ = child.try_wait();
    }
}

fn map_process_error(_error: ProcessError) -> CommandError {
    CommandError::new("desktop.command_group_failed")
}

fn map_guardian_start_error(error: ProcessError) -> CommandError {
    match error.code() {
        "desktop.process_cancelled" => CommandError::new("desktop.command_cancelled"),
        "desktop.process_start_timeout" => CommandError::new("desktop.command_timeout"),
        _ => CommandError::new("desktop.command_group_failed"),
    }
}

#[cfg(test)]
mod tests {
    use std::{
        env, fs,
        process::Command,
        sync::{
            Arc, Mutex,
            atomic::{AtomicBool, Ordering},
        },
    };

    use super::*;

    const MODE: &str = "SCHEDULE_COMMAND_TEST_MODE";
    const VALUE: &str = "SCHEDULE_COMMAND_VALUE";
    const ACK_DELAY_MS: &str = "SCHEDULE_GUARDIAN_TEST_ACK_DELAY_MS";

    #[derive(Default)]
    struct RecordingControl {
        fail_attach: bool,
        stops: Mutex<usize>,
        releases: Mutex<usize>,
    }

    impl ProcessGroupControl for RecordingControl {
        fn attach(
            &self,
            _identity: ChildIdentity,
            _child: &mut Child,
            _channel: Arc<GuardianChannel>,
        ) -> Result<(), ProcessError> {
            if self.fail_attach {
                Err(ProcessError::new("test.group_attach_failed"))
            } else {
                Ok(())
            }
        }

        fn force_stop(
            &self,
            _identity: ChildIdentity,
            child: &mut Child,
        ) -> Result<(), ProcessError> {
            *self.stops.lock().unwrap() += 1;
            let _ = child.kill();
            Ok(())
        }

        fn release(&self, _identity: ChildIdentity) {
            *self.releases.lock().unwrap() += 1;
        }
    }

    fn helper(mode: &str, timeout: Duration) -> CommandSpec {
        CommandSpec::new(
            env::current_exe().unwrap(),
            env::current_dir().unwrap(),
            timeout,
        )
        .arg("runtime::command::tests::command_subprocess_helper")
        .arg("--exact")
        .arg("--nocapture")
        .env(MODE, mode)
    }

    #[test]
    fn database_payload_restriction_requires_explicit_opt_in() {
        assert!(
            !helper("success", Duration::from_secs(1))
                .launch_spec()
                .is_database_payload()
        );
        assert!(
            helper("success", Duration::from_secs(1))
                .database_payload()
                .launch_spec()
                .is_database_payload()
        );
    }

    #[test]
    fn command_subprocess_helper() {
        match env::var(MODE).as_deref() {
            Ok("success") => {
                print!(
                    "{}:{}",
                    env::var(VALUE).unwrap_or_default(),
                    env::var_os("PATH").is_none()
                );
                eprint!("stderr");
            }
            Ok("failure") => std::process::exit(7),
            Ok("sleep") => thread::sleep(Duration::from_secs(2)),
            Ok("delayed_success") => {
                thread::sleep(Duration::from_millis(100));
                print!("done");
            }
            Ok("delayed_marker") => {
                thread::sleep(Duration::from_millis(350));
                fs::write(env::var_os(VALUE).unwrap(), b"alive").unwrap();
            }
            Ok("pipe_descendant") => {
                Command::new(env::current_exe().unwrap())
                    .arg("runtime::command::tests::command_subprocess_helper")
                    .arg("--exact")
                    .arg("--nocapture")
                    .env_clear()
                    .env(MODE, "pipe_descendant_child")
                    .spawn()
                    .unwrap();
            }
            Ok("pipe_descendant_child") => thread::sleep(Duration::from_millis(600)),
            Ok("large") => print!("{}", "x".repeat(2048)),
            Ok("pipe_burst") => print!("{}", "z".repeat(256 * 1024)),
            _ => {}
        }
    }

    #[test]
    fn captures_success_and_clears_inherited_environment() {
        let control = Arc::new(RecordingControl::default());
        let output = run_command(
            helper("success", Duration::from_secs(2)).env(VALUE, "approved"),
            control.clone(),
        )
        .unwrap();
        assert!(
            output
                .stdout()
                .windows(b"approved:true".len())
                .any(|window| window == b"approved:true")
        );
        assert!(
            output
                .stderr()
                .windows(b"stderr".len())
                .any(|window| window == b"stderr")
        );
        assert_eq!(*control.stops.lock().unwrap(), 0);
        assert_eq!(*control.releases.lock().unwrap(), 1);
    }

    #[test]
    fn does_not_release_platform_ownership_when_attach_fails() {
        let control = Arc::new(RecordingControl {
            fail_attach: true,
            ..Default::default()
        });
        let error = match run_command(helper("sleep", Duration::from_secs(2)), control.clone()) {
            Ok(_) => panic!("unattached helper unexpectedly succeeded"),
            Err(error) => error,
        };

        assert_eq!(error.code(), "desktop.command_group_failed");
        assert_eq!(*control.stops.lock().unwrap(), 1);
        assert_eq!(*control.releases.lock().unwrap(), 0);
    }

    #[test]
    fn returns_stable_error_for_nonzero_exit() {
        let control = Arc::new(RecordingControl::default());
        let error = match run_command(helper("failure", Duration::from_secs(2)), control.clone()) {
            Ok(_) => panic!("nonzero helper unexpectedly succeeded"),
            Err(error) => error,
        };
        assert_eq!(error.code(), "desktop.command_exit_failed");
        assert_eq!(*control.stops.lock().unwrap(), 1);
        assert_eq!(*control.releases.lock().unwrap(), 1);
    }

    #[test]
    fn times_out_and_uses_the_injected_group_controller() {
        let control = Arc::new(RecordingControl::default());
        let error = match run_command(helper("sleep", Duration::from_millis(25)), control.clone()) {
            Ok(_) => panic!("sleeping helper unexpectedly succeeded"),
            Err(error) => error,
        };
        assert_eq!(error.code(), "desktop.command_timeout");
        assert_eq!(*control.stops.lock().unwrap(), 1);
        assert_eq!(*control.releases.lock().unwrap(), 1);
    }

    #[test]
    fn command_timeout_is_shared_by_guardian_ack_and_payload() {
        let control = Arc::new(RecordingControl::default());
        let error = run_command(
            helper("delayed_success", Duration::from_millis(150)).env(ACK_DELAY_MS, "100"),
            control.clone(),
        )
        .err()
        .expect("combined admission and payload execution exceeded the command timeout");

        assert_eq!(error.code(), "desktop.command_timeout");
        assert_eq!(*control.stops.lock().unwrap(), 1);
        assert_eq!(*control.releases.lock().unwrap(), 1);
    }

    #[test]
    fn cancellation_stops_and_reaps_a_running_command() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let setter = Arc::clone(&cancelled);
        let thread = thread::spawn(move || {
            thread::sleep(Duration::from_millis(30));
            setter.store(true, Ordering::Release);
        });
        let control = Arc::new(RecordingControl::default());
        let error = run_command_cancellable(
            helper("sleep", Duration::from_secs(2)),
            control.clone(),
            &|| cancelled.load(Ordering::Acquire),
        )
        .err()
        .unwrap();
        thread.join().unwrap();
        assert_eq!(error.code(), "desktop.command_cancelled");
        assert_eq!(*control.stops.lock().unwrap(), 1);
        assert_eq!(*control.releases.lock().unwrap(), 1);
    }

    #[test]
    fn falls_back_to_the_owned_child_when_group_termination_fails() {
        #[derive(Default)]
        struct FailingControl {
            stops: Mutex<usize>,
            releases: Mutex<usize>,
        }
        impl ProcessGroupControl for FailingControl {
            fn force_stop(
                &self,
                _identity: ChildIdentity,
                _child: &mut Child,
            ) -> Result<(), ProcessError> {
                *self.stops.lock().unwrap() += 1;
                Err(ProcessError::new("test.group_stop_failed"))
            }

            fn release(&self, _identity: ChildIdentity) {
                *self.releases.lock().unwrap() += 1;
            }
        }

        let marker = env::temp_dir().join(format!(
            "schedule-command-fallback-{}-{}.marker",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        ));
        let _ = fs::remove_file(&marker);
        let control = Arc::new(FailingControl::default());
        let error = match run_command(
            helper("delayed_marker", Duration::from_millis(25)).env(VALUE, marker.as_os_str()),
            control.clone(),
        ) {
            Ok(_) => panic!("delayed helper unexpectedly succeeded"),
            Err(error) => error,
        };
        thread::sleep(Duration::from_millis(500));

        assert_eq!(error.code(), "desktop.command_timeout");
        assert_eq!(*control.stops.lock().unwrap(), 1);
        assert_eq!(*control.releases.lock().unwrap(), 1);
        assert!(!marker.exists());
    }

    #[test]
    fn guardian_closes_descendant_output_pipes_before_reporting_success() {
        let control = Arc::new(RecordingControl::default());
        let _output = run_command(
            helper("pipe_descendant", Duration::from_secs(2)),
            control.clone(),
        )
        .unwrap();

        assert_eq!(*control.stops.lock().unwrap(), 0);
        assert_eq!(*control.releases.lock().unwrap(), 1);
    }

    #[test]
    fn drains_payload_output_beyond_pipe_capacity_from_commit() {
        let control = Arc::new(RecordingControl::default());
        let output = run_command(
            helper("pipe_burst", Duration::from_secs(2)).output_bounds(512 * 1024, 64 * 1024),
            control.clone(),
        )
        .unwrap();

        assert!(output.stdout().len() >= 256 * 1024);
        assert_eq!(*control.stops.lock().unwrap(), 0);
        assert_eq!(*control.releases.lock().unwrap(), 1);
    }

    #[test]
    fn rejects_oversized_output_without_retaining_it() {
        let error = match run_command(
            helper("large", Duration::from_secs(2)).output_bounds(128, 128),
            Arc::new(super::super::process::DirectChildControl),
        ) {
            Ok(_) => panic!("large helper unexpectedly succeeded"),
            Err(error) => error,
        };
        assert_eq!(error.code(), "desktop.command_output_limit");
    }
}
