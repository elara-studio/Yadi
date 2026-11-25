//! Picks the LLM and speech models for a machine. `select_tier` is a pure function of a
//! `HardwareProfile` and the catalogue, so every rule below is unit-tested without hardware.
//!
//! Rules (PLAN Task 13):
//!  - under 6 GB of RAM: unsupported;
//!  - the tier must qualify by size: RAM at least `min_ram_gb`, or a dedicated GPU with at least
//!    `min_vram_gb`. The smallest tier is the fallback for 6 to 8 GB;
//!  - the LLM's weights plus a context overhead must fit in at most 50% of RAM, or at most 80% of
//!    a dedicated GPU's video memory (Apple Silicon counts as RAM, not as a dedicated GPU);
//!  - the disk must have at least 1.5x the tier's installed size free.
//!
//! The highest tier that passes everything wins.

use serde::Serialize;

use crate::hardware::HardwareProfile;
use crate::models::{Catalog, ModelEntry, ModelKind, TierEntry};

/// Below this many GiB of RAM Yadi cannot run its language model.
pub const MIN_SUPPORTED_RAM_GB: u32 = 6;
/// Memory beyond the weights: the 4096-token context, runtime buffers. An estimate.
pub const CONTEXT_OVERHEAD_BYTES: u64 = 1024 * 1024 * 1024;
pub const RAM_FRACTION: f64 = 0.5;
pub const VRAM_FRACTION: f64 = 0.8;
pub const DISK_FACTOR: f64 = 1.5;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Tier {
    pub id: String,
    pub llm_model_id: String,
    pub llm_tag: String,
    pub stt_final_model_id: String,
    pub stt_stream_model_id: String,
    /// What the tier's models occupy on disk once installed.
    pub installed_bytes: u64,
    /// What must be free before starting (1.5x installed).
    pub disk_needed_bytes: u64,
    /// Memory the LLM needs while running (weights + context overhead).
    pub memory_needed_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Unsupported {
    RamTooLow {
        ram_gb: u32,
        min_gb: u32,
    },
    DiskTooSmall {
        needed_bytes: u64,
        available_bytes: u64,
    },
    /// No tier's model fits in memory.
    DoesNotFit {
        memory_needed_bytes: u64,
        budget_bytes: u64,
    },
}

impl Unsupported {
    /// A readable explanation for the setup screen.
    pub fn reason(&self) -> String {
        let gb = |b: &u64| *b as f64 / 1e9;
        match self {
            Unsupported::RamTooLow { ram_gb, min_gb } => {
                format!("This computer has {ram_gb} GB of memory; Yadi needs at least {min_gb} GB.")
            }
            Unsupported::DiskTooSmall {
                needed_bytes,
                available_bytes,
            } => format!(
                "Yadi needs about {:.1} GB of free disk space for its models; only {:.1} GB is free.",
                gb(needed_bytes),
                gb(available_bytes)
            ),
            Unsupported::DoesNotFit {
                memory_needed_bytes,
                budget_bytes,
            } => format!(
                "The smallest language model needs about {:.1} GB of memory but only {:.1} GB can be used.",
                gb(memory_needed_bytes),
                gb(budget_bytes)
            ),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "result", rename_all = "kebab-case")]
pub enum Selection {
    Tier(Box<Tier>),
    Unsupported { why: Unsupported, reason: String },
}

fn llm_and_speech<'a>(c: &'a Catalog, t: &TierEntry) -> Option<[&'a ModelEntry; 3]> {
    Some([
        c.find(&t.llm_model_id)?,
        c.find(&t.stt_final_model_id)?,
        c.find(&t.stt_stream_model_id)?,
    ])
}

fn describe(c: &Catalog, t: &TierEntry) -> Option<Tier> {
    let [llm, fin, stream] = llm_and_speech(c, t)?;
    let installed = llm.size_bytes? + fin.installed_bytes? + stream.installed_bytes?;
    Some(Tier {
        id: t.id.clone(),
        llm_model_id: llm.id.clone(),
        llm_tag: llm.ollama_tag.clone()?,
        stt_final_model_id: fin.id.clone(),
        stt_stream_model_id: stream.id.clone(),
        installed_bytes: installed,
        disk_needed_bytes: (installed as f64 * DISK_FACTOR).ceil() as u64,
        memory_needed_bytes: llm.size_bytes? + CONTEXT_OVERHEAD_BYTES,
    })
}

/// How much memory the LLM may use on this machine.
fn memory_budget(p: &HardwareProfile) -> u64 {
    let ram = (p.ram_bytes as f64 * RAM_FRACTION) as u64;
    let vram = p
        .vram_bytes()
        .map_or(0, |v| (v as f64 * VRAM_FRACTION) as u64);
    ram.max(vram)
}

fn qualifies(p: &HardwareProfile, t: &TierEntry, is_smallest: bool) -> bool {
    if is_smallest {
        return true; // RAM >= 6 GB is checked before; the smallest tier is the fallback
    }
    p.ram_gb() >= t.min_ram_gb
        || matches!(
            (p.vram_bytes(), t.min_vram_gb),
            (Some(v), Some(min)) if (v as f64 / crate::hardware::GIB as f64).round() as u32 >= min
        )
}

pub fn select_tier(profile: &HardwareProfile, catalog: &Catalog) -> Selection {
    let unsupported = |why: Unsupported| Selection::Unsupported {
        reason: why.reason(),
        why,
    };
    if profile.ram_gb() < MIN_SUPPORTED_RAM_GB {
        return unsupported(Unsupported::RamTooLow {
            ram_gb: profile.ram_gb(),
            min_gb: MIN_SUPPORTED_RAM_GB,
        });
    }
    let budget = memory_budget(profile);
    // Remember why the smallest candidate failed, to explain an "unsupported" result.
    let mut smallest_failure: Option<Unsupported> = None;

    for (i, entry) in catalog.llm_tiers.iter().enumerate().rev() {
        let is_smallest = i == 0;
        if !qualifies(profile, entry, is_smallest) {
            continue;
        }
        let Some(tier) = describe(catalog, entry) else {
            continue;
        };
        let failure = if tier.memory_needed_bytes > budget {
            Some(Unsupported::DoesNotFit {
                memory_needed_bytes: tier.memory_needed_bytes,
                budget_bytes: budget,
            })
        } else if profile.free_disk_bytes < tier.disk_needed_bytes {
            Some(Unsupported::DiskTooSmall {
                needed_bytes: tier.disk_needed_bytes,
                available_bytes: profile.free_disk_bytes,
            })
        } else {
            None
        };
        match failure {
            None => return Selection::Tier(Box::new(tier)),
            Some(f) if is_smallest => smallest_failure = Some(f),
            Some(_) => {} // a smaller tier may still fit
        }
    }
    unsupported(smallest_failure.unwrap_or(Unsupported::DoesNotFit {
        memory_needed_bytes: 0,
        budget_bytes: budget,
    }))
}

/// Swaps the tier's language model for the one the user chose in Settings. An unknown id, or an
/// id that is not a language model, is ignored (the tier's own model stays).
pub fn apply_llm_override(tier: Tier, catalog: &Catalog, model_id: Option<&str>) -> Tier {
    let Some(id) = model_id else { return tier };
    let Some(chosen) = catalog.find(id) else {
        return tier;
    };
    let (Some(tag), Some(size)) = (chosen.ollama_tag.clone(), chosen.size_bytes) else {
        return tier;
    };
    if chosen.kind != ModelKind::Llm {
        return tier;
    }
    let old_size = catalog
        .find(&tier.llm_model_id)
        .and_then(|m| m.size_bytes)
        .unwrap_or(0);
    let installed = tier.installed_bytes.saturating_sub(old_size) + size;
    Tier {
        llm_model_id: chosen.id.clone(),
        llm_tag: tag,
        installed_bytes: installed,
        disk_needed_bytes: (installed as f64 * DISK_FACTOR).ceil() as u64,
        memory_needed_bytes: size + CONTEXT_OVERHEAD_BYTES,
        ..tier
    }
}

/// One language model the user may pick in Settings, with whether it suits this computer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LlmOption {
    pub id: String,
    pub tag: String,
    pub size_bytes: u64,
    pub memory_needed_bytes: u64,
    /// This is the model Yadi picks for this hardware.
    pub recommended: bool,
    /// Its weights plus context fit in the memory budget.
    pub fits: bool,
    /// Plain-language warning when it does not fit; `None` when it does.
    pub warning: Option<String>,
    pub tested: bool,
}

