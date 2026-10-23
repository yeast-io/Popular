//! Read-only server queue metadata. This cache never authorizes or executes downloads.
use crate::{
    errors::AgentError,
    journal::{self, Identity},
    protocol::{self, Context},
    runtime::Runtime,
    AgentState,
};
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

const CACHE: &str = "queue-cache.json";
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|v| v.as_millis() as u64)
        .unwrap_or(0)
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Item {
    pub command_id: String,
    pub resource_id: String,
    pub source: String,
    pub title: Option<String>,
    pub enqueued_at: u64,
    pub expires_at: u64,
    pub reason: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub observed_at: u64,
    pub total: u64,
    #[serde(default)]
    pub cursor: Option<String>,
    pub next_cursor: Option<String>,
    pub items: Vec<Item>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Cache {
    credential_id: String,
    gateway: String,
    device_id: String,
    auth_version: u64,
    device_version: u64,
    received_at: u64,
    snapshot: Snapshot,
}
#[derive(Default)]
pub struct State {
    pub cache: Option<Cache>,
    pub cursor: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub snapshot: Option<Snapshot>,
    pub stale: bool,
    pub loading: bool,
}
fn cursor_valid(cursor: &str) -> bool {
    let Some((expiry, id)) = cursor.split_once(':') else {
        return false;
    };
    cursor.len() <= 200 && expiry.parse::<u64>().is_ok_and(protocol::positive) && protocol::id(id)
}
impl Snapshot {
    fn valid(&self) -> bool {
        protocol::positive(self.observed_at)
            && self.total <= protocol::MAX_INTEGER
            && self.items.len() <= 50
            && self.total >= self.items.len() as u64
            && self.cursor.as_ref().is_none_or(|v| cursor_valid(v))
            && self.next_cursor.as_ref().is_none_or(|v| cursor_valid(v))
            && self.items.iter().all(|item| {
                protocol::id(&item.command_id)
                    && protocol::id(&item.resource_id)
                    && matches!(item.source.as_str(), "mteam" | "hdarea")
                    && item.title.as_ref().is_none_or(|v| v.chars().count() <= 512)
                    && protocol::positive(item.enqueued_at)
                    && protocol::positive(item.expires_at)
                    && item.expires_at > item.enqueued_at
                    && matches!(
                        item.reason.as_str(),
                        "queued"
                            | "agent_offline"
                            | "downloader_unavailable"
                            | "target_changed"
                            | "gateway_unavailable"
                            | "retrying"
                            | "verifying"
                            | "executing"
                    )
            })
    }
}
impl Cache {
    fn matches(&self, identity: &Identity) -> bool {
        !identity.revoked
            && self.credential_id == identity.credential_id
            && self.gateway == identity.gateway
            && identity.device_id.as_deref() == Some(self.device_id.as_str())
    }
}
pub fn same_binding(cache: &Cache, context: &Context) -> bool {
    cache.device_id == context.device_id
        && cache.auth_version == context.auth_version
        && cache.device_version == context.device_version
}
pub fn initialize(directory: &Path, runtime: &Runtime) {
    let cache = journal::load::<Option<Cache>>(directory, CACHE)
        .ok()
        .flatten();
    runtime
        .queue
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .cache = cache.filter(|c| c.snapshot.valid());
}
pub fn view(directory: &Path, runtime: &Runtime) -> View {
    let identity = journal::load::<Identity>(directory, "identity.json").unwrap_or_default();
    let online = runtime.snapshot().service == "online";
    let state = runtime.queue.lock().unwrap_or_else(|e| e.into_inner());
    let cache = state
        .cache
        .as_ref()
        .filter(|cache| cache.matches(&identity));
    View {
        snapshot: cache.map(|cache| cache.snapshot.clone()),
        stale: cache.is_none_or(|cache| {
            !online
                || now()
                    .checked_sub(cache.received_at)
                    .is_none_or(|age| age > 45000)
        }),
        loading: online && cache.is_none_or(|cache| cache.snapshot.cursor != state.cursor),
    }
}
pub fn accept(
    directory: &Path,
    runtime: &Runtime,
    identity: &Identity,
    context: &Context,
    payload: &serde_json::Value,
) -> Result<(), AgentError> {
    let snapshot: Snapshot = protocol::parse(payload)?;
    if !snapshot.valid() {
        return Err(protocol::invalid());
    }
    let current: Identity = journal::load(directory, "identity.json")?;
    if current.credential_id != identity.credential_id
        || current.gateway != identity.gateway
        || current.device_id.as_deref() != Some(&context.device_id)
        || current.revoked
    {
        return Err(protocol::invalid());
    }
    let mut state = runtime.queue.lock().unwrap_or_else(|e| e.into_inner());
    if state.cursor != snapshot.cursor {
        return Ok(());
    }
    let cache = Cache {
        credential_id: identity.credential_id.clone(),
        gateway: identity.gateway.clone(),
        device_id: context.device_id.clone(),
        auth_version: context.auth_version,
        device_version: context.device_version,
        received_at: now(),
        snapshot,
    };
    journal::atomic(directory, CACHE, &Some(&cache))?;
    state.cache = Some(cache);
    Ok(())
}
#[tauri::command]
pub fn queue_status(app: tauri::AppHandle) -> View {
    view(
        &app.state::<AgentState>().directory,
        &app.state::<Runtime>(),
    )
}
#[tauri::command]
pub fn queue_page(app: tauri::AppHandle, cursor: Option<String>) -> Result<(), String> {
    if cursor.as_ref().is_some_and(|v| !cursor_valid(v)) {
        return Err("invalidCommand".into());
    }
    let runtime = app.state::<Runtime>();
    runtime
        .queue
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .cursor = cursor;
    runtime.queue_refresh.notify_one();
    Ok(())
}
#[tauri::command]
pub fn select_page(app: tauri::AppHandle, page: String) -> Result<(), String> {
    if !matches!(page.as_str(), "settings" | "queue") {
        return Err("invalidCommand".into());
    }
    if page == "queue" {
        app.state::<Runtime>().queue_refresh.notify_one();
    }
    app.state::<Runtime>()
        .status
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .page = page;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn snapshots_are_scoped_cached_and_pagination_never_authorizes_execution() {
        let directory = tempfile::tempdir().unwrap();
        let mut identity = Identity {
            credential_id: "local-credential".into(),
            gateway: "https://gateway.invalid".into(),
            device_id: Some("device-a".into()),
            ..Default::default()
        };
        journal::atomic(directory.path(), "identity.json", &identity).unwrap();
        let context: Context = protocol::parse(
            &json!({"ownerId":"owner","deviceId":"device-a","authVersion":1,
            "deviceVersion":1,"sessionId":"session","instanceId":"gateway"}),
        )
        .unwrap();
        let runtime = Runtime::default();
        runtime.update(Some("online"), None, None);
        let data = json!({"observedAt":now(),"total":1,"nextCursor":null,"items":[{
            "commandId":"command","resourceId":"991","source":"hdarea","title":"电影 · Movie",
            "enqueuedAt":1000,"expiresAt":100000,"reason":"downloader_unavailable"}]});
        accept(directory.path(), &runtime, &identity, &context, &data).unwrap();
        assert_eq!(view(directory.path(), &runtime).snapshot.unwrap().total, 1);
        assert!(!view(directory.path(), &runtime).stale);
        let restored = Runtime::default();
        initialize(directory.path(), &restored);
        assert!(view(directory.path(), &restored).stale);
        assert_eq!(
            view(directory.path(), &restored).snapshot.unwrap().items[0]
                .title
                .as_deref(),
            Some("电影 · Movie")
        );
        assert!(!directory.path().join("gateway-journal.json").exists());
        runtime.queue.lock().unwrap().cursor = Some("100000:command".into());
        assert!(view(directory.path(), &runtime).loading);
        accept(directory.path(), &runtime, &identity, &context, &data).unwrap();
        assert!(view(directory.path(), &runtime).loading);
        identity.device_id = Some("other-device".into());
        journal::atomic(directory.path(), "identity.json", &identity).unwrap();
        assert!(view(directory.path(), &runtime).snapshot.is_none());
        assert!(accept(directory.path(), &runtime, &identity, &context, &data).is_err());
    }
    #[test]
    fn rejects_invalid_queue_payloads_and_cursors() {
        assert!(cursor_valid("1000:command-a"));
        for cursor in ["0:command", "1000:$where", "1000:a:b", "not-a-page"] {
            assert!(!cursor_valid(cursor));
        }
        let data = json!({"observedAt":1000,"total":0,"nextCursor":null,"items":[]});
        let snapshot: Snapshot = protocol::parse(&data).unwrap();
        assert!(snapshot.valid());
        let mut invalid = data.clone();
        invalid["nextCursor"] = json!("arbitrary");
        assert!(!protocol::parse::<Snapshot>(&invalid).unwrap().valid());
        invalid = data;
        invalid["torrentUrl"] = json!("https://tracker.invalid/secret");
        assert!(protocol::parse::<Snapshot>(&invalid).is_err());
    }
}
