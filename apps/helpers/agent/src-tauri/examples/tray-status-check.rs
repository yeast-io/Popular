//! Isolated native menu checks: no user settings, credentials, windows or service connections.
#[cfg(target_os = "macos")]
#[allow(dead_code)]
#[path = "../src/tray_presentation.rs"]
mod tray_presentation;

#[cfg(target_os = "macos")]
fn main() {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSMenu};
    use tauri::menu::{
        CheckMenuItem, ContextMenu, IconMenuItem, Menu, MenuItem, PredefinedMenuItem,
    };

    fn native<M: ContextMenu>(menu: &M) -> &NSMenu {
        // SAFETY: called on the main thread; the reference cannot outlive its owning menu.
        unsafe { &*menu.inner_context().ns_menu().cast::<NSMenu>() }
    }
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    context.config_mut().identifier = "com.popular.helper-agent.tray-status-check".into();
    tauri::Builder::default().setup(|app| {
        let header = IconMenuItem::with_id(app, "brand", "Agent", true, None, None::<&str>)?;
        let section = MenuItem::with_id(app, "connections", "Connections", false, None::<&str>)?;
        let gateway = IconMenuItem::with_id(app, "service", "Gateway · Connected", true, None, None::<&str>)?;
        let downloader = IconMenuItem::with_id(app, "downloader", "Transmission · Disconnected", true, None, None::<&str>)?;
        let settings = MenuItem::with_id(app, "settings", "Open settings", true, None::<&str>)?;
        let startup = CheckMenuItem::with_id(app, "autostart", "Start at login", true, true, None::<&str>)?;
        let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
        let separators = [PredefinedMenuItem::separator(app)?, PredefinedMenuItem::separator(app)?, PredefinedMenuItem::separator(app)?];
        let menu = Menu::with_items(app, &[&header, &separators[0], &section, &gateway, &downloader, &separators[1], &settings, &startup, &separators[2], &quit])?;
        let original_ids = menu.items()?.iter().map(|item| item.id().clone()).collect::<Vec<_>>();
        assert_eq!(original_ids.len(), 10);
        let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
        let tray = tauri::tray::TrayIconBuilder::with_id("tray-status-check").icon(icon).menu(&menu).build(app)?;
        tray_presentation::application_icon(false)?;
        let app_icon = NSApplication::sharedApplication(MainThreadMarker::new().unwrap()).applicationIconImage().unwrap();
        assert_eq!(app_icon.size().width, 512.0);
        assert!(!app_icon.isTemplate());
        let mut previous: Option<([bool; 2], Vec<Vec<u8>>)> = None;
        let mut light_brand = None;
        let mark = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
        let offline = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-offline.png"))?;
        let opaque = |image: &tauri::image::Image<'_>| image.rgba().chunks_exact(4).filter(|pixel| pixel[3] > 128).count();
        assert!(opaque(&mark) > 50);
        assert!(opaque(&offline) > opaque(&mark));
        // Downsampling can leave a faint antialiasing fringe in the transparent visor.
        assert!(mark.rgba()[(20 * 32 + 16) * 4 + 3] < 16);
        for (names, states, dark) in [
            (["Gateway · Connected", "Transmission · Disconnected"], [true, false], false),
            (["Gateway · Disconnected", "qBittorrent · Connected"], [false, true], true),
            (["Gateway · Connected", "Transmission · Connected"], [true, true], false),
        ] {
            let tray_bytes: &[u8] = if states[0] { include_bytes!("../icons/tray.png") } else { include_bytes!("../icons/tray-offline.png") };
            tray.set_icon_with_as_template(Some(tauri::image::Image::from_bytes(tray_bytes)?), true)?;
            let template_preserved = tray.with_inner_tray_icon(|inner| {
                inner.ns_status_item()
                    .and_then(|item| item.button(MainThreadMarker::new().unwrap()))
                    .and_then(|button| button.image())
                    .is_some_and(|image| image.isTemplate())
            })?;
            assert!(template_preserved, "tray replacement must preserve native light/dark rendering");
            gateway.set_text(names[0])?;
            downloader.set_text(names[1])?;
            tray_presentation::apply(app.handle(), &menu, states, dark)?;
            let current_app_icon = NSApplication::sharedApplication(MainThreadMarker::new().unwrap()).applicationIconImage().unwrap();
            let brand = current_app_icon.TIFFRepresentation().unwrap().to_vec();
            if let Some(light) = &light_brand {
                if dark { assert_ne!(&brand, light); } else { assert_eq!(&brand, light); }
            } else { light_brand = Some(brand); }
            let menu_native = native(&menu);
            let header = menu_native.itemAtIndex(0).unwrap();
            assert_eq!(header.image().unwrap().size().width, 24.0);
            assert!(!header.image().unwrap().isTemplate());
            assert!(header.attributedTitle().is_some());
            let mut images = Vec::new();
            for (index, name) in names.into_iter().enumerate() {
                let item = menu_native.itemAtIndex(index as isize + 3).unwrap();
                assert_eq!(item.title().to_string(), name);
                assert!(item.attributedTitle().is_none());
                let image = item.image().unwrap();
                assert!(image.isTemplate());
                assert_eq!(image.size().width, 16.0);
                images.push(image.TIFFRepresentation().unwrap().to_vec());
            }
            if states[0] != states[1] { assert_ne!(images[0], images[1]); }
            if let Some((previous_states, previous_images)) = previous {
                for i in 0..2 { if states[i] != previous_states[i] { assert_ne!(images[i], previous_images[i]); } }
            }
            previous = Some((states, images));
            assert_eq!(menu.items()?.iter().map(|item| item.id().clone()).collect::<Vec<_>>(), original_ids);
        }
        println!("Native menu: brand logo, grouping, template state icons, live updates and development application icon and light/dark switching and tray template preservation passed.");
        app.handle().exit(0);
        Ok(())
    }).build(context).expect("isolated native menu check").run(|_, _| {});
}
#[cfg(not(target_os = "macos"))]
fn main() {}
