use super::*;
use crate::{
    credentials::CredentialStore,
    journal::{Journal, JOURNAL},
    settings::{Provider, Secrets},
};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader},
    sync::{Arc, Mutex},
};
#[derive(Default)]
struct Memory(Mutex<HashMap<String, String>>);
impl CredentialStore for Memory {
    fn read(&self, id: &str) -> Result<Secrets, AgentError> {
        serde_json::from_str(
            self.0
                .lock()
                .unwrap()
                .get(id)
                .ok_or(AgentError::code("credentialError"))?,
        )
        .map_err(Into::into)
    }
    fn write(&self, id: &str, secrets: &Secrets) -> Result<(), AgentError> {
        self.0
            .lock()
            .unwrap()
            .insert(id.into(), serde_json::to_string(secrets)?);
        Ok(())
    }
    fn delete(&self, id: &str) -> Result<(), AgentError> {
        self.0.lock().unwrap().remove(id);
        Ok(())
    }
}
struct Fixture {
    process: std::process::Child,
    url: String,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.process.kill();
        let _ = self.process.wait();
    }
}
impl Fixture {
    fn start() -> Self {
        crate::diagnostics::quiet_tests();
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(4)
            .unwrap();
        let mut process = std::process::Command::new("node")
            .arg("--import")
            .arg(root.join("apps/api/node_modules/tsx/dist/loader.mjs"))
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../tools/mock-gateway.mjs"
            ))
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut url = String::new();
        BufReader::new(process.stdout.take().unwrap())
            .read_line(&mut url)
            .unwrap();
        assert!(
            url.starts_with("http://127.0.0.1:"),
            "fixture did not start"
        );
        Self {
            process,
            url: url.trim().into(),
        }
    }
    async fn control(&self, payload: Value) {
        let response = client()
            .unwrap()
            .post(format!("{}/test/control", self.url))
            .json(&payload)
            .send()
            .await
            .unwrap();
        assert!(
            response.status().is_success(),
            "fixture control failed: {}",
            response.status()
        );
    }
    async fn stats(&self) -> Value {
        client()
            .unwrap()
            .get(format!("{}/test/stats", self.url))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap()
    }
    async fn wait(&self, predicate: impl Fn(&Value) -> bool) -> Value {
        let start = Instant::now();
        loop {
            let stats = self.stats().await;
            if predicate(&stats) {
                return stats;
            }
            assert!(
                start.elapsed() < Duration::from_secs(40),
                "fixture timeout: auth={}, adds={}, events={}, errors={}",
                stats["auth"],
                stats["adds"],
                stats["events"].as_array().unwrap().len(),
                stats["errors"]
            );
            tokio::time::sleep(Duration::from_millis(60)).await;
        }
    }
    async fn ready(&self, auth: u64) -> Value {
        self.wait(|s| {
            s["auth"].as_u64().unwrap() >= auth
                && s["statuses"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|s| s["reachable"] == true)
        })
        .await
    }
}
struct Client {
    directory: tempfile::TempDir,
    settings: Settings,
    key: String,
    store: Memory,
    runtime: Arc<Runtime>,
    lock: Arc<tokio::sync::Mutex<()>>,
}
impl Client {
    fn new(fixture: &Fixture, provider: Provider) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let store = Memory::default();
        let settings = Settings {
            downloader_configured: true,
            gateway_url: fixture.url.clone(),
            downloader_url: format!(
                "{}{}",
                fixture.url,
                if provider == Provider::Qbittorrent {
                    "/qb"
                } else {
                    "/transmission/rpc"
                }
            ),
            provider,
            ..Settings::default()
        };
        let identity = Identity {
            binding_requested: true,
            ..Identity::default()
        };
        journal::atomic(directory.path(), "identity.json", &identity).unwrap();
        let (_, keys) = crate::device::identity(directory.path(), &settings, &store).unwrap();
        let key = serde_json::to_string(&keys).unwrap();
        Self {
            directory,
            settings,
            key,
            store,
            runtime: Arc::new(Runtime::default()),
            lock: Default::default(),
        }
    }
    fn start(&self) -> tokio::task::JoinHandle<Result<(), AgentError>> {
        self.start_with_key("fixture-api-key")
    }
    fn start_with_key(
        &self,
        api_key: &'static str,
    ) -> tokio::task::JoinHandle<Result<(), AgentError>> {
        let directory = self.directory.path().to_path_buf();
        let settings = self.settings.clone();
        let key = self.key.clone();
        let runtime = self.runtime.clone();
        let lock = self.lock.clone();
        tokio::spawn(async move {
            let identity = journal::load(&directory, "identity.json")?;
            session_transport(
                &directory,
                &lock,
                &runtime,
                settings,
                Secrets {
                    api_key: api_key.into(),
                    password: std::env::var("HELPER_REAL_DOWNLOADER_PASSWORD")
                        .unwrap_or_else(|_| "dummy-password".into()),
                },
                identity,
                serde_json::from_str(&key)?,
            )
            .await
        })
    }
    fn journal(&self) -> Journal {
        journal::load(self.directory.path(), JOURNAL).unwrap()
    }
}
fn event(s: &Value, field: &str, value: &str) -> bool {
    s["events"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["payload"][field] == value)
}
async fn stop(task: tokio::task::JoinHandle<Result<(), AgentError>>) -> Result<(), AgentError> {
    tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .expect("session failed to stop promptly")
        .unwrap()
}

