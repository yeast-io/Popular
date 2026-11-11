//! Locally owned site configuration and fixed, session-bound resource operations.
pub(crate) mod resources;
pub(crate) mod tickets;
pub(crate) mod torrent;
pub(crate) mod types;
mod verification;
use crate::{
    credentials::CredentialStore,
    diagnostics::{self, Trace},
    errors::AgentError,
    journal,
    settings::{SecretChange, Secrets},
};
use std::{
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;
pub use types::{ConfigureRequest, EnabledRequest, Site, SiteRequest, SiteSnapshot};
use types::{PendingCredential, SiteSecrets, Status, StoredSite, StoredSites};
const FILE: &str = "resource-sites.json";

pub struct ResourceSites<C> {
    directory: PathBuf,
    credentials: Arc<C>,
    sites: [Mutex<()>; 3],
    commit: Mutex<()>,
}
impl<C: CredentialStore + Send + Sync + 'static> ResourceSites<C> {
    pub fn new(directory: PathBuf, credentials: Arc<C>) -> Self {
        Self {
            directory,
            credentials,
            sites: std::array::from_fn(|_| Mutex::new(())),
            commit: Mutex::new(()),
        }
    }
    fn load(&self) -> Result<StoredSites, AgentError> {
        let rows: StoredSites = journal::load(&self.directory, FILE)?;
        let mut seen = std::collections::BTreeSet::new();
        if rows.pending_cleanup.len() > 64
            || rows.pending_cleanup.iter().any(|id| {
                uuid::Uuid::parse_str(&id.credential_id).is_err()
                    || rows
                        .sites
                        .iter()
                        .any(|row| row.credential_id == id.credential_id)
            })
            || rows.sites.len() > 3
            || rows.sites.iter().any(|row| {
                !seen.insert(row.site) || uuid::Uuid::parse_str(&row.credential_id).is_err()
            })
        {
            return Err(AgentError::code("invalidSettings"));
        }
        Ok(rows)
    }
    fn secrets(&self, row: &StoredSite) -> Result<SiteSecrets, AgentError> {
        let bundle = self.credentials.read(&row.credential_id)?;
        let secrets: SiteSecrets = serde_json::from_str(&bundle.api_key)
            .map_err(|e| AgentError::caused("credentialError", e))?;
        if secrets.site != row.site || secrets.base_url != row.base_url {
            return Err(AgentError::code("credentialError"));
        }
        Ok(secrets)
    }
    fn snapshot(&self, site: Site, row: Option<&StoredSite>) -> Result<SiteSnapshot, AgentError> {
        let secrets = row.map(|row| self.secrets(row)).transpose()?;
        Ok(SiteSnapshot {
            site,
            base_url: row
                .map(|r| r.base_url.clone())
                .unwrap_or_else(|| site.base().into()),
            enabled: row.is_some_and(|r| r.enabled),
            status: match row.map(|r| &r.status) {
                None => "unconfigured",
                Some(Status::ConfiguredValid) => "configured_valid",
                Some(Status::ConfiguredInvalid) => "configured_invalid",
            },
            has_credential: secrets.as_ref().is_some_and(|s| !s.credential.is_empty()),
            has_passkey: false,
            requires_passkey: false,
            verified_at: row.map(|r| r.verified_at),
            last_error: row.and_then(|r| r.last_error.clone()),
        })
    }
    pub async fn list(&self, trace: &Trace) -> Result<Vec<SiteSnapshot>, AgentError> {
        // Serialize readers with the short commit/credential cleanup window, not network I/O.
        let _guard = self.commit.lock().await;
        let mut stored = self.load()?;
        self.cleanup_pending(&mut stored, trace)?;
        Site::ALL
            .into_iter()
            .map(|site| {
                let row = stored.sites.iter().find(|r| r.site == site);
                match self.snapshot(site, row) {
                    Ok(snapshot) => Ok(snapshot),
                    Err(error) => {
                        diagnostics::failure(
                            "resource-sites.credentials.read",
                            &trace.id,
                            &error,
                            0,
                        );
                        let mut snapshot = self.snapshot(site, None)?;
                        if let Some(row) = row {
                            snapshot.base_url = row.base_url.clone();
                            snapshot.enabled = row.enabled;
                            snapshot.status = "configured_invalid";
                            snapshot.verified_at = Some(row.verified_at);
                            snapshot.last_error = Some("credentialError".into());
                        }
                        Ok(snapshot)
                    }
                }
            })
            .collect()
    }
    pub async fn configure(
        &self,
        input: ConfigureRequest,
        trace: &Trace,
    ) -> Result<SiteSnapshot, AgentError> {
        let _site = self.sites[input.site.index()].lock().await;
        trace.stage("resource-sites.configure.started");
        let base = verification::endpoint(&input.base_url, input.site)?;
        let old = {
            let _guard = self.commit.lock().await;
            self.load()?
                .sites
                .into_iter()
                .find(|r| r.site == input.site)
        };
        let same = old
            .as_ref()
            .is_some_and(|row| row.base_url == base.as_str());
        let replacing_credential = matches!(input.credential, SecretChange::Set(_));

        let old_secrets = if same {
            match old.as_ref().map(|row| self.secrets(row)).transpose() {
                Ok(secrets) => secrets,
                Err(error) if replacing_credential => {
                    diagnostics::failure(
                        "resource-sites.credentials.replace-unreadable",
                        &trace.id,
                        &error,
                        0,
                    );
                    None
                }
                Err(error) => return Err(error),
            }
        } else {
            None
        };
        let credential = replacement(
            input.credential,
            old_secrets.as_ref().map(|s| s.credential.as_str()),
        )?;
        // Legacy passkeys are ignored; Cookie authentication also handles torrent retrieval.
        let passkey = String::new();
        if credential.len() > 8192
            || (input.site == Site::Mteam && credential.len() > 4096)
            || credential.chars().any(char::is_control)
            || passkey.len() > 2048
            || passkey.chars().any(|c| c.is_whitespace() || c.is_control())
        {
            return Err(AgentError::code("invalidSecret"));
        }
        // Failed replacement never overwrites the last working configuration or credentials.
        let external_user_id = verification::verify(input.site, &base, &credential, trace).await?;
        let secrets = SiteSecrets {
            site: input.site,
            base_url: base.to_string(),
            credential,
            passkey,
            external_user_id,
        };
        let row = StoredSite {
            site: input.site,
            base_url: base.to_string(),
            credential_id: uuid::Uuid::new_v4().to_string(),
            enabled: old.as_ref().is_none_or(|row| row.enabled),
            status: Status::ConfiguredValid,
            verified_at: now()?,
            last_error: None,
        };
        let bundle = Secrets {
            api_key: serde_json::to_string(&secrets)?,
            password: String::new(),
        };
        let _commit = self.commit.lock().await;
        let mut stored = self.load()?;
        trace.stage("resource-sites.credentials.write.started");
        if let Err(error) = self.credentials.write(&row.credential_id, &bundle) {
            cleanup(self.credentials.as_ref(), &row.credential_id, trace);
            return Err(error);
        }
        stored.sites.retain(|existing| existing.site != input.site);
        stored.sites.push(row.clone());
        if let Some(old) = &old {
            stored.pending_cleanup.push(PendingCredential {
                site: old.site,
                credential_id: old.credential_id.clone(),
            });
        }
        trace.stage("resource-sites.configuration.write.started");
        if let Err(error) = journal::atomic(&self.directory, FILE, &stored) {
            cleanup(self.credentials.as_ref(), &row.credential_id, trace);
            return Err(error);
        }
        self.cleanup_pending(&mut stored, trace)?;
        trace.stage("resource-sites.configure.completed");
        self.snapshot(input.site, Some(&row))
    }
    pub async fn verify(&self, site: Site, trace: &Trace) -> Result<SiteSnapshot, AgentError> {
        let _site = self.sites[site.index()].lock().await;
        trace.stage("resource-sites.reverify.started");
        let mut row = {
            let _guard = self.commit.lock().await;
            self.load()?
                .sites
                .into_iter()
                .find(|r| r.site == site)
                .ok_or_else(|| AgentError::code("siteNotConfigured"))?
        };
        let secrets = self.secrets(&row)?;
        let base = verification::endpoint(&row.base_url, site)?;
        let result = verification::verify(site, &base, &secrets.credential, trace).await;
        match &result {
            Ok(identity) if identity != &secrets.external_user_id => {
                row.status = Status::ConfiguredInvalid;
                row.last_error = Some("siteAccountChanged".into());
            }
            Ok(_) => {
                row.status = Status::ConfiguredValid;
                row.verified_at = now()?;
                row.last_error = None;
            }
            Err(error) if matches!(error.code, "siteAuthentication" | "siteBlocked") => {
                row.status = Status::ConfiguredInvalid;
                row.last_error = Some(error.code.into());
            }
            Err(_) => return result.map(|_| unreachable!()),
        }
        let _commit = self.commit.lock().await;
        let mut stored = self.load()?;
        stored.sites.retain(|existing| existing.site != site);
        stored.sites.push(row.clone());
        journal::atomic(&self.directory, FILE, &stored)?;
        if result
            .as_ref()
            .is_ok_and(|id| id != &secrets.external_user_id)
        {
            return Err(AgentError::code("siteAccountChanged"));
        }
        result?;
        trace.stage("resource-sites.reverify.completed");
        self.snapshot(site, Some(&row))
    }
    pub async fn set_enabled(
        &self,
        input: EnabledRequest,
        trace: &Trace,
    ) -> Result<SiteSnapshot, AgentError> {
        let _site = self.sites[input.site.index()].lock().await;
        let _guard = self.commit.lock().await;
        trace.stage("resource-sites.enabled.started");
        let mut stored = self.load()?;
        let row = stored
            .sites
            .iter_mut()
            .find(|r| r.site == input.site)
            .ok_or_else(|| AgentError::code("siteNotConfigured"))?;
        if input.enabled && matches!(row.status, Status::ConfiguredInvalid) {
            return Err(AgentError::code("siteAuthentication"));
        }
        row.enabled = input.enabled;
        let snapshot = self.snapshot(input.site, Some(row))?;
        journal::atomic(&self.directory, FILE, &stored)?;
        trace.stage("resource-sites.enabled.completed");
        Ok(snapshot)
    }
    fn cleanup_pending(&self, stored: &mut StoredSites, trace: &Trace) -> Result<(), AgentError> {
        let before = stored.pending_cleanup.len();
        stored
            .pending_cleanup
            .retain(|id| match self.credentials.delete(&id.credential_id) {
                Ok(()) => false,
                Err(error) => {
                    diagnostics::failure(
                        "resource-sites.credentials.cleanup",
                        &trace.id,
                        &error,
                        0,
                    );
                    true
                }
            });
        if stored.pending_cleanup.len() != before {
            journal::atomic(&self.directory, FILE, stored)?;
        }
        Ok(())
    }
    pub async fn remove(&self, site: Site, trace: &Trace) -> Result<(), AgentError> {
        let _site = self.sites[site.index()].lock().await;
        let _guard = self.commit.lock().await;
        trace.stage("resource-sites.delete.started");
        let mut stored = self.load()?;
        let old = stored.sites.iter().find(|r| r.site == site).cloned();
        stored.sites.retain(|row| row.site != site);
        if let Some(row) = old {
            stored.pending_cleanup.push(PendingCredential {
                site: row.site,
                credential_id: row.credential_id,
            });
        }
        journal::atomic(&self.directory, FILE, &stored)?;
        self.cleanup_pending(&mut stored, trace)?;
        if stored
            .pending_cleanup
            .iter()
            .any(|pending| pending.site == site)
        {
            return Err(AgentError::code("credentialError"));
        }
        trace.stage("resource-sites.delete.completed");
        Ok(())
    }
}
fn replacement(input: SecretChange, previous: Option<&str>) -> Result<String, AgentError> {
    let value = match input {
        SecretChange::Set(value) => value,
        SecretChange::Keep => previous.unwrap_or_default().into(),
        SecretChange::Clear => String::new(),
    };
    if value.trim().is_empty() || value == "********" {
        return Err(AgentError::code("invalidSecret"));
    }
    Ok(value)
}
fn cleanup<C: CredentialStore>(store: &C, id: &str, trace: &Trace) {
    if let Err(error) = store.delete(id) {
        diagnostics::failure("resource-sites.credentials.cleanup", &trace.id, &error, 0);
    }
}
fn now() -> Result<u64, AgentError> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| AgentError::caused("runtimeError", e))?
        .as_millis() as u64)
}
#[cfg(test)]
mod tests;

fn keep_secret() -> SecretChange {
    SecretChange::Keep
}
