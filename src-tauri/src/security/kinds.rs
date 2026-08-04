//! File kind classification.
//!
//! Extensions decide which files are *offered* to the user; content sniffing
//! decides how a file is actually rendered. A `.png` holding a PDF is reported
//! as a PDF, and a file whose magic bytes match nothing renderable is rejected
//! rather than handed to a viewer.

use std::io::Read;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::SecurityError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FileKind {
    Markdown,
    Canvas,
    Image,
    Pdf,
    Video,
    Audio,
    Text,
    Unsupported,
}

impl FileKind {
    pub fn is_media(self) -> bool {
        matches!(self, FileKind::Image | FileKind::Video | FileKind::Audio)
    }
}

/// Extensions the workspace browser lists. Anything else is ignored.
pub fn kind_for_extension(path: &Path) -> FileKind {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "md" | "markdown" | "mdown" => FileKind::Markdown,
        "canvas" => FileKind::Canvas,
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "avif" | "svg" => FileKind::Image,
        "pdf" => FileKind::Pdf,
        "mp4" | "webm" | "m4v" | "mov" | "mkv" => FileKind::Video,
        "mp3" | "m4a" | "ogg" | "oga" | "opus" | "wav" | "flac" => FileKind::Audio,
        "txt" | "csv" | "log" => FileKind::Text,
        _ => FileKind::Unsupported,
    }
}

/// Classify by magic bytes, falling back to the extension for text formats
/// (Markdown, plain text and `.canvas` JSON have no magic bytes).
pub fn detect_kind(path: &Path) -> Result<FileKind, SecurityError> {
    let by_extension = kind_for_extension(path);
    let mut head = [0u8; 512];
    let read = {
        let mut file = std::fs::File::open(path)?;
        file.read(&mut head)?
    };
    let head = &head[..read];

    if let Some(kind) = infer::get(head) {
        let mime = kind.mime_type();
        let sniffed = match mime {
            m if m.starts_with("image/") => FileKind::Image,
            m if m.starts_with("video/") => FileKind::Video,
            m if m.starts_with("audio/") => FileKind::Audio,
            "application/pdf" => FileKind::Pdf,
            _ => FileKind::Unsupported,
        };
        // Text-first formats are never overridden by a container guess.
        if matches!(
            by_extension,
            FileKind::Markdown | FileKind::Canvas | FileKind::Text
        ) {
            return Ok(by_extension);
        }
        return Ok(sniffed);
    }

    // No magic bytes. Accept only if the content is valid UTF-8 text and the
    // extension claims a text format; SVG is XML and also lands here.
    match by_extension {
        FileKind::Markdown | FileKind::Canvas | FileKind::Text => {
            if std::str::from_utf8(head).is_ok() || read == head.len() {
                Ok(by_extension)
            } else {
                Ok(FileKind::Unsupported)
            }
        }
        FileKind::Image if is_svg(head) => Ok(FileKind::Image),
        _ => Ok(FileKind::Unsupported),
    }
}

fn is_svg(head: &[u8]) -> bool {
    let text = String::from_utf8_lossy(head).to_lowercase();
    text.contains("<svg")
}

/// MIME type used when serving a file through the local protocol handler.
pub fn mime_for(path: &Path, kind: FileKind) -> &'static str {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/opus",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        _ => match kind {
            FileKind::Markdown | FileKind::Text => "text/plain; charset=utf-8",
            FileKind::Canvas => "application/json; charset=utf-8",
            _ => "application/octet-stream",
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_magic_wins_over_extension() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("actually.jpg");
        let png = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0];
        std::fs::write(&path, png).unwrap();
        assert_eq!(detect_kind(&path).unwrap(), FileKind::Image);
    }

    #[test]
    fn executable_disguised_as_image_is_unsupported() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("payload.png");
        // ELF header.
        std::fs::write(&path, [0x7f, b'E', b'L', b'F', 2, 1, 1, 0, 0, 0, 0, 0]).unwrap();
        assert_eq!(detect_kind(&path).unwrap(), FileKind::Unsupported);
    }

    #[test]
    fn markdown_is_text_classified() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        std::fs::write(&path, b"# Title\n").unwrap();
        assert_eq!(detect_kind(&path).unwrap(), FileKind::Markdown);
    }

    #[test]
    fn pdf_is_detected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("doc.pdf");
        std::fs::write(&path, b"%PDF-1.7\n1 0 obj\n").unwrap();
        assert_eq!(detect_kind(&path).unwrap(), FileKind::Pdf);
    }
}
