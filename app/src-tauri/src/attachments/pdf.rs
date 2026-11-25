//! PDF text, with a time limit (extraction of a damaged file can take very long) and panic
//! isolation (the parser may panic on malformed input).

use super::{AttachmentError, ErrorKind, PDF_TIMEOUT_SECS};
use std::sync::mpsc;
use std::time::Duration;

pub fn extract(bytes: &[u8]) -> Result<String, AttachmentError> {
    if !bytes.starts_with(b"%PDF-") {
        return Err(AttachmentError::new(
            ErrorKind::Unreadable,
            "This file is not a PDF, or it is damaged.",
        ));
    }
    let data = bytes.to_vec();
    let (tx, rx) = mpsc::channel();
    // The thread cannot be killed, so on a timeout it is left to finish on its own. Its result is
    // dropped. A panic drops the sender, which we see as a disconnect below.
    std::thread::spawn(move || {
        let _ = tx.send(pdf_extract::extract_text_from_mem(&data));
    });
    match rx.recv_timeout(Duration::from_secs(PDF_TIMEOUT_SECS)) {
        Ok(Ok(text)) => Ok(text),
        Ok(Err(_)) => {
            log::warn!("pdf extraction failed"); // nothing about the file goes to the log
            Err(AttachmentError::new(
                ErrorKind::Unreadable,
                "This PDF could not be read (it may be password-protected or damaged).",
            ))
        }
        Err(mpsc::RecvTimeoutError::Timeout) => Err(AttachmentError::new(
            ErrorKind::Timeout,
            "Reading this PDF took too long, so it was skipped.",
        )),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(AttachmentError::new(
            ErrorKind::Unreadable,
            "This PDF could not be read (it may be damaged).",
        )),
    }
}
