use crate::{diagnostics::Trace, runtime::Runtime, storage, AgentState};
use tauri::{
    menu::{CheckMenuItem, IconMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager,
};
use tauri_plugin_autostart::ManagerExt;
pub fn text(locale: &str, key: &str) -> String {
    let messages: serde_json::Value =
        serde_json::from_str(include_str!("../../src/locales/messages.json"))
            .expect("bundled translations");
    messages[locale][key].as_str().unwrap_or(key).into()
}
fn dark_theme(app: &tauri::AppHandle) -> bool {
    app.get_webview_window("settings")
        .and_then(|window| window.theme().ok())
        .is_some_and(|theme| theme == tauri::Theme::Dark)
}
fn brand_icon(dark: bool) -> tauri::Result<tauri::image::Image<'static>> {
    tauri::image::Image::from_bytes(if dark {
        include_bytes!("../icons/icon-dark.png")
    } else {
        include_bytes!("../icons/icon.png")
    })
}
pub fn open(app: &tauri::AppHandle) {
    let trace = Trace::new();
    trace.stage("window.open.started");
    let action = || -> tauri::Result<()> {
        #[cfg(target_os = "macos")]
        {
            app.set_activation_policy(tauri::ActivationPolicy::Regular)?;
            app.show()?;
            crate::tray_presentation::application_icon(dark_theme(app))?;
        }
        if let Some(w) = app.get_webview_window("settings") {
            w.unminimize()?;
            w.show()?;
            w.set_focus()?;
        }
        Ok(())
    };
    let _ = trace.finish(
        "window.open",
        action().map_err(|e| crate::errors::AgentError::caused("runtimeError", e)),
    );
}
pub fn hide(window: &tauri::Window) {
    let trace = Trace::new();
    trace.stage("window.hide.started");
    let action = || -> tauri::Result<()> {
        window.hide()?;
        #[cfg(target_os = "macos")]
        window
            .app_handle()
            .set_activation_policy(tauri::ActivationPolicy::Accessory)?;
        Ok(())
    };
    let _ = trace.finish(
        "window.hide",
        action().map_err(|e| crate::errors::AgentError::caused("runtimeError", e)),
    );
}
fn status_text(locale: &str, key: &str) -> String {
    let short_key = format!("{key}Status");
    let short = text(locale, &short_key);
    if short == short_key {
        text(locale, key)
    } else {
        short
    }
}
fn status_icon(online: bool) -> tauri::Result<tauri::image::Image<'static>> {
    tauri::image::Image::from_bytes(if online {
        include_bytes!("../icons/connection-online.png")
    } else {
        include_bytes!("../icons/connection-offline.png")
    })
}
fn tray_icon(online: bool) -> tauri::Result<tauri::image::Image<'static>> {
    #[cfg(target_os = "macos")]
    let bytes: &[u8] = if online {
        include_bytes!("../icons/tray.png")
    } else {
        include_bytes!("../icons/tray-offline.png")
    };
    #[cfg(not(target_os = "macos"))]
    let bytes: &[u8] = {
        let _ = online;
        include_bytes!("../icons/icon.png")
    };
    tauri::image::Image::from_bytes(bytes)
}
// Refresh existing items in place so an open native menu is never replaced.
struct TrayMenu {
    items: [MenuItem<tauri::Wry>; 2],
    header: IconMenuItem<tauri::Wry>,
    statuses: [IconMenuItem<tauri::Wry>; 2],
    section: MenuItem<tauri::Wry>,
    queue: MenuItem<tauri::Wry>,
    queue_label: String,
    queue_count: Option<u64>,
    #[cfg(target_os = "macos")]
    menu: Menu<tauri::Wry>,
    online: Option<[bool; 2]>,
    dark: Option<bool>,
    startup: CheckMenuItem<tauri::Wry>,
    applied: [String; 7],
}
impl TrayMenu {
    fn labels(app: &tauri::AppHandle) -> [String; 7] {
        let state = app.state::<AgentState>();
        let settings = storage::load(&state.directory)
            .map(|stored| stored.settings)
            .unwrap_or_default();
        let locale = settings.locale;
        let status = app.state::<Runtime>().snapshot();
        let downloader_name = text(
            &locale,
            match settings.provider {
                crate::settings::Provider::Qbittorrent => "qbittorrentName",
                crate::settings::Provider::Transmission => "transmissionName",
            },
        );
        let label = |name: &str, status: &str| {
            text(&locale, "trayStatusLabel")
                .replace("{name}", name)
                .replace("{status}", &status_text(&locale, status))
        };
        [
            label(&text(&locale, "gateway"), &status.service),
            label(&downloader_name, &status.downloader),
            text(&locale, "openSettings"),
            text(&locale, "quit"),
            text(&locale, "title"),
            text(&locale, "autostart"),
            text(&locale, "connections"),
        ]
    }
    fn new(app: &tauri::AppHandle) -> tauri::Result<(Self, Menu<tauri::Wry>)> {
        let applied = Self::labels(app);
        let header = IconMenuItem::with_id(
            app,
            "brand",
            &applied[4],
            true,
            Some(brand_icon(dark_theme(app))?),
            None::<&str>,
        )?;
        let statuses = [
            IconMenuItem::with_id(
                app,
                "service",
                &applied[0],
                true,
                Some(status_icon(false)?),
                None::<&str>,
            )?,
            IconMenuItem::with_id(
                app,
                "downloader",
                &applied[1],
                true,
                Some(status_icon(false)?),
                None::<&str>,
            )?,
        ];
        let items = [
            MenuItem::with_id(app, "settings", &applied[2], true, None::<&str>)?,
            MenuItem::with_id(app, "quit", &applied[3], true, None::<&str>)?,
        ];
        let section = MenuItem::with_id(app, "connections", &applied[6], false, None::<&str>)?;
        let queue = MenuItem::with_id(
            app,
            "queue",
            text("en-US", "queueTitle"),
            true,
            None::<&str>,
        )?;
        let enabled = storage::load(&app.state::<AgentState>().directory)
            .map(|stored| stored.settings.autostart)
            .unwrap_or(true);
        let startup =
            CheckMenuItem::with_id(app, "autostart", &applied[5], true, enabled, None::<&str>)?;
        let brand_separator = PredefinedMenuItem::separator(app)?;
        let settings_separator = PredefinedMenuItem::separator(app)?;
        let quit_separator = PredefinedMenuItem::separator(app)?;
        let menu = Menu::with_items(
            app,
            &[
                &header,
                &brand_separator,
                &section,
                &statuses[0],
                &statuses[1],
                &settings_separator,
                &queue,
                &items[0],
                &startup,
                &quit_separator,
                &items[1],
            ],
        )?;
        Ok((
            Self {
                items,
                header,
                statuses,
                section,
                queue,
                queue_label: String::new(),
                queue_count: None,
                #[cfg(target_os = "macos")]
                menu: menu.clone(),
                online: None,
                dark: None,
                startup,
                applied,
            },
            menu,
        ))
    }
    fn refresh(&mut self, app: &tauri::AppHandle) -> tauri::Result<()> {
        let labels = Self::labels(app);
        let state = app.state::<AgentState>();
        let locale = storage::load(&state.directory)
            .map(|s| s.settings.locale)
            .unwrap_or_else(|_| "en-US".into());
        let view = crate::queue::view(&state.directory, &app.state::<Runtime>());
        let count = view.snapshot.as_ref().map(|snapshot| snapshot.total);
        let count_label = count.map(|v| v.to_string()).unwrap_or_else(|| "—".into());
        let mut queue_label = text(&locale, "queueMenu").replace("{count}", &count_label);
        if view.stale {
            queue_label.push_str(&format!(" · {}", text(&locale, "queueCached")));
        }
        if self.queue_label != queue_label {
            self.queue.set_text(&queue_label)?;
            self.queue_label = queue_label;
        }
        for (index, item) in [2, 3].into_iter().zip(self.items.iter()) {
            if self.applied[index] != labels[index] {
                item.set_text(&labels[index])?;
            }
        }
        for (index, item) in self.statuses.iter().enumerate() {
            if self.applied[index] != labels[index] {
                item.set_text(&labels[index])?;
            }
        }
        let header_changed = self.applied[4] != labels[4];
        if header_changed {
            self.header.set_text(&labels[4])?;
        }
        if self.applied[5] != labels[5] {
            self.startup.set_text(&labels[5])?;
        }
        if self.applied[6] != labels[6] {
            self.section.set_text(&labels[6])?;
        }
        let status = app.state::<Runtime>().snapshot();
        let online = [status.service == "online", status.downloader == "online"];
        let dark = dark_theme(app);
        let theme_changed = self.dark != Some(dark);
        if theme_changed {
            self.header.set_icon(Some(brand_icon(dark)?))?;
            if let Some(window) = app.get_webview_window("settings") {
                window.set_icon(brand_icon(dark)?)?;
            }
        }
        if self.online != Some(online) || header_changed || theme_changed {
            for (index, item) in self.statuses.iter().enumerate() {
                item.set_icon(Some(status_icon(online[index])?))?;
            }
            #[cfg(target_os = "macos")]
            crate::tray_presentation::apply(app, &self.menu, online, dark)?;
        }
        if self.online.map(|previous| previous[0]) != Some(online[0])
            || header_changed
            || self.queue_count != count
        {
            if let Some(tray) = app.tray_by_id("main") {
                #[cfg(target_os = "macos")]
                crate::tray_presentation::apply_queue_badge(&tray, online[0], count.unwrap_or(0))?;
                #[cfg(not(target_os = "macos"))]
                // set_icon alone resets AppKit's template flag; update both atomically.
                tray.set_icon_with_as_template(
                    Some(tray_icon(online[0])?),
                    cfg!(target_os = "macos"),
                )?;
            }
        }
        self.queue_count = count;
        if let Some(tray) = app.tray_by_id("main") {
            if self.applied[0] != labels[0] || header_changed {
                tray.set_tooltip(Some(format!("{} — {}", labels[4], labels[0])))?;
            }
        }
        if let Ok(stored) = storage::load(&app.state::<AgentState>().directory) {
            if self.startup.is_checked()? != stored.settings.autostart {
                self.startup.set_checked(stored.settings.autostart)?;
            }
        }
        self.online = Some(online);
        self.dark = Some(dark);
        self.applied = labels;
        Ok(())
    }
}
#[tauri::command]
pub async fn open_documentation(provider: crate::settings::Provider) -> Result<(), String> {
    let trace = Trace::new();
    trace.stage("documentation.open.started");
    let result = tauri::async_runtime::spawn_blocking(move || {
        use crate::errors::AgentError;
        let resources: serde_json::Value =
            serde_json::from_str(include_str!("../../src/documentation.resources.json"))?;
        let key = match provider {
            crate::settings::Provider::Qbittorrent => "qbittorrent",
            crate::settings::Provider::Transmission => "transmission",
        };
        // Only bundled documentation URLs can be opened; the UI cannot supply a command or URL.
        let url = resources[key]
            .as_str()
            .ok_or_else(|| AgentError::code("documentationError"))?;
        #[cfg(target_os = "macos")]
        let mut launcher = std::process::Command::new("/usr/bin/open");
        #[cfg(target_os = "windows")]
        let mut launcher = {
            let mut command = std::process::Command::new("rundll32.exe");
            command.arg("url.dll,FileProtocolHandler");
            command
        };
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let mut launcher = std::process::Command::new("xdg-open");
        let status = launcher
            .arg(url)
            .status()
            .map_err(|error| AgentError::caused("documentationError", error))?;
        if !status.success() {
            return Err(AgentError::caused(
                "documentationError",
                std::io::Error::other(format!("documentation launcher exited with {status}")),
            ));
        }
        Ok(())
    })
    .await
    .unwrap_or_else(|error| Err(crate::errors::AgentError::caused("runtimeError", error)));
    trace.finish("documentation.open", result)
}

