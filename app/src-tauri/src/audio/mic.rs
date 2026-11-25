//! `MicSource`: the default input device through cpal, converted to 16 kHz mono f32.
//!
//! cpal streams are not `Send` on every platform, so the stream lives on its own thread.

use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{ErrorKind, FromSample, Sample, SampleFormat, SizedSample, StreamConfig};

use super::convert::{Chunker, downmix_to_mono};
use super::queue::ChunkQueue;
use super::resample::StreamResampler;
use super::{AudioError, AudioErrorKind, AudioSource, CHUNK_SAMPLES, Msg};

#[derive(Default)]
pub struct MicSource {
    /// The microphone the user chose in Settings; `None` = the system default.
    device_name: Option<String>,
    stop_tx: Option<mpsc::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl MicSource {
    pub fn new() -> Self {
        Self::default()
    }

    /// Records from the named microphone if it is connected, otherwise from the default one.
    pub fn with_device(device_name: Option<String>) -> Self {
        Self {
            device_name,
            ..Self::default()
        }
    }
}

/// One entry of the microphone list in Settings.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct InputDevice {
    pub name: String,
    pub is_default: bool,
}

fn device_name(device: &cpal::Device) -> Option<String> {
    device.description().ok().map(|d| d.name().to_string())
}

/// The connected input devices, the system default marked. Empty when none can be listed.
pub fn list_input_devices() -> Vec<InputDevice> {
    let host = cpal::default_host();
    let default = host.default_input_device().and_then(|d| device_name(&d));
    let mut out: Vec<InputDevice> = Vec::new();
    for name in host
        .input_devices()
        .into_iter()
        .flatten()
        .filter_map(|d| device_name(&d))
    {
        if !out.iter().any(|d| d.name == name) {
            out.push(InputDevice {
                is_default: default.as_deref() == Some(name.as_str()),
                name,
            });
        }
    }
    out
}

/// The name to open: the requested one if it is among the connected devices, else `None`
/// (meaning the system default). A microphone that was unplugged therefore never blocks recording.
pub fn pick_device<'a>(requested: Option<&'a str>, available: &[String]) -> Option<&'a str> {
    requested.filter(|r| available.iter().any(|a| a == r))
}

#[tauri::command]
pub fn audio_list_devices() -> Vec<InputDevice> {
    list_input_devices()
}

fn cpal_error(e: &cpal::Error) -> Option<AudioError> {
    match e.kind() {
        ErrorKind::DeviceNotAvailable | ErrorKind::StreamInvalidated => Some(AudioError::new(
            AudioErrorKind::DeviceLost,
            "The microphone was disconnected or stopped working.",
        )),
        ErrorKind::PermissionDenied => Some(AudioError::new(
            AudioErrorKind::PermissionDenied,
            "The system denied access to the microphone.",
        )),
        // Xrun (a glitch), DeviceChanged (rerouted but still running) and friends are not fatal.
        ErrorKind::Xrun | ErrorKind::DeviceChanged | ErrorKind::RealtimeDenied => None,
        _ => Some(AudioError::new(
            AudioErrorKind::Other,
            format!("Audio error: {e}"),
        )),
    }
}

/// Conversion state shared between the audio callback and `stop`, so the tail of the recording
/// (up to the last partial chunk) can be flushed instead of lost.
struct Pipeline {
    channels: usize,
    resampler: StreamResampler,
    chunker: Chunker,
}

impl Pipeline {
    fn new(config: &StreamConfig) -> Result<Self, AudioError> {
        Ok(Self {
            channels: usize::from(config.channels),
            resampler: StreamResampler::new(config.sample_rate)?,
            chunker: Chunker::new(CHUNK_SAMPLES),
        })
    }

    fn feed(&mut self, floats: &[f32], out: &ChunkQueue) {
        let mono = downmix_to_mono(floats, self.channels);
        match self.resampler.push(&mono) {
            Ok(samples) => {
                for chunk in self.chunker.push(&samples) {
                    out.push(Msg::Chunk(chunk));
                }
            }
            Err(e) => out.push(Msg::Error(e)),
        }
    }

    /// Pushes everything still buffered (resampler tail, then the final short chunk).
    fn flush(&mut self, out: &ChunkQueue) {
        match self.resampler.finish() {
            Ok(tail) => {
                for chunk in self.chunker.push(&tail) {
                    out.push(Msg::Chunk(chunk));
                }
            }
            Err(e) => out.push(Msg::Error(e)),
        }
        if let Some(rest) = self.chunker.flush() {
            out.push(Msg::Chunk(rest));
        }
    }
}

type SharedPipeline = Arc<Mutex<Pipeline>>;

fn build<T>(
    device: &cpal::Device,
    config: StreamConfig,
    out: Arc<ChunkQueue>,
    pipeline: SharedPipeline,
) -> Result<cpal::Stream, AudioError>
where
    T: SizedSample + Send + 'static,
    f32: FromSample<T>,
{
    let data_out = out.clone();
    let err_out = out;
    device
        .build_input_stream(
            config,
            move |data: &[T], _| {
                let floats: Vec<f32> = data.iter().map(|&s| f32::from_sample(s)).collect();
                pipeline
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .feed(&floats, &data_out);
            },
            move |e| match cpal_error(&e) {
                Some(err) => err_out.push(Msg::Error(err)),
                None => log::debug!("non-fatal audio stream event: {:?}", e.kind()),
            },
            None,
        )
        .map_err(|e| {
            cpal_error(&e).unwrap_or_else(|| AudioError::new(AudioErrorKind::Other, e.to_string()))
        })
}

