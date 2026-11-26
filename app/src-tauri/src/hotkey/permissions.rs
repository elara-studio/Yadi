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

    /// Shows the system Accessibility prompt (once per app; afterwards macOS only lists the
    /// app in System Settings).
    pub fn request() {
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

#[cfg(target_os = "macos")]
pub fn request() {
    mac::request()
}

#[cfg(not(target_os = "macos"))]
pub fn status() -> PermissionStatus {
    PermissionStatus {
        accessibility: true,
        input_monitoring: true,
    }
}

#[cfg(not(target_os = "macos"))]
pub fn request() {}

/// Opens the System Settings pane for the first missing permission (macOS only).
pub fn open_settings() -> Result<(), String> {
    let Some(url) = settings_url(status()) else {
        return Err("No permission is missing".into());
    };
    open_url(url)
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
    fn accessibility_alone_is_enough() {
        assert!(st(true, false).all_granted());
        assert_eq!(settings_url(st(true, false)), None);
    }
}
