//! Pure PostgreSQL 17 configuration, command planning, and readiness parsing.
//!
//! The supervisor supplies the filesystem locations and executes these plans.  Keeping this
//! module side-effect free makes it impossible for a password to accidentally become a process
//! argument while still allowing the lifecycle layer to test every startup/recovery decision.

use std::{
    collections::BTreeMap,
    fmt,
    path::{Path, PathBuf},
};

use super::safe_pg_identifier;

pub(crate) const POSTGRESQL_MAJOR: u16 = 17;
const IDENTITY_COLUMNS: usize = 5;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PgCommand {
    pub(crate) program: PathBuf,
    pub(crate) arguments: Vec<String>,
    pub(crate) environment: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PgConnection {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) database: String,
    pub(crate) user: String,
    /// A private, mode-0600 libpq pgpass file. Never pass a password in `arguments`.
    pub(crate) pgpass_file: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PgIdentity {
    pub(crate) server_version_num: u32,
    pub(crate) data_directory: PathBuf,
    pub(crate) recovery: bool,
    pub(crate) current_user: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PgError(&'static str);

impl fmt::Display for PgError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.0)
    }
}

impl std::error::Error for PgError {}

impl PgConnection {
    pub(crate) fn new(
        port: u16,
        database: impl Into<String>,
        user: impl Into<String>,
        pgpass_file: impl Into<PathBuf>,
    ) -> Result<Self, PgError> {
        let database = database.into();
        let user = user.into();
        if port == 0 || !safe_pg_identifier(&database) || !safe_pg_identifier(&user) {
            return Err(PgError("invalid PostgreSQL connection settings"));
        }
        let pgpass_file = pgpass_file.into();
        if pgpass_file.as_os_str().is_empty() {
            return Err(PgError("PostgreSQL pgpass file is required"));
        }
        Ok(Self {
            host: "127.0.0.1".to_owned(),
            port,
            database,
            user,
            pgpass_file,
        })
    }

    fn environment(&self) -> BTreeMap<String, String> {
        BTreeMap::from([
            ("PGHOST".to_owned(), self.host.clone()),
            ("PGPORT".to_owned(), self.port.to_string()),
            ("PGDATABASE".to_owned(), self.database.clone()),
            ("PGUSER".to_owned(), self.user.clone()),
            (
                "PGPASSFILE".to_owned(),
                self.pgpass_file.to_string_lossy().into_owned(),
            ),
            ("PGCONNECT_TIMEOUT".to_owned(), "5".to_owned()),
        ])
    }
}

pub(crate) fn validate_pg_version(contents: &str) -> Result<(), PgError> {
    (contents == "17\n" || contents == "17\r\n")
        .then_some(())
        .ok_or(PgError("PostgreSQL data directory major is not 17"))
}

/// Configures TCP loopback only and uses SCRAM for both local TCP and Unix-socket attempts.
pub(crate) fn postgresql_conf(port: u16, log_file: &Path) -> Result<String, PgError> {
    if port == 0 || log_file.as_os_str().is_empty() || contains_line_break(log_file) {
        return Err(PgError("invalid PostgreSQL server settings"));
    }
    Ok(format!(
        "listen_addresses = '127.0.0.1'\nport = {port}\npassword_encryption = 'scram-sha-256'\nunix_socket_directories = ''\nlogging_collector = on\nlog_destination = 'stderr'\nlog_directory = '{}'\nlog_filename = 'postgresql.log'\n",
        quote_conf_path(log_file)
    ))
}

pub(crate) fn pg_hba_conf(
    cluster_admin: &str,
    owner: &str,
    runtime: &str,
    database: &str,
) -> Result<String, PgError> {
    if !safe_pg_identifier(cluster_admin)
        || !safe_pg_identifier(owner)
        || !safe_pg_identifier(runtime)
        || !safe_pg_identifier(database)
    {
        return Err(PgError("invalid PostgreSQL access rule"));
    }
    Ok(format!(
        "# Managed by Schedule. Do not add network rules.\nlocal all all reject\nhost all {cluster_admin} 127.0.0.1/32 scram-sha-256\nhost {database} {owner} 127.0.0.1/32 scram-sha-256\nhost {database} {runtime} 127.0.0.1/32 scram-sha-256\nhost all all ::1/128 reject\nhost all all 0.0.0.0/0 reject\nhost all all ::0/0 reject\n"
    ))
}

pub(crate) fn initdb_plan(
    bin: &Path,
    data: &Path,
    connection: &PgConnection,
    initial_password_file: &Path,
) -> PgCommand {
    command(
        bin.join(executable("initdb")),
        [
            "--pgdata".into(),
            display(data),
            "--encoding".into(),
            "UTF8".into(),
            "--locale".into(),
            "C".into(),
            "--auth-host".into(),
            "scram-sha-256".into(),
            "--auth-local".into(),
            "reject".into(),
            "--username".into(),
            connection.user.clone(),
            "--pwfile".into(),
            display(initial_password_file),
        ],
        BTreeMap::new(),
    )
}

