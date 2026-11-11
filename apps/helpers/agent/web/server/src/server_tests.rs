use crate::{
    auth::Auth,
    config::Config,
    credentials::{initialize_secrets, FileCredentials},
    server::WebServer,
};
use popular_agent_core::{credentials::CredentialStore, settings::Secrets};
use serde_json::{json, Value};
use std::{path::PathBuf, time::Duration};

const PASSWORD: &str = "local-test-password-not-for-production";
struct Fixture {
    root: tempfile::TempDir,
    base: String,
    client: reqwest::Client,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    task: Option<tokio::task::JoinHandle<Result<(), popular_agent_core::errors::AgentError>>>,
}
impl Fixture {
    async fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        initialize_secrets(&root.path().join("secrets")).unwrap();
        std::fs::write(root.path().join("secrets/admin-password"), PASSWORD).unwrap();
        std::fs::create_dir(root.path().join("ui")).unwrap();
        std::fs::write(
            root.path().join("ui/index.html"),
            "<!doctype html><title>Agent</title>",
        )
        .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let base = format!("http://{address}");
        let config = Config {
            bind: address,
            origin: base.clone(),
            authority: String::new(),
            secure_cookie: false,
            data: root.path().join("data"),
            static_dir: root.path().join("ui"),
            master_key: root.path().join("secrets/master.key"),
            admin_password: root.path().join("secrets/admin-password"),
            session_ttl: Duration::from_secs(3600),
        };
        let server = WebServer::new(config).unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(server.serve(listener, async {
            let _ = stopped.await;
        }));
        Self {
            root,
            base,
            stop: Some(stop),
            task: Some(task),
            client: reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap(),
        }
    }
    async fn login(&self) -> (String, String) {
        let response = self
            .client
            .post(format!("{}/api/session", self.base))
            .header("origin", &self.base)
            .json(&json!({"password":PASSWORD}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let cookie = response.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .to_owned();
        assert!(cookie.contains("HttpOnly") && cookie.contains("SameSite=Strict"));
        let value: Value = response.json().await.unwrap();
        (
            cookie.split(';').next().unwrap().into(),
            value["csrf"].as_str().unwrap().into(),
        )
    }
    async fn stop(mut self) {
        self.stop.take().unwrap().send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(8), self.task.take().unwrap())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

#[test]
fn credentials_are_encrypted_bound_to_id_and_reject_a_different_master_key() {
    let root = tempfile::tempdir().unwrap();
    initialize_secrets(&root.path().join("secrets")).unwrap();
    let directory = root.path().join("credentials");
    let key = root.path().join("secrets/master.key");
    let store = FileCredentials::open(&directory, &key).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let other = uuid::Uuid::new_v4().to_string();
    store
        .write(
            &id,
            &Secrets {
                api_key: "private-gateway-key".into(),
                password: "private-downloader-password".into(),
            },
        )
        .unwrap();
    let bytes = std::fs::read(directory.join(format!("{id}.json"))).unwrap();
    let text = String::from_utf8_lossy(&bytes);
    assert!(!text.contains("private-"));
    assert_eq!(
        store.read(&id).unwrap().password,
        "private-downloader-password"
    );
    std::fs::write(directory.join(format!("{other}.json")), &bytes).unwrap();
    assert!(store.read(&other).is_err());
    assert!(store.read("../master.key").is_err());
    drop(store);
    assert_eq!(
        FileCredentials::open(&directory, &key)
            .unwrap()
            .read(&id)
            .unwrap()
            .api_key,
        "private-gateway-key"
    );
    std::fs::write(&key, [7u8; 32]).unwrap();
    assert!(FileCredentials::open(&directory, &key).is_err());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(directory.join(format!("{id}.json")))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}
#[test]
fn secret_initialization_refuses_to_overwrite_and_missing_keys_do_not_regenerate() {
    let root = tempfile::tempdir().unwrap();
    let secrets = root.path().join("secrets");
    initialize_secrets(&secrets).unwrap();
    let key = std::fs::read(secrets.join("master.key")).unwrap();
    assert!(initialize_secrets(&secrets).is_err());
    assert_eq!(std::fs::read(secrets.join("master.key")).unwrap(), key);
    assert!(FileCredentials::open(
        &root.path().join("credentials"),
        &root.path().join("missing")
    )
    .is_err());
    assert!(!root.path().join("missing").exists());
}
#[tokio::test]
async fn sessions_expire_and_logout_revokes_only_the_current_session() {
    let auth = Auth::new(PASSWORD.as_bytes(), Duration::from_millis(5)).unwrap();
    assert!(!auth.verifier.verify(b"not-the-password"));
    let (first, session) = auth.create().unwrap();
    let (second, _) = auth.create().unwrap();
    assert_ne!(first, second);
    assert_ne!(first, session.csrf);
    auth.remove(&first);
    assert!(auth.session(&first).is_none());
    assert!(auth.session(&second).is_some());
    tokio::time::sleep(Duration::from_millis(10)).await;
    assert!(auth.session(&second).is_none());
}
#[tokio::test]
async fn management_requires_authentication_same_origin_and_csrf() {
    let f = Fixture::new().await;
    assert_eq!(
        f.client
            .get(format!("{}/health/ready", f.base))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        f.client
            .get(format!("{}/api/settings", f.base))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    let (cookie, csrf) = f.login().await;
    let response = f
        .client
        .get(format!("{}/api/settings", f.base))
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let value: Value = response.json().await.unwrap();
    assert_eq!(value["hasApiKey"], false);
    assert!(value.get("password").is_none());
    assert_eq!(
        f.client
            .put(format!("{}/api/locale", f.base))
            .header("origin", &f.base)
            .header("cookie", &cookie)
            .json(&json!({"locale":"zh-CN"}))
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        f.client
            .put(format!("{}/api/locale", f.base))
            .header("origin", "https://evil.example")
            .header("cookie", &cookie)
            .header("x-csrf-token", &csrf)
            .json(&json!({"locale":"zh-CN"}))
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        f.client
            .put(format!("{}/api/locale", f.base))
            .header("origin", &f.base)
            .header("cookie", &cookie)
            .header("x-csrf-token", &csrf)
            .json(&json!({"locale":"zh-CN","unexpected":"secret"}))
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    assert_eq!(
        f.client
            .put(format!("{}/api/locale", f.base))
            .header("origin", &f.base)
            .header("cookie", &cookie)
            .header("x-csrf-token", &csrf)
            .json(&json!({"locale":"zh-CN"}))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        f.client
            .delete(format!("{}/api/session", f.base))
            .header("origin", &f.base)
            .header("cookie", &cookie)
            .header("x-csrf-token", &csrf)
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        f.client
            .get(format!("{}/api/settings", f.base))
            .header("cookie", cookie)
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    assert_eq!(
        serde_json::from_slice::<Value>(
            &std::fs::read(f.root.path().join("data/settings.json")).unwrap()
        )
        .unwrap()["settings"]["locale"],
        "zh-CN"
    );
    f.stop().await;
}
#[tokio::test]
async fn static_routes_and_runtime_events_do_not_expose_files_or_secrets() {
    let f = Fixture::new().await;
    let response = f.client.get(&f.base).send().await.unwrap();
    assert_eq!(response.status(), 200);
    assert!(response.headers().contains_key("content-security-policy"));
    assert_eq!(
        f.client
            .get(format!("{}/settings.json", f.base))
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    assert_eq!(
        f.client
            .get(format!("{}/assets/%252e%252e/master.key", f.base))
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    assert_eq!(
        f.client
            .get(&f.base)
            .header("host", "evil.example")
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let (cookie, _) = f.login().await;
    let mut stream = f
        .client
        .get(format!("{}/api/events", f.base))
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(stream.headers()["content-type"], "text/event-stream");
    let first = stream.chunk().await.unwrap().unwrap();
    let text = String::from_utf8_lossy(&first);
    assert!(text.contains("event: runtime"));
    assert!(!text.contains(PASSWORD));
    assert!(!text.contains("csrf"));
    drop(stream);
    f.stop().await;
}
#[tokio::test]
async fn login_throttling_and_data_directory_lock_are_enforced() {
    let f = Fixture::new().await;
    let config = Config {
        bind: "127.0.0.1:0".parse().unwrap(),
        origin: f.base.clone(),
        authority: String::new(),
        secure_cookie: false,
        data: f.root.path().join("data"),
        static_dir: f.root.path().join("ui"),
        master_key: f.root.path().join("secrets/master.key"),
        admin_password: f.root.path().join("secrets/admin-password"),
        session_ttl: Duration::from_secs(3600),
    };
    assert!(WebServer::new(config).is_err());
    for _ in 0..8 {
        assert_eq!(
            f.client
                .post(format!("{}/api/session", f.base))
                .header("origin", &f.base)
                .json(&json!({"password":"wrong-password-long-enough"}))
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
    }
    assert_eq!(
        f.client
            .post(format!("{}/api/session", f.base))
            .header("origin", &f.base)
            .json(&json!({"password":PASSWORD}))
            .send()
            .await
            .unwrap()
            .status(),
        429
    );
    f.stop().await;
}
#[test]
fn origin_validation_rejects_credentials_paths_and_fragments() {
    for origin in [
        "https://user:secret@example.com",
        "https://example.com/path",
        "https://example.com/#secret",
        "ftp://example.com",
    ] {
        let mut config = Config {
            bind: "127.0.0.1:0".parse().unwrap(),
            origin: origin.into(),
            authority: String::new(),
            secure_cookie: false,
            data: PathBuf::new(),
            static_dir: PathBuf::new(),
            master_key: PathBuf::new(),
            admin_password: PathBuf::new(),
            session_ttl: Duration::from_secs(3600),
        };
        assert!(config.validate().is_err());
    }
}

#[tokio::test]
async fn login_rejects_cross_origin_unknown_fields_and_oversized_bodies() {
    let f = Fixture::new().await;
    for origin in [None, Some("https://other.example")] {
        let mut request = f.client.post(format!("{}/api/session", f.base));
        if let Some(origin) = origin {
            request = request.header("origin", origin);
        }
        assert_eq!(
            request
                .json(&json!({"password":PASSWORD}))
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
    }
    assert_eq!(
        f.client
            .post(format!("{}/api/session", f.base))
            .header("origin", &f.base)
            .json(&json!({"password":PASSWORD,"unexpected":true}))
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    assert_eq!(
        f.client
            .post(format!("{}/api/session", f.base))
            .header("origin", &f.base)
            .header("content-type", "text/plain")
            .body(PASSWORD)
            .send()
            .await
            .unwrap()
            .status(),
        415
    );
    assert_eq!(
        f.client
            .post(format!("{}/api/session", f.base))
            .header("origin", &f.base)
            .json(&json!({"password":"x".repeat(20000)}))
            .send()
            .await
            .unwrap()
            .status(),
        413
    );
    f.stop().await;
}

#[tokio::test]
async fn site_management_requires_session_csrf_and_strict_site_inputs() {
    let f = Fixture::new().await;
    assert_eq!(
        f.client
            .get(format!("{}/api/resource-sites", f.base))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    let (cookie, csrf) = f.login().await;
    let rows: Value = f
        .client
        .get(format!("{}/api/resource-sites", f.base))
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(rows.as_array().unwrap().len(), 3);
    assert_eq!(rows[0]["hasCredential"], false);
    assert!(rows[0].get("credential").is_none());
    assert_eq!(f.client.post(format!("{}/api/resource-sites/configure",f.base)).header("cookie",&cookie).header("origin",&f.base).json(&json!({"site":"mteam","baseUrl":"https://api.m-team.cc","credential":{"action":"keep"},"passkey":{"action":"keep"}})).send().await.unwrap().status(),403);
    for site in [json!("unknown-site"), json!({"url":"https://evil.example"})] {
        assert_eq!(
            f.client
                .post(format!("{}/api/resource-sites/verify", f.base))
                .header("cookie", &cookie)
                .header("origin", &f.base)
                .header("x-csrf-token", &csrf)
                .json(&json!({"site":site}))
                .send()
                .await
                .unwrap()
                .status(),
            400
        );
    }
    assert_eq!(
        f.client
            .post(format!("{}/api/resource-sites/verify", f.base))
            .header("cookie", &cookie)
            .header("origin", &f.base)
            .header("x-csrf-token", &csrf)
            .json(&json!({"site":"mteam","url":"https://evil.example"}))
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    f.stop().await;
}
