use std::{
    fs,
    path::{Component, Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use super::integrity::is_link_or_reparse;

pub(crate) const PORTABLE_EXPORT_PREFIX: &str = "SCHEDULE_PORTABLE_EXPORT_V1 ";
pub(crate) const PORTABLE_INSPECT_PREFIX: &str = "SCHEDULE_PORTABLE_INSPECT_V1 ";
pub(crate) const PORTABLE_IMPORT_PREFIX: &str = "SCHEDULE_PORTABLE_IMPORT_V1 ";
pub(crate) const PORTABLE_RECOVERY_PREFIX: &str = "SCHEDULE_PORTABLE_RECOVERY_V1 ";

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub(crate) enum PortableExportResult {
    Created {
        #[serde(rename = "sizeBytes")]
        size_bytes: u64,
    },
    Cancelled,
    Busy,
    Unavailable,
    Failed {
        code: &'static str,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PortableImportPreview {
    pub(crate) archive_id: String,
    #[serde(skip_serializing)]
    pub(crate) archive_sha256: String,
    pub(crate) exported_at: String,
    pub(crate) application_version: String,
    pub(crate) schema_version: u64,
    pub(crate) size_bytes: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PortableImportRequest {
    pub(crate) source: PathBuf,
    pub(crate) expected_archive_id: String,
    pub(crate) expected_archive_sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum PortableImportInspectResult {
    Inspected(PortableImportPreview),
    Unavailable,
    Failed { code: &'static str },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub(crate) enum PortableImportSelectResult {
    Selected {
        token: String,
        preview: PortableImportPreview,
    },
    Cancelled,
    Busy,
    Unavailable,
    Failed {
        code: &'static str,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub(crate) enum PortableImportResult {
    Imported,
    ImportedRestartRequired,
    RecoveryRequired,
    Cancelled,
    Busy,
    Unavailable,
    Failed { code: &'static str },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PortablePayload {
    size_bytes: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PortableInspectionPayload {
    archive_id: String,
    archive_sha256: String,
    exported_at: String,
    application_version: String,
    schema_version: u64,
    size_bytes: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PortableImportPayload {
    previous_retained: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct PortableRecoveryOutcome {
    pub(crate) recovered: bool,
    pub(crate) committed: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PortableRecoveryPayload {
    recovered: bool,
    committed: bool,
}
const MAX_PORTABLE_EXPORT_BYTES: u64 = 513 * 1024 * 1024;
const MAX_PORTABLE_PROTOCOL_BYTES: usize = 4096;

pub(crate) fn validate_destination(path: &Path) -> Result<PathBuf, &'static str> {
    if !path.is_absolute() || path.to_str().is_none() {
        return Err("desktop.portable_export_destination_invalid");
    }
    match fs::symlink_metadata(path) {
        Ok(_) => return Err("desktop.portable_export_destination_exists"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("desktop.portable_export_destination_invalid"),
    }
    if path.extension().and_then(|value| value.to_str()) != Some("schedule") {
        return Err("desktop.portable_export_destination_invalid");
    }
    let parent = path
        .parent()
        .ok_or("desktop.portable_export_destination_invalid")?;
    let mut current = PathBuf::new();
    for component in parent.components() {
        match component {
            Component::Prefix(value) => current.push(value.as_os_str()),
            Component::RootDir => current.push(component.as_os_str()),
            Component::Normal(value) => {
                current.push(value);
                let metadata = fs::symlink_metadata(&current)
                    .map_err(|_| "desktop.portable_export_destination_invalid")?;
                if is_link_or_reparse(&metadata) || !metadata.is_dir() {
                    return Err("desktop.portable_export_destination_invalid");
                }
            }
            _ => return Err("desktop.portable_export_destination_invalid"),
        }
    }
    let canonical =
        dunce::canonicalize(parent).map_err(|_| "desktop.portable_export_destination_invalid")?;
    if !canonical.is_absolute() || canonical.to_str().is_none() {
        return Err("desktop.portable_export_destination_invalid");
    }
    Ok(canonical.join(
        path.file_name()
            .ok_or("desktop.portable_export_destination_invalid")?,
    ))
}

pub(crate) fn validate_source(path: &Path) -> Result<PathBuf, &'static str> {
    if !path.is_absolute()
        || path.to_str().is_none()
        || path.extension().and_then(|value| value.to_str()) != Some("schedule")
    {
        return Err("desktop.portable_import_source_invalid");
    }
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "desktop.portable_import_source_invalid")?;
    if is_link_or_reparse(&metadata)
        || !metadata.is_file()
        || metadata.len() == 0
        || metadata.len() > MAX_PORTABLE_EXPORT_BYTES
    {
        return Err("desktop.portable_import_source_invalid");
    }
    let parent = path
        .parent()
        .ok_or("desktop.portable_import_source_invalid")?;
    let mut current = PathBuf::new();
    for component in parent.components() {
        match component {
            Component::Prefix(value) => current.push(value.as_os_str()),
            Component::RootDir => current.push(component.as_os_str()),
            Component::Normal(value) => {
                current.push(value);
                let metadata = fs::symlink_metadata(&current)
                    .map_err(|_| "desktop.portable_import_source_invalid")?;
                if is_link_or_reparse(&metadata) || !metadata.is_dir() {
                    return Err("desktop.portable_import_source_invalid");
                }
            }
            _ => return Err("desktop.portable_import_source_invalid"),
        }
    }
    let canonical =
        dunce::canonicalize(path).map_err(|_| "desktop.portable_import_source_invalid")?;
    let canonical_metadata =
        fs::symlink_metadata(&canonical).map_err(|_| "desktop.portable_import_source_invalid")?;
    if !canonical.is_absolute()
        || canonical.to_str().is_none()
        || canonical.extension().and_then(|value| value.to_str()) != Some("schedule")
        || is_link_or_reparse(&canonical_metadata)
        || !canonical_metadata.is_file()
        || canonical_metadata.len() != metadata.len()
    {
        return Err("desktop.portable_import_source_invalid");
    }
    Ok(canonical)
}

fn exact_protocol_payload<'a>(
    stdout: &'a [u8],
    prefix: &str,
    error: &'static str,
) -> Result<&'a str, &'static str> {
    let value = std::str::from_utf8(stdout).map_err(|_| error)?;
    let line = value
        .strip_suffix("\r\n")
        .or_else(|| value.strip_suffix('\n'))
        .unwrap_or(value);
    if line.contains(['\r', '\n']) {
        return Err(error);
    }
    let payload = line.strip_prefix(prefix).ok_or(error)?;
    (payload.len() <= MAX_PORTABLE_PROTOCOL_BYTES)
        .then_some(payload)
        .ok_or(error)
}

pub(crate) fn parse_portable_output(stdout: &[u8]) -> Result<u64, &'static str> {
    let payload = exact_protocol_payload(
        stdout,
        PORTABLE_EXPORT_PREFIX,
        "desktop.portable_export_protocol_invalid",
    )?;
    if payload.len() > 256 {
        return Err("desktop.portable_export_protocol_invalid");
    }
    let size = serde_json::from_str::<PortablePayload>(payload)
        .map_err(|_| "desktop.portable_export_protocol_invalid")?
        .size_bytes;
    (size > 0 && size <= MAX_PORTABLE_EXPORT_BYTES)
        .then_some(size)
        .ok_or("desktop.portable_export_protocol_invalid")
}

pub(crate) fn parse_portable_inspect_output(
    stdout: &[u8],
) -> Result<PortableImportPreview, &'static str> {
    const ERROR: &str = "desktop.portable_import_protocol_invalid";
    let payload = exact_protocol_payload(stdout, PORTABLE_INSPECT_PREFIX, ERROR)?;
    let parsed = serde_json::from_str::<PortableInspectionPayload>(payload).map_err(|_| ERROR)?;
    let safe_text = |value: &str, max: usize| {
        !value.is_empty() && value.len() <= max && !value.chars().any(|value| value.is_control())
    };
    if !safe_text(&parsed.archive_id, 128)
        || parsed.archive_sha256.len() != 64
        || !parsed
            .archive_sha256
            .bytes()
            .all(|value| value.is_ascii_hexdigit() && !value.is_ascii_uppercase())
        || !safe_text(&parsed.exported_at, 64)
        || !safe_text(&parsed.application_version, 128)
        || parsed.schema_version == 0
        || parsed.size_bytes == 0
        || parsed.size_bytes > MAX_PORTABLE_EXPORT_BYTES
    {
        return Err(ERROR);
    }
    Ok(PortableImportPreview {
        archive_id: parsed.archive_id,
        archive_sha256: parsed.archive_sha256,
        exported_at: parsed.exported_at,
        application_version: parsed.application_version,
        schema_version: parsed.schema_version,
        size_bytes: parsed.size_bytes,
    })
}

pub(crate) fn parse_portable_import_output(stdout: &[u8]) -> Result<(), &'static str> {
    const ERROR: &str = "desktop.portable_import_protocol_invalid";
    let payload = exact_protocol_payload(stdout, PORTABLE_IMPORT_PREFIX, ERROR)?;
    let parsed = serde_json::from_str::<PortableImportPayload>(payload).map_err(|_| ERROR)?;
    parsed.previous_retained.then_some(()).ok_or(ERROR)
}

pub(crate) fn parse_portable_recovery_output(
    stdout: &[u8],
) -> Result<PortableRecoveryOutcome, &'static str> {
    const ERROR: &str = "desktop.portable_recovery_protocol_invalid";
    let payload = exact_protocol_payload(stdout, PORTABLE_RECOVERY_PREFIX, ERROR)?;
    let parsed = serde_json::from_str::<PortableRecoveryPayload>(payload).map_err(|_| ERROR)?;
    if parsed.committed && !parsed.recovered {
        return Err(ERROR);
    }
    Ok(PortableRecoveryOutcome {
        recovered: parsed.recovered,
        committed: parsed.committed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn created_result_uses_the_frontend_contract() {
        assert_eq!(
            serde_json::to_value(PortableExportResult::Created { size_bytes: 42 }).unwrap(),
            serde_json::json!({ "result": "created", "sizeBytes": 42 })
        );
        assert_eq!(
            serde_json::to_value(PortableImportSelectResult::Selected {
                token: "opaque-token".to_owned(),
                preview: PortableImportPreview {
                    archive_id: "archive-1".to_owned(),
                    archive_sha256: "a".repeat(64),
                    exported_at: "2026-07-21T00:00:00.000Z".to_owned(),
                    application_version: "0.1.0".to_owned(),
                    schema_version: 12,
                    size_bytes: 42,
                },
            })
            .unwrap(),
            serde_json::json!({
                "result": "selected",
                "token": "opaque-token",
                "preview": {
                    "archiveId": "archive-1",
                    "exportedAt": "2026-07-21T00:00:00.000Z",
                    "applicationVersion": "0.1.0",
                    "schemaVersion": 12,
                    "sizeBytes": 42
                }
            })
        );
        assert_eq!(
            serde_json::to_value(PortableImportResult::Imported).unwrap(),
            serde_json::json!({ "result": "imported" })
        );
        assert_eq!(
            serde_json::to_value(PortableImportResult::ImportedRestartRequired).unwrap(),
            serde_json::json!({ "result": "imported_restart_required" })
        );
        assert_eq!(
            serde_json::to_value(PortableImportResult::RecoveryRequired).unwrap(),
            serde_json::json!({ "result": "recovery_required" })
        );
    }
    #[test]
    fn parses_only_the_exact_bounded_protocol() {
        assert_eq!(
            parse_portable_output(b"SCHEDULE_PORTABLE_EXPORT_V1 {\"sizeBytes\":12}\n"),
            Ok(12)
        );
        for bad in [
            b"noise\nSCHEDULE_PORTABLE_EXPORT_V1 {\"sizeBytes\":12}\n".as_slice(),
            b"SCHEDULE_PORTABLE_EXPORT_V1 {\"sizeBytes\":12}\nmore",
            b"SCHEDULE_PORTABLE_EXPORT_V1 {\"sizeBytes\":\"12\"}",
            b"SCHEDULE_PORTABLE_EXPORT_V1 {\"sizeBytes\":0}",
            b"SCHEDULE_PORTABLE_EXPORT_V1 {\"sizeBytes\":12}\n\n",
            b"SCHEDULE_PORTABLE_EXPORT_V1 {\"sizeBytes\":12,\"extra\":true}",
        ] {
            assert!(parse_portable_output(bad).is_err());
        }

        assert_eq!(
            parse_portable_inspect_output(
                b"SCHEDULE_PORTABLE_INSPECT_V1 {\"archiveId\":\"archive-1\",\"archiveSha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"exportedAt\":\"2026-07-21T00:00:00.000Z\",\"applicationVersion\":\"0.1.0\",\"schemaVersion\":12,\"sizeBytes\":42}\n"
            ),
            Ok(PortableImportPreview {
                archive_id: "archive-1".to_owned(),
                archive_sha256: "a".repeat(64),
                exported_at: "2026-07-21T00:00:00.000Z".to_owned(),
                application_version: "0.1.0".to_owned(),
                schema_version: 12,
                size_bytes: 42,
            })
        );
        assert_eq!(
            parse_portable_import_output(
                b"SCHEDULE_PORTABLE_IMPORT_V1 {\"previousRetained\":true}\n"
            ),
            Ok(())
        );
        assert_eq!(
            parse_portable_recovery_output(
                b"SCHEDULE_PORTABLE_RECOVERY_V1 {\"recovered\":true,\"committed\":false}\n"
            ),
            Ok(PortableRecoveryOutcome {
                recovered: true,
                committed: false,
            })
        );
        for bad in [
            b"SCHEDULE_PORTABLE_INSPECT_V1 {\"archiveId\":\"\",\"archiveSha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"exportedAt\":\"x\",\"applicationVersion\":\"x\",\"schemaVersion\":1,\"sizeBytes\":1}".as_slice(),
            b"SCHEDULE_PORTABLE_INSPECT_V1 {\"archiveId\":\"x\",\"archiveSha256\":\"invalid\",\"exportedAt\":\"x\",\"applicationVersion\":\"x\",\"schemaVersion\":1,\"sizeBytes\":1}",
            b"SCHEDULE_PORTABLE_INSPECT_V1 {\"archiveId\":\"x\",\"archiveSha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"exportedAt\":\"x\",\"applicationVersion\":\"x\",\"schemaVersion\":1,\"sizeBytes\":1,\"path\":\"secret\"}",
        ] {
            assert!(parse_portable_inspect_output(bad).is_err());
        }
        assert!(
            parse_portable_import_output(
                b"SCHEDULE_PORTABLE_IMPORT_V1 {\"previousRetained\":false}"
            )
            .is_err()
        );
        assert!(
            parse_portable_recovery_output(
                b"SCHEDULE_PORTABLE_RECOVERY_V1 {\"recovered\":false,\"committed\":true}"
            )
            .is_err()
        );
    }
    #[test]
    fn rejects_relative_and_wrong_extension_destinations() {
        assert!(validate_destination(Path::new("x.schedule")).is_err());
        assert!(validate_destination(Path::new("C:\\x.txt")).is_err());
        assert!(validate_source(Path::new("x.schedule")).is_err());
        assert!(validate_source(Path::new("C:\\x.txt")).is_err());
    }

    #[test]
    fn accepts_only_a_nonempty_regular_schedule_source() {
        use std::time::{SystemTime, UNIX_EPOCH};
        let root = std::env::temp_dir().join(format!(
            "schedule-portable-source-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let source = root.join("data.schedule");
        fs::write(&source, b"archive").unwrap();
        assert_eq!(
            validate_source(&source),
            dunce::canonicalize(&source).map_err(|_| "")
        );
        let empty = root.join("empty.schedule");
        fs::write(&empty, b"").unwrap();
        assert!(validate_source(&empty).is_err());
        fs::remove_file(empty).unwrap();
        fs::remove_file(source).unwrap();
        fs::remove_dir(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_existing_and_linked_destinations_without_following_them() {
        use std::{
            fs,
            os::unix::fs::symlink,
            time::{SystemTime, UNIX_EPOCH},
        };
        let root = std::env::temp_dir().join(format!(
            "schedule-portable-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let existing = root.join("existing.schedule");
        fs::write(&existing, b"").unwrap();
        assert_eq!(
            validate_destination(&existing),
            Err("desktop.portable_export_destination_exists")
        );
        let dangling = root.join("dangling.schedule");
        symlink(root.join("missing"), &dangling).unwrap();
        assert_eq!(
            validate_destination(&dangling),
            Err("desktop.portable_export_destination_exists")
        );
        let linked_parent = root.join("linked");
        symlink(&root, &linked_parent).unwrap();
        assert_eq!(
            validate_destination(&linked_parent.join("new.schedule")),
            Err("desktop.portable_export_destination_invalid")
        );
        let source = root.join("source.schedule");
        fs::write(&source, b"archive").unwrap();
        let linked_source = root.join("linked.schedule");
        symlink(&source, &linked_source).unwrap();
        assert_eq!(
            validate_source(&linked_source),
            Err("desktop.portable_import_source_invalid")
        );
        assert_eq!(
            validate_source(&linked_parent.join("source.schedule")),
            Err("desktop.portable_import_source_invalid")
        );
        fs::remove_file(linked_source).unwrap();
        fs::remove_file(source).unwrap();
        fs::remove_file(dangling).unwrap();
        fs::remove_file(linked_parent).unwrap();
        fs::remove_file(existing).unwrap();
        fs::remove_dir(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn rejects_reparse_point_parents_when_symlinks_are_available() {
        use std::{
            fs,
            os::windows::fs::symlink_dir,
            time::{SystemTime, UNIX_EPOCH},
        };
        let root = std::env::temp_dir().join(format!(
            "schedule-portable-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let actual = root.join("actual");
        let linked = root.join("linked");
        fs::create_dir_all(&actual).unwrap();
        match symlink_dir(&actual, &linked) {
            Ok(()) => {
                assert_eq!(
                    validate_destination(&linked.join("new.schedule")),
                    Err("desktop.portable_export_destination_invalid")
                );
                fs::write(actual.join("source.schedule"), b"archive").unwrap();
                assert_eq!(
                    validate_source(&linked.join("source.schedule")),
                    Err("desktop.portable_import_source_invalid")
                );
                fs::remove_file(actual.join("source.schedule")).unwrap();
                fs::remove_dir(linked).unwrap();
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::PermissionDenied
                    || error.raw_os_error() == Some(1314) => {}
            Err(error) => panic!("unexpected symlink error: {error}"),
        }
        fs::remove_dir(actual).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
