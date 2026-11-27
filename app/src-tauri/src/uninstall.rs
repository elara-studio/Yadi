//! "Uninstall Yadi…" in the tray menu (macOS only; Windows has its installer's uninstaller). Dragging Yadi to the Trash does not work while
//! the summon listener runs from inside the bundle, so Yadi takes itself apart: it stops the
//! listener, removes both login entries, optionally deletes its data, moves the app to the
//! Trash and quits. Ollama and its models are left alone: other apps may use them.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};

const KEEP_DATA: &str = "Uninstall";
const DELETE_DATA: &str = "Uninstall and Delete Data";
const CANCEL: &str = "Cancel";

/// Asks first, then uninstalls. Called from the menu (main thread); the work runs elsewhere.
pub fn confirm_and_run(app: &AppHandle) {
    let app = app.clone();
    app.dialog()
        .message(
            "Yadi will stop its background helper, remove itself from your login items and \
             move to the Trash.\n\nYou can also delete your settings, vocabulary and \
             downloaded speech models.",
        )
        .title("Uninstall Yadi?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::YesNoCancelCustom(
            KEEP_DATA.into(),
            DELETE_DATA.into(),
            CANCEL.into(),
        ))
        .show_with_result(move |result| {
            let delete_data = match result {
                MessageDialogResult::Custom(label) if label == KEEP_DATA => false,
                MessageDialogResult::Custom(label) if label == DELETE_DATA => true,
                MessageDialogResult::Yes => false,
                MessageDialogResult::No => true,
                _ => return,
            };
            std::thread::spawn(move || run(&app, delete_data));
        });
}

fn run(app: &AppHandle, delete_data: bool) {
    log::info!("uninstalling Yadi (delete data: {delete_data})");
    // The listener first: once its entry is gone, quitting no longer wakes it.
    if let Err(e) = crate::listener::agent::remove() {
        log::warn!("uninstall: {e}");
    }
    if let Err(e) = app.autolaunch().disable() {
        log::warn!("uninstall: could not remove the login item: {e}");
    }
    if delete_data {
        for dir in data_dirs(app) {
            match std::fs::remove_dir_all(&dir) {
                Ok(()) => log::info!("uninstall: removed {}", dir.display()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => log::warn!("uninstall: cannot remove {}: {e}", dir.display()),
            }
        }
    }
    remove_app();
    app.exit(0);
}

/// Every folder Yadi writes to, deduplicated (several resolve to the same place on macOS).
fn data_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let paths = app.path();
    let mut dirs: Vec<PathBuf> = [
        paths.app_data_dir(),
        paths.app_local_data_dir(),
        paths.app_config_dir(),
        paths.app_cache_dir(),
        paths.app_log_dir(),
    ]
    .into_iter()
    .flatten()
    .collect();
    // WKWebView keeps its storage outside the app folders.
    if let Ok(home) = paths.home_dir() {
        dirs.push(home.join("Library/WebKit").join(&app.config().identifier));
    }
    dirs.sort();
    dirs.dedup();
    dirs.retain(|d| is_yadi_dir(d, &app.config().identifier));
    dirs
}

/// Guard against a misresolved path: only folders named after Yadi's identifier are removed.
fn is_yadi_dir(dir: &Path, identifier: &str) -> bool {
    dir.file_name().is_some_and(|n| n == identifier)
}

fn remove_app() {
    let Some(bundle) = std::env::current_exe()
        .ok()
        .and_then(|exe| crate::listener::app_bundle(&exe))
    else {
        log::info!("uninstall: not running from an app bundle; nothing to move to the Trash");
        return;
    };
    match trash(&bundle) {
        Ok(()) => log::info!("uninstall: moved {} to the Trash", bundle.display()),
        Err(e) => {
            // Nothing of Yadi runs once it quits, so a plain drag to the Trash now works.
            log::warn!("uninstall: {e}; showing Yadi in Finder instead");
            let _ = std::process::Command::new("/usr/bin/open")
                .arg("-R")
                .arg(&bundle)
                .status();
        }
    }
}

/// `-[NSFileManager trashItemAtURL:resultingItemURL:error:]`: the Finder's own Trash (with
/// "Put Back"), and no Automation prompt as scripting the Finder would cause.
fn trash(path: &Path) -> Result<(), String> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::ptr::null_mut;

    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject, Bool};

    let c_path = CString::new(path.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    let moved = std::panic::catch_unwind(|| {
        let (Some(string), Some(url), Some(manager)) = (
            AnyClass::get(c"NSString"),
            AnyClass::get(c"NSURL"),
            AnyClass::get(c"NSFileManager"),
        ) else {
            return false;
        };
        // SAFETY: plain Foundation calls with the argument types their selectors declare; the
        // C string outlives the calls, and null is allowed for both out-parameters.
        unsafe {
            let ns_path: *mut AnyObject = msg_send![string, stringWithUTF8String: c_path.as_ptr()];
            if ns_path.is_null() {
                return false;
            }
            let file_url: *mut AnyObject = msg_send![url, fileURLWithPath: ns_path];
            let fm: *mut AnyObject = msg_send![manager, defaultManager];
            let ok: Bool = msg_send![
                fm,
                trashItemAtURL: file_url,
                resultingItemURL: null_mut::<*mut AnyObject>(),
                error: null_mut::<*mut AnyObject>()
            ];
            ok.as_bool()
        }
    })
    .unwrap_or(false);
    if moved {
        Ok(())
    } else {
        Err(format!("could not move {} to the Trash", path.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_folders_named_after_yadi_are_removed() {
        let id = "com.elarasoftware.yadi";
        assert!(is_yadi_dir(
            Path::new("/Users/a/Library/Application Support/com.elarasoftware.yadi"),
            id
        ));
        assert!(!is_yadi_dir(Path::new("/Users/a/Library/Application Support"), id));
        assert!(!is_yadi_dir(Path::new("/"), id));
    }
}
