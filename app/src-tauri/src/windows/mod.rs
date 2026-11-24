//! The two always-on-top windows: the mascot and the chat overlay.

pub mod geometry;
pub mod menu;

use geometry::{CHAT_GAP, Rect, chat_position, clamp_to_monitors, default_mascot_position};
use tauri::menu::ContextMenu;
use tauri::{
    AppHandle, Manager, Monitor, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_store::StoreExt;

pub const MASCOT_LABEL: &str = "mascot";
pub const CHAT_LABEL: &str = "chat";

// The plan says 96x96. The window is taller and wider so the status bubble can sit above
// the 96 px mascot image (user request, Task 03).
const MASCOT_SIZE: (f64, f64) = (128.0, 140.0);
const CHAT_SIZE: (f64, f64) = (420.0, 560.0);

const STORE_FILE: &str = "window-state.json";
const POSITION_KEY: &str = "mascot_position";
const FALLBACK_SCREEN: Rect = Rect::new(0, 0, 1920, 1080);

fn monitor_rect(m: &Monitor) -> Rect {
    let p = m.position();
    let s = m.size();
    Rect::new(p.x, p.y, s.width as i32, s.height as i32)
}

fn primary_rect(app: &AppHandle, monitors: &[Rect]) -> Rect {
    app.primary_monitor()
        .ok()
        .flatten()
        .map(|m| monitor_rect(&m))
        .or_else(|| monitors.first().copied())
        .unwrap_or(FALLBACK_SCREEN)
}

fn load_saved_position(app: &AppHandle) -> Option<(i32, i32)> {
    let store = app.store(STORE_FILE).ok()?;
    let v = store.get(POSITION_KEY)?;
    Some((v.get("x")?.as_i64()? as i32, v.get("y")?.as_i64()? as i32))
}

fn save_position(app: &AppHandle, pos: PhysicalPosition<i32>) {
    if let Ok(store) = app.store(STORE_FILE) {
        store.set(POSITION_KEY, serde_json::json!({ "x": pos.x, "y": pos.y }));
    }
}

pub fn create_windows(app: &AppHandle) -> tauri::Result<()> {
    let mascot = WebviewWindowBuilder::new(app, MASCOT_LABEL, WebviewUrl::App("index.html".into()))
        .title("Yadi")
        .inner_size(MASCOT_SIZE.0, MASCOT_SIZE.1)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .resizable(false)
        .skip_taskbar(true)
        .shadow(false)
        .visible(false)
        .build()?;

    let monitors: Vec<Rect> = app
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(monitor_rect)
        .collect();
    let primary = primary_rect(app, &monitors);
    let size = mascot.outer_size()?;
    let size = (size.width as i32, size.height as i32);
    let wanted = load_saved_position(app).unwrap_or_else(|| default_mascot_position(primary, size));
    let (x, y) = clamp_to_monitors(wanted, size, &monitors, primary);
    mascot.set_position(PhysicalPosition::new(x, y))?;
    mascot.show()?;

    let handle = app.clone();
    mascot.on_window_event(move |event| {
        if let WindowEvent::Moved(pos) = event {
            save_position(&handle, *pos);
        }
    });

    let chat = WebviewWindowBuilder::new(app, CHAT_LABEL, WebviewUrl::App("index.html".into()))
        .title("Yadi")
        .inner_size(CHAT_SIZE.0, CHAT_SIZE.1)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .resizable(false)
        .skip_taskbar(true)
        .shadow(false)
        .visible(false)
        .build()?;
    // The chat is only ever hidden, never destroyed.
    let chat_for_close = chat.clone();
    chat.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = chat_for_close.hide();
        }
    });

    log::info!("windows created; mascot at ({x}, {y})");
    Ok(())
}

fn window(app: &AppHandle, label: &str) -> Result<WebviewWindow, String> {
    app.get_webview_window(label)
        .ok_or_else(|| format!("window '{label}' does not exist"))
}

fn place_chat(app: &AppHandle, mascot: &WebviewWindow, chat: &WebviewWindow) -> Result<(), String> {
    let err = |e: tauri::Error| e.to_string();
    let pos = mascot.outer_position().map_err(err)?;
    let size = mascot.outer_size().map_err(err)?;
    let mascot_rect = Rect::new(pos.x, pos.y, size.width as i32, size.height as i32);
    let monitors: Vec<Rect> = app
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(monitor_rect)
        .collect();
    let monitor = mascot
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| monitor_rect(&m))
        .unwrap_or_else(|| primary_rect(app, &monitors));
    let chat_size = chat.outer_size().map_err(err)?;
    let (x, y) = chat_position(
        mascot_rect,
        (chat_size.width as i32, chat_size.height as i32),
        monitor,
        CHAT_GAP,
    );
    chat.set_position(PhysicalPosition::new(x, y)).map_err(err)
}

#[tauri::command]
pub fn show_chat(app: AppHandle) -> Result<(), String> {
    let mascot = window(&app, MASCOT_LABEL)?;
    let chat = window(&app, CHAT_LABEL)?;
    place_chat(&app, &mascot, &chat)?;
    chat.show().map_err(|e| e.to_string())?;
    chat.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn hide_chat(app: AppHandle) -> Result<(), String> {
    window(&app, CHAT_LABEL)?.hide().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn focus_chat(app: AppHandle) -> Result<(), String> {
    window(&app, CHAT_LABEL)?
        .set_focus()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub fn show_context_menu(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    let menu = menu::build_menu(&app).map_err(|e| e.to_string())?;
    menu.popup(window.as_ref().window().clone())
        .map_err(|e| e.to_string())
}
