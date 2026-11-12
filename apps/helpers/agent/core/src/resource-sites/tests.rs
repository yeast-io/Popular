use super::verification::{html_identity, mteam_identity};
use super::*;
use serde_json::json;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex as StdMutex,
};
#[derive(Default)]
struct Memory {
    values: StdMutex<HashMap<String, String>>,
    fail_write: AtomicBool,
    fail_delete: AtomicBool,
}
impl CredentialStore for Memory {
    fn read(&self, id: &str) -> Result<Secrets, AgentError> {
        let rows = self.values.lock().unwrap();
        Ok(serde_json::from_str(
            rows.get(id)
                .ok_or_else(|| AgentError::code("credentialError"))?,
        )?)
    }
    fn write(&self, id: &str, value: &Secrets) -> Result<(), AgentError> {
        if self.fail_write.load(Ordering::SeqCst) {
            return Err(AgentError::code("credentialError"));
        }
        self.values
            .lock()
            .unwrap()
            .insert(id.into(), serde_json::to_string(value)?);
        Ok(())
    }
    fn delete(&self, id: &str) -> Result<(), AgentError> {
        if self.fail_delete.load(Ordering::SeqCst) {
            return Err(AgentError::code("credentialError"));
        }
        self.values.lock().unwrap().remove(id);
        Ok(())
    }
}
#[test]
fn identity_parser_requires_one_authenticated_site_scoped_user() {
    let base = url::Url::parse("https://site.example/").unwrap();
    for (site,html) in [(Site::Hdarea,"<a href='usercp.php'>profile</a><div id='info_block'><a href='userdetails.php?id=00123'>me</a></div>"), (Site::Hdwing,"<div id='site_header'><div class='userinfo'><a href='userdetails.php?id=00123'>me</a></div></div>")] {
        assert_eq!(html_identity(html.as_bytes(),&base,site).unwrap(),"123");
        for href in ["https://evil.example/userdetails.php?id=123","userdetails.php?id=123&id=456","userdetails.php?id=0","userdetails.php?id=-1"] {
            let broken=html.replace("userdetails.php?id=00123",href);
            assert!(html_identity(broken.as_bytes(),&base,site).is_err());
        }
        let blocked=format!("<title>Just a moment</title>{html}");
        assert_eq!(html_identity(blocked.as_bytes(),&base,site).unwrap_err().code,"siteBlocked");
        let login=format!("<input type='password'>{html}");
        assert_eq!(html_identity(login.as_bytes(),&base,site).unwrap_err().code,"siteAuthentication");
    }
}
#[test]
fn mteam_identity_preserves_large_string_ids_and_rejects_unsafe_numbers() {
    for id in [json!("9007199254740993123456"), json!(123)] {
        assert!(mteam_identity(
            &serde_json::to_vec(&json!({"code":"0","data":{"id":id}})).unwrap()
        )
        .is_ok());
    }
    for id in [
        json!(9007199254740992u64),
        json!("0"),
        json!(-1),
        json!("1e2"),
        json!(null),
    ] {
        assert!(
            mteam_identity(&serde_json::to_vec(&json!({"code":0,"data":{"id":id}})).unwrap())
                .is_err()
        );
    }
    assert_eq!(
        mteam_identity(br#"{"code":401,"message":"invalid key"}"#)
            .unwrap_err()
            .code,
        "siteAuthentication"
    );
}
#[test]
fn endpoints_reject_credentials_queries_fragments_paths_and_unencrypted_hosts() {
    for url in [
        "http://site.example",
        "https://user:secret@site.example",
        "https://site.example/?passkey=secret",
        "https://site.example/#secret",
        "https://site.example/wrong",
    ] {
        for site in Site::ALL {
            assert!(verification::endpoint(url, site).is_err());
        }
    }
    assert!(verification::endpoint("https://api.m-team.cc/api", Site::Mteam).is_ok());
}
#[tokio::test]
async fn unconfigured_sites_do_not_touch_credentials_and_remove_is_idempotent() {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(Memory::default());
    let service = ResourceSites::new(directory.path().into(), store.clone());
    let rows = service.list(&Trace::new()).await.unwrap();
    assert_eq!(rows.len(), 3);
    assert!(rows
        .iter()
        .all(|r| r.status == "unconfigured" && !r.has_credential));
    service.remove(Site::Mteam, &Trace::new()).await.unwrap();
    assert!(store.values.lock().unwrap().is_empty());
    assert_eq!(
        service
            .verify(Site::Mteam, &Trace::new())
            .await
            .unwrap_err()
            .code,
        "siteNotConfigured"
    );
}

struct Fixture {
    base: String,
    mode: Arc<StdMutex<String>>,
    requests: Arc<StdMutex<Vec<String>>>,
    task: tokio::task::JoinHandle<()>,
}
impl Fixture {
    async fn new() -> Self {
        // Explicit test-only loopback permission; no external site or real credentials.
        crate::diagnostics::quiet_tests();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/", listener.local_addr().unwrap());
        let mode = Arc::new(StdMutex::new(String::from("ok")));
        let requests = Arc::new(StdMutex::new(Vec::new()));
        let control = mode.clone();
        let seen = requests.clone();
        let task = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mode = control.clone();
                let requests = seen.clone();
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut bytes = vec![0; 32768];
                    let count = socket.read(&mut bytes).await.unwrap();
                    let request = String::from_utf8_lossy(&bytes[..count]).to_string();
                    requests.lock().unwrap().push(request.clone());
                    let current = mode.lock().unwrap().clone();
                    if current == "slow" {
                        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                    }
                    let (status,extra,body)=match current.as_str() {
                        "redirect"=>("302 Found","Location: http://127.0.0.1:9/stolen\r\n","".into()),
                        "expired"=>("401 Unauthorized","","".into()),
                        "blocked"=>("200 OK","","<title>Just a moment</title><form id='challenge-form'></form>".into()),
                        "limit"=>("429 Too Many Requests","","".into()),
                        "large"=>("200 OK","","x".repeat(2*1024*1024+1)),
                        _ if request.starts_with("POST /api/member/profile") =>("200 OK","",json!({"code":0,"data":{"id":if current=="changed" {"456"}else{"123"}}}).to_string()),
                        _ =>("200 OK","",format!("<a href='usercp.php'>me</a><div id='info_block'><a href='userdetails.php?id={0}'>me</a></div><div id='site_header'><div class='userinfo'><a href='userdetails.php?id={0}'>me</a></div></div>",if current=="changed" {"456"}else{"123"}))
                    };
                    let response=format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n{body}",body.len());
                    let _ = socket.write_all(response.as_bytes()).await;
                });
            }
        });
        Self {
            base,
            mode,
            requests,
            task,
        }
    }
    fn mode(&self, value: &str) {
        *self.mode.lock().unwrap() = value.into();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}
