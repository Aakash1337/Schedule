mod command;
mod coordinator;
mod credentials;
mod integrity;
mod journal;
mod lock;
mod manifest;
mod paths;
mod postgres;
mod process;
mod state;

fn safe_pg_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 63
        && !value.as_bytes()[0].is_ascii_digit()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}
