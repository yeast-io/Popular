use crate::{diagnostics::Trace, AgentState};
use popular_agent_core::resource_sites::{
    ConfigureRequest, EnabledRequest, SiteRequest, SiteSnapshot,
};
#[tauri::command]
pub async fn resource_sites_list(
    state: tauri::State<'_, AgentState>,
) -> Result<Vec<SiteSnapshot>, String> {
    let trace = Trace::new();
    trace.stage("resource-sites.list.started");
    trace.finish(
        "resource-sites.list",
        state.resource_sites.list(&trace).await,
    )
}
#[tauri::command]
pub async fn resource_site_configure(
    state: tauri::State<'_, AgentState>,
    request: ConfigureRequest,
) -> Result<SiteSnapshot, String> {
    let trace = Trace::new();
    trace.stage("resource-sites.configure.requested");
    trace.finish(
        "resource-sites.configure",
        state.resource_sites.configure(request, &trace).await,
    )
}
#[tauri::command]
pub async fn resource_site_verify(
    state: tauri::State<'_, AgentState>,
    request: SiteRequest,
) -> Result<SiteSnapshot, String> {
    let trace = Trace::new();
    trace.stage("resource-sites.verify.requested");
    trace.finish(
        "resource-sites.verify",
        state.resource_sites.verify(request.site, &trace).await,
    )
}
#[tauri::command]
pub async fn resource_site_enabled(
    state: tauri::State<'_, AgentState>,
    request: EnabledRequest,
) -> Result<SiteSnapshot, String> {
    let trace = Trace::new();
    trace.stage("resource-sites.enabled.requested");
    trace.finish(
        "resource-sites.enabled",
        state.resource_sites.set_enabled(request, &trace).await,
    )
}
#[tauri::command]
pub async fn resource_site_remove(
    state: tauri::State<'_, AgentState>,
    request: SiteRequest,
) -> Result<(), String> {
    let trace = Trace::new();
    trace.stage("resource-sites.delete.requested");
    trace.finish(
        "resource-sites.delete",
        state.resource_sites.remove(request.site, &trace).await,
    )
}

#[tauri::command]
pub async fn resource_site_default(
    state: tauri::State<'_, AgentState>,
    request: SiteRequest,
) -> Result<Vec<SiteSnapshot>, String> {
    let trace = Trace::new();
    trace.stage("resource-sites.default.requested");
    trace.finish(
        "resource-sites.default",
        state.resource_sites.set_default(request.site, &trace).await,
    )
}
