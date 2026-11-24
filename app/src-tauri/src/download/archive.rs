//! Archive extraction (`.tar.bz2`, `.zip`) with path-traversal ("zip-slip") protection.

use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};

use bzip2_rs::DecoderReader as BzDecoder;

#[derive(Debug, PartialEq, Eq)]
pub enum ArchiveError {
    /// An entry tried to escape the destination (`../x`, absolute path, symlink...).
    UnsafeEntry(String),
    Unsupported(String),
    Io(String),
}

impl std::fmt::Display for ArchiveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ArchiveError::UnsafeEntry(p) => write!(
                f,
                "The archive contains an unsafe path ({p}); it was not extracted."
            ),
            ArchiveError::Unsupported(m) => write!(f, "Unsupported archive: {m}"),
            ArchiveError::Io(m) => write!(f, "Could not extract the archive: {m}"),
        }
    }
}

impl std::error::Error for ArchiveError {}

fn io_err(e: impl std::fmt::Display) -> ArchiveError {
    ArchiveError::Io(e.to_string())
}

/// True if `path` stays inside the extraction root: relative, no `..`, no drive/root prefix.
pub fn is_safe_entry_path(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && path
            .components()
            .all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
}

/// Extracts `archive` into `dest_dir` (created if needed). Returns the extracted file paths.
/// Nothing outside `dest_dir` is ever written.
pub fn extract(archive: &Path, dest_dir: &Path) -> Result<Vec<PathBuf>, ArchiveError> {
    fs::create_dir_all(dest_dir).map_err(io_err)?;
    let name = archive
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if name.ends_with(".tar.bz2") || name.ends_with(".tbz2") {
        extract_tar_bz2(archive, dest_dir)
    } else if name.ends_with(".zip") {
        extract_zip(archive, dest_dir)
    } else {
        Err(ArchiveError::Unsupported(format!(
            "{name} (only .tar.bz2 and .zip)"
        )))
    }
}

fn extract_tar_bz2(archive: &Path, dest_dir: &Path) -> Result<Vec<PathBuf>, ArchiveError> {
    let file = File::open(archive).map_err(io_err)?;
    let mut tar = tar::Archive::new(BzDecoder::new(file));
    let mut out = Vec::new();
    for entry in tar.entries().map_err(io_err)? {
        let mut entry = entry.map_err(io_err)?;
        let path = entry.path().map_err(io_err)?.into_owned();
        if !is_safe_entry_path(&path) {
            return Err(ArchiveError::UnsafeEntry(path.display().to_string()));
        }
        let kind = entry.header().entry_type();
        if kind.is_symlink() || kind.is_hard_link() {
            return Err(ArchiveError::UnsafeEntry(format!(
                "{} (link)",
                path.display()
            )));
        }
        if !(kind.is_file() || kind.is_dir()) {
            continue; // devices, pax headers and the like
        }
        let target = dest_dir.join(&path);
        if kind.is_dir() {
            fs::create_dir_all(&target).map_err(io_err)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(io_err)?;
        }
        let mut f = File::create(&target).map_err(io_err)?;
        io::copy(&mut entry, &mut f).map_err(io_err)?;
        out.push(target);
    }
    Ok(out)
}

/// The entry's name exactly as stored (zip 9's `name()` can fail on bad UTF-8).
fn raw_name<R: Read + ?Sized>(entry: &zip::read::ZipFile<'_, R>) -> String {
    String::from_utf8_lossy(entry.name_raw()).into_owned()
}

