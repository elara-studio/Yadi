//! What the machine can do: memory, free disk, CPU, and (best effort) GPU memory. The tier
//! selection that uses this lives in `tiers.rs` and is a pure function of a `HardwareProfile`.

use std::path::Path;
use std::process::Command;
use std::sync::mpsc;
use std::time::Duration;

use serde::Serialize;
use sysinfo::{MemoryRefreshKind, RefreshKind, System};
use tauri::{AppHandle, Manager};

pub const GIB: u64 = 1024 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Gpu {
    None,
    /// Apple Silicon: the GPU shares the machine's memory, so there is no separate budget.
    AppleSilicon,
    /// A dedicated NVIDIA GPU, found through `nvidia-smi`.
    Nvidia {
        vram_bytes: u64,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct HardwareProfile {
    pub ram_bytes: u64,
    /// Free space on the volume that holds the app data (where models are stored).
    pub free_disk_bytes: u64,
    pub cpu_cores: usize,
    pub arch: String,
    pub os: String,
    pub gpu: Gpu,
}

impl HardwareProfile {
    /// Total RAM in GiB, rounded (a "16 GB" PC often reports 15.7 GiB).
    pub fn ram_gb(&self) -> u32 {
        (self.ram_bytes as f64 / GIB as f64).round() as u32
    }

    /// Dedicated video memory in bytes, if there is a dedicated GPU.
    pub fn vram_bytes(&self) -> Option<u64> {
        match self.gpu {
            Gpu::Nvidia { vram_bytes } => Some(vram_bytes),
            _ => None,
        }
    }
}

/// `nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits` prints one number of MiB
/// per GPU per line. Returns the largest, in bytes.
pub fn parse_nvidia_smi(output: &str) -> Option<u64> {
    output
        .lines()
        .filter_map(|l| l.trim().parse::<u64>().ok())
        .max()
        .filter(|mib| *mib > 0)
        .map(|mib| mib * 1024 * 1024)
}

fn nvidia_vram_bytes() -> Option<u64> {
    // A hung driver must not hang startup: run the tool on a thread and give up after 3 s.
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let out = Command::new("nvidia-smi")
            .args(["--query-gpu=memory.total", "--format=csv,noheader,nounits"])
            .output();
        let _ = tx.send(out);
    });
    let out = rx.recv_timeout(Duration::from_secs(3)).ok()?.ok()?;
    if !out.status.success() {
        return None;
    }
    parse_nvidia_smi(&String::from_utf8_lossy(&out.stdout))
}

pub fn detect_gpu(os: &str, arch: &str) -> Gpu {
    if os == "macos" && arch == "aarch64" {
        return Gpu::AppleSilicon;
    }
    match nvidia_vram_bytes() {
        Some(vram_bytes) => Gpu::Nvidia { vram_bytes },
        None => Gpu::None,
    }
}

/// Reads the machine's capabilities. `data_dir` is where models will be stored.
pub fn detect(data_dir: &Path) -> HardwareProfile {
    let ram_bytes = System::new_with_specifics(
        RefreshKind::nothing().with_memory(MemoryRefreshKind::everything()),
    )
    .map(|s| s.total_memory())
    .unwrap_or(0);
    let cpu_cores = System::physical_core_count()
        .ok()
        .or_else(|| std::thread::available_parallelism().ok().map(|n| n.get()))
        .unwrap_or(1);
    // The folder may not exist yet; ask about the nearest existing parent.
    let mut probe = data_dir;
    while !probe.exists() {
        match probe.parent() {
            Some(p) => probe = p,
            None => break,
        }
    }
    let free_disk_bytes = fs4::available_space(probe).unwrap_or(0);
    let os = std::env::consts::OS.to_string();
    let arch = std::env::consts::ARCH.to_string();
    let gpu = detect_gpu(&os, &arch);
    HardwareProfile {
        ram_bytes,
        free_disk_bytes,
        cpu_cores,
        arch,
        os,
        gpu,
    }
}

#[tauri::command]
pub fn get_hardware_profile(app: AppHandle) -> Result<HardwareProfile, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data directory: {e}"))?;
    Ok(detect(&dir))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nvidia_smi_output_is_parsed_in_mib() {
        assert_eq!(parse_nvidia_smi("12288\n"), Some(12288 * 1024 * 1024));
        assert_eq!(
            parse_nvidia_smi("8192\n24576\n"),
            Some(24576 * 1024 * 1024),
            "largest GPU wins"
        );
        assert_eq!(parse_nvidia_smi("  8192  \r\n"), Some(8192 * 1024 * 1024));
    }

    #[test]
    fn unusable_nvidia_smi_output_gives_none() {
        for bad in ["", "\n", "N/A", "No devices were found", "0", "-5"] {
            assert_eq!(parse_nvidia_smi(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn ram_is_rounded_to_whole_gib() {
        let mut p = sample(15_700_000_000);
        assert_eq!(p.ram_gb(), 15); // 14.6 GiB
        p.ram_bytes = 16 * GIB - 100 * 1024 * 1024; // a "16 GB" PC reporting slightly less
        assert_eq!(p.ram_gb(), 16);
        p.ram_bytes = 8 * GIB;
        assert_eq!(p.ram_gb(), 8);
    }

    fn sample(ram_bytes: u64) -> HardwareProfile {
        HardwareProfile {
            ram_bytes,
            free_disk_bytes: 100 * GIB,
            cpu_cores: 8,
            arch: "x86_64".into(),
            os: "windows".into(),
            gpu: Gpu::None,
        }
    }

    #[test]
    fn apple_silicon_is_recognised_without_running_anything() {
        assert_eq!(detect_gpu("macos", "aarch64"), Gpu::AppleSilicon);
    }

    #[test]
    fn vram_only_for_dedicated_gpus() {
        let mut p = sample(16 * GIB);
        assert_eq!(p.vram_bytes(), None);
        p.gpu = Gpu::AppleSilicon;
        assert_eq!(p.vram_bytes(), None);
        p.gpu = Gpu::Nvidia {
            vram_bytes: 12 * GIB,
        };
        assert_eq!(p.vram_bytes(), Some(12 * GIB));
    }

    #[test]
    fn detect_runs_on_this_machine_and_reports_sane_values() {
        let profile = detect(&std::env::temp_dir().join("yadi-hw-test-does-not-exist-yet"));
        println!("HARDWARE PROFILE: {profile:?}");
        assert!(
            profile.ram_bytes >= GIB,
            "RAM looks wrong: {}",
            profile.ram_bytes
        );
        assert!(profile.cpu_cores >= 1);
        assert!(
            profile.free_disk_bytes > 0,
            "the nearest existing parent is used when the folder is missing"
        );
        assert!(!profile.arch.is_empty() && !profile.os.is_empty());
    }
}