fn gb(bytes: u64) -> String {
    format!("{:.1} GB", bytes as f64 / 1_073_741_824.0)
}

/// Every language model in the catalogue, smallest first, with a fit warning where needed.
pub fn llm_options(
    profile: &HardwareProfile,
    catalog: &Catalog,
    recommended_id: Option<&str>,
) -> Vec<LlmOption> {
    let budget = memory_budget(profile);
    let mut options: Vec<LlmOption> = catalog
        .models
        .iter()
        .filter(|m| m.kind == ModelKind::Llm)
        .filter_map(|m| {
            let size = m.size_bytes?;
            let needed = size + CONTEXT_OVERHEAD_BYTES;
            let fits = needed <= budget;
            Some(LlmOption {
                id: m.id.clone(),
                tag: m.ollama_tag.clone()?,
                size_bytes: size,
                memory_needed_bytes: needed,
                recommended: recommended_id == Some(m.id.as_str()),
                fits,
                warning: (!fits).then(|| {
                    format!(
                        "This model needs about {} of memory and Yadi can use about {} on this computer. It may be very slow or fail to load.",
                        gb(needed),
                        gb(budget)
                    )
                }),
                tested: m.status.as_deref() == Some("tested"),
            })
        })
        .collect();
    options.sort_by_key(|o| o.size_bytes);
    options
}