fn extract_zip(archive: &Path, dest_dir: &Path) -> Result<Vec<PathBuf>, ArchiveError> {
    let file = File::open(archive).map_err(io_err)?;
    let mut zip = zip::ZipArchive::new(file).map_err(io_err)?;
    let mut out = Vec::new();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(io_err)?;
        // `enclosed_name` is None for absolute paths and for any `..` that escapes the root.
        let Some(rel) = entry.enclosed_name() else {
            return Err(ArchiveError::UnsafeEntry(raw_name(&entry)));
        };
        if !is_safe_entry_path(&rel) {
            return Err(ArchiveError::UnsafeEntry(raw_name(&entry)));
        }
        if entry.is_symlink() {
            return Err(ArchiveError::UnsafeEntry(format!(
                "{} (link)",
                raw_name(&entry)
            )));
        }
        let target = dest_dir.join(&rel);
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(io_err)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(io_err)?;
        }
        let mut f = File::create(&target).map_err(io_err)?;
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf).map_err(io_err)?;
        io::Write::write_all(&mut f, &buf).map_err(io_err)?;
        out.push(target);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("yadi-arc-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Builds a .tar.bz2 from (path, contents) pairs. Paths are written raw so that
    /// hostile names (`../evil`) can be created, which `tar::Builder` would refuse.
    fn make_tar_bz2(path: &Path, entries: &[(&str, &[u8])], symlink: Option<(&str, &str)>) {
        let mut tar_bytes = Vec::new();
        {
            let mut b = tar::Builder::new(&mut tar_bytes);
            for (name, data) in entries {
                let mut h = tar::Header::new_gnu();
                h.set_size(data.len() as u64);
                h.set_mode(0o644);
                h.set_entry_type(tar::EntryType::Regular);
                let raw = h.as_old_mut();
                raw.name = [0; 100];
                raw.name[..name.len()].copy_from_slice(name.as_bytes());
                h.set_cksum();
                b.append(&h, *data).unwrap();
            }
            if let Some((name, target)) = symlink {
                let mut h = tar::Header::new_gnu();
                h.set_size(0);
                h.set_entry_type(tar::EntryType::Symlink);
                h.set_link_name(target).unwrap();
                let raw = h.as_old_mut();
                raw.name = [0; 100];
                raw.name[..name.len()].copy_from_slice(name.as_bytes());
                h.set_cksum();
                b.append(&h, std::io::empty()).unwrap();
            }
            b.finish().unwrap();
        }
        let mut enc =
            bzip2::write::BzEncoder::new(File::create(path).unwrap(), bzip2::Compression::fast());
        enc.write_all(&tar_bytes).unwrap();
        enc.finish().unwrap();
    }

    fn make_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let mut w = zip::ZipWriter::new(File::create(path).unwrap());
        let opts = zip::write::SimpleFileOptions::default();
        for (name, data) in entries {
            w.start_file(*name, opts).unwrap();
            w.write_all(data).unwrap();
        }
        w.finish().unwrap();
    }

    #[test]
    fn extracts_a_tar_bz2() {
        let dir = tmp("tar-ok");
        let archive = dir.join("model.tar.bz2");
        make_tar_bz2(
            &archive,
            &[("model/a.txt", b"hello"), ("model/sub/b.txt", b"world")],
            None,
        );
        let out = dir.join("out");
        let files = extract(&archive, &out).unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(fs::read(out.join("model/a.txt")).unwrap(), b"hello");
        assert_eq!(fs::read(out.join("model/sub/b.txt")).unwrap(), b"world");
    }

    #[test]
    fn extracts_a_zip() {
        let dir = tmp("zip-ok");
        let archive = dir.join("model.zip");
        make_zip(&archive, &[("m/a.txt", b"zipped")]);
        let out = dir.join("out");
        extract(&archive, &out).unwrap();
        assert_eq!(fs::read(out.join("m/a.txt")).unwrap(), b"zipped");
    }

    #[test]
    fn zip_slip_entry_in_a_zip_is_rejected_and_nothing_escapes() {
        let dir = tmp("zip-slip");
        let archive = dir.join("evil.zip");
        make_zip(&archive, &[("ok.txt", b"fine"), ("../evil.txt", b"pwned")]);
        let out = dir.join("out");
        let err = extract(&archive, &out).unwrap_err();
        assert!(matches!(err, ArchiveError::UnsafeEntry(_)), "{err:?}");
        assert!(
            !dir.join("evil.txt").exists(),
            "nothing was written outside the destination"
        );
    }

    #[test]
    fn dot_dot_entry_in_a_tar_is_rejected_and_nothing_escapes() {
        let dir = tmp("tar-slip");
        let archive = dir.join("evil.tar.bz2");
        make_tar_bz2(&archive, &[("../evil.txt", b"pwned")], None);
        let out = dir.join("out");
        let err = extract(&archive, &out).unwrap_err();
        assert!(matches!(err, ArchiveError::UnsafeEntry(_)), "{err:?}");
        assert!(!dir.join("evil.txt").exists());
    }

    #[test]
    fn absolute_paths_in_a_tar_are_rejected() {
        let dir = tmp("tar-abs");
        let archive = dir.join("abs.tar.bz2");
        make_tar_bz2(&archive, &[("/tmp/yadi-evil.txt", b"x")], None);
        assert!(matches!(
            extract(&archive, &dir.join("out")),
            Err(ArchiveError::UnsafeEntry(_))
        ));
        assert!(!Path::new("/tmp/yadi-evil.txt").exists());
    }

    #[test]
    fn symlinks_in_a_tar_are_rejected() {
        let dir = tmp("tar-link");
        let archive = dir.join("link.tar.bz2");
        make_tar_bz2(
            &archive,
            &[("a.txt", b"x")],
            Some(("sneaky", "/etc/passwd")),
        );
        assert!(matches!(
            extract(&archive, &dir.join("out")),
            Err(ArchiveError::UnsafeEntry(_))
        ));
    }

    #[test]
    fn unknown_archive_type_is_unsupported() {
        let dir = tmp("unk");
        let f = dir.join("x.rar");
        fs::write(&f, b"x").unwrap();
        assert!(matches!(
            extract(&f, &dir.join("out")),
            Err(ArchiveError::Unsupported(_))
        ));
    }

    #[test]
    fn path_safety_rules() {
        assert!(is_safe_entry_path(Path::new("model/file.onnx")));
        assert!(is_safe_entry_path(Path::new("./model/file.onnx")));
        assert!(!is_safe_entry_path(Path::new("../x")));
        assert!(!is_safe_entry_path(Path::new("a/../../x")));
        assert!(!is_safe_entry_path(Path::new("/abs")));
        assert!(!is_safe_entry_path(Path::new("")));
    }
}