fn request(site: Site, base: &str) -> ConfigureRequest {
    ConfigureRequest {
        site,
        base_url: base.into(),
        credential: SecretChange::Set("synthetic-site-credential".into()),
        passkey: if site == Site::Hdarea {
            SecretChange::Set("synthetic-passkey".into())
        } else {
            SecretChange::Keep
        },
    }
}
#[tokio::test]
async fn all_three_sites_verify_without_gateway_and_preserve_local_secrets_across_restart() {
    let f = Fixture::new().await;
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(Memory::default());
    let service = ResourceSites::new(directory.path().into(), store.clone());
    let trace = Trace::new();
    for site in Site::ALL {
        let snapshot = service
            .configure(request(site, &f.base), &trace)
            .await
            .unwrap();
        assert_eq!(snapshot.status, "configured_valid");
        assert!(snapshot.has_credential);
        assert!(snapshot.enabled);
        let public = serde_json::to_string(&snapshot).unwrap();
        assert!(!public.contains("synthetic"));
        assert!(!public.contains("123"));
        let file = std::fs::read_to_string(directory.path().join(FILE)).unwrap();
        assert!(!file.contains("synthetic"));
        assert!(!file.contains("externalUserId"));
        service
            .set_enabled(
                EnabledRequest {
                    site,
                    enabled: false,
                },
                &trace,
            )
            .await
            .unwrap();
    }
    assert!(f.requests.lock().unwrap().iter().any(|r| r
        .to_lowercase()
        .contains("x-api-key: synthetic-site-credential")));
    assert!(f.requests.lock().unwrap().iter().any(|r| r
        .to_lowercase()
        .contains("cookie: synthetic-site-credential")));
    assert!(f
        .requests
        .lock()
        .unwrap()
        .iter()
        .all(|r| !r.contains("synthetic-passkey")));
    drop(service);
    let restored = ResourceSites::new(directory.path().into(), store.clone());
    assert!(restored
        .list(&Trace::new())
        .await
        .unwrap()
        .iter()
        .all(|s| s.has_credential && !s.enabled));
    for site in Site::ALL {
        restored.verify(site, &trace).await.unwrap();
        restored.remove(site, &trace).await.unwrap();
    }
    assert!(store.values.lock().unwrap().is_empty());
    assert!(restored
        .list(&Trace::new())
        .await
        .unwrap()
        .iter()
        .all(|s| !s.has_credential));
}
#[tokio::test]
async fn bad_replacement_does_not_overwrite_and_changed_endpoint_cannot_reuse_credentials() {
    let f = Fixture::new().await;
    let other = Fixture::new().await;
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(Memory::default());
    let service = ResourceSites::new(directory.path().into(), store.clone());
    let trace = Trace::new();
    service
        .configure(request(Site::Mteam, &f.base), &trace)
        .await
        .unwrap();
    let original = std::fs::read(directory.path().join(FILE)).unwrap();
    f.mode("expired");
    assert!(service
        .configure(request(Site::Mteam, &f.base), &trace)
        .await
        .is_err());
    assert_eq!(
        std::fs::read(directory.path().join(FILE)).unwrap(),
        original
    );
    let input = ConfigureRequest {
        site: Site::Mteam,
        base_url: other.base.clone(),
        credential: SecretChange::Keep,
        passkey: SecretChange::Keep,
    };
    assert_eq!(
        service.configure(input, &trace).await.unwrap_err().code,
        "invalidSecret"
    );
    assert!(other.requests.lock().unwrap().is_empty());
    assert_eq!(store.values.lock().unwrap().len(), 1);
    f.mode("ok");
    store.fail_write.store(true, Ordering::SeqCst);
    assert!(service
        .configure(request(Site::Mteam, &f.base), &trace)
        .await
        .is_err());
    assert_eq!(
        std::fs::read(directory.path().join(FILE)).unwrap(),
        original
    );
}
#[tokio::test]
async fn auth_errors_invalidate_but_rate_limits_keep_the_last_verification() {
    let f = Fixture::new().await;
    let directory = tempfile::tempdir().unwrap();
    let service = ResourceSites::new(directory.path().into(), Arc::new(Memory::default()));
    let trace = Trace::new();
    service
        .configure(request(Site::Hdwing, &f.base), &trace)
        .await
        .unwrap();
    for mode in ["limit", "redirect", "large"] {
        f.mode(mode);
        assert!(service.verify(Site::Hdwing, &trace).await.is_err());
        assert_eq!(
            service.list(&Trace::new()).await.unwrap()[2].status,
            "configured_valid"
        );
    }
    f.mode("blocked");
    assert_eq!(
        service.verify(Site::Hdwing, &trace).await.unwrap_err().code,
        "siteBlocked"
    );
    assert_eq!(
        service.list(&Trace::new()).await.unwrap()[2].status,
        "configured_invalid"
    );
    service
        .set_enabled(
            EnabledRequest {
                site: Site::Hdwing,
                enabled: false,
            },
            &trace,
        )
        .await
        .unwrap();
    assert!(service
        .set_enabled(
            EnabledRequest {
                site: Site::Hdwing,
                enabled: true
            },
            &trace
        )
        .await
        .is_err());
    f.mode("changed");
    assert_eq!(
        service.verify(Site::Hdwing, &trace).await.unwrap_err().code,
        "siteAccountChanged"
    );
}
#[tokio::test]
async fn deletion_failure_retains_a_cleanup_record_and_retry_removes_the_secret() {
    let f = Fixture::new().await;
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(Memory::default());
    let service = ResourceSites::new(directory.path().into(), store.clone());
    let trace = Trace::new();
    service
        .configure(request(Site::Mteam, &f.base), &trace)
        .await
        .unwrap();
    store.fail_delete.store(true, Ordering::SeqCst);
    assert!(service.remove(Site::Mteam, &trace).await.is_err());
    let stored = service.load().unwrap();
    assert!(stored.sites.is_empty());
    assert_eq!(stored.pending_cleanup.len(), 1);
    assert_eq!(store.values.lock().unwrap().len(), 1);
    store.fail_delete.store(false, Ordering::SeqCst);
    service.remove(Site::Mteam, &trace).await.unwrap();
    assert!(store.values.lock().unwrap().is_empty());
    assert!(service.load().unwrap().pending_cleanup.is_empty());
}
#[tokio::test]
async fn a_cookie_for_a_different_hdarea_account_does_not_require_a_passkey() {
    let f = Fixture::new().await;
    let directory = tempfile::tempdir().unwrap();
    let service = ResourceSites::new(directory.path().into(), Arc::new(Memory::default()));
    let trace = Trace::new();
    service
        .configure(request(Site::Hdarea, &f.base), &trace)
        .await
        .unwrap();
    f.mode("changed");
    let mut input = request(Site::Hdarea, &f.base);
    input.passkey = SecretChange::Keep;
    let snapshot = service.configure(input, &trace).await.unwrap();
    assert!(!snapshot.requires_passkey);
    assert!(!snapshot.has_passkey);
    assert_eq!(
        service.list(&Trace::new()).await.unwrap()[1].status,
        "configured_valid"
    );
}

