mod attachments;
mod audio;
mod download;
mod hardware;
mod hotkey;
mod listener;
mod models;
mod ollama;
mod settings;
mod setup;
mod stt;
mod tiers;
mod updates;
mod vocabulary;
mod windows;

#[cfg(test)]
mod privacy;

use tauri_plugin_log::{Target, TargetKind};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    // The same program, started at login, waits for the summon while Yadi is closed.
    if listener::is_listener_process() {
        listener::run::run(context);
        return;
    }
    listener::note_launch_args();
    tauri::Builder::default()
        // Must be the first plugin. A second launch (double-click, login item plus manual start)
        // brings the first Yadi forward instead of starting another mascot.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            use tauri::Emitter;
            log::info!("a second Yadi was started; bringing the first one forward");
            let _ = app.emit_to(windows::MASCOT_LABEL, "hotkey:summon", ());
        }))
        // Log to stdout only. Never log transcripts, audio or prompts (decision D12).
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([Target::new(TargetKind::Stdout)])
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // HTTP for the prompt pipeline (Task 16). Its allow-list is limited to Ollama on localhost
        // in capabilities/default.json.
        .plugin(tauri_plugin_http::init())
        // Launch at login (Settings; off by default) and the file dialogs for importing and
        // exporting the vocabulary.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_dialog::init())
        .manage(audio::commands::AudioState::default())
        .manage(models::DownloadState::default())
        .manage(updates::UpdateState::default())
        .manage(stt::commands::SttState::default())
        .manage(ollama::commands::OllamaState::new().expect("HTTP client for Ollama"))
        .manage(stt::commands::FinalPassState::default())
        .invoke_handler(tauri::generate_handler![
            windows::show_chat,
            windows::hide_chat,
            windows::focus_chat,
            windows::quit_app,
            windows::show_context_menu,
            settings::get_settings,
            settings::set_settings,
            settings::reset_everything,
            vocabulary::get_vocabulary,
            vocabulary::set_vocabulary,
            vocabulary::add_vocabulary,
            vocabulary::vocabulary_import,
            vocabulary::vocabulary_export,
            audio::mic::audio_list_devices,
            tiers::llm_options_list,
            audio::commands::audio_start,
            audio::commands::audio_stop,
            audio::commands::audio_clear,
            stt::commands::stt_start,
            stt::commands::stt_stop,
            stt::commands::final_pass_run,
            ollama::commands::ollama_status,
            ollama::commands::ollama_start,
            ollama::commands::ollama_install,
            ollama::commands::ollama_pull,
            ollama::commands::ollama_cancel_pull,
            ollama::commands::ollama_list,
            ollama::commands::ollama_has,
            setup::get_setup_state,
            setup::save_setup_state,
            setup::setup_mock_enabled,
            setup::mic_permission_status,
            setup::mic_request_permission,
            setup::hotkey_permission_status,
            setup::hotkey_request_permission,
            hardware::get_hardware_profile,
            tiers::select_model_tier,
            attachments::commands::attachment_from_path,
            attachments::commands::attachment_from_bytes,
            models::list_models,
            models::download_model,
            models::cancel_download,
            updates::check_for_update,
            updates::download_update,
            updates::cancel_update_download,
            updates::install_update,
            updates::open_release_page,
            hotkey::get_notice,
            hotkey::summon_capture_start,
            hotkey::summon_capture_end,
            hotkey::summon_set_paused,
            hotkey::open_permission_settings,
            listener::take_launch_summon,
            listener::summon_listener_ensure,
        ])
        .on_menu_event(|app, event| windows::menu::handle_menu_event(app, event.id().as_ref()))
        .setup(|app| {
            // First, so the summon listener stops listening before Yadi registers its own summon.
            listener::hold_main_lock(app.handle());
            // No Dock icon: Yadi lives in the tray and as the floating mascot.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            settings::init(app.handle());
            windows::create_windows(app.handle())?;
            windows::menu::setup_tray(app.handle())?;
            Ok(())
        })
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| {
            // Stop Ollama on quit, but only if Yadi was the one that started it. Then hand the
            // summon to the listener, so Hold-Y or the shortcut can open Yadi again.
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                app.state::<ollama::commands::OllamaState>().shutdown();
                listener::on_main_exit(app);
            }
        });
}
