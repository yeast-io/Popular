//! AppKit presentation for the native brand and connection menu, including unbundled development.
use objc2::{rc::Retained, AllocAnyThread, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSFont, NSFontAttributeName, NSImage, NSMenu};
use objc2_foundation::{NSData, NSMutableAttributedString, NSRange, NSSize};
use tauri::menu::{ContextMenu, Menu};

fn image(bytes: &[u8], size: f64, template: bool) -> tauri::Result<Retained<NSImage>> {
    let image =
        NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(bytes)).ok_or_else(|| {
            tauri::Error::InvalidIcon(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "invalid embedded brand image",
            ))
        })?;
    image.setSize(NSSize::new(size, size));
    image.setTemplate(template);
    Ok(image)
}

fn brand_bytes(dark: bool) -> &'static [u8] {
    if dark {
        include_bytes!("../icons/icon-dark.png")
    } else {
        include_bytes!("../icons/icon.png")
    }
}

pub fn application_icon(dark: bool) -> tauri::Result<()> {
    let main_thread = MainThreadMarker::new().ok_or(tauri::Error::FailedToReceiveMessage)?;
    let image = image(brand_bytes(dark), 512.0, false)?;
    // SAFETY: a non-null, valid image is passed to AppKit on the main thread. AppKit retains it.
    unsafe {
        NSApplication::sharedApplication(main_thread).setApplicationIconImage(Some(&image));
    }
    Ok(())
}

pub(crate) fn decorate_native_menu(
    menu: &NSMenu,
    online: [bool; 2],
    dark: bool,
) -> tauri::Result<()> {
    if MainThreadMarker::new().is_none() {
        return Err(tauri::Error::FailedToReceiveMessage);
    }
    let header = menu
        .itemAtIndex(0)
        .ok_or(tauri::Error::FailedToReceiveMessage)?;
    let brand_image = image(brand_bytes(dark), 24.0, false)?;
    header.setImage(Some(&brand_image));
    let title = NSMutableAttributedString::initWithString(
        NSMutableAttributedString::alloc(),
        &header.title(),
    );
    let font = NSFont::boldSystemFontOfSize(14.0);
    // SAFETY: NSFont is the documented value type for this attribute; the range is the full UTF-16 title.
    unsafe {
        title.addAttribute_value_range(
            NSFontAttributeName,
            &font,
            NSRange::new(0, header.title().length()),
        );
    }
    header.setAttributedTitle(Some(&title));
    for (index, connected) in online.into_iter().enumerate() {
        let item = menu
            .itemAtIndex(index as isize + 3)
            .ok_or(tauri::Error::FailedToReceiveMessage)?;
        let bytes: &[u8] = if connected {
            include_bytes!("../icons/connection-online.png")
        } else {
            include_bytes!("../icons/connection-offline.png")
        };
        // Native template images remain legible in both light and dark macOS menus.
        let state_image = image(bytes, 16.0, true)?;
        item.setImage(Some(&state_image));
        item.setAttributedTitle(None);
    }
    Ok(())
}

fn decorate<M: ContextMenu>(menu: &M, online: [bool; 2], dark: bool) -> tauri::Result<()> {
    if MainThreadMarker::new().is_none() {
        return Err(tauri::Error::FailedToReceiveMessage);
    }
    let pointer = menu.inner_context().ns_menu().cast::<NSMenu>();
    // SAFETY: the borrowed Tauri menu owns this native pointer; all accesses stay on the main thread.
    let menu = unsafe { pointer.as_ref() }.ok_or(tauri::Error::FailedToReceiveMessage)?;
    application_icon(dark)?;
    decorate_native_menu(menu, online, dark)
}

pub fn apply(
    app: &tauri::AppHandle,
    menu: &Menu<tauri::Wry>,
    online: [bool; 2],
    dark: bool,
) -> tauri::Result<()> {
    let menu = menu.clone();
    let (sender, receiver) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = sender.send(decorate(&menu, online, dark));
    })?;
    receiver
        .recv()
        .map_err(|_| tauri::Error::FailedToReceiveMessage)?
}
