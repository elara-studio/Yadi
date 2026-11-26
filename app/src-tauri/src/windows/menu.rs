//! Tray icon and the mascot right-click menu. Both share one menu layout.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::image::Image;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use super::MASCOT_LABEL;

pub const ID_TOGGLE: &str = "toggle";
pub const ID_ABOUT: &str = "about";
pub const ID_QUIT: &str = "quit";

pub fn build_menu<R: Runtime, M: Manager<R>>(manager: &M) -> tauri::Result<Menu<R>> {
    let toggle = MenuItem::with_id(manager, ID_TOGGLE, "Show / Hide", true, None::<&str>)?;
    let about = MenuItem::with_id(manager, ID_ABOUT, "About", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(manager)?;
    let quit = MenuItem::with_id(manager, ID_QUIT, "Quit Yadi", true, None::<&str>)?;
    Menu::with_items(manager, &[&toggle, &about, &sep, &quit])
}

/// Menu clicks are forwarded to the Controller (which lives in the mascot webview),
/// except Quit which exits directly.
pub fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        ID_TOGGLE => {
            let _ = app.emit_to(MASCOT_LABEL, "tray:toggle", ());
        }
        ID_ABOUT => {
            let _ = app.emit_to(MASCOT_LABEL, "tray:about", ());
        }
        ID_QUIT => app.exit(0),
        _ => {}
    }
}

/// The orange Yadi hand, cropped to the drawing with no margin so it fills the bar.
/// macOS keeps the aspect ratio (fixed height), so the tall crop is used as is;
/// Windows squeezes tray icons into a square, so it gets the square, centred copy.
fn tray_image() -> Image<'static> {
    #[cfg(target_os = "windows")]
    {
        tauri::include_image!("icons/tray-square.png")
    }
    #[cfg(not(target_os = "windows"))]
    {
        tauri::include_image!("icons/tray.png")
    }
}

pub fn setup_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = build_menu(app)?;
    let mut builder = TrayIconBuilder::with_id("yadi-tray")
        .tooltip("Yadi")
        .menu(&menu)
        .show_menu_on_left_click(true);
    builder = builder.icon(tray_image()).icon_as_template(false);
    builder.build(app)?;
    Ok(())
}
