use super::*;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

fn err_kind(r: Result<Extracted, AttachmentError>) -> ErrorKind {
    r.expect_err("expected an error").kind
}

/// A fresh empty folder under the system temp dir, removed on drop.
struct TempDir(PathBuf);
impl TempDir {
    fn new() -> Self {
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "yadi-attach-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
    fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let p = self.0.join(name);
        std::fs::write(&p, bytes).unwrap();
        p
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// ---- fixtures built in code -------------------------------------------------------------------

/// A one-page PDF with `text` set in Helvetica, with a correct cross-reference table.
fn pdf_with_text(text: &str) -> Vec<u8> {
    let stream = format!("BT /F1 24 Tf 72 700 Td ({text}) Tj ET");
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R \
         /Resources << /Font << /F1 5 0 R >> >> >>"
            .to_string(),
        format!(
            "<< /Length {} >>\nstream\n{stream}\nendstream",
            stream.len()
        ),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
    ];
    let mut out = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (i, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend(format!("{} 0 obj\n{body}\nendobj\n", i + 1).bytes());
    }
    let xref = out.len();
    out.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).bytes());
    for o in offsets {
        out.extend(format!("{o:010} 00000 n \n").bytes());
    }
    out.extend(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            objects.len() + 1
        )
        .bytes(),
    );
    out
}

/// A `.docx` whose `word/document.xml` is `xml`.
fn docx_with_xml(xml: &[u8]) -> Vec<u8> {
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut buf);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("[Content_Types].xml", options).unwrap();
        zip.write_all(b"<Types/>").unwrap();
        zip.start_file("word/document.xml", options).unwrap();
        zip.write_all(xml).unwrap();
        zip.finish().unwrap();
    }
    buf.into_inner()
}

const W: &str = r#"xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main""#;

