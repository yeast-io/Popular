//! Render the production badge without credentials, service connections or a running Agent.
#[cfg(target_os = "macos")]
#[allow(dead_code)]
#[path = "../src/tray_presentation.rs"]
mod tray_presentation;

#[cfg(target_os = "macos")]
#[allow(deprecated)]
fn main() {
    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{
        NSApplication, NSColor, NSCompositingOperation, NSImage, NSRectFillUsingOperation,
    };
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    let directory =
        std::path::PathBuf::from(std::env::args().nth(1).expect("preview output directory"));
    std::fs::create_dir_all(&directory).unwrap();
    NSApplication::sharedApplication(MainThreadMarker::new().unwrap());
    for online in [false, true] {
        for count in [0, 1, 2, 12, 99, 100, u64::MAX] {
            let image = tray_presentation::queue_tray_image(online, count).unwrap();
            assert!(image.isTemplate());
            assert_eq!(image.size().height, 18.0);
            assert!(image.size().width <= 32.0);
            if count == 0 {
                assert_eq!(image.size().width, 18.0);
            }
            std::fs::write(
                directory.join(format!("badge-{online}-{count}.tiff")),
                image.TIFFRepresentation().unwrap().to_vec(),
            )
            .unwrap();
        }
    }
    assert_eq!(
        tray_presentation::queue_tray_image(true, 100)
            .unwrap()
            .TIFFRepresentation()
            .unwrap()
            .to_vec(),
        tray_presentation::queue_tray_image(true, u64::MAX)
            .unwrap()
            .TIFFRepresentation()
            .unwrap()
            .to_vec(),
    );
    // Enlarged light/dark sheet for visual inspection; the actual status image stays 18 points tall.
    let sheet = NSImage::initWithSize(NSImage::alloc(), NSSize::new(600.0, 160.0));
    sheet.lockFocus();
    NSColor::whiteColor().set();
    NSRectFillUsingOperation(
        NSRect::new(NSPoint::new(0.0, 80.0), NSSize::new(600.0, 80.0)),
        NSCompositingOperation::SourceOver,
    );
    NSColor::blackColor().set();
    NSRectFillUsingOperation(
        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(600.0, 80.0)),
        NSCompositingOperation::SourceOver,
    );
    for (index, count) in [0, 1, 2, 12, 99, 100].into_iter().enumerate() {
        let image = tray_presentation::queue_tray_image(true, count).unwrap();
        let size = image.size();
        image.setTemplate(false);
        image.drawInRect(NSRect::new(
            NSPoint::new(index as f64 * 100.0 + 8.0, 92.0),
            NSSize::new(size.width * 3.0, 54.0),
        ));
        image.lockFocus();
        NSColor::whiteColor().set();
        NSRectFillUsingOperation(
            NSRect::new(NSPoint::new(0.0, 0.0), size),
            NSCompositingOperation::SourceIn,
        );
        image.unlockFocus();
        image.drawInRect(NSRect::new(
            NSPoint::new(index as f64 * 100.0 + 8.0, 12.0),
            NSSize::new(size.width * 3.0, 54.0),
        ));
    }
    sheet.unlockFocus();
    std::fs::write(
        directory.join("preview.tiff"),
        sheet.TIFFRepresentation().unwrap().to_vec(),
    )
    .unwrap();
    println!("Native badge previews: zero hidden, 1/2/12/99/99+, online/offline and template rendering passed.");
}

#[cfg(not(target_os = "macos"))]
fn main() {}
