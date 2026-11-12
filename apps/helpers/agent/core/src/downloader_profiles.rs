//! Local downloader configurations. The default is projected into the existing pinned execution target.
use crate::{
    credentials::CredentialStore,
    diagnostics::{self, Trace},
    errors::AgentError,
    protocol::DownloaderTarget,
    settings::{
        self, SaveRequest, SecretChange, Secrets, Settings, Snapshot, StoredSettings, TestRequest,
    },
    storage,
};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredProfile {
    pub id: String,
    pub settings: Settings,
    pub target: DownloaderTarget,
    pub credential_id: String,
    pub enabled: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub provider: settings::Provider,
    pub downloader_url: String,
    pub username: String,
    pub auth_mode: settings::DownloaderAuthMode,
    pub enabled: bool,
    pub is_default: bool,
    pub has_password: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigureRequest {
    pub id: Option<String>,
    pub configuration: TestRequest,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionRequest {
    pub id: String,
    pub operation: Operation,
    pub enabled: Option<bool>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Operation {
    Default,
    Enabled,
    Remove,
}

fn validate(stored: &StoredSettings) -> Result<(), AgentError> {
    let mut seen = std::collections::BTreeSet::new();
    if stored.downloaders.len() > 32
        || stored.downloaders.iter().any(|row| {
            !seen.insert(&row.id)
                || uuid::Uuid::parse_str(&row.id).is_err()
                || uuid::Uuid::parse_str(&row.credential_id).is_err()
                || uuid::Uuid::parse_str(&row.target.instance_id).is_err()
                || row.target.downloader_type != row.settings.provider
                || settings::validate_stored(&row.settings).is_err()
        })
        || stored
            .default_downloader_id
            .as_ref()
            .is_some_and(|id| !seen.contains(id))
    {
        return Err(AgentError::code("storageError"));
    }
    Ok(())
}
fn password(row: &StoredProfile, store: &impl CredentialStore) -> Result<String, AgentError> {
    Ok(store.read(&row.credential_id)?.password)
}
fn commit(
    directory: &Path,
    stored: StoredSettings,
    store: &impl CredentialStore,
    trace: &Trace,
) -> Result<Snapshot, AgentError> {
    validate(&stored)?;
    let mut active = stored.settings.clone();
    let mut secret = None;
    let mut target = None;
    if let Some(row) = stored
        .downloaders
        .iter()
        .find(|row| Some(&row.id) == stored.default_downloader_id.as_ref())
    {
        active.provider = row.settings.provider.clone();
        active.downloader_url = row.settings.downloader_url.clone();
        active.username = row.settings.username.clone();
        active.auth_mode = row.settings.auth_mode.clone();
        active.downloader_configured = row.enabled;
        secret = Some(password(row, store)?);
        target = Some(row.target.clone());
    } else {
        active.downloader_configured = false;
    }
    storage::save_with_profiles(
        directory,
        SaveRequest {
            settings: active,
            api_key: SecretChange::Keep,
            password: secret.map(SecretChange::Set).unwrap_or(SecretChange::Clear),
        },
        store,
        trace,
        Some((stored.downloaders, stored.default_downloader_id, target)),
    )
}
fn cleanup(store: &impl CredentialStore, id: &str, trace: &Trace) {
    if let Err(error) = store.delete(id) {
        diagnostics::failure("downloaders.credentials.cleanup", &trace.id, &error, 0);
    }
}
fn load(
    directory: &Path,
    store: &impl CredentialStore,
    trace: &Trace,
) -> Result<StoredSettings, AgentError> {
    let mut stored = storage::load(directory)?;
    validate(&stored)?;
    // Import legacy writes while preserving the existing execution identity and credential ownership.
    if stored.settings.downloader_configured {
        let secret = storage::secrets(&stored, store)?;
        let matching = stored
            .downloaders
            .iter()
            .find(|row| {
                Some(&row.id) == stored.default_downloader_id.as_ref()
                    && settings::same_downloader_credentials(&row.settings, &stored.settings)
            })
            .cloned();
        let same_secret = matching
            .as_ref()
            .map(|row| password(row, store))
            .transpose()?
            .is_some_and(|value| value == secret.password);
        if !same_secret {
            let target = crate::device::target(directory, &stored.settings)?;
            let credential_id = uuid::Uuid::new_v4().to_string();
            store.write(
                &credential_id,
                &Secrets {
                    api_key: String::new(),
                    password: secret.password,
                },
            )?;
            let id = matching
                .as_ref()
                .map(|row| row.id.clone())
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            stored.downloaders.retain(|row| row.id != id);
            stored.downloaders.push(StoredProfile {
                id: id.clone(),
                settings: stored.settings.clone(),
                target,
                credential_id: credential_id.clone(),
                enabled: true,
            });
            stored.default_downloader_id = Some(id);
            if let Err(error) = commit(directory, stored, store, trace) {
                cleanup(store, &credential_id, trace);
                return Err(error);
            }
            if let Some(row) = matching {
                cleanup(store, &row.credential_id, trace);
            }
            stored = storage::load(directory)?;
        }
    }
    Ok(stored)
}
pub fn list(
    directory: &Path,
    store: &impl CredentialStore,
    trace: &Trace,
) -> Result<Vec<Item>, AgentError> {
    trace.stage("downloaders.list.started");
    let stored = load(directory, store, trace)?;
    let items = stored
        .downloaders
        .iter()
        .map(|row| {
            Ok(Item {
                id: row.id.clone(),
                provider: row.settings.provider.clone(),
                downloader_url: row.settings.downloader_url.clone(),
                username: row.settings.username.clone(),
                auth_mode: row.settings.auth_mode.clone(),
                enabled: row.enabled,
                is_default: Some(&row.id) == stored.default_downloader_id.as_ref(),
                has_password: !password(row, store)?.is_empty(),
            })
        })
        .collect::<Result<_, AgentError>>()?;
    trace.stage("downloaders.list.completed");
    Ok(items)
}
pub async fn configure(
    directory: &Path,
    input: ConfigureRequest,
    store: &impl CredentialStore,
    trace: &Trace,
) -> Result<Snapshot, AgentError> {
    trace.stage("downloaders.configure.started");
    let mut stored = load(directory, store, trace)?;
    let old = input
        .id
        .as_ref()
        .map(|id| {
            stored
                .downloaders
                .iter()
                .find(|row| &row.id == id)
                .cloned()
                .ok_or_else(|| AgentError::code("invalidSettings"))
        })
        .transpose()?;
    if old.is_none() && stored.downloaders.len() >= 32 {
        return Err(AgentError::code("invalidSettings"));
    }
    let request = input.configuration;
    let configuration = settings::normalize(Settings {
        provider: request.provider.clone(),
        downloader_url: request.downloader_url.clone(),
        username: request.username.clone(),
        auth_mode: request.auth_mode.clone(),
        downloader_configured: true,
        ..Settings::default()
    })?;
    let previous = old
        .as_ref()
        .map(|row| password(row, store))
        .transpose()?
        .unwrap_or_default();
    let secret = settings::resolve_secret(
        &request.password,
        &previous,
        old.as_ref().is_some_and(|row| {
            settings::same_downloader_credentials(&row.settings, &configuration)
        }),
    )?;
    crate::downloader::test(request, secret.clone(), trace).await?;
    let credential_id = uuid::Uuid::new_v4().to_string();
    if let Err(error) = store.write(
        &credential_id,
        &Secrets {
            api_key: String::new(),
            password: secret,
        },
    ) {
        cleanup(store, &credential_id, trace);
        return Err(error);
    }
    let id = old
        .as_ref()
        .map(|row| row.id.clone())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let target = old
        .as_ref()
        .filter(|row| settings::same_downloader(&row.settings, &configuration))
        .map(|row| row.target.clone())
        .unwrap_or_else(|| DownloaderTarget {
            downloader_type: configuration.provider.clone(),
            instance_id: uuid::Uuid::new_v4().to_string(),
        });
    stored.downloaders.retain(|row| row.id != id);
    stored.downloaders.push(StoredProfile {
        id: id.clone(),
        settings: configuration,
        target,
        credential_id: credential_id.clone(),
        enabled: old.as_ref().is_none_or(|row| row.enabled),
    });
    if stored.default_downloader_id.is_none() {
        stored.default_downloader_id = Some(id);
    }
    let result = commit(directory, stored, store, trace);
    if result.is_err() {
        cleanup(store, &credential_id, trace);
    } else if let Some(old) = old {
        cleanup(store, &old.credential_id, trace);
    }
    if result.is_ok() {
        trace.stage("downloaders.configure.completed");
    }
    result
}
pub fn action(
    directory: &Path,
    input: ActionRequest,
    store: &impl CredentialStore,
    trace: &Trace,
) -> Result<Snapshot, AgentError> {
    trace.stage("downloaders.action.started");
    let mut stored = load(directory, store, trace)?;
    let row = stored
        .downloaders
        .iter_mut()
        .find(|row| row.id == input.id)
        .ok_or_else(|| AgentError::code("invalidSettings"))?;
    let removed = match input.operation {
        Operation::Default => {
            if !row.enabled {
                return Err(AgentError::code("downloaderRequired"));
            }
            stored.default_downloader_id = Some(row.id.clone());
            None
        }
        Operation::Enabled => {
            row.enabled = input
                .enabled
                .ok_or_else(|| AgentError::code("invalidSettings"))?;
            None
        }
        Operation::Remove => {
            let credential = row.credential_id.clone();
            stored.downloaders.retain(|row| row.id != input.id);
            if stored.default_downloader_id.as_ref() == Some(&input.id) {
                stored.default_downloader_id = None;
            }
            Some(credential)
        }
    };
    let snapshot = commit(directory, stored, store, trace)?;
    if let Some(id) = removed {
        cleanup(store, &id, trace);
    }
    trace.stage("downloaders.action.completed");
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::HashMap, sync::Mutex};
    #[derive(Default)]
    struct Memory(Mutex<HashMap<String, String>>);
    impl CredentialStore for Memory {
        fn read(&self, id: &str) -> Result<Secrets, AgentError> {
            serde_json::from_str(
                self.0
                    .lock()
                    .unwrap()
                    .get(id)
                    .ok_or_else(|| AgentError::code("credentialError"))?,
            )
            .map_err(Into::into)
        }
        fn write(&self, id: &str, value: &Secrets) -> Result<(), AgentError> {
            self.0
                .lock()
                .unwrap()
                .insert(id.into(), serde_json::to_string(value)?);
            Ok(())
        }
        fn delete(&self, id: &str) -> Result<(), AgentError> {
            self.0.lock().unwrap().remove(id);
            Ok(())
        }
    }
    async fn downloader(token: &'static str) -> (String, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buffer = [0; 8192];
                let n = socket.read(&mut buffer).await.unwrap();
                let request = String::from_utf8_lossy(&buffer[..n]).to_lowercase();
                let ok = request.contains(&format!("authorization: bearer {token}"));
                let response = if ok {
                    "HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nv5.1.0"
                } else {
                    "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                };
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        (url, task)
    }
    fn request(id: Option<String>, url: &str, token: &str) -> ConfigureRequest {
        ConfigureRequest {
            id,
            configuration: TestRequest {
                provider: settings::Provider::Qbittorrent,
                downloader_url: url.into(),
                username: String::new(),
                auth_mode: settings::DownloaderAuthMode::ApiKey,
                password: SecretChange::Set(token.into()),
            },
        }
    }
    #[tokio::test]
    async fn multiple_profiles_keep_credentials_and_pinned_targets_across_default_enable_and_restart(
    ) {
        crate::diagnostics::quiet_tests();
        let directory = tempfile::tempdir().unwrap();
        let store = Memory::default();
        let trace = Trace::new();
        let (a, server_a) = downloader("token-a").await;
        let (b, server_b) = downloader("token-b").await;
        configure(
            directory.path(),
            request(None, &a, "token-a"),
            &store,
            &trace,
        )
        .await
        .unwrap();
        let first = list(directory.path(), &store, &trace).unwrap().remove(0);
        let original_target = storage::load(directory.path())
            .unwrap()
            .downloader_identity
            .unwrap();
        configure(
            directory.path(),
            request(None, &b, "token-b"),
            &store,
            &trace,
        )
        .await
        .unwrap();
        let rows = list(directory.path(), &store, &trace).unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows[0].is_default);
        let second_id = rows[1].id.clone();
        let active = storage::load(directory.path()).unwrap();
        assert_eq!(active.settings.downloader_url.trim_end_matches('/'), a);
        assert_eq!(
            storage::secrets(&active, &store).unwrap().password,
            "token-a"
        );
        action(
            directory.path(),
            ActionRequest {
                id: second_id.clone(),
                operation: Operation::Default,
                enabled: None,
            },
            &store,
            &trace,
        )
        .unwrap();
        let active = storage::load(directory.path()).unwrap();
        assert_eq!(active.settings.downloader_url.trim_end_matches('/'), b);
        assert_eq!(
            storage::secrets(&active, &store).unwrap().password,
            "token-b"
        );
        action(
            directory.path(),
            ActionRequest {
                id: second_id.clone(),
                operation: Operation::Enabled,
                enabled: Some(false),
            },
            &store,
            &trace,
        )
        .unwrap();
        assert!(
            !storage::load(directory.path())
                .unwrap()
                .settings
                .downloader_configured
        );
        assert!(action(
            directory.path(),
            ActionRequest {
                id: second_id.clone(),
                operation: Operation::Default,
                enabled: None
            },
            &store,
            &trace
        )
        .is_err());
        action(
            directory.path(),
            ActionRequest {
                id: first.id,
                operation: Operation::Default,
                enabled: None,
            },
            &store,
            &trace,
        )
        .unwrap();
        let active = storage::load(directory.path()).unwrap();
        assert!(active.downloader_identity.unwrap() == original_target);
        assert_eq!(
            storage::secrets(&storage::load(directory.path()).unwrap(), &store)
                .unwrap()
                .password,
            "token-a"
        );
        let before = std::fs::read(directory.path().join("settings.json")).unwrap();
        assert!(configure(
            directory.path(),
            request(Some(second_id), &a, "wrong-token"),
            &store,
            &trace
        )
        .await
        .is_err());
        assert_eq!(
            std::fs::read(directory.path().join("settings.json")).unwrap(),
            before
        );
        let public =
            serde_json::to_string(&list(directory.path(), &store, &trace).unwrap()).unwrap();
        assert!(!public.contains("token-a") && !public.contains("token-b"));
        server_a.abort();
        server_b.abort();
    }
    #[test]
    fn legacy_migration_preserves_execution_identity_and_gateway_credentials() {
        let directory = tempfile::tempdir().unwrap();
        let store = Memory::default();
        let trace = Trace::new();
        storage::save(
            directory.path(),
            SaveRequest {
                settings: Settings {
                    downloader_configured: true,
                    ..Default::default()
                },
                api_key: SecretChange::Set("gateway-key".into()),
                password: SecretChange::Set("downloader-password".into()),
            },
            &store,
            &trace,
        )
        .unwrap();
        let target = storage::load(directory.path())
            .unwrap()
            .downloader_identity
            .unwrap();
        let rows = list(directory.path(), &store, &trace).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].is_default);
        let current = storage::load(directory.path()).unwrap();
        assert!(current.downloader_identity.as_ref() == Some(&target));
        let secrets = storage::secrets(&current, &store).unwrap();
        assert_eq!(secrets.api_key, "gateway-key");
        assert_eq!(secrets.password, "downloader-password");
        assert_eq!(list(directory.path(), &store, &trace).unwrap().len(), 1);
    }
}
