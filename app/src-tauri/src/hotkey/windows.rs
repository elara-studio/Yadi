//! Windows keyboard hook: a low-level keyboard hook (`WH_KEYBOARD_LL`).
//!
//! Limits (see docs/hotkey-notes.md): the hook cannot see keystrokes sent to elevated
//! (administrator) windows, and security software may flag any global keyboard hook.
//! This module could not be compiled or run on the macOS development machine.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::Duration;

use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput,
    VIRTUAL_KEY, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_Y,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, HC_ACTION, KBDLLHOOKSTRUCT, LLKHF_INJECTED, MSG,
    SetWindowsHookExW, WH_KEYBOARD_LL, WM_KEYDOWN, WM_SYSKEYDOWN,
};

use super::engine::{Output, RawKey};
use super::hook::{HookError, SYNTHETIC_TAG, Shared, SummonFn, now_ms};
use super::longpress::Mods;

struct Ctx {
    shared: Arc<Shared>,
    on_summon: SummonFn,
}

// The hook procedure is a plain function pointer, so its context lives in a static.
static CTX: OnceLock<Ctx> = OnceLock::new();
static INSTALLED: AtomicBool = AtomicBool::new(false);

pub fn start(shared: Arc<Shared>, on_summon: SummonFn) -> Result<(), HookError> {
    if CTX.set(Ctx { shared, on_summon }).is_err() {
        return Ok(()); // already started
    }
    let (tx, rx) = std::sync::mpsc::sync_channel::<Result<(), HookError>>(1);
    let spawned = thread::Builder::new()
        .name("yadi-key-hook".into())
        .spawn(move || unsafe {
            // SAFETY: standard low-level hook setup. The hook procedure is `hook_proc` and the
            // thread then pumps messages, which a low-level hook requires.
            let module = match GetModuleHandleW(None) {
                Ok(m) => m,
                Err(e) => {
                    let _ = tx.send(Err(HookError::Failed(format!("GetModuleHandleW: {e}"))));
                    return;
                }
            };
            match SetWindowsHookExW(
                WH_KEYBOARD_LL,
                Some(hook_proc),
                Some(HINSTANCE(module.0)),
                0,
            ) {
                Ok(_) => {
                    INSTALLED.store(true, Ordering::Relaxed);
                    let _ = tx.send(Ok(()));
                }
                Err(e) => {
                    let _ = tx.send(Err(HookError::Failed(format!("SetWindowsHookExW: {e}"))));
                    return;
                }
            }
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {}
        });
    if let Err(e) = spawned {
        return Err(HookError::Failed(format!(
            "could not start the hook thread: {e}"
        )));
    }
    rx.recv_timeout(Duration::from_secs(3))
        .map_err(|_| HookError::Failed("the keyboard hook did not report back".into()))?
}

unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 && INSTALLED.load(Ordering::Relaxed) {
        // A panic must not unwind into Windows.
        let swallow =
            std::panic::catch_unwind(|| unsafe { process(wparam, lparam) }).unwrap_or(false);
        if swallow {
            return LRESULT(1);
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

/// Returns true to swallow the event.
unsafe fn process(wparam: WPARAM, lparam: LPARAM) -> bool {
    let Some(ctx) = CTX.get() else { return false };
    if !ctx.shared.enabled() {
        return false;
    }
    // SAFETY: for WH_KEYBOARD_LL with code HC_ACTION, lparam points to a KBDLLHOOKSTRUCT.
    let kb = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
    // Our own replays (tagged) and anything injected by other software pass through.
    if kb.dwExtraInfo == SYNTHETIC_TAG as usize || kb.flags.0 & LLKHF_INJECTED.0 != 0 {
        return false;
    }
    let down = matches!(wparam.0 as u32, WM_KEYDOWN | WM_SYSKEYDOWN);
    let pressed = |vk: VIRTUAL_KEY| unsafe { GetAsyncKeyState(i32::from(vk.0)) } < 0;
    let key = RawKey {
        down,
        // VK_Y is the key that produces the letter Y in the active layout.
        is_y: kb.vkCode == u32::from(VK_Y.0),
        code: kb.vkCode,
        mods: Mods {
            ctrl: pressed(VK_CONTROL),
            alt: pressed(VK_MENU),
            meta: pressed(VK_LWIN) || pressed(VK_RWIN),
        },
        t: now_ms(),
    };
    let decision = ctx.shared.engine().on_key(key, ctx.shared.chat_focused());
    for output in &decision.outputs {
        match *output {
            Output::ReplayTap { code } => {
                send_key(code, false);
                send_key(code, true);
            }
            Output::ReplayDown { code, .. } => send_key(code, false),
            Output::Summon => {
                log::info!("summon fired (long press)");
                (ctx.on_summon)();
            }
        }
    }
    decision.swallow
}

/// Sends one tagged synthetic key event. `up == true` is a key release.
fn send_key(vk: u32, up: bool) {
    let input = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk as u16),
                wScan: 0,
                dwFlags: if up {
                    KEYEVENTF_KEYUP
                } else {
                    Default::default()
                },
                time: 0,
                dwExtraInfo: SYNTHETIC_TAG as usize,
            },
        },
    };
    // SAFETY: `input` is a fully initialised INPUT and the size matches.
    unsafe {
        SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
    }
}