fn docx_body(inner: &str) -> Vec<u8> {
    docx_with_xml(
        format!(r#"<?xml version="1.0"?><w:document {W}><w:body>{inner}</w:body></w:document>"#)
            .as_bytes(),
    )
}

// ---- text types ---------------------------------------------------------------------------------

#[test]
fn reads_each_supported_text_type() {
    let cases = [
        ("notes.txt", "plain words", "txt"),
        ("README.md", "# Title\n\nBody", "md"),
        ("data.csv", "a,b\n1,2\n", "csv"),
        ("config.json", r#"{"a": 1}"#, "json"),
        ("server.LOG", "2026-01-01 ERROR boom", "log"),
        ("main.rs", "fn main() {}", "rs"),
        ("App.tsx", "export const A = () => <div/>;", "tsx"),
        ("script.py", "print('hi')", "py"),
        ("query.sql", "select 1;", "sql"),
        ("Makefile.mk", "all:\n\techo hi", "mk"), // unknown extension, but text
    ];
    for (name, body, label) in cases {
        let got =
            extract_from_bytes(name, body.as_bytes()).unwrap_or_else(|e| panic!("{name}: {e:?}"));
        assert_eq!(got.text, body.trim(), "{name}");
        assert_eq!(got.type_label, label, "{name}");
        assert_eq!(got.size_bytes, body.len() as u64);
        assert!(!got.truncated);
    }
}

#[test]
fn a_file_with_no_extension_that_looks_like_text_is_text() {
    let got = extract_from_bytes("LICENSE", b"Some licence words").unwrap();
    assert_eq!(got.type_label, "text");
    let dotfile = extract_from_bytes(".gitignore", b"target/\n").unwrap();
    assert_eq!(dotfile.type_label, "text");
}

#[test]
fn invalid_utf8_is_read_leniently() {
    let got = extract_from_bytes("latin1.txt", b"caf\xE9 au lait").unwrap();
    assert_eq!(got.text, "caf\u{FFFD} au lait");
}

#[test]
fn a_utf8_bom_and_crlf_are_cleaned() {
    let got = extract_from_bytes("win.txt", b"\xEF\xBB\xBFone\r\ntwo\r\n").unwrap();
    assert_eq!(got.text, "one\ntwo");
}

// ---- refusals ----------------------------------------------------------------------------------

#[test]
fn a_binary_file_is_rejected_even_with_a_text_extension() {
    let mut bytes = b"looks fine at first".to_vec();
    bytes.extend([0u8; 16]);
    assert_eq!(
        err_kind(extract_from_bytes("fake.txt", &bytes)),
        ErrorKind::Binary
    );
}

#[test]
fn images_and_other_unsupported_types_say_not_supported_yet() {
    for name in [
        "photo.PNG",
        "pic.jpg",
        "x.heic",
        "a.zip",
        "song.mp3",
        "old.doc",
        "sheet.xlsx",
        "d.svg",
    ] {
        let e = extract_from_bytes(name, b"whatever").unwrap_err();
        assert_eq!(e.kind, ErrorKind::Unsupported, "{name}");
        assert!(
            e.message.contains("not supported yet"),
            "{name}: {}",
            e.message
        );
    }
}

#[test]
fn an_unknown_extension_with_binary_content_is_unsupported() {
    let e = extract_from_bytes("thing.xyz", &[0, 1, 2, 3, 0, 0]).unwrap_err();
    assert_eq!(e.kind, ErrorKind::Unsupported);
}

#[test]
fn an_oversize_file_is_rejected_at_exactly_one_byte_over() {
    let ok = vec![b'a'; MAX_FILE_BYTES as usize];
    assert!(extract_from_bytes("big.txt", &ok).is_ok());
    let over = vec![b'a'; MAX_FILE_BYTES as usize + 1];
    let e = extract_from_bytes("big.txt", &over).unwrap_err();
    assert_eq!(e.kind, ErrorKind::TooLarge);
    assert!(e.message.contains("5 MB"));
}

#[test]
fn an_oversize_file_on_disk_is_refused_without_being_read() {
    let dir = TempDir::new();
    let path = dir.0.join("huge.txt");
    let f = std::fs::File::create(&path).unwrap();
    f.set_len(MAX_FILE_BYTES + 10).unwrap(); // sparse: nothing is really written
    assert_eq!(err_kind(extract_from_path(&path)), ErrorKind::TooLarge);
}

#[test]
fn empty_and_whitespace_only_files_are_rejected() {
    assert_eq!(err_kind(extract_from_bytes("a.txt", b"")), ErrorKind::Empty);
    assert_eq!(
        err_kind(extract_from_bytes("a.txt", b" \n\t \r\n")),
        ErrorKind::Empty
    );
}

// ---- cleaning ----------------------------------------------------------------------------------

#[test]
fn control_characters_and_hidden_marks_are_removed() {
    let dirty = "a\u{1b}[31mred\u{7}\u{8}b \u{202E}evil\u{202C} c\u{200B}d\u{FEFF}e\tf\ng";
    assert_eq!(sanitize(dirty), "a[31mredb evil cde\tf\ng");
}

#[test]
fn emoji_joiners_survive() {
    let family = "👨\u{200D}👩\u{200D}👧";
    assert_eq!(sanitize(family), family);
}

#[test]
fn very_long_text_is_cut_and_flagged() {
    let body = "x".repeat(MAX_TEXT_CHARS + 10);
    let got = extract_from_bytes("long.txt", body.as_bytes()).unwrap();
    assert!(got.truncated);
    assert_eq!(got.text.chars().count(), MAX_TEXT_CHARS);
}

#[test]
fn truncation_never_splits_a_character() {
    let (t, cut) = truncate_chars("héllo wörld", 2);
    assert_eq!(t, "hé");
    assert!(cut);
    assert_eq!(truncate_chars("abc", 3), ("abc".to_string(), false));
}

#[test]
fn names_lose_folders_and_control_characters() {
    assert_eq!(display_name("/Users/jane/docs/report.txt"), "report.txt");
    assert_eq!(display_name(r"C:\Users\jane\docs\report.txt"), "report.txt");
    assert_eq!(display_name("bad\nname\u{7}.txt"), "bad name.txt");
    assert_eq!(display_name(""), "attachment");
    assert_eq!(display_name("a/"), "attachment");
}

// ---- pdf ---------------------------------------------------------------------------------------

#[test]
fn reads_text_from_a_pdf() {
    let got = extract_from_bytes("paper.pdf", &pdf_with_text("Hello PDF world")).unwrap();
    assert_eq!(got.type_label, "pdf");
    assert!(got.text.contains("Hello PDF world"), "got {:?}", got.text);
}

#[test]
fn a_pdf_fixture_is_tiny() {
    assert!(pdf_with_text("Hello").len() < 2_000);
}

#[test]
fn a_file_called_pdf_that_is_not_one_is_unreadable() {
    assert_eq!(
        err_kind(extract_from_bytes("x.pdf", b"just text")),
        ErrorKind::Unreadable
    );
}

#[test]
fn a_damaged_pdf_fails_cleanly_instead_of_crashing() {
    let mut bytes = b"%PDF-1.4\n".to_vec();
    bytes.extend(b"1 0 obj << /Type /Catalog >> endobj garbage garbage \xff\xfe\x00\x01");
    let kind = err_kind(extract_from_bytes("broken.pdf", &bytes));
    assert!(
        matches!(kind, ErrorKind::Unreadable | ErrorKind::Empty),
        "{kind:?}"
    );
}

// ---- docx --------------------------------------------------------------------------------------

#[test]
fn reads_paragraphs_from_a_docx() {
    let bytes = docx_body(
        "<w:p><w:r><w:t>First paragraph</w:t></w:r></w:p>\
         <w:p><w:r><w:t xml:space=\"preserve\">Second </w:t></w:r><w:r><w:t>one</w:t></w:r></w:p>",
    );
    let got = extract_from_bytes("letter.docx", &bytes).unwrap();
    assert_eq!(got.type_label, "docx");
    assert_eq!(got.text, "First paragraph\nSecond one");
}

#[test]
fn docx_entities_tabs_and_breaks() {
    let bytes = docx_body(
        "<w:p><w:r><w:t>Fish &amp; chips &lt;3 &#233;</w:t><w:tab/><w:t>x</w:t><w:br/><w:t>y</w:t></w:r></w:p>",
    );
    let got = extract_from_bytes("a.docx", &bytes).unwrap();
    assert_eq!(got.text, "Fish & chips <3 é\tx\ny");
}

#[test]
fn text_outside_runs_is_ignored() {
    let bytes = docx_body(
        "<w:p><w:instrText>SECRET FIELD CODE</w:instrText><w:r><w:t>shown</w:t></w:r></w:p>",
    );
    assert_eq!(extract_from_bytes("a.docx", &bytes).unwrap().text, "shown");
}

#[test]
fn a_docx_that_is_not_a_zip_is_unreadable() {
    assert_eq!(
        err_kind(extract_from_bytes("a.docx", b"not a zip")),
        ErrorKind::Unreadable
    );
}

#[test]
fn a_zip_without_a_document_is_unreadable() {
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut buf);
        zip.start_file("other.txt", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"hi").unwrap();
        zip.finish().unwrap();
    }
    assert_eq!(
        err_kind(extract_from_bytes("a.docx", &buf.into_inner())),
        ErrorKind::Unreadable
    );
}