/// Run a private bootstrap SQL file against initdb's built-in `postgres` database.
/// The file creates the owner/runtime roles and the Schedule database, then is removed.
pub(crate) fn bootstrap_plan(
    bin: &Path,
    admin_connection: &PgConnection,
    bootstrap_sql_file: &Path,
) -> PgCommand {
    command(
        bin.join(executable("psql")),
        [
            "--no-psqlrc".into(),
            "--set".into(),
            "ON_ERROR_STOP=1".into(),
            "--file".into(),
            display(bootstrap_sql_file),
        ],
        admin_connection.environment(),
    )
}

pub(crate) fn start_plan(bin: &Path, data: &Path, connection: &PgConnection) -> PgCommand {
    let hba_file = data.join("pg_hba.conf");
    command(
        // Run the server directly so the desktop retains the real database
        // process handle. `pg_ctl start` daemonizes and would orphan ownership.
        bin.join(executable("postgres")),
        [
            "-D".into(),
            display(data),
            "-h".into(),
            "127.0.0.1".into(),
            "-p".into(),
            connection.port.to_string(),
            "-c".into(),
            format!("hba_file={}", display(&hba_file)),
            "-c".into(),
            "unix_socket_directories=".into(),
        ],
        BTreeMap::new(),
    )
}

pub(crate) fn readiness_plan(bin: &Path, connection: &PgConnection) -> PgCommand {
    command(
        bin.join(executable("pg_isready")),
        [
            "--host".into(),
            connection.host.clone(),
            "--port".into(),
            connection.port.to_string(),
            "--dbname".into(),
            connection.database.clone(),
            "--username".into(),
            connection.user.clone(),
            "--timeout".into(),
            "5".into(),
        ],
        connection.environment(),
    )
}

pub(crate) fn identity_plan(bin: &Path, connection: &PgConnection) -> PgCommand {
    command(bin.join(executable("psql")), ["--no-psqlrc".into(), "--tuples-only".into(), "--no-align".into(), "--field-separator".into(), "\t".into(), "--set".into(), "ON_ERROR_STOP=1".into(), "--command".into(), "SELECT current_setting('server_version_num'), current_setting('data_directory'), pg_is_in_recovery(), current_user, current_database()".into()], connection.environment())
}

pub(crate) fn backup_plan(bin: &Path, output: &Path, connection: &PgConnection) -> PgCommand {
    command(
        bin.join(executable("pg_dump")),
        [
            "--format".into(),
            "custom".into(),
            "--file".into(),
            display(output),
            "--no-owner".into(),
            "--no-privileges".into(),
        ],
        connection.environment(),
    )
}

pub(crate) fn restore_verify_plan(bin: &Path, backup: &Path) -> PgCommand {
    command(
        bin.join(executable("pg_restore")),
        ["--list".into(), display(backup)],
        BTreeMap::new(),
    )
}

pub(crate) fn fast_stop_plan(bin: &Path, data: &Path) -> PgCommand {
    command(
        bin.join(executable("pg_ctl")),
        [
            "stop".into(),
            "--wait".into(),
            "--timeout".into(),
            "30".into(),
            "--mode".into(),
            "fast".into(),
            "--pgdata".into(),
            display(data),
        ],
        BTreeMap::new(),
    )
}

pub(crate) fn parse_identity(
    output: &str,
    expected_data_directory: &Path,
    connection: &PgConnection,
) -> Result<PgIdentity, PgError> {
    let line = output.trim_end_matches(['\r', '\n']);
    let columns: Vec<_> = line.split('\t').collect();
    if columns.len() != IDENTITY_COLUMNS || columns.iter().any(|column| column.is_empty()) {
        return Err(PgError("PostgreSQL identity output is malformed"));
    }
    let server_version_num = columns[0]
        .parse::<u32>()
        .map_err(|_| PgError("PostgreSQL identity output is malformed"))?;
    if !(170_000..180_000).contains(&server_version_num) {
        return Err(PgError("PostgreSQL server major is not 17"));
    }
    let data_directory = PathBuf::from(columns[1]);
    if data_directory != expected_data_directory {
        return Err(PgError("PostgreSQL data directory does not match"));
    }
    let recovery = match columns[2] {
        "t" => true,
        "f" => false,
        _ => return Err(PgError("PostgreSQL recovery state is malformed")),
    };
    if recovery {
        return Err(PgError("PostgreSQL server is in recovery"));
    }
    if columns[3] != connection.user || columns[4] != connection.database {
        return Err(PgError("PostgreSQL authenticated identity does not match"));
    }
    Ok(PgIdentity {
        server_version_num,
        data_directory,
        recovery,
        current_user: columns[3].to_owned(),
    })
}

fn command(
    program: PathBuf,
    arguments: impl IntoIterator<Item = String>,
    environment: BTreeMap<String, String>,
) -> PgCommand {
    PgCommand {
        program,
        arguments: arguments.into_iter().collect(),
        environment,
    }
}

