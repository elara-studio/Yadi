//! The two always-on-top windows: the mascot and the chat overlay.

pub mod geometry;
pub mod menu;

use std::sync::Mutex;
use std::time::{Duration, Instant};

use geometry::{
    CHAT_GAP, Rect, chat_position, clamp_to_monitors, default_mascot_position, follow_position,
    offset_between,
};
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

/// Where the chat sits relative to the mascot. The chat keeps this distance while the mascot is
/// dragged; dragging the chat itself changes it.
#[derive(Default)]
struct ChatFollow {
    offset: Mutex<(i32, i32)>,
    /// When Yadi itself last moved the chat. Moves reported shortly after are our own echo, not
    /// the person dragging, and must not change the offset.
    last_own_move: Mutex<Option<Instant>>,
}

/// Window-moved events arrive a moment after the move that caused them.
const OWN_MOVE_ECHO: Duration = Duration::from_millis(300);

impl ChatFollow {
    fn set_offset(&self, offset: (i32, i32)) {
        *self.offset.lock().unwrap_or_else(|e| e.into_inner()) = offset;
    }
    fn offset(&self) -> (i32, i32) {
        *self.offset.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn mark_own_move(&self) {
        *self.last_own_move.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
    }
    fn is_own_echo(&self) -> bool {
        self.last_own_move
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some_and(|t| t.elapsed() < OWN_MOVE_ECHO)
    }
}

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
    app.manage(ChatFollow::default());
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

    let monitors = monitor_rects(app);
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
            follow_mascot(&handle);
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
    let focus_handle = app.clone();
    let moved_handle = app.clone();
    chat.on_window_event(move |event| match event {
        // The person dragged the chat: remember where it is relative to the mascot.
        WindowEvent::Moved(_) => remember_chat_offset(&moved_handle),
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = chat_for_close.hide();
        }
        // Own-window rule for the global hook: no Y interception while the chat has focus.
        WindowEvent::Focused(focused) => {
            if let Some(hook) = focus_handle.try_state::<crate::hotkey::hook::HookState>() {
                hook.shared.set_chat_focused(*focused);
            }
        }
        _ => {}
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
    let monitors = monitor_rects(app);
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
    if let Some(follow) = app.try_state::<ChatFollow>() {
        follow.set_offset(offset_between((x, y), (pos.x, pos.y)));
        follow.mark_own_move();
    }
    chat.set_position(PhysicalPosition::new(x, y)).map_err(err)
}

fn monitor_rects(app: &AppHandle) -> Vec<Rect> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(monitor_rect)
        .collect()
}

/// The mascot moved: bring the chat along if it is open.
fn follow_mascot(app: &AppHandle) {
    let (Some(mascot), Some(chat), Some(follow)) = (
        app.get_webview_window(MASCOT_LABEL),
        app.get_webview_window(CHAT_LABEL),
        app.try_state::<ChatFollow>(),
    ) else {
        return;
    };
    if !chat.is_visible().unwrap_or(false) {
        return;
    }
    let (Ok(pos), Ok(size)) = (mascot.outer_position(), chat.outer_size()) else {
        return;
    };
    let monitors = monitor_rects(app);
    let primary = primary_rect(app, &monitors);
    let (x, y) = follow_position(
        (pos.x, pos.y),
        follow.offset(),
        (size.width as i32, size.height as i32),
        &monitors,
        primary,
    );
    follow.mark_own_move();
    let _ = chat.set_position(PhysicalPosition::new(x, y));
}

/// The chat moved. If Yadi did not do that itself, the person dragged it: keep the new distance.
fn remember_chat_offset(app: &AppHandle) {
    let (Some(mascot), Some(chat), Some(follow)) = (
        app.get_webview_window(MASCOT_LABEL),
        app.get_webview_window(CHAT_LABEL),
        app.try_state::<ChatFollow>(),
    ) else {
        return;
    };
    if follow.is_own_echo() || !chat.is_visible().unwrap_or(false) {
        return;
    }
    if let (Ok(m), Ok(c)) = (mascot.outer_position(), chat.outer_position()) {
        follow.set_offset(offset_between((c.x, c.y), (m.x, m.y)));
    }
}

/// If the screen layout changed while Yadi was running (a monitor unplugged, a resolution change),
/// the mascot may now be off every screen: bring it back. Called whenever the chat is shown.
fn keep_mascot_on_screen(app: &AppHandle, mascot: &WebviewWindow) {
    let (Ok(pos), Ok(size)) = (mascot.outer_position(), mascot.outer_size()) else {
        return;
    };
    let monitors = monitor_rects(app);
    let primary = primary_rect(app, &monitors);
    let size = (size.width as i32, size.height as i32);
    let (x, y) = clamp_to_monitors((pos.x, pos.y), size, &monitors, primary);
    if (x, y) != (pos.x, pos.y) {
        log::info!("the mascot was off screen; moved back");
        let _ = mascot.set_position(PhysicalPosition::new(x, y));
        save_position(app, PhysicalPosition::new(x, y));
    }
}

#[tauri::command]
pub fn show_chat(app: AppHandle) -> Result<(), String> {
    let mascot = window(&app, MASCOT_LABEL)?;
    let chat = window(&app, CHAT_LABEL)?;
    keep_mascot_on_screen(&app, &mascot);
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