#[test]
fn a_zip_bomb_is_refused() {
    // 26 MB of spaces deflates to a few KB, which is under the file limit but over the expansion limit.
    let xml = format!(
        r#"<?xml version="1.0"?><w:document {W}><w:body><w:p><w:r><w:t>{}</w:t></w:r></w:p></w:body></w:document>"#,
        " ".repeat(MAX_DOCX_XML_BYTES as usize + 1000)
    );
    let bomb = docx_with_xml(xml.as_bytes());
    assert!(
        bomb.len() < 200_000,
        "the fixture itself must be small, was {}",
        bomb.len()
    );
    assert_eq!(
        err_kind(extract_from_bytes("bomb.docx", &bomb)),
        ErrorKind::ZipBomb
    );
}

// ---- paths -------------------------------------------------------------------------------------

#[test]
fn reads_a_file_from_disk_and_uses_its_name() {
    let dir = TempDir::new();
    let path = dir.file("brief.md", b"# Brief\nDo the thing.");
    let got = extract_from_path(&path).unwrap();
    assert_eq!(got.name, "brief.md");
    assert_eq!(got.text, "# Brief\nDo the thing.");
}

#[test]
fn a_missing_file_is_unreadable() {
    let dir = TempDir::new();
    assert_eq!(
        err_kind(extract_from_path(&dir.0.join("nope.txt"))),
        ErrorKind::Unreadable
    );
}

#[test]
fn a_folder_is_refused_and_nothing_inside_is_read() {
    let dir = TempDir::new();
    dir.file("inside.txt", b"secret");
    let e = extract_from_path(&dir.0).unwrap_err();
    assert_eq!(e.kind, ErrorKind::Folder);
    assert!(!e.message.contains("secret"));
}

#[cfg(unix)]
#[test]
fn a_dropped_symlink_to_a_file_is_resolved_once() {
    let dir = TempDir::new();
    let target = dir.file("real.txt", b"through the link");
    let link = dir.0.join("link.txt");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    let got = extract_from_path(&link).unwrap();
    assert_eq!(got.text, "through the link");
    assert_eq!(got.name, "link.txt"); // named as dropped
}

#[cfg(unix)]
#[test]
fn a_symlink_to_a_folder_or_to_nothing_is_refused() {
    let dir = TempDir::new();
    let sub = dir.0.join("sub");
    std::fs::create_dir(&sub).unwrap();
    let to_dir = dir.0.join("to_dir");
    std::os::unix::fs::symlink(&sub, &to_dir).unwrap();
    assert_eq!(err_kind(extract_from_path(&to_dir)), ErrorKind::Folder);
    let dangling = dir.0.join("dangling");
    std::os::unix::fs::symlink(dir.0.join("gone"), &dangling).unwrap();
    assert_eq!(
        err_kind(extract_from_path(&dangling)),
        ErrorKind::Unreadable
    );
}

#[test]
fn errors_serialise_with_a_kebab_case_kind() {
    let e = AttachmentError::new(ErrorKind::TooLarge, "big");
    assert_eq!(
        serde_json::to_string(&e).unwrap(),
        r#"{"kind":"too-large","message":"big"}"#
    );
}
