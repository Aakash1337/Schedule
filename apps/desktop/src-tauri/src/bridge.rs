use std::{
    sync::{
        Arc, RwLock,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use reqwest::{Client, Method, header, redirect};
use serde::{Deserialize, Serialize};
use tauri::{State, Url};
use zeroize::Zeroize;

const MAX_REQUEST_BODY_BYTES: usize = 256 * 1024;
const MAX_RESPONSE_BODY_BYTES: usize = 4 * 1024 * 1024;
const MAX_PATH_BYTES: usize = 8 * 1024;
const MAX_CONCURRENT_REQUESTS: usize = 16;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum DesktopApiMethod {
    Get,
    Post,
    Put,
    Patch,
    Delete,
}

impl DesktopApiMethod {
    fn as_reqwest(self) -> Method {
        match self {
            Self::Get => Method::GET,
            Self::Post => Method::POST,
            Self::Put => Method::PUT,
            Self::Patch => Method::PATCH,
            Self::Delete => Method::DELETE,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopApiRequest {
    method: DesktopApiMethod,
    path: String,
    json_body: Option<String>,
    idempotency_key: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopApiResponse {
    status: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    json_body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct DesktopApiBridgeError {
    code: &'static str,
}

impl DesktopApiBridgeError {
    const fn new(code: &'static str) -> Self {
        Self { code }
    }
}

struct DesktopLaunchCredential(String);

impl DesktopLaunchCredential {
    fn parse(value: String) -> Result<Self, DesktopApiBridgeError> {
        if value.len() != 43
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        {
            return Err(DesktopApiBridgeError::new("desktop.credential_invalid"));
        }
        Ok(Self(value))
    }

    fn authorization(&self) -> String {
        format!("Bearer {}", self.0)
    }
}

impl Drop for DesktopLaunchCredential {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

#[derive(Clone)]
struct DesktopApiTarget {
    port: u16,
    credential: Arc<DesktopLaunchCredential>,
}

pub struct DesktopApiForwarder {
    client: Client,
    target: RwLock<Option<DesktopApiTarget>>,
    in_flight: Arc<AtomicUsize>,
}

#[derive(Debug)]
struct RequestSlot(Arc<AtomicUsize>);

impl Drop for RequestSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

impl DesktopApiForwarder {
    pub fn new() -> Result<Self, DesktopApiBridgeError> {
        let client = Client::builder()
            .no_proxy()
            .redirect(redirect::Policy::none())
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|_| DesktopApiBridgeError::new("desktop.bridge_unavailable"))?;
        Ok(Self {
            client,
            target: RwLock::new(None),
            in_flight: Arc::new(AtomicUsize::new(0)),
        })
    }

    pub(crate) fn configure(
        &self,
        port: u16,
        credential: String,
    ) -> Result<(), DesktopApiBridgeError> {
        if port == 0 {
            return Err(DesktopApiBridgeError::new("desktop.target_invalid"));
        }
        let target = DesktopApiTarget {
            port,
            credential: Arc::new(DesktopLaunchCredential::parse(credential)?),
        };
        *self
            .target
            .write()
            .map_err(|_| DesktopApiBridgeError::new("desktop.bridge_unavailable"))? = Some(target);
        Ok(())
    }

    pub(crate) fn clear(&self) -> Result<(), DesktopApiBridgeError> {
        *self
            .target
            .write()
            .map_err(|_| DesktopApiBridgeError::new("desktop.bridge_unavailable"))? = None;
        Ok(())
    }

    fn try_acquire_request_slot(&self) -> Result<RequestSlot, DesktopApiBridgeError> {
        self.in_flight
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                (current < MAX_CONCURRENT_REQUESTS).then_some(current + 1)
            })
            .map_err(|_| DesktopApiBridgeError::new("desktop.bridge_busy"))?;
        Ok(RequestSlot(Arc::clone(&self.in_flight)))
    }

    async fn forward(
        &self,
        request: DesktopApiRequest,
    ) -> Result<DesktopApiResponse, DesktopApiBridgeError> {
        validate_request(&request)?;
        let _slot = self.try_acquire_request_slot()?;
        let target = self
            .target
            .read()
            .map_err(|_| DesktopApiBridgeError::new("desktop.bridge_unavailable"))?
            .clone()
            .ok_or_else(|| DesktopApiBridgeError::new("desktop.api_not_ready"))?;
        let url = format!("http://127.0.0.1:{}{}", target.port, request.path);
        let mut outbound = self
            .client
            .request(request.method.as_reqwest(), url)
            .header(header::ACCEPT, "application/json")
            .header(header::AUTHORIZATION, target.credential.authorization());
        if let Some(key) = request.idempotency_key {
            outbound = outbound.header("idempotency-key", key);
        }
        if let Some(body) = request.json_body {
            outbound = outbound
                .header(header::CONTENT_TYPE, "application/json")
                .body(body);
        }

        let mut inbound = outbound
            .send()
            .await
            .map_err(|_| DesktopApiBridgeError::new("desktop.api_unavailable"))?;
        if inbound
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BODY_BYTES as u64)
        {
            return Err(DesktopApiBridgeError::new("desktop.response_too_large"));
        }
        let status = inbound.status().as_u16();
        let request_id = inbound
            .headers()
            .get("x-request-id")
            .and_then(|value| value.to_str().ok())
            .map(ToOwned::to_owned);
        let mut body = Vec::new();
        while let Some(chunk) = inbound
            .chunk()
            .await
            .map_err(|_| DesktopApiBridgeError::new("desktop.api_unavailable"))?
        {
            if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BODY_BYTES {
                return Err(DesktopApiBridgeError::new("desktop.response_too_large"));
            }
            body.extend_from_slice(&chunk);
        }
        let json_body = if body.is_empty() {
            None
        } else {
            Some(
                String::from_utf8(body)
                    .map_err(|_| DesktopApiBridgeError::new("desktop.response_invalid"))?,
            )
        };

        Ok(DesktopApiResponse {
            status,
            json_body,
            request_id,
        })
    }
}

fn validate_request(request: &DesktopApiRequest) -> Result<(), DesktopApiBridgeError> {
    if request.path.len() > MAX_PATH_BYTES
        || !request.path.starts_with("/v1/workspaces")
        || !(request.path == "/v1/workspaces"
            || request.path.starts_with("/v1/workspaces/")
            || request.path.starts_with("/v1/workspaces?"))
        || request.path.contains(['\r', '\n', '\\', '#'])
    {
        return Err(DesktopApiBridgeError::new("desktop.request_not_allowed"));
    }
    let encoded_path = request.path.split('?').next().unwrap_or_default();
    let lower_path = encoded_path.to_ascii_lowercase();
    if ["%00", "%2e", "%2f", "%5c"]
        .iter()
        .any(|forbidden| lower_path.contains(forbidden))
    {
        return Err(DesktopApiBridgeError::new("desktop.request_not_allowed"));
    }
    let parsed = Url::parse(&format!("http://schedule.invalid{}", request.path))
        .map_err(|_| DesktopApiBridgeError::new("desktop.request_not_allowed"))?;
    if parsed.host_str() != Some("schedule.invalid")
        || parsed.fragment().is_some()
        || !(parsed.path() == "/v1/workspaces" || parsed.path().starts_with("/v1/workspaces/"))
    {
        return Err(DesktopApiBridgeError::new("desktop.request_not_allowed"));
    }
    if request
        .json_body
        .as_ref()
        .is_some_and(|body| body.len() > MAX_REQUEST_BODY_BYTES)
        || matches!(
            request.method,
            DesktopApiMethod::Get | DesktopApiMethod::Delete
        ) && request.json_body.is_some()
    {
        return Err(DesktopApiBridgeError::new("desktop.request_not_allowed"));
    }
    if request.idempotency_key.as_ref().is_some_and(|key| {
        key.is_empty()
            || key.len() > 128
            || !key.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':')
            })
    }) {
        return Err(DesktopApiBridgeError::new("desktop.request_not_allowed"));
    }
    Ok(())
}

#[tauri::command]
pub async fn api_request(
    forwarder: State<'_, DesktopApiForwarder>,
    request: DesktopApiRequest,
) -> Result<DesktopApiResponse, DesktopApiBridgeError> {
    forwarder.forward(request).await
}

#[cfg(test)]
mod tests {
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::mpsc,
        thread,
    };

    use super::*;

    const TOKEN: &str = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";

    fn request(method: DesktopApiMethod, path: &str) -> DesktopApiRequest {
        DesktopApiRequest {
            method,
            path: path.to_owned(),
            json_body: None,
            idempotency_key: None,
        }
    }

    #[test]
    fn rejects_requests_outside_the_local_product_surface() {
        for path in [
            "https://example.com/v1/workspaces",
            "//example.com/v1/workspaces",
            "/v1/hosted/workspaces",
            "/v1/integrations/today",
            "/v1/workspaces-elsewhere",
            "/v1/workspaces/../hosted",
            "/v1/workspaces/%2e%2e/hosted",
            "/v1/workspaces/id%2fhosted",
            "/v1/workspaces/id#fragment",
            "/v1/workspaces/id\\hosted",
            "/v1/workspaces/id\nheader",
        ] {
            assert_eq!(
                validate_request(&request(DesktopApiMethod::Get, path)),
                Err(DesktopApiBridgeError::new("desktop.request_not_allowed")),
                "{path}"
            );
        }
    }

    #[test]
    fn rejects_oversized_bodies_and_invalid_idempotency_keys() {
        let mut oversized = request(DesktopApiMethod::Post, "/v1/workspaces");
        oversized.json_body = Some("x".repeat(MAX_REQUEST_BODY_BYTES + 1));
        assert!(validate_request(&oversized).is_err());

        let mut invalid_key = request(DesktopApiMethod::Post, "/v1/workspaces");
        invalid_key.idempotency_key = Some("not allowed".to_owned());
        assert!(validate_request(&invalid_key).is_err());

        let mut get_body = request(DesktopApiMethod::Get, "/v1/workspaces");
        get_body.json_body = Some("{}".to_owned());
        assert!(validate_request(&get_body).is_err());

        let mut delete_body = request(DesktopApiMethod::Delete, "/v1/workspaces/workspace-1");
        delete_body.json_body = Some("{}".to_owned());
        assert!(validate_request(&delete_body).is_err());

        let overlong_path = format!("/v1/workspaces/{}", "x".repeat(MAX_PATH_BYTES));
        assert!(validate_request(&request(DesktopApiMethod::Get, &overlong_path)).is_err());
    }

    #[test]
    fn returns_not_ready_without_disclosing_runtime_state() {
        let forwarder = DesktopApiForwarder::new().unwrap();
        let error = tauri::async_runtime::block_on(
            forwarder.forward(request(DesktopApiMethod::Get, "/v1/workspaces")),
        )
        .unwrap_err();
        assert_eq!(error.code, "desktop.api_not_ready");
    }

    #[test]
    fn rejects_invalid_runtime_targets() {
        let forwarder = DesktopApiForwarder::new().unwrap();
        assert_eq!(
            forwarder.configure(0, TOKEN.to_owned()),
            Err(DesktopApiBridgeError::new("desktop.target_invalid"))
        );
        assert_eq!(
            forwarder.configure(4_000, "not-a-credential".to_owned()),
            Err(DesktopApiBridgeError::new("desktop.credential_invalid"))
        );
    }

    #[test]
    fn clears_stale_runtime_targets_before_restart() {
        let forwarder = DesktopApiForwarder::new().unwrap();
        forwarder.configure(4_000, TOKEN.to_owned()).unwrap();
        forwarder.clear().unwrap();

        let error = tauri::async_runtime::block_on(
            forwarder.forward(request(DesktopApiMethod::Get, "/v1/workspaces")),
        )
        .unwrap_err();
        assert_eq!(error.code, "desktop.api_not_ready");
    }

    #[test]
    fn bounds_concurrent_renderer_requests() {
        let forwarder = DesktopApiForwarder::new().unwrap();
        let slots = (0..MAX_CONCURRENT_REQUESTS)
            .map(|_| forwarder.try_acquire_request_slot().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            forwarder.try_acquire_request_slot().unwrap_err().code,
            "desktop.bridge_busy"
        );
        drop(slots);
        assert!(forwarder.try_acquire_request_slot().is_ok());
    }

    #[test]
    fn forwards_only_owned_authority_headers_and_preserves_the_response() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (captured_sender, captured_receiver) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request_bytes = Vec::new();
            let mut buffer = [0_u8; 4096];
            loop {
                let read = stream.read(&mut buffer).unwrap();
                if read == 0 {
                    break;
                }
                request_bytes.extend_from_slice(&buffer[..read]);
                if request_bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            captured_sender
                .send(String::from_utf8(request_bytes).unwrap())
                .unwrap();
            let body = r#"{"error":{"code":"version.conflict"}}"#;
            write!(
                stream,
                "HTTP/1.1 409 Conflict\r\nContent-Type: application/json\r\nContent-Length: {}\r\nX-Request-Id: request-9\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        });

        let forwarder = DesktopApiForwarder::new().unwrap();
        forwarder.configure(port, TOKEN.to_owned()).unwrap();
        let mut outbound = request(
            DesktopApiMethod::Post,
            "/v1/workspaces/workspace-1/work-items?limit=20",
        );
        outbound.json_body = Some(r#"{"title":"Review"}"#.to_owned());
        outbound.idempotency_key = Some("operation-9".to_owned());
        let response = tauri::async_runtime::block_on(forwarder.forward(outbound)).unwrap();
        server.join().unwrap();

        let captured = captured_receiver.recv().unwrap().to_ascii_lowercase();
        assert!(
            captured
                .starts_with("post /v1/workspaces/workspace-1/work-items?limit=20 http/1.1\r\n")
        );
        assert!(captured.contains(&format!("authorization: bearer {TOKEN}").to_ascii_lowercase()));
        assert!(captured.contains("idempotency-key: operation-9"));
        assert!(!captured.contains("origin:"));
        assert_eq!(response.status, 409);
        assert_eq!(response.request_id.as_deref(), Some("request-9"));
        assert_eq!(
            response.json_body.as_deref(),
            Some(r#"{"error":{"code":"version.conflict"}}"#)
        );
    }

    #[test]
    fn never_follows_api_redirects() {
        let destination = TcpListener::bind("127.0.0.1:0").unwrap();
        destination.set_nonblocking(true).unwrap();
        let destination_url = format!(
            "http://127.0.0.1:{}/v1/workspaces",
            destination.local_addr().unwrap().port()
        );
        let redirector = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = redirector.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = redirector.accept().unwrap();
            let mut buffer = [0_u8; 4096];
            let _ = stream.read(&mut buffer).unwrap();
            write!(
                stream,
                "HTTP/1.1 302 Found\r\nLocation: {destination_url}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
        });

        let forwarder = DesktopApiForwarder::new().unwrap();
        forwarder.configure(port, TOKEN.to_owned()).unwrap();
        let response = tauri::async_runtime::block_on(
            forwarder.forward(request(DesktopApiMethod::Get, "/v1/workspaces")),
        )
        .unwrap();
        server.join().unwrap();

        assert_eq!(response.status, 302);
        assert!(matches!(
            destination.accept(),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock
        ));
    }
}
