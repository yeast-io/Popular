use crate::{
    diagnostics::Trace,
    errors::AgentError,
    settings::{downloader_endpoint, downloader_url, Provider, TestRequest},
};
use reqwest::{header, Client, Response};
use serde_json::{json, Value};
use std::time::Duration;

pub(crate) fn checked(response: Response) -> Result<Response, AgentError> {
    if matches!(response.status().as_u16(), 401 | 403) {
        return Err(AgentError::code("authenticationError").http(response.status().as_u16()));
    }
    if !response.status().is_success() {
        return Err(AgentError::code("httpError").http(response.status().as_u16()));
    }
    Ok(response)
}
pub(crate) async fn body(mut response: Response) -> Result<Vec<u8>, AgentError> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len() + chunk.len() > 4194304 {
            return Err(AgentError::code("invalidResponse"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
fn version(value: Option<&str>) -> Result<(), AgentError> {
    match value {
        Some(v) if !v.trim().is_empty() && v.len() <= 100 && !v.contains(['<', '>', '\n']) => {
            Ok(())
        }
        _ => Err(AgentError::code("invalidResponse")),
    }
}

// Keep the credential store injectable so failed validation can be checked without native secrets.
pub async fn test_and_save(
    directory: &std::path::Path,
    request: TestRequest,
    store: &impl crate::credentials::CredentialStore,
    trace: &Trace,
) -> Result<crate::settings::Snapshot, AgentError> {
    use crate::{
        settings::{resolve_secret, same_downloader, SaveRequest, SecretChange, Settings},
        storage,
    };
    let stored = storage::load(directory)?;
    let previous = storage::secrets(&stored, store)?;
    let target = Settings {
        downloader_configured: true,
        provider: request.provider.clone(),
        downloader_url: downloader_url(&request.downloader_url, &request.provider)?,
        username: request.username.clone(),
        ..stored.settings.clone()
    };
    let password = resolve_secret(
        &request.password,
        &previous.password,
        same_downloader(&target, &stored.settings),
    )?;
    test(request, password.clone(), trace).await?;
    // Only a successful API test reaches the commit. Gateway and startup settings come from disk.
    trace.stage("downloader.test.save.started");
    let snapshot = storage::save(
        directory,
        SaveRequest {
            settings: target,
            api_key: SecretChange::Keep,
            password: if password.is_empty() {
                SecretChange::Clear
            } else {
                SecretChange::Set(password)
            },
        },
        store,
        trace,
    )?;
    trace.stage("downloader.test.save.completed");
    Ok(snapshot)
}

pub fn reset(
    directory: &std::path::Path,
    store: &impl crate::credentials::CredentialStore,
    trace: &Trace,
) -> Result<crate::settings::Snapshot, AgentError> {
    use crate::{
        settings::{SaveRequest, SecretChange, Settings},
        storage,
    };
    trace.stage("downloader.reset.started");
    let stored = storage::load(directory)?;
    let settings = Settings {
        downloader_configured: false,
        provider: Default::default(),
        downloader_url: String::new(),
        username: String::new(),
        ..stored.settings
    };
    // Keep device identity, execution history and target associations intact.
    storage::save(
        directory,
        SaveRequest {
            settings,
            api_key: SecretChange::Keep,
            password: SecretChange::Clear,
        },
        store,
        trace,
    )
}

pub async fn test(request: TestRequest, password: String, trace: &Trace) -> Result<(), AgentError> {
    let url = downloader_endpoint(&request.downloader_url, &request.provider)?;
    if request.username.len() > 512 {
        return Err(AgentError::code("invalidSettings"));
    }
    // No system proxy, redirects, persistent cookie jar, or certificate bypass.
    // The Gateway URL and API Key never enter this module.
    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(12))
        .build()?;
    let operation = async {
        match request.provider {
            Provider::Qbittorrent => {
                let base = url.as_str().trim_end_matches('/');
                let origin = url.origin().ascii_serialization();
                trace.stage("downloader.login.started");
                let response = checked(
                    client
                        .post(format!("{base}/api/v2/auth/login"))
                        .header(header::ORIGIN, &origin)
                        .header(header::REFERER, format!("{base}/"))
                        .form(&[
                            ("username", request.username.as_str()),
                            ("password", password.as_str()),
                        ])
                        .send()
                        .await?,
                )?;
                let cookie = response
                    .headers()
                    .get_all(header::SET_COOKIE)
                    .iter()
                    .filter_map(|v| v.to_str().ok())
                    .filter_map(|v| v.split(';').next())
                    .find(|v| v.starts_with("SID="))
                    .map(str::to_owned);
                if body(response).await? != b"Ok." {
                    return Err(AgentError::code("authenticationError"));
                }
                trace.stage("downloader.login.completed");
                trace.stage("downloader.version.started");
                let mut query = client
                    .get(format!("{base}/api/v2/app/version"))
                    .header(header::ORIGIN, origin)
                    .header(header::REFERER, format!("{base}/"));
                if let Some(cookie) = cookie {
                    query = query.header(header::COOKIE, cookie);
                }
                let bytes = body(checked(query.send().await?)?).await?;
                let value = std::str::from_utf8(&bytes).ok();
                // qBittorrent versions start with v; avoid accepting a generic HTML login page.
                if !value.is_some_and(|v| {
                    v.starts_with('v') && v.as_bytes().get(1).is_some_and(u8::is_ascii_digit)
                }) {
                    return Err(AgentError::code("invalidResponse"));
                }
                version(value)?;
                trace.stage("downloader.version.completed");
                Ok(())
            }
            Provider::Transmission => {
                let mut session = None;
                let mut modern = false;
                for attempt in 0..2 {
                    trace.stage(if attempt == 0 {
                        "downloader.rpc.started"
                    } else {
                        "downloader.rpc.session-retry"
                    });
                    let payload = if modern {
                        json!({"jsonrpc":"2.0","method":"session_get","params":{"fields":["version"]},"id":1})
                    } else {
                        json!({"method":"session-get","arguments":{"fields":["version"]},"tag":1})
                    };
                    // Transmission accepts the full RPC endpoint, including custom prefixes.
                    let mut query = client.post(url.clone()).json(&payload);
                    if !request.username.is_empty() || !password.is_empty() {
                        query = query.basic_auth(&request.username, Some(&password));
                    }
                    if let Some(session) = &session {
                        query = query.header("x-transmission-session-id", session);
                    }
                    let response = query.send().await?;
                    if response.status().as_u16() == 409 {
                        if attempt != 0 {
                            return Err(AgentError::code("invalidResponse"));
                        }
                        session = Some(
                            response
                                .headers()
                                .get("x-transmission-session-id")
                                .and_then(|v| v.to_str().ok())
                                .filter(|v| !v.is_empty() && v.len() <= 4096)
                                .ok_or(AgentError::code("invalidResponse"))?
                                .to_owned(),
                        );
                        modern = response
                            .headers()
                            .get("x-transmission-rpc-version")
                            .and_then(|v| v.to_str().ok())
                            .and_then(|v| v.split('.').next()?.parse::<u32>().ok())
                            .is_some_and(|v| v >= 6);
                        continue;
                    }
                    let bytes = body(checked(response)?).await?;
                    let value: Value = serde_json::from_slice(&bytes)
                        .map_err(|e| AgentError::caused("invalidResponse", e))?;
                    let args = if modern {
                        if value["jsonrpc"] != "2.0"
                            || value["id"] != 1
                            || value.get("error").is_some()
                        {
                            return Err(AgentError::code("invalidResponse"));
                        }
                        &value["result"]
                    } else {
                        if value["result"] != "success" || value["tag"] != 1 {
                            return Err(AgentError::code("invalidResponse"));
                        }
                        &value["arguments"]
                    };
                    version(args["version"].as_str())?;
                    trace.stage("downloader.rpc.completed");
                    return Ok(());
                }
                Err(AgentError::code("invalidResponse"))
            }
        }
    };
    tokio::time::timeout(Duration::from_secs(15), operation)
        .await
        .map_err(|_| AgentError::code("timeout"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };
    // A real loopback HTTP peer verifies request paths, credentials, and handshakes.
    async fn mock(responses: Vec<String>) -> (String, tokio::task::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            let mut requests = Vec::new();
            for response in responses {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                loop {
                    let mut buffer = [0; 2048];
                    let n = socket.read(&mut buffer).await.unwrap();
                    assert_ne!(n, 0);
                    bytes.extend_from_slice(&buffer[..n]);
                    if let Some(at) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&bytes[..at]).to_lowercase();
                        let length = head
                            .lines()
                            .find_map(|line| line.strip_prefix("content-length: "))
                            .map(|v| v.parse::<usize>().unwrap())
                            .unwrap_or(0);
                        if bytes.len() >= at + 4 + length {
                            break;
                        }
                    }
                }
                requests.push(String::from_utf8(bytes).unwrap());
                socket.write_all(response.as_bytes()).await.unwrap();
            }
            requests
        });
        (address, handle)
    }
    fn response(status: &str, headers: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: {}\r\n{headers}\r\n{body}",
            body.len()
        )
    }
    fn request(provider: Provider, url: String) -> TestRequest {
        TestRequest {
            provider,
            downloader_url: url,
            username: "user".into(),
            password: crate::settings::SecretChange::Keep,
        }
    }
    #[derive(Default)]
    struct Memory(std::cell::RefCell<std::collections::HashMap<String, String>>);
    impl crate::credentials::CredentialStore for Memory {
        fn read(&self, id: &str) -> Result<crate::settings::Secrets, AgentError> {
            Ok(serde_json::from_str(
                self.0
                    .borrow()
                    .get(id)
                    .ok_or(AgentError::code("credentialError"))?,
            )?)
        }
        fn write(&self, id: &str, secrets: &crate::settings::Secrets) -> Result<(), AgentError> {
            self.0
                .borrow_mut()
                .insert(id.into(), serde_json::to_string(secrets)?);
            Ok(())
        }
        fn delete(&self, id: &str) -> Result<(), AgentError> {
            self.0.borrow_mut().remove(id);
            Ok(())
        }
    }
    #[test]
    fn reset_removes_only_downloader_configuration_and_password() {
        use crate::{
            settings::{SaveRequest, SecretChange, Settings},
            storage,
        };
        let directory = tempfile::tempdir().unwrap();
        let store = Memory::default();
        let trace = Trace::new();
        let initial = Settings {
            gateway_url: "https://gateway.example/".into(),
            gateway_enabled: false,
            downloader_configured: true,
            username: "local-user".into(),
            ..Settings::default()
        };
        storage::save(
            directory.path(),
            SaveRequest {
                settings: initial.clone(),
                api_key: SecretChange::Set("test-api-key".into()),
                password: SecretChange::Set("test-password".into()),
            },
            &store,
            &trace,
        )
        .unwrap();
        let target = crate::device::target(directory.path(), &initial).unwrap();
        for name in ["identity.json", crate::journal::JOURNAL] {
            std::fs::write(directory.path().join(name), b"retained-history").unwrap();
        }
        let targets_before =
            std::fs::read(directory.path().join("downloader-targets.json")).unwrap();
        let snapshot = reset(directory.path(), &store, &trace).unwrap();
        assert!(!snapshot.settings.downloader_configured);
        assert!(!snapshot.settings.gateway_enabled);
        assert!(snapshot.settings.downloader_url.is_empty());
        assert!(snapshot.settings.username.is_empty());
        assert!(snapshot.has_api_key && !snapshot.has_password);
        let stored = storage::load(directory.path()).unwrap();
        let secrets = storage::secrets(&stored, &store).unwrap();
        assert_eq!(secrets.api_key, "test-api-key");
        assert!(secrets.password.is_empty());
        let public = serde_json::to_string(&snapshot).unwrap();
        assert!(!public.contains("test-api-key") && !public.contains("test-password"));
        assert_eq!(
            targets_before,
            std::fs::read(directory.path().join("downloader-targets.json")).unwrap()
        );
        assert!(crate::device::target(directory.path(), &initial).unwrap() == target);
        for name in ["identity.json", crate::journal::JOURNAL] {
            assert_eq!(
                std::fs::read(directory.path().join(name)).unwrap(),
                b"retained-history"
            );
        }
    }

    #[tokio::test]
    async fn test_commits_only_downloader_after_success_and_preserves_good_settings_on_failure() {
        use crate::{
            settings::{SaveRequest, SecretChange, Settings},
            storage,
        };
        let dir = tempfile::tempdir().unwrap();
        let store = Memory::default();
        let trace = Trace::new();
        storage::save(
            dir.path(),
            SaveRequest {
                settings: Settings {
                    gateway_url: "https://gateway.example/".into(),
                    locale: "zh-CN".into(),
                    autostart: false,
                    ..Settings::default()
                },
                api_key: SecretChange::Set("gateway-key".into()),
                password: SecretChange::Set("previous-password".into()),
            },
            &store,
            &trace,
        )
        .unwrap();
        std::fs::write(
            dir.path().join("identity.json"),
            b"existing-device-identity",
        )
        .unwrap();
        let (url, server) = mock(vec![
            response("200 OK", "", "Ok."),
            response("200 OK", "", "v5.0.0"),
        ])
        .await;
        let mut input = request(Provider::Qbittorrent, url.clone());
        input.password = SecretChange::Set("tested-password".into());
        let saved = test_and_save(dir.path(), input, &store, &trace)
            .await
            .unwrap();
        server.await.unwrap();
        assert_eq!(saved.settings.downloader_url, format!("{url}/"));
        assert!(saved.settings.downloader_configured);
        assert_eq!(saved.settings.gateway_url, "https://gateway.example/");
        assert_eq!(saved.settings.locale, "zh-CN");
        assert!(!saved.settings.autostart);
        let secrets = storage::secrets(&storage::load(dir.path()).unwrap(), &store).unwrap();
        assert_eq!(secrets.api_key, "gateway-key");
        assert_eq!(secrets.password, "tested-password");
        let before = std::fs::read(dir.path().join("settings.json")).unwrap();
        let credentials = store.0.borrow().clone();
        let (url, server) = mock(vec![response("401 Unauthorized", "", "")]).await;
        let mut input = request(Provider::Transmission, url);
        input.password = SecretChange::Set("rejected-password".into());
        assert_eq!(
            test_and_save(dir.path(), input, &store, &trace)
                .await
                .err()
                .unwrap()
                .code,
            "authenticationError"
        );
        server.await.unwrap();
        assert_eq!(
            std::fs::read(dir.path().join("settings.json")).unwrap(),
            before
        );
        assert_eq!(*store.0.borrow(), credentials);
        assert_eq!(
            std::fs::read(dir.path().join("identity.json")).unwrap(),
            b"existing-device-identity"
        );
        let input = request(
            Provider::Transmission,
            "http://127.0.0.1:1/new-target".into(),
        );
        assert_eq!(
            test_and_save(dir.path(), input, &store, &trace)
                .await
                .err()
                .unwrap()
                .code,
            "targetChanged"
        );
        assert_eq!(
            std::fs::read(dir.path().join("settings.json")).unwrap(),
            before
        );
    }
    #[tokio::test]
    async fn qbittorrent_login_cookie_and_read_only_version() {
        let (url, server) = mock(vec![
            response(
                "200 OK",
                "Set-Cookie: SID=test-session; HttpOnly\r\n",
                "Ok.",
            ),
            response("200 OK", "", "v5.0.0"),
        ])
        .await;
        test(
            request(Provider::Qbittorrent, format!("{url}/prefix")),
            "p& word".into(),
            &Trace::new(),
        )
        .await
        .unwrap();
        let requests = server.await.unwrap();
        assert!(requests[0].starts_with("POST /prefix/api/v2/auth/login "));
        assert!(requests[0].contains("username=user&password=p%26+word"));
        assert!(requests[1].starts_with("GET /prefix/api/v2/app/version "));
        assert!(requests[1]
            .to_lowercase()
            .contains("cookie: sid=test-session"));
        assert!(!requests[1].contains("p%26"));
    }
    #[tokio::test]
    async fn transmission_legacy_and_modern_session_handshake() {
        for (modern, path) in [(false, ""), (true, "/custom/rpc")] {
            let extra = if modern {
                "X-Transmission-Rpc-Version: 6.0.0\r\n"
            } else {
                ""
            };
            let body = if modern {
                r#"{"jsonrpc":"2.0","id":1,"result":{"version":"4.1.0"}}"#
            } else {
                r#"{"result":"success","tag":1,"arguments":{"version":"4.0.6"}}"#
            };
            let (url, server) = mock(vec![
                response(
                    "409 Conflict",
                    &format!("X-Transmission-Session-Id: test-session\r\n{extra}"),
                    "",
                ),
                response("200 OK", "", body),
            ])
            .await;
            test(
                request(Provider::Transmission, format!("{url}{path}")),
                "pass".into(),
                &Trace::new(),
            )
            .await
            .unwrap();
            let requests = server.await.unwrap();
            assert!(requests[0].starts_with(&format!(
                "POST {} ",
                if path.is_empty() {
                    "/transmission/rpc"
                } else {
                    path
                }
            )));
            assert!(requests[0]
                .to_lowercase()
                .contains("authorization: basic dxnlcjpwyxnz"));
            assert!(requests[1]
                .to_lowercase()
                .contains("x-transmission-session-id: test-session"));
            assert!(requests[1].contains(if modern { "session_get" } else { "session-get" }));
        }
    }
    #[tokio::test]
    async fn rejects_auth_failures_redirects_and_invalid_rpc_response() {
        for (status, headers, body, expected) in [
            ("401 Unauthorized", "", "", "authenticationError"),
            (
                "302 Found",
                "Location: http://127.0.0.1:1/leak\r\n",
                "",
                "httpError",
            ),
            ("200 OK", "", "<html>login</html>", "invalidResponse"),
            ("409 Conflict", "", "", "invalidResponse"),
            (
                "200 OK",
                "",
                r#"{"result":"success","tag":2,"arguments":{"version":"4"}}"#,
                "invalidResponse",
            ),
        ] {
            let (url, server) = mock(vec![response(status, headers, body)]).await;
            let error = test(
                request(Provider::Transmission, url),
                "pass".into(),
                &Trace::new(),
            )
            .await
            .unwrap_err();
            assert_eq!(error.code, expected);
            if expected == "httpError" || expected == "authenticationError" {
                assert_eq!(error.http_status, Some(status[..3].parse().unwrap()));
            }
            assert_eq!(server.await.unwrap().len(), 1);
        }
    }
    #[tokio::test]
    async fn bounds_response_body_and_qb_rejected_login() {
        for (body, expected) in [
            ("Fails.".into(), "authenticationError"),
            ("x".repeat(4194305), "invalidResponse"),
        ] {
            let (url, server) = mock(vec![response("200 OK", "", &body)]).await;
            let error = test(
                request(Provider::Qbittorrent, url),
                "pass".into(),
                &Trace::new(),
            )
            .await
            .unwrap_err();
            assert_eq!(error.code, expected);
            server.await.unwrap();
        }
    }
}
