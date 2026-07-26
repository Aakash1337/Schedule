mod bootstrap;
mod bundle;
mod command;
mod coordinator;
mod credentials;
mod executor;
pub(crate) mod guardian;
mod host;
mod integrity;
mod journal;
mod lock;
mod manifest;
mod paths;
mod portable;
pub(crate) use portable::{PortableExportResult, PortableImportResult, PortableImportSelectResult};
mod postgres;
mod process;
mod recovery;
pub(crate) mod smoke;
mod state;
pub(crate) mod tauri_adapter;

fn safe_pg_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 63
        && !value.as_bytes()[0].is_ascii_digit()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}