fn executable(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    }
}
fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
fn contains_line_break(path: &Path) -> bool {
    path.to_string_lossy().contains(['\r', '\n'])
}
fn quote_conf_path(path: &Path) -> String {
    display(path).replace('\\', "\\\\").replace('\'', "''")
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn connection() -> PgConnection {
        PgConnection::new(54_321, "schedule", "schedule_app", "private/pgpass").unwrap()
    }

    #[test]
    fn accepts_only_major_17_data_directories() {
        assert!(validate_pg_version("17\n").is_ok());
        for version in ["16\n", "17.4\n", "17\nextra", "17"] {
            assert!(validate_pg_version(version).is_err(), "{version:?}");
        }
    }

    #[test]
    fn generates_loopback_scram_configuration_without_trust() {
        let conf = postgresql_conf(54_321, Path::new("logs")).unwrap();
        let hba = pg_hba_conf(
            "schedule_cluster_admin",
            "schedule_owner",
            "schedule_runtime",
            "schedule",
        )
        .unwrap();
        assert!(conf.contains("listen_addresses = '127.0.0.1'"));
        assert!(conf.contains("password_encryption = 'scram-sha-256'"));
        for role in [
            "schedule_cluster_admin",
            "schedule_owner",
            "schedule_runtime",
        ] {
            assert!(hba.contains(role));
        }
        assert!(hba.contains("local all all reject"));
        assert!(hba.contains("host all schedule_cluster_admin 127.0.0.1/32 scram-sha-256"));
        assert!(!hba.contains("host postgres schedule_cluster_admin"));
        assert!(!hba.contains(" trust"));
        assert!(PgConnection::new(54_321, "Schedule", "schedule_app", "private/pgpass").is_err());
        assert!(pg_hba_conf("Admin", "owner", "runtime", "schedule").is_err());
    }

    #[test]
    fn plans_keep_secrets_out_of_arguments() {
        let connection = connection();
        let plans = [
            initdb_plan(
                Path::new("bin"),
                Path::new("data"),
                &connection,
                Path::new("private/init-password"),
            ),
            start_plan(Path::new("bin"), Path::new("data"), &connection),
            readiness_plan(Path::new("bin"), &connection),
            identity_plan(Path::new("bin"), &connection),
            backup_plan(Path::new("bin"), Path::new("backup.dump"), &connection),
        ];
        for plan in &plans {
            assert!(!plan.arguments.iter().any(|arg| arg.contains("secret")));
        }
        assert_eq!(
            plans[2].environment.get("PGPASSFILE"),
            Some(&"private/pgpass".to_owned())
        );
        assert!(
            plans[0]
                .arguments
                .windows(2)
                .any(|args| args == ["--pwfile", "private/init-password"])
        );
        assert!(plans[1].program.ends_with(executable("postgres")));
        assert!(plans[1].environment.is_empty());
        assert!(plans[1].arguments.windows(2).any(|args| {
            args[0] == "-c"
                && args[1].starts_with("hba_file=")
                && Path::new(args[1].trim_start_matches("hba_file="))
                    == Path::new("data/pg_hba.conf")
        }));
        assert!(
            plans[1]
                .arguments
                .windows(2)
                .any(|args| args == ["-c", "unix_socket_directories="])
        );

        let admin = PgConnection::new(
            54_321,
            "postgres",
            "schedule_cluster_admin",
            "private/admin.pgpass",
        )
        .unwrap();
        let bootstrap =
            bootstrap_plan(Path::new("bin"), &admin, Path::new("private/bootstrap.sql"));
        assert_eq!(
            bootstrap.environment.get("PGPASSFILE"),
            Some(&"private/admin.pgpass".to_owned())
        );
        assert!(
            bootstrap
                .arguments
                .windows(2)
                .any(|args| args == ["--file", "private/bootstrap.sql"])
        );
    }

    #[test]
    fn parses_only_expected_primary_identity() {
        let connection = connection();
        let identity = parse_identity(
            "170004\tdata\tf\tschedule_app\tschedule\n",
            Path::new("data"),
            &connection,
        )
        .unwrap();
        assert_eq!(identity.server_version_num, 170004);
        for bad in [
            "160001\tdata\tf\tschedule_app\tschedule",
            "170001\tother\tf\tschedule_app\tschedule",
            "170001\tdata\tt\tschedule_app\tschedule",
            "170001\tdata\tf\tother\tschedule",
            "170001 data f schedule_app schedule",
        ] {
            assert!(parse_identity(bad, Path::new("data"), &connection).is_err());
        }
    }

    #[test]
    fn uses_fast_bounded_shutdown_and_validates_backup_before_restore() {
        let stop = fast_stop_plan(Path::new("bin"), Path::new("data"));
        assert!(
            stop.arguments
                .windows(2)
                .any(|args| args == ["--mode", "fast"])
        );
        assert!(
            stop.arguments
                .windows(2)
                .any(|args| args == ["--timeout", "30"])
        );
        assert_eq!(
            restore_verify_plan(Path::new("bin"), Path::new("backup.dump")).arguments,
            vec!["--list", "backup.dump"]
        );
    }
}