#[tauri::command]
pub fn runtime_status(app: tauri::AppHandle) -> crate::runtime::Status {
    app.state::<Runtime>().snapshot()
}
#[tauri::command]
pub async fn connect_device(
    app: tauri::AppHandle,
    request: crate::settings::GatewayRequest,
) -> Result<crate::settings::Snapshot, String> {
    let state = app.state::<AgentState>();
    let _guard = state.lock.lock().await;
    let directory = state.directory.clone();
    let trace = Trace::new();
    let worker = trace.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::gateway::request_binding(
            &directory,
            request,
            &crate::credentials::NativeCredentials,
            &worker,
        )
    })
    .await
    .unwrap_or_else(|e| Err(crate::errors::AgentError::caused("runtimeError", e)));
    let runtime = app.state::<Runtime>();
    if let Ok(snapshot) = &result {
        let identity: crate::journal::Identity =
            crate::journal::load(&state.directory, "identity.json")
                .map_err(|error| error.code.to_owned())?;
        let binding = crate::runtime::binding(&identity, &snapshot.settings);
        runtime.set_binding(
            if binding == crate::runtime::BindingState::Unbound {
                crate::runtime::BindingState::Binding
            } else {
                binding
            },
            identity.device_id,
        );
        runtime
            .suspended
            .store(false, std::sync::atomic::Ordering::SeqCst);
        runtime.update(Some("connecting"), None, None);
        runtime.changed.notify_one();
    }
    trace.finish("gateway.bind-request", result)
}
pub fn autostart(app: &tauri::AppHandle, enabled: bool) -> Result<(), crate::errors::AgentError> {
    let result = if enabled {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    };
    result.map_err(|e| crate::errors::AgentError::caused("autostartError", e))
}
pub fn setup(app: &tauri::AppHandle) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    crate::tray_presentation::application_icon(dark_theme(app))?;
    let icon = tray_icon(false)?;
    if let Some(window) = app.get_webview_window("settings") {
        window.set_icon(brand_icon(dark_theme(app))?)?;
    }
    let (mut items, menu) = TrayMenu::new(app)?;
    let startup = items.startup.clone();
    TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip(&items.applied[4])
        .icon(icon)
        .icon_as_template(cfg!(target_os = "macos"))
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "settings" | "brand" => {
                app.state::<Runtime>()
                    .status
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .page = "settings".into();
                let _ = app.emit("agent-page", "settings");
                open(app);
            }
            "queue" => {
                let runtime = app.state::<Runtime>();
                runtime
                    .status
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .page = "queue".into();
                runtime.queue_refresh.notify_one();
                let _ = app.emit("agent-page", "queue");
                open(app);
            }
            "quit" => app.exit(0),
            "autostart" => {
                let app = app.clone();
                let startup = startup.clone();
                let requested = startup.is_checked();
                tauri::async_runtime::spawn(async move {
                    let state = app.state::<AgentState>();
                    let _guard = state.lock.lock().await;
                    let trace = Trace::new();
                    trace.stage("preferences.autostart.started");
                    let action = || -> Result<(), crate::errors::AgentError> {
                        let old = storage::load(&state.directory)?.settings.autostart;
                        let enabled = requested
                            .map_err(|e| crate::errors::AgentError::caused("autostartError", e))?;
                        if let Err(error) = autostart(&app, enabled) {
                            let _ = startup.set_checked(old);
                            return Err(error);
                        }
                        if let Err(error) = crate::preferences::autostart(&state.directory, enabled)
                        {
                            if let Err(rollback) = autostart(&app, old) {
                                crate::diagnostics::failure(
                                    "preferences.autostart.rollback",
                                    &trace.id,
                                    &rollback,
                                    0,
                                );
                            }
                            let _ = startup.set_checked(old);
                            return Err(error);
                        }
                        Ok(())
                    };
                    let result = action();
                    app.state::<Runtime>()
                        .preference_error(result.as_ref().err().map(|e| e.code.to_string()));
                    let _ = trace.finish("preferences.autostart", result);
                });
            }
            _ => {}
        })
        .build(app)?;
    items.refresh(app)?;
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            if let Err(error) = items.refresh(&handle) {
                crate::diagnostics::failure(
                    "tray.refresh",
                    "desktop",
                    &crate::errors::AgentError::caused("runtimeError", error),
                    0,
                );
            }
        }
    });
    Ok(())
}
