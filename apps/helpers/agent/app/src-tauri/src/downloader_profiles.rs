use crate::{diagnostics::Trace, AgentState};
use popular_agent_core::{
    downloader_profiles::{ActionRequest, ConfigureRequest, Item},
    settings::Snapshot,
};
#[tauri::command]
pub async fn downloaders_list(state: tauri::State<'_, AgentState>) -> Result<Vec<Item>, String> {
    let trace = Trace::new();
    trace.stage("downloaders.list.requested");
    trace.finish("downloaders.list", state.list_downloaders(&trace).await)
}
#[tauri::command]
pub async fn downloader_configure(
    state: tauri::State<'_, AgentState>,
    request: ConfigureRequest,
) -> Result<Snapshot, String> {
    let trace = Trace::new();
    trace.stage("downloaders.configure.requested");
    trace.finish(
        "downloaders.configure",
        state.configure_downloader(request, &trace).await,
    )
}
#[tauri::command]
pub async fn downloader_action(
    state: tauri::State<'_, AgentState>,
    request: ActionRequest,
) -> Result<Snapshot, String> {
    let trace = Trace::new();
    trace.stage("downloaders.action.requested");
    trace.finish(
        "downloaders.action",
        state.downloader_action(request, &trace).await,
    )
}
