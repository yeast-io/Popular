use crate::{
    credentials::CredentialStore,
    diagnostics::Trace,
    errors::AgentError,
    journal::{self, Identity},
    settings::{self, GatewayRequest, SaveRequest, SecretChange, Snapshot},
    storage,
};
use std::path::Path;

// Saving ordinary settings does not grant permission for a first device binding.
pub fn request_binding(
    directory: &Path,
    request: GatewayRequest,
    store: &impl CredentialStore,
    trace: &Trace,
) -> Result<Snapshot, AgentError> {
    trace.stage("gateway.binding-request.started");
    let old = storage::load(directory)?;
    let previous = storage::secrets(&old, store)?;
    let mut settings = old.settings;
    let gateway = settings::endpoint(request.gateway_url.trim(), true)?.to_string();
    let api_key = settings::resolve_secret(
        &request.api_key,
        &previous.api_key,
        gateway == settings.gateway_url,
    )?;
    if api_key.is_empty() {
        return Err(AgentError::code("gatewayRequired"));
    }
    settings.gateway_url = gateway;
    settings.gateway_enabled = true;
    settings.locale = request.locale;
    let mut identity: Identity = journal::load(directory, "identity.json")?;
    if identity.protocol_version == 0 && !identity.installation_id.is_empty() {
        // Explicit Connect migrates legacy identities. Preserve the old identity and its keychain entry.
        journal::atomic(
            directory,
            &format!("legacy-identity-{}.json", uuid::Uuid::new_v4()),
            &identity,
        )?;
        identity = Identity::default();
    }
    if (!identity.gateway.is_empty() && identity.gateway != settings.gateway_url)
        || api_key != previous.api_key
        || (identity.device_id.is_some() && identity.revoked)
    {
        // An explicit user action may start a new binding; old task records stay intact.
        identity = Identity::default();
    }
    identity.revoked = false;
    identity.binding_requested = true;
    let snapshot = storage::save(
        directory,
        SaveRequest {
            settings,
            api_key: SecretChange::Set(api_key),
            password: SecretChange::Keep,
        },
        store,
        trace,
    )?;
    journal::atomic(directory, "identity.json", &identity)?;
    trace.stage("gateway.binding-request.completed");
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{Secrets, Settings};
    use std::{cell::RefCell, collections::HashMap};
    #[derive(Default)]
    struct Memory(RefCell<HashMap<String, String>>);
    impl CredentialStore for Memory {
        fn read(&self, id: &str) -> Result<Secrets, AgentError> {
            Ok(serde_json::from_str(
                self.0
                    .borrow()
                    .get(id)
                    .ok_or(AgentError::code("credentialError"))?,
            )?)
        }
        fn write(&self, id: &str, value: &Secrets) -> Result<(), AgentError> {
            self.0
                .borrow_mut()
                .insert(id.into(), serde_json::to_string(value)?);
            Ok(())
        }
        fn delete(&self, id: &str) -> Result<(), AgentError> {
            self.0.borrow_mut().remove(id);
            Ok(())
        }
    }
    fn request() -> GatewayRequest {
        GatewayRequest {
            gateway_url: "https://gateway.example".into(),
            locale: "zh-CN".into(),
            api_key: SecretChange::Set("dummy-api-key".into()),
        }
    }
    #[test]
    fn bind_saves_gateway_only_and_preserves_pending_identity_on_retry() {
        let dir = tempfile::tempdir().unwrap();
        let store = Memory::default();
        let trace = Trace::new();
        storage::save(
            dir.path(),
            SaveRequest {
                settings: Settings::default(),
                api_key: SecretChange::Clear,
                password: SecretChange::Set("local-password".into()),
            },
            &store,
            &trace,
        )
        .unwrap();
        let initial: Identity = journal::load(dir.path(), "identity.json").unwrap();
        assert!(!initial.binding_requested);
        let snapshot = request_binding(dir.path(), request(), &store, &trace).unwrap();
        assert!(snapshot.has_api_key && snapshot.has_password);
        let stored = storage::load(dir.path()).unwrap();
        assert_eq!(stored.settings.locale, "zh-CN");
        assert_eq!(
            storage::secrets(&stored, &store).unwrap().password,
            "local-password"
        );
        let mut identity: Identity = journal::load(dir.path(), "identity.json").unwrap();
        assert!(identity.binding_requested);
        identity.protocol_version = 1;
        identity.installation_id = "pending-installation".into();
        identity.credential_id = "pending-credential".into();
        identity.gateway = stored.settings.gateway_url.clone();
        journal::atomic(dir.path(), "identity.json", &identity).unwrap();
        request_binding(dir.path(), request(), &store, &trace).unwrap();
        let retry: Identity = journal::load(dir.path(), "identity.json").unwrap();
        assert_eq!(retry.installation_id, "pending-installation");
    }
    #[test]
    fn connect_reuses_an_already_bound_identity() {
        let dir = tempfile::tempdir().unwrap();
        let store = Memory::default();
        let trace = Trace::new();
        request_binding(dir.path(), request(), &store, &trace).unwrap();
        let identity = Identity {
            installation_id: uuid::Uuid::new_v4().to_string(),
            credential_id: uuid::Uuid::new_v4().to_string(),
            gateway: "https://gateway.example/".into(),
            device_id: Some("existing-device".into()),
            revoked: false,
            binding_requested: true,
            protocol_version: 1,
        };
        journal::atomic(dir.path(), "identity.json", &identity).unwrap();
        let before_identity = std::fs::read(dir.path().join("identity.json")).unwrap();
        let credential = storage::load(dir.path()).unwrap().credential_id;
        crate::preferences::disconnect_gateway(dir.path()).unwrap();
        let disconnected = storage::load(dir.path()).unwrap();
        assert!(!disconnected.settings.gateway_enabled);
        assert_eq!(disconnected.credential_id, credential);
        assert_eq!(
            before_identity,
            std::fs::read(dir.path().join("identity.json")).unwrap()
        );
        request_binding(
            dir.path(),
            GatewayRequest {
                api_key: SecretChange::Keep,
                ..request()
            },
            &store,
            &trace,
        )
        .unwrap();
        let restored: Identity = journal::load(dir.path(), "identity.json").unwrap();
        assert_eq!(restored.device_id, identity.device_id);
        assert_eq!(restored.credential_id, identity.credential_id);
        assert_eq!(restored.installation_id, identity.installation_id);
        assert!(!restored.revoked);
        assert!(storage::load(dir.path()).unwrap().settings.gateway_enabled);
    }
    #[test]
    fn legacy_identity_and_old_executions_are_preserved_during_explicit_migration() {
        let dir = tempfile::tempdir().unwrap();
        let store = Memory::default();
        let trace = Trace::new();
        request_binding(dir.path(), request(), &store, &trace).unwrap();
        let identity = Identity {
            installation_id: uuid::Uuid::new_v4().to_string(),
            credential_id: uuid::Uuid::new_v4().to_string(),
            gateway: "https://gateway.example/".into(),
            device_id: Some("legacy-device".into()),
            protocol_version: 0,
            binding_requested: false,
            revoked: false,
        };
        store
            .write(
                &identity.credential_id,
                &Secrets {
                    api_key: "old-shared-device-secret".into(),
                    password: String::new(),
                },
            )
            .unwrap();
        journal::atomic(dir.path(), "identity.json", &identity).unwrap();
        std::fs::write(dir.path().join("journal.json"), b"legacy-executions").unwrap();
        assert_eq!(
            crate::device::identity(
                dir.path(),
                &storage::load(dir.path()).unwrap().settings,
                &store
            )
            .err()
            .unwrap()
            .code,
            "legacyIdentity"
        );
        request_binding(dir.path(), request(), &store, &trace).unwrap();
        let current: Identity = journal::load(dir.path(), "identity.json").unwrap();
        assert!(current.installation_id.is_empty() && current.binding_requested);
        assert_eq!(
            store.read(&identity.credential_id).unwrap().api_key,
            "old-shared-device-secret"
        );
        assert_eq!(
            std::fs::read(dir.path().join("journal.json")).unwrap(),
            b"legacy-executions"
        );
        assert!(!dir.path().join(crate::journal::JOURNAL).exists());
        let archive = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("legacy-identity-")
            })
            .unwrap();
        let saved: Identity = serde_json::from_slice(&std::fs::read(archive).unwrap()).unwrap();
        assert_eq!(saved.credential_id, identity.credential_id);
        assert_eq!(saved.device_id, identity.device_id);
    }
    #[test]
    fn empty_key_cannot_request_binding_or_modify_saved_settings() {
        let dir = tempfile::tempdir().unwrap();
        let mut req = request();
        req.api_key = SecretChange::Clear;
        assert_eq!(
            request_binding(dir.path(), req, &Memory::default(), &Trace::new())
                .err()
                .unwrap()
                .code,
            "gatewayRequired"
        );
        assert!(!dir.path().join("settings.json").exists());
    }
}
