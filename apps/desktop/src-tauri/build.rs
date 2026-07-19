fn main() {
    println!("cargo:rerun-if-env-changed=SCHEDULE_DESKTOP_RUNTIME_MANIFEST_SHA256");
    tauri_build::build()
}
