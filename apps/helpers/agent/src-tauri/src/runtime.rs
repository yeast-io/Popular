use crate::{
    credentials::NativeCredentials,
    diagnostics,
    errors::AgentError,
    journal::{self, Identity},
    settings::Settings,
    storage, AgentState,
};
use serde::Serialize;
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::Manager;
#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BindingState {
    Unbound,
    Binding,
    Bound,
    RebindRequired,
}

pub fn binding(identity: &Identity, settings: &Settings) -> BindingState {
    if identity.device_id.is_none() {
        BindingState::Unbound
    } else if identity.revoked || identity.gateway != settings.gateway_url {
        BindingState::RebindRequired
    } else {
        BindingState::Bound
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub service: String,
    pub downloader: String,
    pub device_id: Option<String>,
    pub binding: BindingState,
    pub preference_error: Option<String>,
}
pub struct Runtime {
    pub status: Mutex<Status>,
    pub suspended: std::sync::atomic::AtomicBool,
    pub changed: tokio::sync::Notify,
    pub downloader_changed: tokio::sync::Notify,
}
impl Default for Runtime {
    fn default() -> Self {
        Self {
            status: Mutex::new(Status {
                service: "unconfigured".into(),
                downloader: "disconnected".into(),
                device_id: None,
                binding: BindingState::Unbound,
                preference_error: None,
            }),
            suspended: Default::default(),
            changed: Default::default(),
            downloader_changed: Default::default(),
        }
    }
}
impl Runtime {
    pub fn preference_error(&self, error: Option<String>) {
        self.status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .preference_error = error;
    }
    pub fn set_binding(&self, binding: BindingState, device: Option<String>) {
        let mut status = self.status.lock().unwrap_or_else(|e| e.into_inner());
        status.binding = binding;
        status.device_id = device;
    }
    pub fn update(&self, service: Option<&str>, downloader: Option<&str>, device: Option<String>) {
        let mut s = self.status.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(v) = service {
            s.service = v.into();
        }
        if let Some(v) = downloader {
            s.downloader = v.into();
        }
        if device.is_some() {
            s.device_id = device;
        }
    }
    pub fn snapshot(&self) -> Status {
        self.status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}
async fn session(
    app: &tauri::AppHandle,
    settings: Settings,
    secrets: crate::settings::Secrets,
) -> Result<(), AgentError> {
    let state = app.state::<AgentState>();
    let runtime = app.state::<Runtime>();
    let (identity, keys) = {
        let _guard = state.lock.lock().await;
        let directory = state.directory.clone();
        let config = settings.clone();
        tauri::async_runtime::spawn_blocking(move || {
            crate::device::identity(&directory, &config, &NativeCredentials)
        })
        .await
        .map_err(|e| AgentError::caused("runtimeError", e))??
    };
    crate::connection::session_transport(
        &state.directory,
        &state.lock,
        &runtime,
        settings,
        secrets,
        identity,
        keys,
    )
    .await
}
pub async fn run(app: tauri::AppHandle) {
    let mut delay = 1_u64;
    let mut attempt = 0_u64;
    loop {
        let started = Instant::now();
        let result = async {
            let state = app.state::<AgentState>();
            let (settings, secrets) = {
                let _guard = state.lock.lock().await;
                let stored = storage::load(&state.directory)?;
                if !stored.settings.gateway_enabled
                    || app
                        .state::<Runtime>()
                        .suspended
                        .load(std::sync::atomic::Ordering::SeqCst)
                {
                    let runtime = app.state::<Runtime>();
                    let identity: Identity = journal::load(&state.directory, "identity.json")?;
                    runtime.set_binding(binding(&identity, &stored.settings), identity.device_id);
                    runtime.update(Some("manuallyDisconnected"), None, None);
                    drop(_guard);
                    runtime.changed.notified().await;
                    return Ok(());
                }
                let secrets = storage::secrets(&stored, &NativeCredentials)?;
                (stored.settings, secrets)
            };
            let identity: Identity = journal::load(&state.directory, "identity.json")?;
            let binding = binding(&identity, &settings);
            let runtime = app.state::<Runtime>();
            runtime.set_binding(binding, identity.device_id.clone());
            let waiting = if settings.gateway_url.is_empty() || secrets.api_key.is_empty() {
                Some("unconfigured")
            } else if identity.protocol_version == 0 && !identity.installation_id.is_empty() {
                Some("legacyIdentity")
            } else if binding == BindingState::RebindRequired {
                Some("rebindRequired")
            } else if binding == BindingState::Unbound
                && (identity.revoked || !identity.binding_requested)
            {
                Some(if identity.revoked {
                    "bindingFailed"
                } else {
                    "unbound"
                })
            } else {
                None
            };
            if let Some(service) = waiting {
                runtime.update(Some(service), None, None);
                runtime.changed.notified().await;
                return Ok(());
            }
            session(&app, settings, secrets).await
        }
        .await;
        let runtime = app.state::<Runtime>();
        match result {
            Err(e) => {
                let state = app.state::<AgentState>();
                let identity: Identity =
                    journal::load(&state.directory, "identity.json").unwrap_or_default();
                let settings = storage::load(&state.directory)
                    .map(|s| s.settings)
                    .unwrap_or_default();
                let binding = binding(&identity, &settings);
                runtime.set_binding(binding, identity.device_id.clone());
                runtime.update(
                    Some(if !settings.gateway_enabled {
                        "manuallyDisconnected"
                    } else if e.code == "rebindRequired" {
                        if binding == BindingState::Unbound {
                            "bindingFailed"
                        } else {
                            "rebindRequired"
                        }
                    } else if matches!(
                        e.code,
                        "gatewayProtocol"
                            | "legacyIdentity"
                            | "deviceLimitReached"
                            | "sessionRevoked"
                    ) {
                        e.code
                    } else {
                        "disconnected"
                    }),
                    None,
                    None,
                );
                diagnostics::failure(
                    "gateway.session",
                    "gateway",
                    &e,
                    started.elapsed().as_millis(),
                );
                if matches!(
                    e.code,
                    "rebindRequired"
                        | "legacyIdentity"
                        | "deviceLimitReached"
                        | "gatewayProtocol"
                        | "sessionRevoked"
                ) {
                    runtime.changed.notified().await;
                    delay = 1;
                    continue;
                }
            }
            Ok(()) => {
                delay = 1;
                continue;
            }
        }
        if started.elapsed() > Duration::from_secs(60) {
            delay = 1;
        }
        let jitter = u64::from(uuid::Uuid::new_v4().as_bytes()[0]) * 4;
        attempt = attempt.saturating_add(1);
        diagnostics::retry(attempt, delay * 1000 + jitter);
        tokio::select! {_=tokio::time::sleep(Duration::from_millis(delay*1000+jitter))=>{}, _=runtime.changed.notified()=>{}}
        delay = (delay * 2).min(30);
    }
}
