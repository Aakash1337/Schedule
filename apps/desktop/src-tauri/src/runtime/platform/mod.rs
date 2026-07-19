#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

use std::sync::Arc;

use super::ProcessGroupControl;

#[cfg(unix)]
pub(super) fn new_control() -> Arc<dyn ProcessGroupControl> {
    Arc::new(unix::UnixProcessControl::default())
}

#[cfg(windows)]
pub(super) fn new_control() -> Arc<dyn ProcessGroupControl> {
    Arc::new(windows::WindowsProcessControl::default())
}

#[cfg(not(any(unix, windows)))]
compile_error!("the desktop runtime requires Windows or Unix process ownership support");
