mod audio;
mod download;
mod hotkey;
mod models;
mod settings;
mod stt;
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
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(audio::commands::AudioState::default())
        .manage(models::DownloadState::default())
        .manage(stt::commands::SttState::default())
        .manage(stt::commands::FinalPassState::default())
        .invoke_handler(tauri::generate_handler![
            windows::show_chat,
            windows::hide_chat,
            windows::focus_chat,
            windows::quit_app,
            windows::show_context_menu,
            settings::get_settings,
            settings::set_settings,
            audio::commands::audio_start,
            audio::commands::audio_stop,
            audio::commands::audio_clear,
            stt::commands::stt_start,
            stt::commands::stt_stop,
            stt::commands::final_pass_run,
            models::list_models,
            models::download_model,
            models::cancel_download,
            hotkey::get_notice,
            hotkey::open_permission_settings,
        ])
        .on_menu_event(|app, event| windows::menu::handle_menu_event(app, event.id().as_ref()))
        .setup(|app| {
            // No Dock icon: Yadi lives in the tray and as the floating mascot.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            settings::init(app.handle());
            windows::create_windows(app.handle())?;
            windows::menu::setup_tray(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