fn open_stream(
    out: Arc<ChunkQueue>,
    pipeline_slot: &mut Option<SharedPipeline>,
    wanted: Option<&str>,
) -> Result<cpal::Stream, AudioError> {
    let host = cpal::default_host();
    let available: Vec<String> = host
        .input_devices()
        .into_iter()
        .flatten()
        .filter_map(|d| device_name(&d))
        .collect();
    let chosen = pick_device(wanted, &available).and_then(|name| {
        host.input_devices()
            .into_iter()
            .flatten()
            .find(|d| device_name(d).as_deref() == Some(name))
    });
    if wanted.is_some() && chosen.is_none() {
        log::info!("the chosen microphone is not connected; using the default one");
    }
    let device = chosen
        .or_else(|| host.default_input_device())
        .ok_or_else(|| {
            AudioError::new(
                AudioErrorKind::NoDevice,
                "No microphone was found. Connect one and try again.",
            )
        })?;
    let supported = device.default_input_config().map_err(|e| {
        AudioError::new(
            AudioErrorKind::NoDevice,
            format!("No usable microphone: {e}"),
        )
    })?;
    let format = supported.sample_format();
    let config: StreamConfig = supported.into();
    let pipeline: SharedPipeline = Arc::new(Mutex::new(Pipeline::new(&config)?));
    *pipeline_slot = Some(pipeline.clone());
    log::info!(
        "microphone opened: {} Hz, {} channel(s), {format:?}",
        config.sample_rate,
        config.channels
    );
    let stream = match format {
        SampleFormat::F32 => build::<f32>(&device, config, out, pipeline)?,
        SampleFormat::I16 => build::<i16>(&device, config, out, pipeline)?,
        SampleFormat::I32 => build::<i32>(&device, config, out, pipeline)?,
        SampleFormat::U16 => build::<u16>(&device, config, out, pipeline)?,
        SampleFormat::I8 => build::<i8>(&device, config, out, pipeline)?,
        SampleFormat::U8 => build::<u8>(&device, config, out, pipeline)?,
        SampleFormat::F64 => build::<f64>(&device, config, out, pipeline)?,
        other => {
            return Err(AudioError::new(
                AudioErrorKind::UnsupportedFormat,
                format!("The microphone uses an unsupported sample format ({other:?})."),
            ));
        }
    };
    stream.play().map_err(|e| {
        cpal_error(&e).unwrap_or_else(|| AudioError::new(AudioErrorKind::Other, e.to_string()))
    })?;
    Ok(stream)
}

impl AudioSource for MicSource {
    fn start(&mut self, out: Arc<ChunkQueue>) -> Result<(), AudioError> {
        if self.thread.is_some() {
            return Ok(());
        }
        let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<(), AudioError>>(1);
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let wanted = self.device_name.clone();
        let thread = thread::Builder::new()
            .name("yadi-mic".into())
            .spawn(move || {
                let mut pipeline = None;
                match open_stream(out.clone(), &mut pipeline, wanted.as_deref()) {
                    Ok(stream) => {
                        let _ = ready_tx.send(Ok(()));
                        // Keep the stream alive until asked to stop (or the owner is gone).
                        let _ = stop_rx.recv();
                        drop(stream);
                        // The stream is gone, so nothing else touches the pipeline: flush its tail.
                        if let Some(p) = pipeline {
                            p.lock().unwrap_or_else(|e| e.into_inner()).flush(&out);
                        }
                    }
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                    }
                }
            })
            .map_err(|e| AudioError::new(AudioErrorKind::Other, format!("thread: {e}")))?;
        match ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(())) => {
                self.stop_tx = Some(stop_tx);
                self.thread = Some(thread);
                Ok(())
            }
            Ok(Err(e)) => {
                let _ = thread.join();
                Err(e)
            }
            Err(_) => Err(AudioError::new(
                AudioErrorKind::Other,
                "The microphone did not start in time.",
            )),
        }
    }

    fn stop(&mut self) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

#[cfg(test)]
mod device_tests {
    use super::pick_device;

    fn list(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| n.to_string()).collect()
    }

    #[test]
    fn a_connected_microphone_is_used() {
        assert_eq!(
            pick_device(Some("USB Mic"), &list(&["Built-in", "USB Mic"])),
            Some("USB Mic")
        );
    }

    #[test]
    fn an_unplugged_microphone_falls_back_to_the_default() {
        assert_eq!(pick_device(Some("USB Mic"), &list(&["Built-in"])), None);
        assert_eq!(pick_device(Some("USB Mic"), &[]), None);
    }

    #[test]
    fn no_choice_means_the_default() {
        assert_eq!(pick_device(None, &list(&["Built-in"])), None);
    }

    #[test]
    fn names_must_match_exactly() {
        assert_eq!(pick_device(Some("usb mic"), &list(&["USB Mic"])), None);
    }
}
