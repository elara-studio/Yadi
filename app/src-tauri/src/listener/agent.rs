//! Starting the summon listener at login: a LaunchAgent on macOS, a `Run` registry value on
//! Windows. Development builds leave the system alone unless `YADI_SUMMON_LISTENER=1`, so
//! working on Yadi does not install a login item that points into `target/`.

use std::path::{Path, PathBuf};

use super::LISTENER_ARG;

/// Set to `1` to register the listener from a development build.
pub const DEV_ENV: &str = "YADI_SUMMON_LISTENER";

fn allowed() -> bool {
    !cfg!(debug_assertions) || std::env::var(DEV_ENV).as_deref() == Ok("1")
}

fn current_exe() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|e| format!("cannot find Yadi: {e}"))
}

/// Registers the listener (rewriting the entry if Yadi moved) and makes sure it runs.
pub fn ensure(identifier: &str) -> Result<(), String> {
    if !allowed() {
        log::info!(
            "summon listener: left out in a development build (set {DEV_ENV}=1 to register it)"
        );
        return Ok(());
    }
    let exe = current_exe()?;
    platform::ensure(&exe, identifier)?;
    log::info!("summon listener registered");
    Ok(())
}

/// Stops the listener and removes its login entry (Uninstall). Development builds included,
/// so an entry registered with `YADI_SUMMON_LISTENER=1` can be cleaned up too.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn remove() -> Result<(), String> {
    platform::remove()?;
    log::info!("summon listener stopped and unregistered");
    Ok(())
}

/// Starts the listener if it is registered but not running (Yadi is quitting).
pub fn wake(listener_lock: &Path) {
    if !allowed() || super::is_held(listener_lock) {
        return;
    }
    if let Err(e) = platform::wake() {
        log::warn!("summon listener could not be started: {e}");
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::path::{Path, PathBuf};
    use std::process::Command;

    use super::LISTENER_ARG;

    pub const LABEL: &str = "com.elarasoftware.yadi.summon-listener";

    fn plist_path() -> Result<PathBuf, String> {
        let home = std::env::var_os("HOME").ok_or("HOME is not set")?;
        Ok(PathBuf::from(home)
            .join("Library/LaunchAgents")
            .join(format!("{LABEL}.plist")))
    }

    fn uid() -> Result<String, String> {
        let out = Command::new("/usr/bin/id")
            .arg("-u")
            .output()
            .map_err(|e| format!("id -u: {e}"))?;
        let uid = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if uid.is_empty() {
            return Err("could not read the user id".into());
        }
        Ok(uid)
    }

    fn launchctl(args: &[&str]) -> Result<(), String> {
        let out = Command::new("/bin/launchctl")
            .args(args)
            .output()
            .map_err(|e| format!("launchctl: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(format!(
                "launchctl {}: {}",
                args.first().copied().unwrap_or_default(),
                String::from_utf8_lossy(&out.stderr).trim()
            ))
        }
    }

    fn xml_escape(s: &str) -> String {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    }

    /// No `KeepAlive`: if Yadi is deleted, launchd must not keep retrying a missing program.
    /// Yadi wakes the listener itself whenever it quits.
    pub fn plist(exe: &Path, identifier: &str) -> String {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{exe}</string>
    <string>{LISTENER_ARG}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>AssociatedBundleIdentifiers</key>
  <array>
    <string>{identifier}</string>
  </array>
</dict>
</plist>
"#,
            exe = xml_escape(&exe.to_string_lossy()),
            identifier = xml_escape(identifier),
        )
    }

    pub fn ensure(exe: &Path, identifier: &str) -> Result<(), String> {
        let path = plist_path()?;
        let content = plist(exe, identifier);
        let domain = format!("gui/{}", uid()?);
        let service = format!("{domain}/{LABEL}");
        let path_str = path.to_string_lossy().to_string();
        if std::fs::read_to_string(&path).ok().as_deref() != Some(content.as_str()) {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)
                    .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
            }
            std::fs::write(&path, &content)
                .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
            // An older entry (other path) may be loaded: replace it.
            let _ = launchctl(&["bootout", &service]);
            launchctl(&["bootstrap", &domain, &path_str])?;
        } else if launchctl(&["print", &service]).is_err() {
            launchctl(&["bootstrap", &domain, &path_str])?;
        }
        // Starts it if it is not running; a running listener is left alone.
        launchctl(&["kickstart", &service])
    }

    pub fn wake() -> Result<(), String> {
        if !plist_path()?.exists() {
            return Ok(());
        }
        let service = format!("gui/{}/{LABEL}", uid()?);
        launchctl(&["kickstart", &service])
    }

    /// `bootout` ends the running listener and unloads the entry; the plist goes too, so it
    /// does not come back at the next login.
    pub fn remove() -> Result<(), String> {
        let service = format!("gui/{}/{LABEL}", uid()?);
        if launchctl(&["print", &service]).is_ok() {
            launchctl(&["bootout", &service])?;
        }
        let path = plist_path()?;
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("cannot remove {}: {e}", path.display())),
        }
    }
}

#[cfg(windows)]
mod platform {
    use std::path::Path;
    use std::process::Command;

    use super::LISTENER_ARG;

    const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const VALUE: &str = "Yadi summon listener";

    pub fn ensure(exe: &Path, _identifier: &str) -> Result<(), String> {
        let key = windows_registry::CURRENT_USER
            .create(RUN_KEY)
            .map_err(|e| format!("cannot open the Run key: {e}"))?;
        let command = format!("\"{}\" {LISTENER_ARG}", exe.display());
        key.set_string(VALUE, &command)
            .map_err(|e| format!("cannot register the listener: {e}"))?;
        start(exe)
    }

    pub fn wake() -> Result<(), String> {
        let registered = windows_registry::CURRENT_USER
            .open(RUN_KEY)
            .and_then(|k| k.get_string(VALUE))
            .is_ok();
        if !registered {
            return Ok(());
        }
        start(&super::current_exe()?)
    }

    /// Removes the login entry. A running listener is ended by the caller (it holds a lock, not
    /// a service handle Windows could stop).
    pub fn remove() -> Result<(), String> {
        let Ok(key) = windows_registry::CURRENT_USER.create(RUN_KEY) else {
            return Ok(());
        };
        let _ = key.remove_value(VALUE);
        Ok(())
    }

    /// The listener takes its own lock and exits at once if one is already running.
    fn start(exe: &Path) -> Result<(), String> {
        let mut cmd = Command::new(exe);
        cmd.arg(LISTENER_ARG);
        super::super::detach(&mut cmd);
        cmd.spawn()
            .map(|_| ())
            .map_err(|e| format!("cannot start the listener: {e}"))
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    use std::path::Path;

    pub fn ensure(_exe: &Path, _identifier: &str) -> Result<(), String> {
        Ok(())
    }

    pub fn wake() -> Result<(), String> {
        Ok(())
    }

    pub fn remove() -> Result<(), String> {
        Ok(())
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn the_launch_agent_starts_this_program_as_the_listener() {
        let p = platform::plist(
            Path::new("/Applications/Yadi & Co.app/Contents/MacOS/Yadi"),
            "com.elarasoftware.yadi",
        );
        assert!(p.contains("<string>/Applications/Yadi &amp; Co.app/Contents/MacOS/Yadi</string>"));
        assert!(p.contains(&format!("<string>{LISTENER_ARG}</string>")));
        assert!(p.contains("<key>RunAtLoad</key>"));
        assert!(
            !p.contains("KeepAlive"),
            "a deleted Yadi must not be retried forever"
        );
    }
}