#[tokio::test]
#[ignore = "Loopback integration with real Gateway code and simulated persistence/downloaders; HELPER_ALLOW_INSECURE_DEV=true"]
async fn gateway_protocol_recovery_matrix() {
    for (provider, modern) in [
        (Provider::Qbittorrent, false),
        (Provider::Transmission, false),
        (Provider::Transmission, true),
    ] {
        let fixture = Fixture::start();
        fixture
            .control(json!({"modern":modern,"dropAuthResult":true}))
            .await;
        let mut client = Client::new(&fixture, provider);
        let first = client.start();
        assert!(stop(first).await.is_err());
        let operation: Identity = journal::load(client.directory.path(), "identity.json").unwrap();
        assert!(operation.device_id.is_none());
        let task = client.start();
        fixture.ready(2).await;
        let bound: Identity = journal::load(client.directory.path(), "identity.json").unwrap();
        assert_eq!(operation.installation_id, bound.installation_id);
        assert_eq!(fixture.stats().await["binds"], 1);
        let command = uuid::Uuid::new_v4().to_string();
        fixture
            .control(json!({"issue":true,"commandId":command,"dropAdd":true,"dropAck":true}))
            .await;
        fixture.wait(|s| event(s, "outcome", "succeeded")).await;
        let stats = fixture
            .wait(|s| s["duplicateEvents"].as_u64().unwrap() > 0)
            .await;
        assert_eq!(stats["adds"], 1);
        // Duplicate delivery requests may replay the same grant; only one execution is authorized.
        assert_eq!(stats["grantedExecutions"].as_array().unwrap().len(), 1);
        let received = stats["received"].as_array().unwrap();
        assert_eq!(received[0], received[1]);
        fixture
            .control(json!({"issue":true,"commandId":command}))
            .await;
        fixture
            .control(json!({"phase":"paused","dropAckState":"paused"}))
            .await;
        let previous = fixture.wait(|s| event(s, "state", "paused")).await["duplicateEvents"]
            .as_u64()
            .unwrap();
        assert!(
            client
                .journal()
                .events
                .iter()
                .any(|event| event.wire.payload["state"] == "paused"),
            "the fault must actually leave the paused event unacknowledged"
        );
        fixture.control(json!({"disconnect":true})).await;
        assert!(stop(task).await.is_err());
        let task = client.start();
        fixture.ready(3).await;
        fixture
            .wait(|s| {
                s["duplicateEvents"].as_u64().unwrap() > previous
                    && s["recoveries"].as_u64().unwrap() > 0
            })
            .await;
        assert_eq!(fixture.stats().await["binds"], 1);
        let after: Identity = journal::load(client.directory.path(), "identity.json").unwrap();
        assert_eq!(after.device_id, bound.device_id);
        for phase in ["completed", "failed"] {
            fixture.control(json!({"phase":phase})).await;
            fixture.wait(|s| event(s, "state", phase)).await;
        }
        // Downloading progress is periodic; identical event retries are separate from new sequence snapshots.
        if client.settings.provider == Provider::Qbittorrent {
            fixture.control(json!({"phase":"downloading"})).await;
            let baseline = fixture
                .wait(|s| {
                    s["events"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter(|e| e["payload"]["state"] == "downloading")
                        .count()
                        >= 2
                })
                .await;
            let count = baseline["events"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|e| e["payload"]["state"] == "downloading")
                .count();
            fixture
                .wait(|s| {
                    s["events"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter(|e| e["payload"]["state"] == "downloading")
                        .count()
                        > count
                })
                .await;
        }
        fixture.control(json!({"offline":true})).await;
        fixture.wait(|s| event(s, "state", "unreachable")).await;
        fixture
            .control(json!({"offline":false,"clearTasks":true}))
            .await;
        fixture.wait(|s| event(s, "state", "deleted")).await;
        fixture
            .control(json!({"manual":"b".repeat(40),"issue":true,"hash":"b".repeat(40)}))
            .await;
        fixture.wait(|s| event(s, "outcome", "duplicate")).await;
        assert_eq!(fixture.stats().await["adds"], 1);
        fixture
            .control(json!({"neverCreate":true,"dropAdd":true,"issue":true,"hash":"c".repeat(40)}))
            .await;
        fixture
            .wait(|s| {
                s["adds"] == 2
                    && s["commands"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|c| c["result"]["outcome"] == "unknown")
            })
            .await;
        let journal = client.journal();
        assert!(journal
            .records
            .iter()
            .any(|r| r.info_hash == "c".repeat(40) && r.phase == "unknown"));
        let old_target = crate::device::target(client.directory.path(), &client.settings).unwrap();
        fixture.control(json!({"disconnect":true})).await;
        assert!(stop(task).await.is_err());
        let original = client.settings.downloader_url.clone();
        client.settings.username = "other-instance".into();
        let task = client.start();
        fixture.ready(4).await;
        let changed = crate::device::target(client.directory.path(), &client.settings).unwrap();
        assert!(changed != old_target);
        fixture
            .wait(|s| s["recoveries"].as_u64().unwrap() >= 3)
            .await;
        assert_eq!(fixture.stats().await["adds"], 2);
        fixture.control(json!({"disconnect":true})).await;
        assert!(stop(task).await.is_err());
        client.settings.downloader_url = original;
        client.settings.username.clear();
        let task = client.start();
        fixture.ready(5).await;
        assert!(
            crate::device::target(client.directory.path(), &client.settings).unwrap() != old_target
        );
        fixture
            .control(json!({"issue":true,"expired":true,"hash":"d".repeat(40)}))
            .await;
        assert_eq!(stop(task).await.unwrap_err().code, "invalidCommand");
        assert_eq!(fixture.stats().await["adds"], 2);
        let task = client.start();
        fixture.ready(6).await;
        fixture
            .control(if modern {
                json!({"unbind":true})
            } else {
                json!({"revoke":true})
            })
            .await;
        assert_eq!(stop(task).await.unwrap_err().code, "sessionRevoked");
        // A takeover alone does not destroy device identity. A subsequent authenticated check
        // distinguishes invalid RCCK/device binding from a revoked connection.
        let current: Identity = journal::load(client.directory.path(), "identity.json").unwrap();
        assert!(!current.revoked);
        let check = client.start();
        assert_eq!(stop(check).await.unwrap_err().code, "rebindRequired");
        let revoked: Identity = journal::load(client.directory.path(), "identity.json").unwrap();
        assert!(revoked.revoked);
        assert_eq!(revoked.device_id, bound.device_id);
        assert_eq!(
            crate::device::identity(client.directory.path(), &client.settings, &client.store)
                .err()
                .unwrap()
                .code,
            "rebindRequired"
        );
        let serialized = std::fs::read_to_string(client.directory.path().join(JOURNAL)).unwrap();
        for forbidden in [
            "DO_NOT_LOG",
            "torrentUrl",
            "dummy-password",
            "fixture-api-key",
            "encryptionKey",
        ] {
            assert!(!serialized.contains(forbidden));
        }
        let stats = fixture.stats().await;
        assert_eq!(
            stats["errors"],
            if modern {
                json!(["INVALID_API_KEY"])
            } else {
                json!([])
            }
        );
        let statuses: Vec<_> = stats["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["command"] == "__download_status__")
            .collect();
        assert!(statuses
            .iter()
            .all(|e| e["payload"]["evidence"]["torrentHash"] == "a".repeat(40)));
        for pair in statuses.windows(2) {
            assert!(
                pair[0]["payload"]["sequence"].as_u64().unwrap()
                    < pair[1]["payload"]["sequence"].as_u64().unwrap()
            );
        }
        let mut identities = HashMap::new();
        for wire in stats["received"].as_array().unwrap() {
            if let Some(old) = identities.insert(wire["messageId"].as_str().unwrap(), wire) {
                assert_eq!(old, wire);
            }
        }
    }
}

#[tokio::test]
#[ignore = "Loopback security/recovery checks against real Gateway; HELPER_ALLOW_INSECURE_DEV=true"]
async fn gateway_rejects_tampering_and_never_replays_lost_grants() {
    let fixture = Fixture::start();
    let client = Client::new(&fixture, Provider::Qbittorrent);
    for (index, field) in [
        "expired",
        "wrongSession",
        "wrongOwner",
        "wrongHash",
        "tampered",
    ]
    .iter()
    .enumerate()
    {
        let task = client.start();
        fixture.ready(index as u64 + 1).await;
        let mut control = json!({"issue":true});
        control[*field] = json!(true);
        fixture.control(control).await;
        assert_eq!(stop(task).await.unwrap_err().code, "invalidCommand");
        assert_eq!(fixture.stats().await["adds"], 0);
    }
    let task = client.start();
    fixture.ready(6).await;
    fixture
        .control(json!({"corrupt":"grant","issue":true}))
        .await;
    assert_eq!(stop(task).await.unwrap_err().code, "invalidCommand");
    assert_eq!(fixture.stats().await["adds"], 0);
    let task = client.start();
    fixture.ready(7).await;
    fixture
        .control(json!({"dropGrant":true,"issue":true}))
        .await;
    assert!(stop(task).await.is_err());
    let task = client.start();
    fixture.ready(8).await;
    fixture
        .wait(|s| s["recoveries"].as_u64().unwrap() >= 2)
        .await;
    assert_eq!(fixture.stats().await["adds"], 0);
    assert!(client
        .journal()
        .records
        .iter()
        .all(|r| r.phase == "abandoned"));
    fixture.control(json!({"disconnect":true})).await;
    let _ = stop(task).await;
}
#[tokio::test]
#[ignore = "Loopback revocation during a slow downloader HTTP request; HELPER_ALLOW_INSECURE_DEV=true"]
async fn gateway_revocation_cancels_execution_without_losing_uncertainty() {
    let fixture = Fixture::start();
    let client = Client::new(&fixture, Provider::Qbittorrent);
    let task = client.start();
    fixture.ready(1).await;
    fixture.control(json!({"slowAdd":true,"issue":true})).await;
    fixture.wait(|s| s["adds"] == 1).await;
    let start = Instant::now();
    fixture.control(json!({"revoke":true})).await;
    assert_eq!(stop(task).await.unwrap_err().code, "sessionRevoked");
    assert!(start.elapsed() < Duration::from_secs(2));
    assert_eq!(client.journal().records[0].phase, "unknown");
    assert_eq!(fixture.stats().await["adds"], 1);
}

#[tokio::test]
#[ignore = "Loopback authentication/status diagnostics against real Gateway"]
async fn gateway_identity_http_errors_keep_status_and_do_not_bind() {
    let fixture = Fixture::start();
    let mut client = Client::new(&fixture, Provider::Qbittorrent);
    let error = stop(client.start_with_key("incorrect-fixture-key"))
        .await
        .unwrap_err();
    assert_eq!(error.code, "rebindRequired");
    assert_eq!(error.http_status, Some(401));
    assert_eq!(fixture.stats().await["binds"], 0);
    client.settings.gateway_url.push_str("/missing");
    let error = stop(client.start()).await.unwrap_err();
    assert_eq!(error.code, "gatewayProtocol");
    assert_eq!(error.http_status, Some(404));
    assert_eq!(fixture.stats().await["binds"], 0);
}
#[tokio::test]
#[ignore = "Loopback session takeover against real Gateway"]
async fn gateway_identity_takeover_does_not_destroy_the_new_sessions_keys() {
    let fixture = Fixture::start();
    let client = Client::new(&fixture, Provider::Qbittorrent);
    let old = client.start();
    fixture.ready(1).await;
    let before: Identity = journal::load(client.directory.path(), "identity.json").unwrap();
    let fresh = client.start();
    fixture.ready(2).await;
    assert_eq!(stop(old).await.unwrap_err().code, "sessionRevoked");
    let after: Identity = journal::load(client.directory.path(), "identity.json").unwrap();
    assert!(!after.revoked);
    assert_eq!(before.device_id, after.device_id);
    assert_eq!(before.credential_id, after.credential_id);
    assert_eq!(fixture.stats().await["binds"], 1);
    fixture.control(json!({"disconnect":true})).await;
    let _ = stop(fresh).await;
}

#[tokio::test]
#[ignore = "Loopback 64-hex command with a distinct simulated qBittorrent API task ID"]
async fn gateway_identity_full_v2_hash_is_not_confused_with_the_downloader_task_id() {
    let fixture = Fixture::start();
    let client = Client::new(&fixture, Provider::Qbittorrent);
    let task = client.start();
    fixture.ready(1).await;
    fixture
        .control(json!({"issue":true,"hash":"e".repeat(64)}))
        .await;
    let stats = fixture.wait(|s| event(s, "outcome", "succeeded")).await;
    let success = stats["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["payload"]["outcome"] == "succeeded")
        .unwrap();
    assert_eq!(
        success["payload"]["evidence"]["torrentHash"],
        "e".repeat(64)
    );
    assert_eq!(success["payload"]["evidence"]["taskId"], "e".repeat(40));
    assert_eq!(stats["adds"], 1);
    fixture.control(json!({"disconnect":true})).await;
    let _ = stop(task).await;
}

#[tokio::test]
#[ignore = "Loopback user disconnect and reconnect with a possibly submitted add; HELPER_ALLOW_INSECURE_DEV=true"]
async fn gateway_user_disconnect_preserves_unknown_result_and_device_identity() {
    let fixture = Fixture::start();
    let client = Client::new(&fixture, Provider::Qbittorrent);
    let task = client.start();
    fixture.ready(1).await;
    let identity = std::fs::read(client.directory.path().join("identity.json")).unwrap();
    fixture.control(json!({"slowAdd":true,"issue":true})).await;
    fixture.wait(|s| s["adds"] == 1).await;
    client
        .runtime
        .suspended
        .store(true, std::sync::atomic::Ordering::SeqCst);
    client.runtime.changed.notify_one();
    stop(task).await.unwrap();
    assert_eq!(client.journal().records[0].phase, "unknown");
    assert_eq!(
        identity,
        std::fs::read(client.directory.path().join("identity.json")).unwrap()
    );
    fixture.control(json!({"slowAdd":false})).await;
    client
        .runtime
        .suspended
        .store(false, std::sync::atomic::Ordering::SeqCst);
    let task = client.start();
    fixture.ready(2).await;
    assert_eq!(fixture.stats().await["binds"], 1);
    assert_eq!(fixture.stats().await["adds"], 1);
    client.runtime.changed.notify_one();
    stop(task).await.unwrap();
}

#[tokio::test]
#[ignore = "Real Agent/Gateway queue attempts with simulated downloader and stores"]
async fn gateway_queued_retry_preserves_attempt_history_and_never_adds_twice() {
    let fixture = Fixture::start();
    let client = Client::new(&fixture, Provider::Qbittorrent);
    let task = client.start();
    fixture.ready(1).await;
    fixture.control(json!({"issue":true,"queue":true,"commandId":"queued-retry","downloadId":"queued-download","failPreflight":true})).await;
    fixture.wait(|s| event(s, "outcome", "failed")).await;
    assert_eq!(fixture.stats().await["adds"], 0);
    fixture.control(json!({"retry":"queued-retry"})).await;
    let stats = fixture.wait(|s| event(s, "outcome", "succeeded")).await;
    assert_eq!(stats["adds"], 1);
    assert_eq!(stats["grants"], 2);
    let journal = client.journal();
    assert_eq!(journal.records.len(), 2);
    assert_eq!(journal.records[0].retry_attempt, Some(1));
    assert_eq!(journal.records[1].retry_attempt, Some(2));
    assert_eq!(
        journal.records[0].queue_expires_at,
        journal.records[1].queue_expires_at
    );
    assert_ne!(
        journal.records[0].execution_id,
        journal.records[1].execution_id
    );
    fixture
        .control(json!({"issue":true,"commandId":"queued-retry"}))
        .await;
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(fixture.stats().await["adds"], 1);
    client.runtime.changed.notify_one();
    stop(task).await.unwrap();
}

#[tokio::test]
#[ignore = "Real Agent/Gateway negative reports with simulated stores and HTTP API"]
async fn gateway_reports_unconfigured_and_reset_identity_without_idle_tasks() {
    let fixture = Fixture::start();
    let mut client = Client::new(&fixture, Provider::Transmission);
    client.settings.downloader_configured = false;
    let task = client.start();
    let first = fixture
        .wait(|s| s["statusReports"].as_array().is_some_and(|s| !s.is_empty()))
        .await;
    let placeholder = first["statusReports"][0]["instanceId"].clone();
    assert_eq!(first["statusReports"][0]["configured"], false);
    assert_eq!(first["statusReports"][0]["reachable"], false);
    client.runtime.changed.notify_one();
    stop(task).await.unwrap();
    let task = client.start();
    fixture
        .wait(|s| s["auth"] == 2 && s["statusReports"].as_array().unwrap().len() >= 3)
        .await;
    assert_eq!(
        fixture.stats().await["statusReports"][2]["instanceId"],
        placeholder
    );
    client.runtime.changed.notify_one();
    stop(task).await.unwrap();
    client.settings.downloader_configured = true;
    let task = client.start();
    fixture.ready(3).await;
    let count = fixture.stats().await["statusReports"]
        .as_array()
        .unwrap()
        .len();
    fixture
        .wait(|s| {
            s["statusReports"].as_array().unwrap().len() > count
                && s["statusReports"].as_array().unwrap().last().unwrap()["reachable"] == true
        })
        .await;
    assert_eq!(fixture.stats().await["adds"], 0);
    let stored = crate::settings::StoredSettings {
        settings: Settings::default(),
        ..Default::default()
    };
    journal::atomic(client.directory.path(), "settings.json", &stored).unwrap();
    client.runtime.changed.notify_one();
    stop(task).await.unwrap();
    let stats = fixture
        .wait(|s| s["statusReports"].as_array().unwrap().last().unwrap()["reachable"] == false)
        .await;
    let reports = stats["statusReports"].as_array().unwrap();
    assert_eq!(reports.last().unwrap()["configured"], false);
    let online = reports
        .iter()
        .rev()
        .find(|r| r["reachable"] == true)
        .unwrap();
    assert_eq!(online["instanceId"], reports.last().unwrap()["instanceId"]);
    assert_eq!(
        online["downloaderType"],
        reports.last().unwrap()["downloaderType"]
    );
}

#[tokio::test]
#[ignore = "Real Agent/Gateway offline queue with simulated stores and downloader"]
async fn gateway_offline_queue_delivers_on_reconnect_with_original_deadline() {
    let fixture = Fixture::start();
    let client = Client::new(&fixture, Provider::Qbittorrent);
    let task = client.start();
    fixture.ready(1).await;
    fixture.control(json!({"disconnect":true})).await;
    assert!(stop(task).await.is_err());
    fixture.wait(|s| s["clients"] == 0).await;
    fixture.control(json!({"issue":true,"queue":true,"commandId":"offline-queue","downloadId":"offline-download"})).await;
    let first = fixture.stats().await;
    assert_eq!(first["adds"], 0);
    let deadline = first["commands"][0]["queueExpiresAt"].clone();
    assert!(deadline.as_u64().unwrap() > 0);
    let task = client.start();
    fixture.ready(2).await;
    fixture.control(json!({"retry":"offline-queue"})).await;
    let done = fixture.wait(|s| event(s, "outcome", "succeeded")).await;
    assert_eq!(done["adds"], 1);
    assert_eq!(done["commands"][0]["queueExpiresAt"], deadline);
    client.runtime.changed.notify_one();
    stop(task).await.unwrap();
}

#[tokio::test]
#[ignore = "Opt-in live Transmission test; requires HELPER_REAL_DOWNLOADER_URL/USERNAME/PASSWORD and HELPER_REAL_TORRENT_URL/HASH; adds and pauses a test task"]
async fn live_transmission_queued_push_produces_real_evidence() {
    use crate::downloads::Downloader;
    let url = std::env::var("HELPER_REAL_DOWNLOADER_URL").expect("set live downloader URL");
    let username =
        std::env::var("HELPER_REAL_DOWNLOADER_USERNAME").expect("set live downloader username");
    let password =
        std::env::var("HELPER_REAL_DOWNLOADER_PASSWORD").expect("set live downloader password");
    let hash = std::env::var("HELPER_REAL_TORRENT_HASH").expect("set test torrent hash");
    let fixture = Fixture::start();
    let mut client = Client::new(&fixture, Provider::Transmission);
    client.settings.downloader_url = url.clone();
    client.settings.username = username.clone();
    let mut downloader =
        Downloader::connect(client.settings.clone(), password.clone(), &Trace::new())
            .await
            .unwrap();
    downloader.probe().await.unwrap();
    assert!(
        downloader.tasks(&hash).await.unwrap().is_empty(),
        "test torrent already exists; refusing to adopt or modify it"
    );
    let task = client.start();
    fixture.ready(1).await;
    fixture.control(json!({"issue":true,"queue":true,"commandId":"live-transmission-test","downloadId":"live-transmission-download","hash":hash})).await;
    fixture.wait(|s| event(s, "outcome", "succeeded")).await;
    let record = client.journal().records[0].clone();
    assert_eq!(record.phase, "succeeded");
    assert_eq!(record.retry_attempt, Some(1));
    let found = downloader.tasks(&hash).await.unwrap();
    assert_eq!(found.len(), 1);
    assert!(crate::downloads::owned(&found[0], &record.marker()));
    assert_eq!(record.evidence.as_ref().unwrap()["torrentHash"], hash);
    fixture
        .control(json!({"issue":true,"commandId":"live-transmission-test"}))
        .await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(downloader.tasks(&hash).await.unwrap().len(), 1);
    // Pause only the task created by this test, after checking its full hash and ownership marker.
    let http = super::client().unwrap();
    let payload =
        json!({"method":"torrent-stop","arguments":{"ids":[found[0]["id"].clone()]},"tag":1});
    let first = http
        .post(&url)
        .basic_auth(&username, Some(&password))
        .json(&payload)
        .send()
        .await
        .unwrap();
    let response = if first.status().as_u16() == 409 {
        let session = first
            .headers()
            .get("x-transmission-session-id")
            .unwrap()
            .clone();
        http.post(&url)
            .basic_auth(&username, Some(&password))
            .header("x-transmission-session-id", session)
            .json(&payload)
            .send()
            .await
            .unwrap()
    } else {
        first
    };
    assert!(response.status().is_success());
    let receipt: Value = response.json().await.unwrap();
    assert_eq!(receipt["result"], "success");
    client.runtime.changed.notify_one();
    stop(task).await.unwrap();
}

#[tokio::test]
#[ignore = "Real Agent/Gateway queue metadata over loopback with simulated storage; no downloader is configured"]
async fn gateway_queue_metadata_is_available_without_a_download_tool() {
    let fixture = Fixture::start();
    let mut client = Client::new(&fixture, Provider::Transmission);
    client.settings.downloader_configured = false;
    let task = client.start();
    fixture
        .wait(|s| s["auth"] == 1 && !s["statusReports"].as_array().unwrap().is_empty())
        .await;
    fixture
        .control(json!({"issue":true,"queue":true,"commandId":"queue-metadata-only"}))
        .await;
    client.runtime.queue_refresh.notify_one();
    fixture
        .wait(|_| {
            crate::queue::view(client.directory.path(), &client.runtime)
                .snapshot
                .as_ref()
                .is_some_and(|s| s.total == 1)
        })
        .await;
    let view = crate::queue::view(client.directory.path(), &client.runtime);
    let snapshot = view.snapshot.unwrap();
    assert!(!view.stale);
    assert_eq!(snapshot.items[0].command_id, "queue-metadata-only");
    assert_eq!(snapshot.items[0].reason, "downloader_unavailable");
    assert_eq!(fixture.stats().await["adds"], 0);
    assert_eq!(fixture.stats().await["grants"], 0);
    client.runtime.changed.notify_one();
    stop(task).await.unwrap();
    let offline = Runtime::default();
    crate::queue::initialize(client.directory.path(), &offline);
    let cache = crate::queue::view(client.directory.path(), &offline);
    assert!(cache.stale);
    assert_eq!(cache.snapshot.unwrap().total, 1);
}
