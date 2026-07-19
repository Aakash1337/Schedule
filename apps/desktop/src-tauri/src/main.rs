#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod runtime;

use tauri::{
    Manager, RunEvent, Url, WebviewUrl, WindowEvent,
    webview::{NewWindowResponse, WebviewWindowBuilder},
};

#[tauri::command]
fn runtime_status(
    runtime: tauri::State<'_, std::sync::Arc<runtime::tauri_adapter::DesktopRuntimeAdapter>>,
) -> runtime::tauri_adapter::DesktopRuntimeStatus {
    runtime.status()
}

#[tauri::command]
fn runtime_retry(
    runtime: tauri::State<'_, std::sync::Arc<runtime::tauri_adapter::DesktopRuntimeAdapter>>,
) -> runtime::tauri_adapter::RuntimeRetryResult {
    runtime.retry()
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
    if runtime::guardian::run_if_requested() {
        return;
    }
    if runtime::smoke::run_if_requested() {
        return;
    }
    let api_forwarder = std::sync::Arc::new(
        bridge::DesktopApiForwarder::new()
            .expect("Schedule desktop API bridge failed to initialize"),
    );
    let app = tauri::Builder::default()
        .manage(api_forwarder.clone())
        .setup(|app| {
            let runtime = runtime::tauri_adapter::DesktopRuntimeAdapter::setup(
                &app.handle(),
                app.state::<std::sync::Arc<bridge::DesktopApiForwarder>>()
                    .inner()
                    .clone(),
            );
            app.manage(std::sync::Arc::new(runtime));
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
            runtime_retry,
            bridge::api_request
        ])
        .build(tauri::generate_context!())
        .expect("Schedule desktop failed to build");
    app.run(|app, event| match event {
        RunEvent::WindowEvent {
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } => {
            api.prevent_close();
            runtime::tauri_adapter::schedule_close(
                app.clone(),
                app.state::<std::sync::Arc<runtime::tauri_adapter::DesktopRuntimeAdapter>>()
                    .inner()
                    .clone(),
            );
        }
        RunEvent::ExitRequested { .. } => {
            app.state::<std::sync::Arc<runtime::tauri_adapter::DesktopRuntimeAdapter>>()
                .bounded_shutdown(runtime::tauri_adapter::final_shutdown_wait());
        }
        _ => {}
    });
}
