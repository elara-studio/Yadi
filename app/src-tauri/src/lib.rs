mod windows;

use tauri_plugin_log::{Target, TargetKind};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Log to stdout only. Never log transcripts, audio or prompts (decision D12).
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([Target::new(TargetKind::Stdout)])
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            windows::show_chat,
            windows::hide_chat,
            windows::focus_chat,
            windows::quit_app,
            windows::show_context_menu,
        ])
        .on_menu_event(|app, event| windows::menu::handle_menu_event(app, event.id().as_ref()))
        .setup(|app| {
            // No Dock icon: Yadi lives in the tray and as the floating mascot.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            windows::create_windows(app.handle())?;
            windows::menu::setup_tray(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
