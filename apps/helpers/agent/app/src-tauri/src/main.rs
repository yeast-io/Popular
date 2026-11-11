#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod credentials;
mod desktop;
#[cfg(test)]
mod locale_tests;
mod queue;
mod resource_sites;
mod runtime;
#[cfg(target_os = "macos")]
mod tray_presentation;
use credentials::NativeCredentials;
use diagnostics::Trace;
use popular_agent_core::{diagnostics, errors, settings, storage};
use settings::*;
use tauri::Manager;

type AgentState = std::sync::Arc<popular_agent_core::application::Agent<NativeCredentials>>;

#[tauri::command]
async fn load_settings(state: tauri::State<'_, AgentState>) -> Result<Snapshot, String> {
    let trace = Trace::new();
    trace.stage("settings.load.started");
    trace.finish("settings.load", state.load_settings().await)
}
#[tauri::command]
async fn save_locale(state: tauri::State<'_, AgentState>, locale: String) -> Result<(), String> {
    let trace = Trace::new();
    trace.stage("preferences.locale.started");
    trace.finish("preferences.locale", state.save_locale(locale).await)
}
#[tauri::command]
async fn test_downloader(
    state: tauri::State<'_, AgentState>,
    request: TestRequest,
) -> Result<Snapshot, String> {
    let trace = Trace::new();
    trace.stage("downloader.test.started");
    trace.finish(
        "downloader.test-and-save",
        state.test_downloader(request, &trace).await,
    )
}
#[tauri::command]
async fn disconnect_gateway(state: tauri::State<'_, AgentState>) -> Result<(), String> {
    let trace = Trace::new();
    trace.stage("gateway.disconnect.started");
    trace.finish("gateway.disconnect", state.disconnect_gateway().await)
}
#[tauri::command]
async fn reset_downloader(state: tauri::State<'_, AgentState>) -> Result<Snapshot, String> {
    let trace = Trace::new();
    trace.stage("downloader.reset.requested");
    trace.finish("downloader.reset", state.reset_downloader(&trace).await)
}

fn main() {
    if let Err(error) = diagnostics::initialize() {
        eprintln!("{error}");
        std::process::exit(1);
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if !args.iter().any(|arg| arg == "--autostart") {
                desktop::open(app);
            }
        }))
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .args(["--autostart"])
                .build(),
        )
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                desktop::hide(window);
            }
        })
        .invoke_handler(tauri::generate_handler![
            desktop::runtime_status,
            queue::queue_status,
            queue::queue_page,
            queue::select_page,
            desktop::open_documentation,
            desktop::connect_device,
            desktop::set_autostart,
            load_settings,
            save_locale,
            test_downloader,
            disconnect_gateway,
            reset_downloader,
            resource_sites::resource_sites_list,
            resource_sites::resource_site_configure,
            resource_sites::resource_site_verify,
            resource_sites::resource_site_enabled,
            resource_sites::resource_site_remove
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            diagnostics::directory(app.path().app_log_dir()?)?;
            let agent = std::sync::Arc::new(popular_agent_core::application::Agent::new(
                app.path().app_config_dir()?,
                NativeCredentials,
            ));
            app.manage(runtime::Runtime::new(agent.runtime.clone()));
            app.manage(agent.clone());
            desktop::setup(app.handle())?;
            if !cfg!(debug_assertions) {
                let result = storage::load(&app.state::<AgentState>().directory)
                    .and_then(|stored| desktop::autostart(app.handle(), stored.settings.autostart));
                if let Err(e) = result {
                    diagnostics::failure("autostart.initialize", "desktop", &e, 0);
                }
            }
            tauri::async_runtime::spawn(async move {
                if let Err(error) = agent.run().await {
                    diagnostics::failure("runtime.run", "desktop", &error, 0);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("desktop runtime initialization failed")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::RunEvent::Reopen { .. }) {
                desktop::open(app);
            }

            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<AgentState>().shutdown();
            }

            if let tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } = event
            {
                api.prevent_exit();
            }
        });
}