#[tokio::test]
async fn edited_metadata_cannot_redirect_stored_credentials_and_other_sites_remain_usable() {
    let first = Fixture::new().await;
    let other = Fixture::new().await;
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(Memory::default());
    let service = ResourceSites::new(directory.path().into(), store.clone());
    let trace = Trace::new();
    service
        .configure(request(Site::Mteam, &first.base), &trace)
        .await
        .unwrap();
    service
        .configure(request(Site::Hdarea, &first.base), &trace)
        .await
        .unwrap();
    let mut rows = service.load().unwrap();
    rows.sites
        .iter_mut()
        .find(|r| r.site == Site::Mteam)
        .unwrap()
        .base_url = other.base.clone();
    journal::atomic(directory.path(), FILE, &rows).unwrap();
    let list = service.list(&trace).await.unwrap();
    assert_eq!(list[0].status, "configured_invalid");
    assert_eq!(list[0].last_error.as_deref(), Some("credentialError"));
    assert_eq!(list[1].status, "configured_valid");
    assert_eq!(
        service.verify(Site::Mteam, &trace).await.unwrap_err().code,
        "credentialError"
    );
    assert!(other.requests.lock().unwrap().is_empty());
    // Recovery requires explicit replacement, which is bound to the newly verified destination.
    service
        .configure(request(Site::Mteam, &other.base), &trace)
        .await
        .unwrap();
    assert_eq!(
        service.list(&trace).await.unwrap()[0].status,
        "configured_valid"
    );
    let rows = service.load().unwrap();
    let id = rows
        .sites
        .iter()
        .find(|r| r.site == Site::Mteam)
        .unwrap()
        .credential_id
        .clone();
    store.values.lock().unwrap().remove(&id);
    assert_eq!(
        service.list(&trace).await.unwrap()[0].status,
        "configured_invalid"
    );
    service.remove(Site::Mteam, &trace).await.unwrap();
    assert_eq!(store.values.lock().unwrap().len(), 1);
}
#[tokio::test]
async fn parallel_site_saves_do_not_overwrite_each_others_metadata_or_credentials() {
    let f = Fixture::new().await;
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(Memory::default());
    let service = ResourceSites::new(directory.path().into(), store.clone());
    let trace = Trace::new();
    let (a, b, c) = tokio::join!(
        service.configure(request(Site::Mteam, &f.base), &trace),
        service.configure(request(Site::Hdarea, &f.base), &trace),
        service.configure(request(Site::Hdwing, &f.base), &trace)
    );
    assert!(a.is_ok() && b.is_ok() && c.is_ok());
    assert!(service
        .list(&trace)
        .await
        .unwrap()
        .iter()
        .all(|row| row.has_credential));
    assert_eq!(store.values.lock().unwrap().len(), 3);
}

