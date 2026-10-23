//! Connection health is independent of Gateway sessions and submitted download tasks.
use crate::{
    credentials::{CredentialStore, NativeCredentials},
    diagnostics::Trace,
    downloader,
    errors::AgentError,
    runtime::Runtime,
    settings::{self, SecretChange, Settings, StoredSettings, TestRequest},
    storage, AgentState,
};
use std::{path::Path, time::Duration};
use tauri::Manager;

const INTERVAL: Duration = Duration::from_secs(5);
const TIMEOUT: Duration = Duration::from_secs(3);

struct Probe {
    settings: Settings,
    credential_id: Option<String>,
    password: String,
}
impl Probe {
    fn matches(&self, stored: &StoredSettings) -> bool {
        self.credential_id == stored.credential_id
            && settings::same_downloader_credentials(&self.settings, &stored.settings)
    }
}

fn load(
    directory: &Path,
    cached: &Option<Probe>,
    store: &impl CredentialStore,
) -> Result<Option<Probe>, AgentError> {
    if !directory.join("settings.json").exists() {
        return Ok(None);
    }
    let stored = storage::load(directory)?;
    if !stored.settings.downloader_configured {
        return Ok(None);
    }
    let password = match cached {
        Some(previous) if previous.credential_id == stored.credential_id => {
            previous.password.clone()
        }
        _ => storage::secrets(&stored, store)?.password,
    };
    Ok(Some(Probe {
        settings: stored.settings,
        credential_id: stored.credential_id,
        password,
    }))
}

async fn check(
    directory: &Path,
    lock: &tokio::sync::Mutex<()>,
    runtime: &Runtime,
    cached: &mut Option<Probe>,
    store: &impl CredentialStore,
) -> Result<(), AgentError> {
    let trace = Trace::new();
    trace.stage("downloader.health.started");
    let loaded = {
        let _guard = lock.lock().await;
        load(directory, cached, store)
    };
    *cached = match loaded {
        Ok(probe) => probe,
        Err(error) => {
            runtime.update(None, Some("unreachable"), None);
            trace.failed(&error);
            return Err(error);
        }
    };
    let Some(probe) = cached else {
        runtime.update(None, Some("unconfigured"), None);
        return Ok(());
    };
    // Never hold the settings lock during HTTP. A slow or stopped downloader must not block settings.
    let result = tokio::time::timeout(
        TIMEOUT,
        downloader::test(
            TestRequest {
                provider: probe.settings.provider.clone(),
                auth_mode: probe.settings.auth_mode.clone(),
                downloader_url: probe.settings.downloader_url.clone(),
                username: probe.settings.username.clone(),
                password: SecretChange::Keep,
            },
            probe.password.clone(),
            &trace,
        ),
    )
    .await
    .unwrap_or_else(|_| Err(AgentError::code("timeout")));
    {
        let _guard = lock.lock().await;
        // A test may save a new target while this probe is in flight. Discard stale results.
        if probe.matches(&storage::load(directory)?) {
            runtime.update(
                None,
                Some(if result.is_ok() {
                    "online"
                } else {
                    "unreachable"
                }),
                None,
            );
        }
    }
    match &result {
        Ok(()) => trace.stage("downloader.health.completed"),
        Err(error) => trace.failed(error),
    }
    result
}

