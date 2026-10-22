#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod connection;
mod credentials;
mod desktop;
mod device;
mod diagnostics;
mod downloader;
mod downloader_health;
mod downloads;
mod errors;
mod execution;
mod gateway;
mod journal;
mod preferences;
mod protocol;
mod runtime;
mod settings;
mod storage;
#[cfg(target_os = "macos")]
mod tray_presentation;
use credentials::NativeCredentials;
use diagnostics::Trace;
use errors::AgentError;
use settings::*;
use std::path::PathBuf;
use tauri::Manager;

struct AgentState {
    directory: PathBuf,
    lock: std::sync::Arc<tokio::sync::Mutex<()>>,
}

#[tauri::command]
async fn load_settings(state: tauri::State<'_, AgentState>) -> Result<Snapshot, String> {
    let trace = Trace::new();
    trace.stage("settings.load.started");
    let _guard = state.lock.lock().await;
    let directory = state.directory.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let stored = storage::load(&directory)?;
        let secrets = storage::secrets(&stored, &NativeCredentials)?;
        Ok(storage::snapshot(stored, &secrets))
    })
    .await
    .unwrap_or_else(|e| Err(AgentError::caused("runtimeError", e)));
    trace.finish("settings.load", result)
}

#[tauri::command]
async fn save_locale(state: tauri::State<'_, AgentState>, locale: String) -> Result<(), String> {
    let trace = Trace::new();
    trace.stage("preferences.locale.started");
    let _guard = state.lock.lock().await;
    trace.finish(
        "preferences.locale",
        preferences::locale(&state.directory, locale),
    )
}

#[tauri::command]
async fn test_downloader(
    app: tauri::AppHandle,
    state: tauri::State<'_, AgentState>,
    request: TestRequest,
) -> Result<Snapshot, String> {
    let trace = Trace::new();
    trace.stage("downloader.test.started");
    let _guard = state.lock.lock().await;
    let directory = state.directory.clone();
    let result = downloader::test_and_save(&directory, request, &NativeCredentials, &trace).await;
    if result.is_ok() {
        let runtime = app.state::<runtime::Runtime>();
        runtime.update(None, Some("online"), None);
        runtime.changed.notify_one();
        runtime.downloader_changed.notify_one();
    }
    trace.finish("downloader.test-and-save", result)
}
#[tauri::command]
async fn disconnect_gateway(
    app: tauri::AppHandle,
    state: tauri::State<'_, AgentState>,
) -> Result<(), String> {
    let trace = Trace::new();
    trace.stage("gateway.disconnect.started");
    let runtime = app.state::<runtime::Runtime>();
    runtime
        .suspended
        .store(true, std::sync::atomic::Ordering::SeqCst);
    runtime.changed.notify_one();
    let _guard = state.lock.lock().await;
    let result = preferences::disconnect_gateway(&state.directory);
    if result.is_ok() {
        let runtime = app.state::<runtime::Runtime>();
        runtime.update(Some("manuallyDisconnected"), None, None);
        runtime.changed.notify_one();
    }
    if result.is_err() {
        runtime
            .suspended
            .store(false, std::sync::atomic::Ordering::SeqCst);
        runtime.changed.notify_one();
    }
    trace.finish("gateway.disconnect", result)
}

#[tauri::command]
async fn reset_downloader(
    app: tauri::AppHandle,
    state: tauri::State<'_, AgentState>,
) -> Result<Snapshot, String> {
    let trace = Trace::new();
    trace.stage("downloader.reset.requested");
    let _guard = state.lock.lock().await;
    let directory = state.directory.clone();
    let worker = trace.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        downloader::reset(&directory, &NativeCredentials, &worker)
    })
    .await
    .unwrap_or_else(|e| Err(AgentError::caused("runtimeError", e)));
    if result.is_ok() {
        let runtime = app.state::<runtime::Runtime>();
        runtime.update(None, Some("unconfigured"), None);
        runtime.changed.notify_one();
        runtime.downloader_changed.notify_one();
    }
    trace.finish("downloader.reset", result)
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
                .macos_launcher(tauri_plugin_autostart::MacosLauncher::LaunchAgent)
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
            desktop::open_documentation,
            desktop::connect_device,
            load_settings,
            save_locale,
            test_downloader,
            disconnect_gateway,
            reset_downloader
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            diagnostics::directory(app.path().app_log_dir()?)?;
            app.manage(runtime::Runtime::default());
            app.manage(AgentState {
                directory: app.path().app_config_dir()?,
                lock: Default::default(),
            });
            desktop::setup(app.handle())?;
            if !cfg!(debug_assertions) {
                let result = storage::load(&app.state::<AgentState>().directory)
                    .and_then(|stored| desktop::autostart(app.handle(), stored.settings.autostart));
                if let Err(e) = result {
                    diagnostics::failure("autostart.initialize", "desktop", &e, 0);
                }
            }
            tauri::async_runtime::spawn(runtime::run(app.handle().clone()));
            tauri::async_runtime::spawn(downloader_health::run(app.handle().clone()));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("desktop runtime initialization failed")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::RunEvent::Reopen { .. }) {
                desktop::open(app);
            }

            if let tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } = event
            {
                api.prevent_exit();
            }
        });
}
