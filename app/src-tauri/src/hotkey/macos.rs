//! macOS keyboard hook: a CGEventTap on the session event stream (key down / key up only).
//!
//! Needs Accessibility permission; without it `CGEventTapCreate`
//! returns NULL and `start` reports `PermissionDenied` so the caller can fall back to the chord.

use std::ffi::c_void;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use core_foundation::base::TCFType;
use core_foundation::runloop::{CFRunLoop, kCFRunLoopCommonModes};
use core_graphics::event::{
    CGEvent, CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
    CGEventType, CallbackResult, EventField,
};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use foreign_types::ForeignType;

use super::engine::{Output, RawKey};
use super::hook::{HookError, SYNTHETIC_TAG, Shared, SummonFn, now_ms};
use super::longpress::Mods;

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventKeyboardGetUnicodeString(
        event: *mut c_void,
        max_len: usize,
        actual_len: *mut usize,
        buffer: *mut u16,
    );
    fn CGEventTapEnable(tap: *mut c_void, enable: bool);
}

struct Ctx {
    shared: Arc<Shared>,
    on_summon: SummonFn,
    /// The tap's mach port, so a disabled tap can be switched back on.
    port: AtomicUsize,
}

pub fn start(shared: Arc<Shared>, on_summon: SummonFn) -> Result<(), HookError> {
    let (tx, rx) = mpsc::sync_channel::<Result<(), HookError>>(1);
    let spawned = thread::Builder::new()
        .name("yadi-key-hook".into())
        .spawn(move || run_tap(shared, on_summon, tx));
    if let Err(e) = spawned {
        return Err(HookError::Failed(format!(
            "could not start the hook thread: {e}"
        )));
    }
    rx.recv_timeout(Duration::from_secs(3))
        .map_err(|_| HookError::Failed("the keyboard hook did not report back".into()))?
}

fn run_tap(shared: Arc<Shared>, on_summon: SummonFn, tx: mpsc::SyncSender<Result<(), HookError>>) {
    let ctx = Arc::new(Ctx {
        shared,
        on_summon,
        port: AtomicUsize::new(0),
    });
    let cb_ctx = ctx.clone();
    let tap = CGEventTap::new(
        CGEventTapLocation::Session,
        CGEventTapPlacement::HeadInsertEventTap,
        CGEventTapOptions::Default,
        vec![CGEventType::KeyDown, CGEventType::KeyUp],
        move |_proxy, etype, event| {
            // A panic must not unwind into the OS: keep the event and carry on.
            catch_unwind(AssertUnwindSafe(|| handle(&cb_ctx, etype, event)))
                .unwrap_or(CallbackResult::Keep)
        },
    );
    let tap = match tap {
        Ok(t) => t,
        Err(()) => {
            let _ = tx.send(Err(HookError::PermissionDenied(
                "macOS refused the keyboard hook; Accessibility is probably not granted".into(),
            )));
            return;
        }
    };
    ctx.port.store(
        tap.mach_port().as_concrete_TypeRef() as usize,
        Ordering::Relaxed,
    );
    let Ok(source) = tap.mach_port().create_runloop_source(0) else {
        let _ = tx.send(Err(HookError::Failed(
            "could not create a run loop source".into(),
        )));
        return;
    };
    CFRunLoop::get_current().add_source(&source, unsafe { kCFRunLoopCommonModes });
    tap.enable();
    let _ = tx.send(Ok(()));
    CFRunLoop::run_current();
    log::warn!("keyboard hook run loop ended");
}

fn handle(ctx: &Ctx, etype: CGEventType, event: &CGEvent) -> CallbackResult {
    match etype {
        CGEventType::TapDisabledByTimeout | CGEventType::TapDisabledByUserInput => {
            let port = ctx.port.load(Ordering::Relaxed);
            if port != 0 {
                // SAFETY: `port` is the live mach port of our own tap.
                unsafe { CGEventTapEnable(port as *mut c_void, true) };
                log::warn!("keyboard hook was disabled by the system and has been re-enabled");
            }
            return CallbackResult::Keep;
        }
        CGEventType::KeyDown | CGEventType::KeyUp => {}
        _ => return CallbackResult::Keep,
    }
    if !ctx.shared.active() {
        return CallbackResult::Keep;
    }
    // Our own replayed keys carry a tag: never process them again.
    if event.get_integer_value_field(EventField::EVENT_SOURCE_USER_DATA) == SYNTHETIC_TAG {
        return CallbackResult::Keep;
    }

    let flags = event.get_flags();
    let key = RawKey {
        down: matches!(etype, CGEventType::KeyDown),
        is_y: is_letter_y(event),
        code: event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE) as u32,
        mods: Mods {
            ctrl: flags.contains(CGEventFlags::CGEventFlagControl),
            alt: flags.contains(CGEventFlags::CGEventFlagAlternate),
            meta: flags.contains(CGEventFlags::CGEventFlagCommand),
        },
        t: now_ms(),
    };
    let decision = ctx.shared.engine().on_key(key, ctx.shared.chat_focused());
    for output in &decision.outputs {
        match *output {
            Output::ReplayTap { code } => {
                post_key(code, true, CGEventFlags::CGEventFlagNull);
                post_key(code, false, CGEventFlags::CGEventFlagNull);
            }
            Output::ReplayDown { code, .. } => post_key(code, true, flags),
            Output::Summon => {
                log::info!("summon fired (long press)");
                (ctx.on_summon)();
            }
        }
    }
    if decision.swallow {
        CallbackResult::Drop
    } else {
        CallbackResult::Keep
    }
}

/// True when the key press produces the letter Y in the user's current keyboard layout.
fn is_letter_y(event: &CGEvent) -> bool {
    let mut buf = [0u16; 4];
    let mut len = 0usize;
    // SAFETY: `event` is a live CGEvent and `buf`/`len` are valid for the call.
    unsafe {
        CGEventKeyboardGetUnicodeString(
            event.as_ptr() as *mut c_void,
            buf.len(),
            &mut len,
            buf.as_mut_ptr(),
        );
    }
    len == 1 && (buf[0] == u16::from(b'y') || buf[0] == u16::from(b'Y'))
}

/// Posts one tagged synthetic key event.
fn post_key(code: u32, down: bool, flags: CGEventFlags) {
    let Ok(source) = CGEventSource::new(CGEventSourceStateID::HIDSystemState) else {
        return;
    };
    let Ok(event) = CGEvent::new_keyboard_event(source, code as u16, down) else {
        return;
    };
    event.set_flags(flags);
    event.set_integer_value_field(EventField::EVENT_SOURCE_USER_DATA, SYNTHETIC_TAG);
    event.post(CGEventTapLocation::HID);
}
