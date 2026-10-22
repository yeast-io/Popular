use crate::{
    credentials::CredentialStore,
    errors::AgentError,
    journal::{self, Identity},
    protocol::{self, DeviceKeys, DownloaderTarget},
    settings::{Secrets, Settings},
};
use serde::{Deserialize, Serialize};
use std::path::Path;

pub fn identity(
    directory: &Path,
    settings: &Settings,
    store: &impl CredentialStore,
) -> Result<(Identity, DeviceKeys), AgentError> {
    let mut identity: Identity = journal::load(directory, "identity.json")?;
    if !identity.gateway.is_empty() && identity.gateway != settings.gateway_url {
        return Err(AgentError::code("rebindRequired"));
    }
    if identity.protocol_version != 1 && !identity.installation_id.is_empty() {
        return Err(AgentError::code("legacyIdentity"));
    }
    if identity.revoked {
        return Err(AgentError::code("rebindRequired"));
    }
    if identity.installation_id.is_empty() {
        if !identity.binding_requested {
            return Err(AgentError::code("gatewayRequired"));
        }
        let keys = DeviceKeys::generate()?;
        identity.installation_id = uuid::Uuid::new_v4().to_string();
        identity.credential_id = uuid::Uuid::new_v4().to_string();
        identity.gateway = settings.gateway_url.clone();
        identity.protocol_version = 1;
        if let Err(error) = store.write(
            &identity.credential_id,
            &Secrets {
                api_key: serde_json::to_string(&keys)?,
                password: String::new(),
            },
        ) {
            let _ = store.delete(&identity.credential_id);
            return Err(error);
        }
        if let Err(error) = journal::atomic(directory, "identity.json", &identity) {
            let _ = store.delete(&identity.credential_id);
            return Err(error);
        }
        return Ok((identity, keys));
    }
    if !protocol::id(&identity.installation_id)
        || !protocol::id(&identity.credential_id)
        || identity
            .device_id
            .as_ref()
            .is_some_and(|id| !protocol::id(id))
    {
        return Err(AgentError::code("storageError"));
    }
    let secret = store.read(&identity.credential_id)?;
    let keys: DeviceKeys = serde_json::from_str(&secret.api_key)
        .map_err(|e| AgentError::caused("credentialError", e))?;
    keys.public()?;
    Ok((identity, keys))
}
pub fn revoke(directory: &Path, identity: &mut Identity) -> Result<(), AgentError> {
    identity.revoked = true;
    journal::atomic(directory, "identity.json", identity)
}
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Targets {
    targets: Vec<Target>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Target {
    settings: Settings,
    id: String,
}
pub fn target(directory: &Path, settings: &Settings) -> Result<DownloaderTarget, AgentError> {
    let mut targets: Targets = journal::load(directory, "downloader-targets.json")?;
    if let Some(target) = targets
        .targets
        .iter()
        .find(|t| crate::settings::same_downloader(&t.settings, settings))
    {
        if !protocol::id(&target.id) {
            return Err(AgentError::code("storageError"));
        }
        return Ok(DownloaderTarget {
            downloader_type: settings.provider.clone(),
            instance_id: target.id.clone(),
        });
    }
    let id = uuid::Uuid::new_v4().to_string();
    // Only non-secret downloader identity fields; no Gateway address or credentials.
    targets.targets.push(Target {
        settings: Settings {
            downloader_configured: settings.downloader_configured,
            provider: settings.provider.clone(),
            downloader_url: settings.downloader_url.clone(),
            username: settings.username.clone(),
            ..Settings::default()
        },
        id: id.clone(),
    });
    journal::atomic(directory, "downloader-targets.json", &targets)?;
    Ok(DownloaderTarget {
        downloader_type: settings.provider.clone(),
        instance_id: id,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    struct Memory {
        entries: std::cell::RefCell<std::collections::HashMap<String, String>>,
        fail_after_write: bool,
    }
    impl CredentialStore for Memory {
        fn read(&self, id: &str) -> Result<Secrets, AgentError> {
            Ok(serde_json::from_str(
                self.entries
                    .borrow()
                    .get(id)
                    .ok_or(AgentError::code("credentialError"))?,
            )?)
        }
        fn write(&self, id: &str, value: &Secrets) -> Result<(), AgentError> {
            self.entries
                .borrow_mut()
                .insert(id.into(), serde_json::to_string(value)?);
            if self.fail_after_write {
                return Err(AgentError::code("credentialError"));
            }
            Ok(())
        }
        fn delete(&self, id: &str) -> Result<(), AgentError> {
            self.entries.borrow_mut().remove(id);
            Ok(())
        }
    }
    #[test]
    fn restart_reuses_both_private_keys_and_never_writes_them_to_disk() {
        let dir = tempfile::tempdir().unwrap();
        let settings = Settings::default();
        let store = Memory::default();
        journal::atomic(
            dir.path(),
            "identity.json",
            &Identity {
                binding_requested: true,
                ..Identity::default()
            },
        )
        .unwrap();
        let (first, keys) = identity(dir.path(), &settings, &store).unwrap();
        let (second, restored) = identity(dir.path(), &settings, &store).unwrap();
        assert_eq!(first.installation_id, second.installation_id);
        assert_eq!(first.credential_id, second.credential_id);
        assert_eq!(keys.public().unwrap(), restored.public().unwrap());
        assert_eq!(store.entries.borrow().len(), 1);
        assert!(store
            .entries
            .borrow()
            .values()
            .all(|value| value.len() < 2560));
        let text = std::fs::read_to_string(dir.path().join("identity.json")).unwrap();
        for forbidden in ["signing", "encryption", "BEGIN PRIVATE", "apiKey"] {
            assert!(!text.contains(forbidden));
        }
    }
    #[test]
    fn incomplete_credential_write_does_not_commit_or_orphan_identity() {
        let dir = tempfile::tempdir().unwrap();
        let store = Memory {
            fail_after_write: true,
            ..Memory::default()
        };
        journal::atomic(
            dir.path(),
            "identity.json",
            &Identity {
                binding_requested: true,
                ..Identity::default()
            },
        )
        .unwrap();
        let before = std::fs::read(dir.path().join("identity.json")).unwrap();
        assert_eq!(
            identity(dir.path(), &Settings::default(), &store)
                .err()
                .unwrap()
                .code,
            "credentialError"
        );
        assert!(store.entries.borrow().is_empty());
        assert_eq!(
            std::fs::read(dir.path().join("identity.json")).unwrap(),
            before
        );
    }
    #[test]
    fn downloader_switch_preserves_old_target_identity() {
        let dir = tempfile::tempdir().unwrap();
        let mut settings = Settings::default();
        let old = target(dir.path(), &settings).unwrap();
        settings.provider = crate::settings::Provider::Transmission;
        let new = target(dir.path(), &settings).unwrap();
        assert!(old != new);
        settings.provider = crate::settings::Provider::Qbittorrent;
        assert!(target(dir.path(), &settings).unwrap() == old);
    }
}
