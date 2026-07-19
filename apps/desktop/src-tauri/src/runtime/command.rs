//! Bounded, shell-free helpers for one-shot bundled-runtime commands.
//!
//! This module deliberately does not expose command lines or captured output through error
//! formatting: PostgreSQL connection settings and migration diagnostics can contain credentials.

use std::{
    ffi::OsString,
    fmt,
    io::Read,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        mpsc::{self, Receiver, SyncSender},
    },
    thread,
    time::{Duration, Instant},
};

use super::process::{ChildIdentity, ProcessError, ProcessGroupControl, ProcessRole};

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

/// Run a bounded initdb/psql/pg_dump/pg_restore/migration helper. A controller is injected so a
/// platform process group or Job Object can stop descendants on timeout, nonzero exit, or output
/// overflow. The direct child is always reaped; reader threads are only joined if already done,
/// because a descendant may retain an inherited output pipe after its parent exits.
pub(crate) fn run_command(
    spec: CommandSpec,
    control: Arc<dyn ProcessGroupControl>,
) -> Result<CommandOutput, CommandError> {
    spec.validate()?;
    let mut command = spec.command();
    control
        .configure_command(ProcessRole::Database, &mut command)
        .map_err(map_process_error)?;
    let mut child = command
        .spawn()
        .map_err(|_| CommandError::new("desktop.command_spawn_failed"))?;
    let identity = ChildIdentity {
        role: ProcessRole::Database,
        pid: child.id(),
    };
    if control.attach(identity, &mut child).is_err() {
        stop_and_reap(&control, identity, &mut child);
        return Err(CommandError::new("desktop.command_group_failed"));
    }

    let Some(stdout) = child.stdout.take() else {
        stop_and_reap(&control, identity, &mut child);
        return Err(CommandError::new("desktop.command_output_failed"));
    };
    let Some(stderr) = child.stderr.take() else {
        stop_and_reap(&control, identity, &mut child);
        return Err(CommandError::new("desktop.command_output_failed"));
    };
    let (sender, receiver) = mpsc::sync_channel(16);
    let readers = [
        drain_stream(stdout, Stream::Stdout, sender.clone()),
        drain_stream(stderr, Stream::Stderr, sender),
    ];

    let result = collect_output(
        &mut child,
        identity,
        &control,
        receiver,
        spec.timeout,
        spec.max_stdout_bytes,
        spec.max_stderr_bytes,
    );
    // Never block on a reader: a descendant can keep a pipe handle open after the child exits.
    for reader in readers {
        if reader.is_finished() {
            let _ = reader.join();
        }
    }
    result
}

fn collect_output(
    child: &mut Child,
    identity: ChildIdentity,
    control: &Arc<dyn ProcessGroupControl>,
    receiver: Receiver<OutputEvent>,
    timeout: Duration,
    stdout_limit: usize,
    stderr_limit: usize,
) -> Result<CommandOutput, CommandError> {
    let deadline = Instant::now() + timeout;
    let mut stdout = Vec::with_capacity(stdout_limit.min(READ_CHUNK_BYTES));
    let mut stderr = Vec::with_capacity(stderr_limit.min(READ_CHUNK_BYTES));
    let mut ended = 0;
    let mut exit = None;
    let mut exited_at = None;

    loop {
        match receiver.recv_timeout(POLL_INTERVAL) {
            Ok(OutputEvent::Bytes(Stream::Stdout, bytes)) => {
                if let Err(error) = append_bounded(&mut stdout, bytes, stdout_limit) {
                    stop_and_reap(control, identity, child);
                    return Err(error);
                }
            }
            Ok(OutputEvent::Bytes(Stream::Stderr, bytes)) => {
                if let Err(error) = append_bounded(&mut stderr, bytes, stderr_limit) {
                    stop_and_reap(control, identity, child);
                    return Err(error);
                }
            }
            Ok(OutputEvent::Ended) => ended += 1,
            Ok(OutputEvent::Failed) => {
                stop_and_reap(control, identity, child);
                return Err(CommandError::new("desktop.command_output_failed"));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }

        if exit.is_none() {
            exit = match child.try_wait() {
                Ok(status) => status,
                Err(_) => {
                    stop_and_reap(control, identity, child);
                    return Err(CommandError::new("desktop.command_status_failed"));
                }
            };
            if exit.is_some() {
                exited_at = Some(Instant::now());
            }
        }
        if let Some(status) = exit {
            // Give normal readers a short bounded chance to flush. Do not wait indefinitely for
            // inherited pipe handles held by descendants.
            if ended >= 2 {
                return if status.success() {
                    Ok(CommandOutput { stdout, stderr })
                } else {
                    stop_and_reap(control, identity, child);
                    Err(CommandError::new("desktop.command_exit_failed"))
                };
            }
            if exited_at.is_some_and(|at| at.elapsed() >= OUTPUT_SETTLE_TIMEOUT) {
                return Err(CommandError::new("desktop.command_output_failed"));
            }
        }
        if Instant::now() >= deadline {
            stop_and_reap(control, identity, child);
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
    identity: ChildIdentity,
    child: &mut Child,
) {
    let _ = control.force_stop(identity, child);
    let until = Instant::now() + Duration::from_secs(2);
    while Instant::now() < until {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        thread::sleep(POLL_INTERVAL);
    }
}

fn map_process_error(_error: ProcessError) -> CommandError {
    CommandError::new("desktop.command_group_failed")
}

#[cfg(test)]
mod tests {
    use std::{env, sync::Mutex};

    use super::*;

    const MODE: &str = "SCHEDULE_COMMAND_TEST_MODE";
    const VALUE: &str = "SCHEDULE_COMMAND_VALUE";

    fn helper(mode: &str, timeout: Duration) -> CommandSpec {
        CommandSpec::new(
            env::current_exe().unwrap(),
            env::current_dir().unwrap(),
            timeout,
        )
        .arg("command_subprocess_helper")
        .arg("--nocapture")
        .env(MODE, mode)
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
            Ok("large") => print!("{}", "x".repeat(2048)),
            _ => {}
        }
    }

    #[test]
    fn captures_success_and_clears_inherited_environment() {
        let output = run_command(
            helper("success", Duration::from_secs(2)).env(VALUE, "approved"),
            Arc::new(super::super::process::DirectChildControl),
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
    }

    #[test]
    fn returns_stable_error_for_nonzero_exit() {
        let error = match run_command(
            helper("failure", Duration::from_secs(2)),
            Arc::new(super::super::process::DirectChildControl),
        ) {
            Ok(_) => panic!("nonzero helper unexpectedly succeeded"),
            Err(error) => error,
        };
        assert_eq!(error.code(), "desktop.command_exit_failed");
    }

    #[test]
    fn times_out_and_uses_the_injected_group_controller() {
        #[derive(Default)]
        struct RecordingControl(Mutex<usize>);
        impl ProcessGroupControl for RecordingControl {
            fn force_stop(
                &self,
                _identity: ChildIdentity,
                child: &mut Child,
            ) -> Result<(), ProcessError> {
                *self.0.lock().unwrap() += 1;
                let _ = child.kill();
                Ok(())
            }
        }
        let control = Arc::new(RecordingControl::default());
        let error = match run_command(helper("sleep", Duration::from_millis(25)), control.clone()) {
            Ok(_) => panic!("sleeping helper unexpectedly succeeded"),
            Err(error) => error,
        };
        assert_eq!(error.code(), "desktop.command_timeout");
        assert_eq!(*control.0.lock().unwrap(), 1);
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
