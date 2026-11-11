use super::types::{Site, Status, StoredSite, StoredSites, TorrentSource};
use crate::{errors::AgentError, journal, protocol::Context};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::Path,
    sync::Mutex,
    time::{Duration, Instant},
};
struct Ticket {
    context: Context,
    command_id: String,
    site: Site,
    credential_id: String,
    base_url: String,
    resource_id: String,
    source: TorrentSource,
    hash: String,
    expires: Instant,
}
#[derive(Default)]
pub(crate) struct ResourceTickets(Mutex<HashMap<String, Ticket>>);
impl ResourceTickets {
    fn prune(rows: &mut HashMap<String, Ticket>) {
        rows.retain(|_, ticket| ticket.expires > Instant::now());
    }
    pub(super) fn existing(
        &self,
        context: &Context,
        command: &str,
        row: &StoredSite,
        resource: &str,
    ) -> Option<Value> {
        let mut rows = self.0.lock().unwrap_or_else(|e| e.into_inner());
        Self::prune(&mut rows);
        rows.iter()
            .find(|(_, t)| {
                t.context.session_id == context.session_id
                    && t.context.instance_id == context.instance_id
                    && t.context.same_authority(context)
                    && t.command_id == command
                    && t.site == row.site
                    && t.credential_id == row.credential_id
                    && t.base_url == row.base_url
                    && t.resource_id == resource
            })
            .map(|(id, t)| json!({"agentTicket":id,"torrentHash":t.hash}))
    }
    pub(super) fn insert(
        &self,
        context: &Context,
        command: &str,
        row: &StoredSite,
        resource: &str,
        source: TorrentSource,
        hash: String,
    ) -> Result<Value, AgentError> {
        let mut rows = self.0.lock().unwrap_or_else(|e| e.into_inner());
        Self::prune(&mut rows);
        if rows.len() >= 64 {
            return Err(AgentError::code("siteRateLimited"));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let result = json!({"agentTicket":id,"torrentHash":hash});
        rows.insert(
            id,
            Ticket {
                context: context.clone(),
                command_id: command.into(),
                site: row.site,
                credential_id: row.credential_id.clone(),
                base_url: row.base_url.clone(),
                resource_id: resource.into(),
                source,
                hash,
                expires: Instant::now() + Duration::from_secs(120),
            },
        );
        Ok(result)
    }
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn resolve(
        &self,
        directory: &Path,
        context: &Context,
        id: &str,
        command: &str,
        source: &str,
        resource: &str,
        hash: &str,
    ) -> Result<TorrentSource, AgentError> {
        let mut rows = self.0.lock().unwrap_or_else(|e| e.into_inner());
        Self::prune(&mut rows);
        let t = rows
            .get(id)
            .ok_or_else(|| AgentError::code("siteTicketExpired"))?;
        if !t.context.same_authority(context)
            || t.context.instance_id != context.instance_id
            || t.context.session_id != context.session_id
            || t.command_id != command
            || t.site.id() != source
            || t.resource_id != resource
            || t.hash != hash
        {
            return Err(AgentError::code("invalidCommand"));
        }
        let stored: StoredSites = journal::load(directory, "resource-sites.json")?;
        if !stored.sites.iter().any(|r| {
            r.site == t.site
                && r.credential_id == t.credential_id
                && r.base_url == t.base_url
                && r.enabled
                && matches!(r.status, Status::ConfiguredValid)
        }) {
            return Err(AgentError::code("targetChanged"));
        }
        Ok(t.source.clone())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tickets_bind_command_session_resource_hash_and_current_local_credentials() {
        let directory = tempfile::tempdir().unwrap();
        let context = Context {
            owner_id: "owner-1".into(),
            device_id: "device-1".into(),
            auth_version: 1,
            device_version: 1,
            session_id: "session-1".into(),
            instance_id: "gateway-1".into(),
        };
        let mut row = StoredSite {
            site: Site::Mteam,
            base_url: "https://api.m-team.cc".into(),
            credential_id: uuid::Uuid::new_v4().to_string(),
            enabled: true,
            status: Status::ConfiguredValid,
            verified_at: 1,
            last_error: None,
        };
        let persist = |row: &StoredSite| {
            journal::atomic(
                directory.path(),
                "resource-sites.json",
                &StoredSites {
                    sites: vec![row.clone()],
                    pending_cleanup: vec![],
                },
            )
            .unwrap()
        };
        persist(&row);
        let tickets = ResourceTickets::default();
        let hash = "a".repeat(40);
        let value = tickets
            .insert(
                &context,
                "command-1",
                &row,
                "123",
                TorrentSource::Url("https://tracker.invalid/?private=secret".into()),
                hash.clone(),
            )
            .unwrap();
        let ticket = value["agentTicket"].as_str().unwrap();
        assert!(!value.to_string().contains("secret"));
        assert_eq!(
            tickets
                .existing(&context, "command-1", &row, "123")
                .unwrap(),
            value
        );
        let resolve = |ctx: &Context, command: &str, resource: &str, hash: &str| {
            tickets.resolve(
                directory.path(),
                ctx,
                ticket,
                command,
                "mteam",
                resource,
                hash,
            )
        };
        assert!(resolve(&context, "command-1", "123", &hash).is_ok());
        assert!(resolve(&context, "other-command", "123", &hash).is_err());
        assert!(resolve(&context, "command-1", "124", &hash).is_err());
        assert!(resolve(&context, "command-1", "123", &"b".repeat(40)).is_err());
        for field in ["owner", "session", "device", "instance"] {
            let mut other = context.clone();
            match field {
                "owner" => other.owner_id = "other".into(),
                "session" => other.session_id = "other".into(),
                "device" => other.device_id = "other".into(),
                _ => other.instance_id = "other".into(),
            };
            assert!(resolve(&other, "command-1", "123", &hash).is_err());
        }
        row.credential_id = uuid::Uuid::new_v4().to_string();
        persist(&row);
        assert!(resolve(&context, "command-1", "123", &hash).is_err());
        tickets.0.lock().unwrap().get_mut(ticket).unwrap().expires =
            Instant::now() - Duration::from_secs(1);
        assert_eq!(
            resolve(&context, "command-1", "123", &hash)
                .err()
                .unwrap()
                .code,
            "siteTicketExpired"
        );
    }
}