#[tokio::test]
async fn defaults_are_persistent_unique_and_require_an_enabled_verified_site() {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(Memory::default());
    let service = ResourceSites::new(directory.path().into(), store.clone());
    let trace = Trace::new();
    assert!(service.set_default(Site::Mteam, &trace).await.is_err());
    let mut rows = StoredSites::default();
    for site in [Site::Mteam, Site::Hdwing] {
        let credential_id = uuid::Uuid::new_v4().to_string();
        let base = site.base().to_owned();
        store
            .write(
                &credential_id,
                &Secrets {
                    api_key: serde_json::to_string(&SiteSecrets {
                        site,
                        base_url: base.clone(),
                        credential: "site-secret".into(),
                        passkey: String::new(),
                        external_user_id: "123".into(),
                    })
                    .unwrap(),
                    password: String::new(),
                },
            )
            .unwrap();
        rows.sites.push(StoredSite {
            site,
            base_url: base,
            credential_id,
            enabled: true,
            status: Status::ConfiguredValid,
            verified_at: 1000,
            last_error: None,
        });
    }
    journal::atomic(directory.path(), FILE, &rows).unwrap();
    service.set_default(Site::Mteam, &trace).await.unwrap();
    service.set_default(Site::Hdwing, &trace).await.unwrap();
    let fresh = ResourceSites::new(directory.path().into(), store);
    let states = fresh.list(&trace).await.unwrap();
    assert_eq!(states.iter().filter(|row| row.is_default).count(), 1);
    assert!(
        states
            .iter()
            .find(|row| row.site == Site::Hdwing)
            .unwrap()
            .is_default
    );
    fresh
        .set_enabled(
            EnabledRequest {
                site: Site::Hdwing,
                enabled: false,
            },
            &trace,
        )
        .await
        .unwrap();
    assert!(fresh.set_default(Site::Hdwing, &trace).await.is_err());
    assert!(!fresh
        .list(&trace)
        .await
        .unwrap()
        .iter()
        .any(|row| row.is_default));
}
