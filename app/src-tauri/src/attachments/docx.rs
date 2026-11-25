//! `.docx` text: the paragraphs of `word/document.xml` inside the zip.

use super::{AttachmentError, ErrorKind, MAX_DOCX_XML_BYTES};
use quick_xml::Reader;
use quick_xml::events::Event;
use std::io::{Cursor, Read};

const MAX_ENTRIES: usize = 20_000;

fn unreadable() -> AttachmentError {
    AttachmentError::new(
        ErrorKind::Unreadable,
        "This Word file could not be read (it may be damaged).",
    )
}

pub fn extract(bytes: &[u8]) -> Result<String, AttachmentError> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| unreadable())?;
    if archive.len() > MAX_ENTRIES {
        return Err(AttachmentError::new(
            ErrorKind::ZipBomb,
            "This Word file is not safe to open.",
        ));
    }
    let entry = archive
        .by_name("word/document.xml")
        .map_err(|_| unreadable())?;
    // Both the declared size and what actually comes out are limited: a lying header cannot get
    // around the second check.
    if entry.size() > MAX_DOCX_XML_BYTES {
        return Err(AttachmentError::new(
            ErrorKind::ZipBomb,
            "This Word file expands to far too much text to open safely.",
        ));
    }
    let mut xml = Vec::new();
    entry
        .take(MAX_DOCX_XML_BYTES + 1)
        .read_to_end(&mut xml)
        .map_err(|_| unreadable())?;
    if xml.len() as u64 > MAX_DOCX_XML_BYTES {
        return Err(AttachmentError::new(
            ErrorKind::ZipBomb,
            "This Word file expands to far too much text to open safely.",
        ));
    }
    paragraphs(&xml)
}

/// Text of `<w:t>` runs, a newline after each paragraph, tabs and line breaks kept.
fn paragraphs(xml: &[u8]) -> Result<String, AttachmentError> {
    let mut reader = Reader::from_reader(xml);
    let mut out = String::new();
    let mut in_text = false;
    loop {
        match reader.read_event().map_err(|_| unreadable())? {
            Event::Start(e) => match e.local_name().as_ref() {
                "t" => in_text = true,
                "tab" => out.push('\t'),
                "br" | "cr" => out.push('\n'),
                _ => {}
            },
            Event::Empty(e) => match e.local_name().as_ref() {
                "tab" => out.push('\t'),
                "br" | "cr" => out.push('\n'),
                _ => {}
            },
            Event::End(e) => match e.local_name().as_ref() {
                "t" => in_text = false,
                "p" => out.push('\n'),
                _ => {}
            },
            Event::Text(t) if in_text => out.push_str(&t.xml10_content()),
            Event::GeneralRef(r) if in_text => match r.as_ref() {
                "amp" => out.push('&'),
                "lt" => out.push('<'),
                "gt" => out.push('>'),
                "quot" => out.push('"'),
                "apos" => out.push('\''),
                _ => {
                    if let Ok(Some(c)) = r.resolve_char_ref() {
                        out.push(c);
                    }
                }
            },
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(out)
}
