use std::{
    fs,
    path::{Component, Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use super::integrity::is_link_or_reparse;

pub(crate) const PORTABLE_EXPORT_PREFIX: &str = "SCHEDULE_PORTABLE_EXPORT_V1 ";

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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PortablePayload {
    size_bytes: u64,
}
const MAX_PORTABLE_EXPORT_BYTES: u64 = 513 * 1024 * 1024;

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

pub(crate) fn parse_portable_output(stdout: &[u8]) -> Result<u64, &'static str> {
    let value =
        std::str::from_utf8(stdout).map_err(|_| "desktop.portable_export_protocol_invalid")?;
    let line = value
        .strip_suffix("\r\n")
        .or_else(|| value.strip_suffix('\n'))
        .unwrap_or(value);
    if line.contains(['\r', '\n']) {
        return Err("desktop.portable_export_protocol_invalid");
    }
    let payload = line
        .strip_prefix(PORTABLE_EXPORT_PREFIX)
        .ok_or("desktop.portable_export_protocol_invalid")?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn created_result_uses_the_frontend_contract() {
        assert_eq!(
            serde_json::to_value(PortableExportResult::Created { size_bytes: 42 }).unwrap(),
            serde_json::json!({ "result": "created", "sizeBytes": 42 })
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
    }
    #[test]
    fn rejects_relative_and_wrong_extension_destinations() {
        assert!(validate_destination(Path::new("x.schedule")).is_err());
        assert!(validate_destination(Path::new("C:\\x.txt")).is_err());
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
