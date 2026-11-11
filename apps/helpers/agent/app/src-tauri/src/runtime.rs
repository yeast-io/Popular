//! Desktop presentation state; business state belongs to the shared Core runtime.
use serde::Serialize;
use std::{
    ops::Deref,
    sync::{Arc, Mutex},
};

#[derive(Default)]
pub struct Presentation {
    pub page: String,
    pub preference_error: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub autostart: Option<bool>,
    pub page: String,
    #[serde(flatten)]
    pub business: popular_agent_core::runtime::Status,
    pub preference_error: Option<String>,
}
pub struct Runtime {
    core: Arc<popular_agent_core::runtime::Runtime>,
    pub status: Mutex<Presentation>,
}
impl Runtime {
    pub fn new(core: Arc<popular_agent_core::runtime::Runtime>) -> Self {
        Self {
            core,
            status: Mutex::new(Presentation {
                page: "settings".into(),
                preference_error: None,
            }),
        }
    }
    pub fn preference_error(&self, error: Option<String>) {
        self.status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .preference_error = error;
    }
    pub fn snapshot(&self) -> Status {
        let presentation = self.status.lock().unwrap_or_else(|e| e.into_inner());
        Status {
            autostart: None,
            page: presentation.page.clone(),
            preference_error: presentation.preference_error.clone(),
            business: self.core.snapshot(),
        }
    }
}
impl Deref for Status {
    type Target = popular_agent_core::runtime::Status;
    fn deref(&self) -> &Self::Target {
        &self.business
    }
}
impl Deref for Runtime {
    type Target = popular_agent_core::runtime::Runtime;
    fn deref(&self) -> &Self::Target {
        &self.core
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn desktop_snapshot_keeps_legacy_shape_and_shares_core_state() {
        let core = Arc::new(popular_agent_core::runtime::Runtime::default());
        let runtime = Runtime::new(core.clone());
        core.update(Some("online"), Some("unreachable"), Some("device".into()));
        runtime.status.lock().unwrap().page = "queue".into();
        runtime.preference_error(Some("autostartError".into()));
        let value = serde_json::to_value(runtime.snapshot()).unwrap();
        assert_eq!(value["page"], "queue");
        assert_eq!(value["service"], "online");
        assert_eq!(value["downloader"], "unreachable");
        assert_eq!(value["deviceId"], "device");
        assert_eq!(value["binding"], "unbound");
        assert_eq!(value["preferenceError"], "autostartError");
        assert!(value.get("business").is_none());
        assert!(serde_json::to_value(core.snapshot())
            .unwrap()
            .get("page")
            .is_none());
    }
}
