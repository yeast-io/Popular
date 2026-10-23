//! AppKit presentation for the native brand and connection menu, including unbundled development.
use objc2::{rc::Retained, AllocAnyThread, MainThreadMarker};
use objc2_app_kit::{
    NSApplication, NSAttributedStringNSStringDrawing, NSBezierPath, NSColor,
    NSCompositingOperation, NSFont, NSFontAttributeName, NSForegroundColorAttributeName, NSImage,
    NSMenu,
};
use objc2_foundation::{
    NSData, NSMutableAttributedString, NSPoint, NSRange, NSRect, NSSize, NSString,
};
use tauri::menu::{ContextMenu, Menu};

/// A template mask keeps the icon, badge and knockout digits legible in all menu bar appearances.
#[allow(deprecated)] // AppKit focus supplies the screen's backing scale for native Retina rendering.
pub(crate) fn queue_tray_image(online: bool, count: u64) -> tauri::Result<Retained<NSImage>> {
    if MainThreadMarker::new().is_none() {
        return Err(tauri::Error::FailedToReceiveMessage);
    }
    let base = image(
        if online {
            include_bytes!("../icons/tray.png")
        } else {
            include_bytes!("../icons/tray-offline.png")
        },
        18.0,
        false,
    )?;
    if count == 0 {
        base.setTemplate(true);
        return Ok(base);
    }
    let label = NSString::from_str(&if count > 99 {
        "99+".into()
    } else {
        count.to_string()
    });
    let title =
        NSMutableAttributedString::initWithString(NSMutableAttributedString::alloc(), &label);
    let font = NSFont::systemFontOfSize(if count < 10 { 10.0 } else { 9.0 });
    // SAFETY: each attribute uses its documented AppKit value type and the full UTF-16 range.
    unsafe {
        title.addAttribute_value_range(NSFontAttributeName, &font, NSRange::new(0, label.length()));
        title.addAttribute_value_range(
            NSForegroundColorAttributeName,
            &NSColor::blackColor(),
            NSRange::new(0, label.length()),
        );
    }
    let text_size = title.size();
    let badge_width = (text_size.width + 4.0).ceil().max(12.0);
    let size = NSSize::new(10.0 + badge_width, 18.0);
    let full_rect = NSRect::new(NSPoint::new(0.0, 0.0), size);
    // The halo separates the badge from the robot; both it and the digits are transparent holes.
    let halo = NSImage::initWithSize(NSImage::alloc(), size);
    halo.lockFocus();
    NSColor::blackColor().set();
    NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(
        NSRect::new(
            NSPoint::new(9.0, -1.0),
            NSSize::new(badge_width + 2.0, 14.0),
        ),
        7.0,
        7.0,
    )
    .fill();
    halo.unlockFocus();
    let digits = NSImage::initWithSize(NSImage::alloc(), size);
    digits.lockFocus();
    title.drawAtPoint(NSPoint::new(
        10.0 + (badge_width - text_size.width) / 2.0,
        (12.0 - text_size.height) / 2.0,
    ));
    digits.unlockFocus();
    let result = NSImage::initWithSize(NSImage::alloc(), size);
    result.lockFocus();
    base.drawInRect(NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(18.0, 18.0)));
    halo.drawInRect_fromRect_operation_fraction(
        full_rect,
        full_rect,
        NSCompositingOperation::DestinationOut,
        1.0,
    );
    NSColor::blackColor().set();
    NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(
        NSRect::new(NSPoint::new(10.0, 0.0), NSSize::new(badge_width, 12.0)),
        6.0,
        6.0,
    )
    .fill();
    digits.drawInRect_fromRect_operation_fraction(
        full_rect,
        full_rect,
        NSCompositingOperation::DestinationOut,
        1.0,
    );
    result.unlockFocus();
    result.setTemplate(true);
    Ok(result)
}

pub fn apply_queue_badge(
    tray: &tauri::tray::TrayIcon,
    online: bool,
    count: u64,
) -> tauri::Result<()> {
    tray.with_inner_tray_icon(move |inner| {
        let main_thread = MainThreadMarker::new().ok_or(tauri::Error::FailedToReceiveMessage)?;
        let button = inner
            .ns_status_item()
            .and_then(|item| item.button(main_thread))
            .ok_or(tauri::Error::FailedToReceiveMessage)?;
        let image = queue_tray_image(online, count)?;
        button.setTitle(&NSString::from_str(""));
        button.setImage(Some(&image));
        Ok(())
    })?
}

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