fn chosen_model_id(app: &tauri::AppHandle) -> Option<String> {
    use tauri::Manager;
    app.try_state::<crate::settings::SettingsState>()
        .and_then(|s| s.0.lock().ok().and_then(|s| s.llm.model_id.clone()))
}

fn profile_of(app: &tauri::AppHandle) -> Result<HardwareProfile, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data directory: {e}"))?;
    Ok(crate::hardware::detect(&dir))
}

/// The tier for this machine, with the user's own model choice (Settings) applied.
#[tauri::command]
pub fn select_model_tier(app: tauri::AppHandle) -> Result<Selection, String> {
    let catalog = Catalog::embedded()?;
    Ok(match select_tier(&profile_of(&app)?, &catalog) {
        Selection::Tier(tier) => Selection::Tier(Box::new(apply_llm_override(
            *tier,
            &catalog,
            chosen_model_id(&app).as_deref(),
        ))),
        other => other,
    })
}

/// The language models Settings offers, with fit warnings for this computer.
#[tauri::command]
pub fn llm_options_list(app: tauri::AppHandle) -> Result<Vec<LlmOption>, String> {
    let catalog = Catalog::embedded()?;
    let profile = profile_of(&app)?;
    let recommended = match select_tier(&profile, &catalog) {
        Selection::Tier(t) => Some(t.llm_model_id),
        Selection::Unsupported { .. } => None,
    };
    Ok(llm_options(&profile, &catalog, recommended.as_deref()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hardware::{GIB, Gpu};

    fn machine(ram_gb: u64, disk_gb: u64, gpu: Gpu) -> HardwareProfile {
        HardwareProfile {
            ram_bytes: ram_gb * GIB,
            free_disk_bytes: disk_gb * GIB,
            cpu_cores: 8,
            arch: "x86_64".into(),
            os: "windows".into(),
            gpu,
        }
    }
    fn catalog() -> Catalog {
        Catalog::embedded().expect("the embedded catalogue is valid")
    }
    fn tier_id(s: &Selection) -> String {
        match s {
            Selection::Tier(t) => t.id.clone(),
            Selection::Unsupported { reason, .. } => format!("unsupported: {reason}"),
        }
    }

    #[test]
    fn the_plans_table() {
        let nvidia12 = Gpu::Nvidia {
            vram_bytes: 12 * GIB,
        };
        let rows: &[(&str, HardwareProfile, &str)] = &[
            ("4 GB RAM", machine(4, 500, Gpu::None), "unsupported"),
            ("8 GB, no GPU", machine(8, 500, Gpu::None), "low"),
            ("16 GB", machine(16, 500, Gpu::None), "mid"),
            ("32 GB", machine(32, 500, Gpu::None), "high"),
            (
                "16 GB Apple Silicon",
                machine(16, 500, Gpu::AppleSilicon),
                "mid",
            ),
            (
                "8 GB RAM + 4 GB free disk",
                machine(8, 4, Gpu::None),
                "unsupported",
            ),
            (
                "NVIDIA 12 GB VRAM (16 GB RAM)",
                machine(16, 500, nvidia12),
                "high",
            ),
        ];
        for (name, profile, expected) in rows {
            let got = tier_id(&select_tier(profile, &catalog()));
            assert!(
                got.starts_with(expected),
                "{name}: expected {expected}, got {got}"
            );
        }
    }

    #[test]
    fn a_4_gb_machine_is_unsupported_because_of_ram() {
        match select_tier(&machine(4, 500, Gpu::None), &catalog()) {
            Selection::Unsupported {
                why:
                    Unsupported::RamTooLow {
                        ram_gb: 4,
                        min_gb: 6,
                    },
                reason,
            } => {
                assert!(
                    reason.contains("4 GB") && reason.contains("at least 6 GB"),
                    "{reason}"
                );
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn eight_gb_with_four_gb_free_is_unsupported_because_the_disk_is_too_small() {
        match select_tier(&machine(8, 4, Gpu::None), &catalog()) {
            Selection::Unsupported {
                why:
                    Unsupported::DiskTooSmall {
                        needed_bytes,
                        available_bytes,
                    },
                reason,
            } => {
                assert_eq!(available_bytes, 4 * GIB);
                assert!(
                    needed_bytes > 4 * GIB,
                    "the low tier needs 1.5x its installed size: {needed_bytes}"
                );
                assert!(reason.contains("free disk space"), "{reason}");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn the_disk_threshold_is_exactly_one_and_a_half_times_the_installed_size() {
        let cat = catalog();
        let Selection::Tier(low) = select_tier(&machine(8, 500, Gpu::None), &cat) else {
            panic!()
        };
        let mut m = machine(8, 0, Gpu::None);
        m.free_disk_bytes = low.disk_needed_bytes - 1;
        assert!(matches!(
            select_tier(&m, &cat),
            Selection::Unsupported { .. }
        ));
        m.free_disk_bytes = low.disk_needed_bytes;
        assert_eq!(tier_id(&select_tier(&m, &cat)), "low");
        assert_eq!(
            low.disk_needed_bytes,
            (low.installed_bytes as f64 * 1.5).ceil() as u64
        );
    }

    #[test]
    fn six_gb_is_the_minimum_and_gets_the_low_tier() {
        assert_eq!(
            tier_id(&select_tier(&machine(6, 500, Gpu::None), &catalog())),
            "low"
        );
        assert!(
            tier_id(&select_tier(&machine(5, 500, Gpu::None), &catalog()))
                .starts_with("unsupported")
        );
    }

    #[test]
    fn in_between_sizes_get_the_largest_tier_they_qualify_for() {
        for (ram, expected) in [
            (7, "low"),
            (12, "low"),
            (15, "low"),
            (16, "mid"),
            (24, "mid"),
            (31, "mid"),
            (32, "high"),
            (64, "high"),
        ] {
            assert_eq!(
                tier_id(&select_tier(&machine(ram, 500, Gpu::None), &catalog())),
                expected,
                "{ram} GB"
            );
        }
    }

    #[test]
    fn a_16_gb_pc_that_reports_15_7_gib_still_counts_as_16() {
        let mut m = machine(16, 500, Gpu::None);
        m.ram_bytes = (15.7 * GIB as f64) as u64;
        assert_eq!(tier_id(&select_tier(&m, &catalog())), "mid");
        m.ram_bytes = (15.4 * GIB as f64) as u64; // rounds to 15
        assert_eq!(tier_id(&select_tier(&m, &catalog())), "low");
    }

    #[test]
    fn a_small_gpu_does_not_promote_the_machine() {
        let nvidia8 = Gpu::Nvidia {
            vram_bytes: 8 * GIB,
        };
        assert_eq!(
            tier_id(&select_tier(&machine(8, 500, nvidia8), &catalog())),
            "low"
        );
        assert_eq!(
            tier_id(&select_tier(&machine(16, 500, nvidia8), &catalog())),
            "mid"
        );
    }

    #[test]
    fn apple_silicon_counts_as_ram_not_as_a_dedicated_gpu() {
        // 16 GB unified memory must not be treated like a 16 GB graphics card (which would reach "high")
        assert_eq!(
            tier_id(&select_tier(
                &machine(16, 500, Gpu::AppleSilicon),
                &catalog()
            )),
            "mid"
        );
        assert_eq!(
            tier_id(&select_tier(
                &machine(64, 500, Gpu::AppleSilicon),
                &catalog()
            )),
            "high"
        );
    }

    #[test]
    fn a_tier_that_does_not_fit_in_memory_falls_back_to_a_smaller_one() {
        // 32 GB qualifies for "high" by size, but with a tiny disk-free budget for its big model...
        let mut cat = catalog();
        // make the high tier's LLM too large for 50% of 32 GB
        let high_llm = cat.llm_tiers[2].llm_model_id.clone();
        cat.models
            .iter_mut()
            .find(|m| m.id == high_llm)
            .unwrap()
            .size_bytes = Some(20 * GIB);
        assert_eq!(
            tier_id(&select_tier(&machine(32, 500, Gpu::None), &cat)),
            "mid"
        );
    }

    #[test]
    fn when_even_the_smallest_model_does_not_fit_the_reason_is_memory() {
        let mut cat = catalog();
        let low_llm = cat.llm_tiers[0].llm_model_id.clone();
        cat.models
            .iter_mut()
            .find(|m| m.id == low_llm)
            .unwrap()
            .size_bytes = Some(10 * GIB);
        match select_tier(&machine(8, 500, Gpu::None), &cat) {
            Selection::Unsupported {
                why:
                    Unsupported::DoesNotFit {
                        memory_needed_bytes,
                        budget_bytes,
                    },
                ..
            } => {
                assert!(memory_needed_bytes > budget_bytes);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn dedicated_gpu_memory_can_hold_a_model_that_ram_alone_cannot() {
        // 16 GB RAM, 12 GB VRAM: the 8B model (about 5.2 GB + 1 GB) fits in 80% of VRAM and in 50% of RAM
        let Selection::Tier(t) = select_tier(
            &machine(
                16,
                500,
                Gpu::Nvidia {
                    vram_bytes: 12 * GIB,
                },
            ),
            &catalog(),
        ) else {
            panic!()
        };
        assert_eq!(t.id, "high");
        assert!(t.memory_needed_bytes <= (12.0 * GIB as f64 * 0.8) as u64);
    }

    #[test]
    fn tier_details_come_from_the_catalogue() {
        let Selection::Tier(t) = select_tier(&machine(16, 500, Gpu::None), &catalog()) else {
            panic!()
        };
        assert_eq!(t.llm_tag, "qwen3:4b-instruct-2507-q4_K_M");
        assert_eq!(t.stt_final_model_id, "stt-final-whisper-base-en");
        assert_eq!(t.stt_stream_model_id, "stt-stream-zipformer-en-2023-06-26");
        assert!(t.installed_bytes > 3_000_000_000 && t.installed_bytes < 4_000_000_000);
        assert_eq!(
            t.memory_needed_bytes,
            2_497_293_316 + CONTEXT_OVERHEAD_BYTES
        );
    }

    #[test]
    fn serialised_selection_is_tagged_for_the_ui() {
        let v = serde_json::to_value(select_tier(&machine(4, 500, Gpu::None), &catalog())).unwrap();
        assert_eq!(v["result"], "unsupported");
        assert_eq!(v["why"]["kind"], "ram-too-low");
        let v = serde_json::to_value(select_tier(&machine(8, 500, Gpu::None), &catalog())).unwrap();
        assert_eq!(v["result"], "tier");
        assert_eq!(v["id"], "low");
    }

    // ---- catalogue validation of tiers ----
    #[test]
    fn the_embedded_tiers_reference_real_models_of_the_right_kind() {
        // Catalog::embedded() validates this; here a broken tier table must be rejected.
        let mut value: serde_json::Value =
            serde_json::from_str(include_str!("../resources/models.json")).unwrap();
        value["llm_tiers"][0]["llm_model_id"] = "stt-final-whisper-base-en".into();
        assert!(
            Catalog::parse(&value.to_string())
                .unwrap_err()
                .contains("wrong kind")
        );
        let mut value: serde_json::Value =
            serde_json::from_str(include_str!("../resources/models.json")).unwrap();
        value["llm_tiers"][1]["llm_model_id"] = "no-such-model".into();
        assert!(
            Catalog::parse(&value.to_string())
                .unwrap_err()
                .contains("not in the catalogue")
        );
        let mut value: serde_json::Value =
            serde_json::from_str(include_str!("../resources/models.json")).unwrap();
        value["llm_tiers"].as_array_mut().unwrap().swap(0, 2);
        assert!(
            Catalog::parse(&value.to_string())
                .unwrap_err()
                .contains("ordered")
        );
    }

    #[test]
    fn this_machine_gets_a_decision() {
        let profile = crate::hardware::detect(&std::env::temp_dir());
        let selection = select_tier(&profile, &catalog());
        println!("THIS MACHINE: {profile:?}\n  -> {selection:?}");
        match selection {
            Selection::Tier(t) => assert!(t.disk_needed_bytes <= profile.free_disk_bytes),
            Selection::Unsupported { reason, .. } => assert!(!reason.is_empty()),
        }
    }

    // ---- the user's own choice (Task 21) ----------------------------------------------------

    fn mid_tier() -> Tier {
        match select_tier(&machine(16, 500, Gpu::None), &catalog()) {
            Selection::Tier(t) => *t,
            other => panic!("expected a tier, got {other:?}"),
        }
    }

    #[test]
    fn a_chosen_model_replaces_the_tiers_model_and_its_numbers() {
        let c = catalog();
        let tier = mid_tier();
        let big = c
            .find("llm-qwen3-8b")
            .expect("qwen3-8b is in the catalogue")
            .clone();
        let over = apply_llm_override(tier.clone(), &c, Some("llm-qwen3-8b"));
        assert_eq!(over.llm_model_id, "llm-qwen3-8b");
        assert_eq!(over.llm_tag, big.ollama_tag.clone().unwrap());
        assert_eq!(
            over.memory_needed_bytes,
            big.size_bytes.unwrap() + CONTEXT_OVERHEAD_BYTES
        );
        assert!(over.installed_bytes > tier.installed_bytes);
        assert_eq!(over.stt_final_model_id, tier.stt_final_model_id);
        assert_eq!(
            over.disk_needed_bytes,
            (over.installed_bytes as f64 * DISK_FACTOR).ceil() as u64
        );
    }

    #[test]
    fn no_choice_an_unknown_id_or_a_speech_model_leave_the_tier_alone() {
        let c = catalog();
        let tier = mid_tier();
        assert_eq!(apply_llm_override(tier.clone(), &c, None), tier);
        assert_eq!(
            apply_llm_override(tier.clone(), &c, Some("no-such-model")),
            tier
        );
        assert_eq!(
            apply_llm_override(tier.clone(), &c, Some(&tier.stt_final_model_id)),
            tier
        );
    }

    #[test]
    fn options_list_every_llm_smallest_first_and_flag_the_recommended_one() {
        let c = catalog();
        let p = machine(16, 500, Gpu::None);
        let tier = mid_tier();
        let options = llm_options(&p, &c, Some(&tier.llm_model_id));
        assert!(options.len() >= 3);
        assert!(
            options
                .windows(2)
                .all(|w| w[0].size_bytes <= w[1].size_bytes)
        );
        assert_eq!(options.iter().filter(|o| o.recommended).count(), 1);
        assert!(options.iter().find(|o| o.recommended).unwrap().id == tier.llm_model_id);
        assert!(options.iter().all(|o| o.tag.contains(':')));
    }

    #[test]
    fn a_model_too_big_for_the_computer_gets_a_warning_and_a_fitting_one_does_not() {
        let c = catalog();
        let small_machine = machine(8, 500, Gpu::None); // budget 4 GiB
        let options = llm_options(&small_machine, &c, None);
        let big = options.iter().find(|o| o.id == "llm-qwen3-8b").unwrap();
        assert!(!big.fits);
        let warning = big.warning.as_deref().unwrap();
        assert!(
            warning.contains("of memory") && warning.contains("GB"),
            "{warning}"
        );
        let small = options.first().unwrap();
        assert!(small.fits, "the smallest model fits an 8 GB computer");
        assert_eq!(small.warning, None);
        // a roomy machine has no warnings at all
        assert!(
            llm_options(&machine(64, 500, Gpu::None), &c, None)
                .iter()
                .all(|o| o.fits)
        );
    }

    #[test]
    fn nothing_is_marked_tested_before_the_eval_has_run_it() {
        let c = catalog();
        let options = llm_options(&machine(16, 500, Gpu::None), &c, None);
        assert!(
            options
                .iter()
                .all(|o| !o.tested || c.find(&o.id).unwrap().status.as_deref() == Some("tested"))
        );
    }
}
