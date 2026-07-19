#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod runtime;

use serde::Serialize;
use tauri::{
    Url, WebviewUrl,
    webview::{NewWindowResponse, WebviewWindowBuilder},
};

#[derive(Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopRuntimeStatus {
    phase: &'static str,
    message: &'static str,
}

#[tauri::command]
fn runtime_status() -> DesktopRuntimeStatus {
    DesktopRuntimeStatus {
        phase: "foundation",
        message: "The self-contained local runtime is not installed in this build yet.",
    }
}

fn is_allowed_navigation(url: &Url, allow_development_origin: bool) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }

    let is_bundled_origin = matches!(
        (url.scheme(), url.host_str(), url.port()),
        ("tauri", Some("localhost"), None) | ("http", Some("tauri.localhost"), None)
    );
    let is_development_origin = allow_development_origin
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(1420);

    is_bundled_origin || is_development_origin
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn foundation_status_does_not_claim_the_runtime_is_ready() {
        assert_eq!(
            runtime_status(),
            DesktopRuntimeStatus {
                phase: "foundation",
                message: "The self-contained local runtime is not installed in this build yet.",
            }
        );
    }

    #[test]
    fn navigation_is_limited_to_exact_application_origins() {
        for allowed in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/index.html",
        ] {
            assert!(is_allowed_navigation(&allowed.parse().unwrap(), false));
        }
        assert!(is_allowed_navigation(
            &"http://127.0.0.1:1420/".parse().unwrap(),
            true
        ));

        for denied in [
            "https://example.com/",
            "http://127.0.0.1:1421/",
            "http://localhost:1420/",
            "http://tauri.localhost.evil.example/",
            "http://user@tauri.localhost/",
        ] {
            assert!(!is_allowed_navigation(&denied.parse().unwrap(), false));
        }
        assert!(!is_allowed_navigation(
            &"http://127.0.0.1:1420/".parse().unwrap(),
            false
        ));
    }
}

fn main() {
    let api_forwarder = bridge::DesktopApiForwarder::new()
        .expect("Schedule desktop API bridge failed to initialize");
    tauri::Builder::default()
        .manage(api_forwarder)
        .setup(|app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Schedule")
                .inner_size(1180.0, 780.0)
                .min_inner_size(720.0, 560.0)
                .resizable(true)
                .fullscreen(false)
                .on_navigation(|url| is_allowed_navigation(url, cfg!(debug_assertions)))
                .on_new_window(|_, _| NewWindowResponse::Deny)
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            runtime_status,
            bridge::api_request
        ])
        .run(tauri::generate_context!())
        .expect("Schedule desktop failed to start");
}
