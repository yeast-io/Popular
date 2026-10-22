use crate::{errors::AgentError, settings::Secrets};

pub trait CredentialStore {
    fn read(&self, id: &str) -> Result<Secrets, AgentError>;
    fn write(&self, id: &str, secrets: &Secrets) -> Result<(), AgentError>;
    fn delete(&self, id: &str) -> Result<(), AgentError>;
}

pub struct NativeCredentials;
fn entry(id: &str) -> Result<keyring::Entry, AgentError> {
    keyring::Entry::new("com.popular.helper-agent", id).map_err(storage_error)
}
fn storage_error(error: keyring::Error) -> AgentError {
    // Retain the native error as a cause, but diagnostics must never format it:
    // BadEncoding may contain raw secret bytes.
    AgentError::caused("credentialError", error)
}
impl CredentialStore for NativeCredentials {
    fn read(&self, id: &str) -> Result<Secrets, AgentError> {
        let text = entry(id)?.get_password().map_err(storage_error)?;
        serde_json::from_str(&text).map_err(|e| AgentError::caused("credentialError", e))
    }
    fn write(&self, id: &str, secrets: &Secrets) -> Result<(), AgentError> {
        let text = serde_json::to_string(secrets)?;
        let entry = entry(id)?;
        entry.set_password(&text).map_err(storage_error)?;
        if entry.get_password().map_err(storage_error)? != text {
            return Err(AgentError::code("credentialError"));
        }
        Ok(())
    }
    fn delete(&self, id: &str) -> Result<(), AgentError> {
        match entry(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(storage_error(error)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "Writes and deletes a uniquely named dummy entry in the native OS credential store"]
    fn native_credential_roundtrip() {
        let id = uuid::Uuid::new_v4().to_string();
        let secrets = Secrets {
            api_key: "dummy-test-api-key".into(),
            password: "dummy-test-password".into(),
        };
        let store = NativeCredentials;
        let saved = store.write(&id, &secrets);
        let loaded = store.read(&id);
        let removed = store.delete(&id);
        assert!(saved.is_ok());
        assert!(removed.is_ok());
        let loaded = loaded.unwrap();
        assert_eq!(loaded.api_key, secrets.api_key);
        assert_eq!(loaded.password, secrets.password);
        assert!(store.read(&id).is_err());
    }
}
