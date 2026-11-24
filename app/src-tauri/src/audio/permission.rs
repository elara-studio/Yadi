//! Microphone permission. macOS has a reliable native answer (`AVCaptureDevice`); elsewhere the
//! silence watchdog (`level.rs`) is the fallback.

use super::{AudioError, AudioErrorKind};

// The native statuses are only produced on macOS; other systems only ever see `Unknown`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MicPermission {
    Authorized,
    NotDetermined,
    Denied,
    Restricted,
    /// No native answer is available; rely on the silence watchdog.
    Unknown,
}

/// Maps `AVAuthorizationStatus` (0 not determined, 1 restricted, 2 denied, 3 authorized).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn status_from_av_code(code: isize) -> MicPermission {
    match code {
        0 => MicPermission::NotDetermined,
        1 => MicPermission::Restricted,
        2 => MicPermission::Denied,
        3 => MicPermission::Authorized,
        _ => MicPermission::Unknown,
    }
}

/// The error to show before even trying to record, if permission is known to be missing.
pub fn blocking_error(status: MicPermission) -> Option<AudioError> {
    match status {
        MicPermission::Denied => Some(AudioError::new(
            AudioErrorKind::PermissionDenied,
            "Microphone access is turned off for Yadi. Open System Settings > Privacy & Security > Microphone and allow Yadi.",
        )),
        MicPermission::Restricted => Some(AudioError::new(
            AudioErrorKind::PermissionDenied,
            "Microphone access is restricted on this Mac (for example by a profile), so Yadi cannot record.",
        )),
        _ => None,
    }
}

/// The message used when the watchdog sees only silence.
pub fn probable_denial_error() -> AudioError {
    AudioError::new(
        AudioErrorKind::ProbablePermissionDenied,
        "No sound was heard for 3 seconds. Yadi probably does not have microphone permission (or the microphone is muted). Check your system's microphone privacy settings.",
    )
}

#[cfg(target_os = "macos")]
pub fn microphone_status() -> MicPermission {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};

    #[link(name = "AVFoundation", kind = "framework")]
    unsafe extern "C" {
        static AVMediaTypeAudio: Option<&'static AnyObject>;
    }

    // A failed Objective-C lookup or an encoding mismatch must degrade to "Unknown", never crash.
    std::panic::catch_unwind(|| {
        let Some(class) = AnyClass::get(c"AVCaptureDevice") else {
            return MicPermission::Unknown;
        };
        // SAFETY: AVMediaTypeAudio is an immutable framework constant; the selector returns NSInteger.
        let code: isize = unsafe {
            let media = AVMediaTypeAudio;
            msg_send![class, authorizationStatusForMediaType: media]
        };
        status_from_av_code(code)
    })
    .unwrap_or(MicPermission::Unknown)
}

#[cfg(not(target_os = "macos"))]
pub fn microphone_status() -> MicPermission {
    MicPermission::Unknown
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn av_codes_map_to_statuses() {
        assert_eq!(status_from_av_code(0), MicPermission::NotDetermined);
        assert_eq!(status_from_av_code(1), MicPermission::Restricted);
        assert_eq!(status_from_av_code(2), MicPermission::Denied);
        assert_eq!(status_from_av_code(3), MicPermission::Authorized);
        assert_eq!(status_from_av_code(99), MicPermission::Unknown);
    }

    #[test]
    fn only_denied_and_restricted_block_recording() {
        assert!(blocking_error(MicPermission::Denied).is_some());
        assert!(blocking_error(MicPermission::Restricted).is_some());
        for ok in [
            MicPermission::Authorized,
            MicPermission::NotDetermined,
            MicPermission::Unknown,
        ] {
            assert!(blocking_error(ok).is_none());
        }
        let e = blocking_error(MicPermission::Denied).unwrap();
        assert_eq!(e.kind, AudioErrorKind::PermissionDenied);
        assert!(e.message.contains("System Settings"));
    }

    #[test]
    fn probable_denial_error_says_probable() {
        let e = probable_denial_error();
        assert_eq!(e.kind, AudioErrorKind::ProbablePermissionDenied);
        assert!(e.message.contains("probably"));
    }

    #[test]
    fn native_status_query_does_not_crash() {
        // Whatever the answer is on this machine, asking must not panic.
        let _ = microphone_status();
    }
}
