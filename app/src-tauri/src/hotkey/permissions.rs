//! macOS privacy permissions needed by the global keyboard hook. On other systems nothing is
//! needed and every check reports "granted".

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub struct PermissionStatus {
    /// "Accessibility": needed to create an event tap that can swallow keys. A process with
    /// Accessibility may also see key events, so this is the only one Hold-Y requires.
    pub accessibility: bool,
    /// "Input Monitoring": reported for diagnostics only. It is needed by listen-only taps of
    /// apps *without* Accessibility, and its status can stay stale until the app restarts.
    pub input_monitoring: bool,
}

impl PermissionStatus {
    /// Everything Hold-Y needs is granted.
    pub fn all_granted(&self) -> bool {
        self.accessibility
    }
}

pub const ACCESSIBILITY_PANE: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

/// The System Settings pane that fixes the missing permission, if any.
pub fn settings_url(status: PermissionStatus) -> Option<&'static str> {
    (!status.all_granted()).then_some(ACCESSIBILITY_PANE)
}

#[cfg(target_os = "macos")]
mod mac {
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::string::{CFString, CFStringRef};

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
        static kAXTrustedCheckOptionPrompt: CFStringRef;
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGPreflightListenEventAccess() -> bool;
    }

    pub fn status() -> super::PermissionStatus {
        // SAFETY: both are plain query functions with no arguments.
        unsafe {
            super::PermissionStatus {
                accessibility: AXIsProcessTrusted(),
                input_monitoring: CGPreflightListenEventAccess(),
            }
        }
    }

    /// Shows the system Accessibility prompt (once per app entry; afterwards macOS only lists
    /// the app in System Settings).
    pub fn prompt() {
        // SAFETY: the dictionary lives for the duration of the call; the key is the system
        // constant for "show the prompt".
        unsafe {
            let key = CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt);
            let options = CFDictionary::from_CFType_pairs(&[(
                key.as_CFType(),
                CFBoolean::true_value().as_CFType(),
            )]);
            AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef());
        }
    }
}

#[cfg(target_os = "macos")]
pub fn status() -> PermissionStatus {
    mac::status()
}

/// Asks for Accessibility: shows the system prompt, which offers to open System Settings.
///
/// A build that is not signed with a stable certificate (any local build) gets a new identity
/// each time it is built, and macOS ties the Accessibility grant to that identity. After
/// installing a new build, System Settings therefore still shows Yadi switched on, yet the new
/// build is not trusted and macOS will not prompt again. So when Yadi is not trusted, its own
/// stale entry (`bundle_id`) is removed first, once per run, which makes macOS ask afresh. Only
/// done from inside an app bundle: in development the permission belongs to the terminal.
#[cfg(target_os = "macos")]
pub fn request(bundle_id: &str) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static FORGOT_STALE_ENTRY: AtomicBool = AtomicBool::new(false);

    if !status().all_granted()
        && running_from_app_bundle()
        && !FORGOT_STALE_ENTRY.swap(true, Ordering::SeqCst)
    {
        match std::process::Command::new("/usr/bin/tccutil")
            .args(["reset", "Accessibility", bundle_id])
            .output()
        {
            Ok(out) if out.status.success() => {
                log::info!("removed a stale Accessibility entry so macOS asks again")
            }
            Ok(out) => log::warn!(
                "could not reset the Accessibility entry: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ),
            Err(e) => log::warn!("could not run tccutil: {e}"),
        }
    }
    mac::prompt()
}

#[cfg(target_os = "macos")]
fn running_from_app_bundle() -> bool {
    std::env::current_exe()
        .map(|p| is_inside_app_bundle(&p))
        .unwrap_or(false)
}

/// `…/Something.app/Contents/MacOS/binary`
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn is_inside_app_bundle(exe: &std::path::Path) -> bool {
    let mut up = exe.ancestors().skip(1);
    matches!(
        (up.next(), up.next(), up.next()),
        (Some(macos), Some(contents), Some(app))
            if macos.file_name() == Some("MacOS".as_ref())
                && contents.file_name() == Some("Contents".as_ref())
                && app.extension() == Some("app".as_ref())
    )
}

#[cfg(not(target_os = "macos"))]
pub fn status() -> PermissionStatus {
    PermissionStatus {
        accessibility: true,
        input_monitoring: true,
    }
}

#[cfg(not(target_os = "macos"))]
pub fn request(_bundle_id: &str) {}

/// Opens the System Settings pane for the missing permission (macOS only), after asking for it
/// so that Yadi is listed there (and a stale entry from an earlier build is replaced).
pub fn open_settings(bundle_id: &str) -> Result<(), String> {
    let Some(url) = settings_url(status()) else {
        return Err("No permission is missing".into());
    };
    request(bundle_id);
    open_url(url)
}

/// Asks for the permission, then waits up to `timeout` for it to be switched on, so the person
/// can do that in System Settings without pressing anything in Yadi afterwards.
pub fn request_and_wait(bundle_id: &str, timeout: std::time::Duration) -> PermissionStatus {
    let step = std::time::Duration::from_millis(500);
    if status().all_granted() {
        return status();
    }
    request(bundle_id);
    let mut waited = std::time::Duration::ZERO;
    while !status().all_granted() && waited < timeout {
        std::thread::sleep(step);
        waited += step;
    }
    status()
}

#[cfg(target_os = "macos")]
fn open_url(url: &str) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("could not open System Settings: {e}"))
}

#[cfg(not(target_os = "macos"))]
fn open_url(_url: &str) -> Result<(), String> {
    Err("Opening system permission settings is only needed on macOS".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    const fn st(a: bool, i: bool) -> PermissionStatus {
        PermissionStatus {
            accessibility: a,
            input_monitoring: i,
        }
    }

    #[test]
    fn nothing_to_fix_when_granted() {
        assert!(st(true, true).all_granted());
        assert_eq!(settings_url(st(true, true)), None);
    }

    #[test]
    fn accessibility_pane_when_accessibility_is_missing() {
        assert_eq!(settings_url(st(false, false)), Some(ACCESSIBILITY_PANE));
        assert_eq!(settings_url(st(false, true)), Some(ACCESSIBILITY_PANE));
        assert!(!st(false, true).all_granted());
    }

    #[test]
    fn app_bundle_paths_are_recognised() {
        use std::path::Path;
        assert!(is_inside_app_bundle(Path::new(
            "/Applications/Yadi.app/Contents/MacOS/app"
        )));
        assert!(!is_inside_app_bundle(Path::new(
            "/Users/me/Yadi/app/src-tauri/target/debug/app"
        )));
        assert!(!is_inside_app_bundle(Path::new("/Contents/MacOS/app")));
    }

    #[test]
    fn accessibility_alone_is_enough() {
        assert!(st(true, false).all_granted());
        assert_eq!(settings_url(st(true, false)), None);
    }
}