pub async fn run(app: tauri::AppHandle) {
    let mut cached = None;
    let mut interval = tokio::time::interval(INTERVAL);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        let state = app.state::<AgentState>();
        let runtime = app.state::<Runtime>();
        tokio::select! {
            _ = interval.tick() => {},
            _ = runtime.downloader_changed.notified() => {},
        }
        let _ = check(
            &state.directory,
            &state.lock,
            &runtime,
            &mut cached,
            &NativeCredentials,
        )
        .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{journal, settings::Provider};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    struct EmptyCredentials;
    impl CredentialStore for EmptyCredentials {
        fn read(&self, _: &str) -> Result<crate::settings::Secrets, AgentError> {
            panic!("health checks must not access credentials when none are configured")
        }
        fn write(&self, _: &str, _: &crate::settings::Secrets) -> Result<(), AgentError> {
            panic!("health checks must never save credentials")
        }
        fn delete(&self, _: &str) -> Result<(), AgentError> {
            panic!("health checks must never delete credentials")
        }
    }
    fn listener(address: std::net::SocketAddr) -> tokio::net::TcpListener {
        let socket = tokio::net::TcpSocket::new_v4().unwrap();
        socket.set_reuseaddr(true).unwrap();
        socket.bind(address).unwrap();
        socket.listen(8).unwrap()
    }
    async fn respond(listener: tokio::net::TcpListener, provider: Provider) {
        for _ in 0..if provider == Provider::Qbittorrent {
            2
        } else {
            1
        } {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0_u8; 2048];
            loop {
                let count = socket.read(&mut buffer).await.unwrap();
                if count == 0 {
                    break;
                }
                bytes.extend_from_slice(&buffer[..count]);
                if let Some(at) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&bytes[..at]).to_lowercase();
                    let length = head
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length: "))
                        .map(|v| v.parse::<usize>().unwrap())
                        .unwrap_or(0);
                    if bytes.len() >= at + 4 + length {
                        break;
                    }
                }
            }
            let request = String::from_utf8(bytes).unwrap();
            let body = if provider == Provider::Transmission {
                assert!(request.starts_with("POST /transmission/rpc "));
                r#"{"result":"success","tag":1,"arguments":{"version":"4.0.6"}}"#
            } else if request.starts_with("POST /api/v2/auth/login ") {
                "Ok."
            } else {
                assert!(request.starts_with("GET /api/v2/app/version "));
                "v5.0.0"
            };
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        }
    }

    #[tokio::test]
    async fn detects_downloader_stop_and_restart_without_a_gateway_for_both_providers() {
        for provider in [Provider::Qbittorrent, Provider::Transmission] {
            let directory = tempfile::tempdir().unwrap();
            let server = listener("127.0.0.1:0".parse().unwrap());
            let address = server.local_addr().unwrap();
            let mut stored = StoredSettings::default();
            stored.settings.downloader_configured = true;
            stored.settings.provider = provider.clone();
            stored.settings.downloader_url = format!("http://{address}");
            journal::atomic(directory.path(), "settings.json", &stored).unwrap();
            let lock = tokio::sync::Mutex::new(());
            let runtime = Runtime::default();
            let mut cached = None;
            let handle = tokio::spawn(respond(server, provider.clone()));
            check(
                directory.path(),
                &lock,
                &runtime,
                &mut cached,
                &EmptyCredentials,
            )
            .await
            .unwrap();
            assert_eq!(runtime.snapshot().downloader, "online");
            assert_eq!(runtime.snapshot().service, "unconfigured");
            handle.await.unwrap();
            assert!(check(
                directory.path(),
                &lock,
                &runtime,
                &mut cached,
                &EmptyCredentials
            )
            .await
            .is_err());
            assert_eq!(runtime.snapshot().downloader, "unreachable");
            let restarted = tokio::spawn(respond(listener(address), provider));
            check(
                directory.path(),
                &lock,
                &runtime,
                &mut cached,
                &EmptyCredentials,
            )
            .await
            .unwrap();
            assert_eq!(runtime.snapshot().downloader, "online");
            restarted.await.unwrap();
        }
    }

    #[tokio::test]
    async fn slow_probe_cannot_overwrite_a_new_target_or_hold_the_settings_lock() {
        let directory = tempfile::tempdir().unwrap();
        let server = listener("127.0.0.1:0".parse().unwrap());
        let mut stored = StoredSettings::default();
        stored.settings.downloader_configured = true;
        stored.settings.provider = Provider::Transmission;
        stored.settings.downloader_url = format!("http://{}", server.local_addr().unwrap());
        journal::atomic(directory.path(), "settings.json", &stored).unwrap();
        let runtime = Runtime::default();
        let lock = tokio::sync::Mutex::new(());
        let mut cached = None;
        let probe = check(
            directory.path(),
            &lock,
            &runtime,
            &mut cached,
            &EmptyCredentials,
        );
        let change_target = async {
            let (mut connection, _) = server.accept().await.unwrap();
            let _guard = tokio::time::timeout(Duration::from_secs(1), lock.lock())
                .await
                .unwrap();
            stored.settings.downloader_url = "http://127.0.0.1:1".into();
            journal::atomic(directory.path(), "settings.json", &stored).unwrap();
            runtime.update(None, Some("online"), None);
            connection
                .write_all(b"HTTP/1.1 500 Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
        };
        let (result, ()) = tokio::join!(probe, change_target);
        assert!(result.is_err());
        assert_eq!(runtime.snapshot().downloader, "online");
    }

    #[tokio::test]
    async fn unconfigured_settings_are_disconnected_and_health_timeout_is_bounded() {
        let directory = tempfile::tempdir().unwrap();
        let runtime = Runtime::default();
        let lock = tokio::sync::Mutex::new(());
        let mut cached = None;
        check(
            directory.path(),
            &lock,
            &runtime,
            &mut cached,
            &EmptyCredentials,
        )
        .await
        .unwrap();
        assert_eq!(runtime.snapshot().downloader, "unconfigured");
        let server = listener("127.0.0.1:0".parse().unwrap());
        let mut stored = StoredSettings::default();
        stored.settings.downloader_configured = true;
        stored.settings.provider = Provider::Transmission;
        stored.settings.downloader_url = format!("http://{}", server.local_addr().unwrap());
        journal::atomic(directory.path(), "settings.json", &stored).unwrap();
        let started = std::time::Instant::now();
        let error = check(
            directory.path(),
            &lock,
            &runtime,
            &mut cached,
            &EmptyCredentials,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "timeout");
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(runtime.snapshot().downloader, "unreachable");
    }
}
