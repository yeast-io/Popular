use crate::{credentials::CredentialStore, errors::AgentError, settings::*};
use std::{io::Write, path::Path};

pub fn load(directory: &Path) -> Result<StoredSettings, AgentError> {
    match std::fs::read(directory.join("settings.json")) {
        Ok(bytes) => {
            let stored: StoredSettings = serde_json::from_slice(&bytes)?;
            validate_stored(&stored.settings)?;
            if stored
                .credential_id
                .as_ref()
                .is_some_and(|id| uuid::Uuid::parse_str(id).is_err())
            {
                return Err(AgentError::code("storageError"));
            }
            Ok(stored)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(StoredSettings::default()),
        Err(error) => Err(error.into()),
    }
}
pub fn secrets(
    stored: &StoredSettings,
    store: &impl CredentialStore,
) -> Result<Secrets, AgentError> {
    stored
        .credential_id
        .as_ref()
        .map_or_else(|| Ok(Secrets::default()), |id| store.read(id))
}
pub fn snapshot(stored: StoredSettings, secrets: &Secrets) -> Snapshot {
    Snapshot {
        settings: stored.settings,
        has_api_key: !secrets.api_key.is_empty(),
        has_password: !secrets.password.is_empty(),
    }
}

pub fn save(
    directory: &Path,
    request: SaveRequest,
    store: &impl CredentialStore,
    trace: &crate::diagnostics::Trace,
) -> Result<Snapshot, AgentError> {
    let old = load(directory)?;
    let settings = normalize(request.settings)?;
    trace.stage("settings.credentials.read.started");
    let previous = secrets(&old, store)?;
    trace.stage("settings.credentials.read.completed");
    let secrets = Secrets {
        api_key: resolve_secret(
            &request.api_key,
            &previous.api_key,
            settings.gateway_url == old.settings.gateway_url,
        )?,
        password: resolve_secret(
            &request.password,
            &previous.password,
            same_downloader(&settings, &old.settings),
        )?,
    };
    std::fs::create_dir_all(directory)?;
    let credential_id = if secrets.api_key.is_empty() && secrets.password.is_empty() {
        None
    } else {
        Some(uuid::Uuid::new_v4().to_string())
    };
    // New immutable credential entry first; the atomic file replacement is the commit point.
    // A failed save cannot attach new credentials to the old destination.
    trace.stage("settings.credentials.write.started");
    if let Some(id) = &credential_id {
        if let Err(error) = store.write(id, &secrets) {
            let _ = store.delete(id);
            return Err(error);
        }
    }
    trace.stage("settings.credentials.write.completed");
    let stored = StoredSettings {
        settings,
        credential_id,
    };
    trace.stage("settings.file.write.started");
    let commit = || -> Result<(), AgentError> {
        let mut file = tempfile::NamedTempFile::new_in(directory)?;
        file.write_all(&serde_json::to_vec_pretty(&stored)?)?;
        file.as_file().sync_all()?;
        file.persist(directory.join("settings.json"))
            .map_err(|e| AgentError::from(e.error))?;
        Ok(())
    };
    if let Err(error) = commit() {
        if let Some(id) = &stored.credential_id {
            let _ = store.delete(id);
        }
        return Err(error);
    }
    trace.stage("settings.file.write.completed");
    if let Some(id) = &old.credential_id {
        if let Err(error) = store.delete(id) {
            crate::diagnostics::failure("credentials.cleanup", &trace.id, &error, 0);
        }
    }
    Ok(snapshot(stored, &secrets))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, collections::HashMap};
    #[derive(Default)]
    struct MemoryStore {
        data: RefCell<HashMap<String, String>>,
        fail: bool,
    }
    impl CredentialStore for MemoryStore {
        fn read(&self, id: &str) -> Result<Secrets, AgentError> {
            Ok(serde_json::from_str(
                self.data
                    .borrow()
                    .get(id)
                    .ok_or(AgentError::code("credentialError"))?,
            )?)
        }
        fn write(&self, id: &str, value: &Secrets) -> Result<(), AgentError> {
            if self.fail {
                return Err(AgentError::code("credentialError"));
            }
            self.data
                .borrow_mut()
                .insert(id.into(), serde_json::to_string(value)?);
            Ok(())
        }
        fn delete(&self, id: &str) -> Result<(), AgentError> {
            self.data.borrow_mut().remove(id);
            Ok(())
        }
    }
    fn save(
        directory: &Path,
        request: SaveRequest,
        store: &impl CredentialStore,
    ) -> Result<Snapshot, AgentError> {
        super::save(directory, request, store, &crate::diagnostics::Trace::new())
    }
    fn request() -> SaveRequest {
        SaveRequest {
            settings: Settings {
                gateway_url: "https://gateway.example".into(),
                ..Settings::default()
            },
            api_key: SecretChange::Set("private-api-key".into()),
            password: SecretChange::Set("private-password".into()),
        }
    }
    #[test]
    fn roundtrip_keeps_secrets_out_of_json_and_supports_keep_clear() {
        let dir = tempfile::tempdir().unwrap();
        let store = MemoryStore::default();
        let first = save(dir.path(), request(), &store).unwrap();
        let json = std::fs::read_to_string(dir.path().join("settings.json")).unwrap();
        assert!(!json.contains("private-"));
        assert!(first.has_api_key && first.has_password);
        let settings = load(dir.path()).unwrap().settings;
        let second = save(
            dir.path(),
            SaveRequest {
                settings,
                api_key: SecretChange::Keep,
                password: SecretChange::Clear,
            },
            &store,
        )
        .unwrap();
        assert!(second.has_api_key && !second.has_password);
        assert_eq!(store.data.borrow().len(), 1);
        assert_eq!(
            secrets(&load(dir.path()).unwrap(), &store).unwrap().api_key,
            "private-api-key"
        );
    }
    #[test]
    fn keyring_failure_preserves_previous_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = MemoryStore::default();
        save(dir.path(), request(), &store).unwrap();
        let before = std::fs::read(dir.path().join("settings.json")).unwrap();
        let failing = MemoryStore {
            data: store.data,
            fail: true,
        };
        assert!(save(dir.path(), request(), &failing).is_err());
        assert_eq!(
            before,
            std::fs::read(dir.path().join("settings.json")).unwrap()
        );
    }
    #[test]
    fn corrupt_settings_are_not_silently_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("settings.json"), b"broken").unwrap();
        assert!(save(dir.path(), request(), &MemoryStore::default()).is_err());
        assert_eq!(
            std::fs::read(dir.path().join("settings.json")).unwrap(),
            b"broken"
        );
    }
}
