use crate::{runtime::Runtime, AgentState};
pub use popular_agent_core::queue::view;
use tauri::Manager;

#[tauri::command]
pub fn queue_status(app: tauri::AppHandle) -> popular_agent_core::queue::View {
    popular_agent_core::queue::view(
        &app.state::<AgentState>().directory,
        &app.state::<Runtime>(),
    )
}

#[tauri::command]
pub fn queue_page(app: tauri::AppHandle, cursor: Option<String>) -> Result<(), String> {
    popular_agent_core::queue::page(&app.state::<Runtime>(), cursor).map_err(|e| e.code.into())
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
