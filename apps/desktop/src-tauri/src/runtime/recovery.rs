//! Redacted protocol and result for explicit automatic-backup recovery.

const RECOVERY_SUCCESS: &[u8] =
    b"SCHEDULE_DESKTOP_BACKUP_RECOVERY_V1 {\"previousRetained\":true}\n";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AutomaticBackupRecoveryResult {
    Restored,
    Failed { code: &'static str },
    Unavailable,
}

pub(crate) fn parse_automatic_backup_recovery_output(stdout: &[u8]) -> Result<(), &'static str> {
    (stdout == RECOVERY_SUCCESS)
        .then_some(())
        .ok_or("desktop.backup_recovery_protocol_invalid")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_the_exact_bounded_recovery_receipt() {
        assert!(parse_automatic_backup_recovery_output(RECOVERY_SUCCESS).is_ok());
        for invalid in [
            b"SCHEDULE_DESKTOP_BACKUP_RECOVERY_V1 {\"previousRetained\":false}\n".as_slice(),
            b"SCHEDULE_DESKTOP_BACKUP_RECOVERY_V1 {\"previousRetained\":true}".as_slice(),
            b"{\"previousRetained\":true}\n".as_slice(),
        ] {
            assert_eq!(
                parse_automatic_backup_recovery_output(invalid),
                Err("desktop.backup_recovery_protocol_invalid")
            );
        }
    }
}
