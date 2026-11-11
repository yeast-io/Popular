//! Preferences do not rewrite credentials or validate unrelated connection drafts.
use crate::{errors::AgentError, journal, storage};
use std::path::Path;

pub fn locale(directory: &Path, locale: String) -> Result<(), AgentError> {
    if !matches!(locale.as_str(), "en-US" | "zh-CN") {
        return Err(AgentError::code("invalidSettings"));
    }
    let mut stored = storage::load(directory)?;
    stored.settings.locale = locale;
    journal::atomic(directory, "settings.json", &stored)
}

pub fn autostart(directory: &Path, enabled: bool) -> Result<(), AgentError> {
    let mut stored = storage::load(directory)?;
    stored.settings.autostart = enabled;
    journal::atomic(directory, "settings.json", &stored)
}

pub fn disconnect_gateway(directory: &Path) -> Result<(), AgentError> {
    let mut stored = storage::load(directory)?;
    stored.settings.gateway_enabled = false;
    journal::atomic(directory, "settings.json", &stored)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preferences_preserve_connection_and_credential_identity() {
        let dir = tempfile::tempdir().unwrap();
        let mut stored = crate::settings::StoredSettings::default();
        // Old connection settings must not block switching language or disabling startup.
        stored.settings.gateway_url = "http://gateway.example/".into();
        stored.settings.username = "local-user".into();
        stored.credential_id = Some(uuid::Uuid::new_v4().to_string());
        journal::atomic(dir.path(), "settings.json", &stored).unwrap();
        locale(dir.path(), "zh-CN".into()).unwrap();
        autostart(dir.path(), false).unwrap();
        let saved = storage::load(dir.path()).unwrap();
        assert_eq!(saved.settings.locale, "zh-CN");
        assert!(!saved.settings.autostart);
        assert_eq!(saved.settings.gateway_url, stored.settings.gateway_url);
        assert_eq!(saved.settings.username, "local-user");
        assert_eq!(saved.credential_id, stored.credential_id);
        let before = std::fs::read(dir.path().join("settings.json")).unwrap();
        assert!(locale(dir.path(), "invalid".into()).is_err());
        assert_eq!(
            before,
            std::fs::read(dir.path().join("settings.json")).unwrap()
        );
    }
}
