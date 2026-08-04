//! Thumbnail cache for large images.
//!
//! Thumbnails live in `.app/thumbnails` and are always rebuildable: deleting the
//! cache never touches canonical content. Generation is keyed by source path,
//! size and modification time, so an externally edited image regenerates.

use std::path::{Path, PathBuf};

use image::imageops::FilterType;
use sha2::{Digest, Sha256};

use crate::security::{detect_kind, FileKind, ResolvedPath, SecurityError};
use crate::workspace::THUMBNAIL_DIR;

/// Sources below this edge length are rendered directly; no cache entry.
pub const DIRECT_RENDER_MAX_EDGE: u32 = 1024;
/// Long edge of a generated thumbnail.
pub const THUMBNAIL_MAX_EDGE: u32 = 512;
/// Refuse to decode absurd images rather than exhausting memory.
pub const MAX_PIXELS: u64 = 80_000_000;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Thumbnail {
    /// Workspace-relative path of the cached thumbnail, or of the source when
    /// the source is already small enough to render directly.
    pub relative_path: String,
    pub width: u32,
    pub height: u32,
    pub cached: bool,
}

fn cache_key(resolved: &ResolvedPath) -> Result<String, SecurityError> {
    let meta = std::fs::metadata(&resolved.absolute)?;
    let modified = crate::persistence::modified_ms(&resolved.absolute);
    let mut hasher = Sha256::new();
    hasher.update(resolved.relative.as_bytes());
    hasher.update(meta.len().to_le_bytes());
    hasher.update(modified.to_le_bytes());
    hasher.update(THUMBNAIL_MAX_EDGE.to_le_bytes());
    Ok(format!("{:x}", hasher.finalize()))
}

/// Generate (or reuse) a thumbnail. Blocking; callers run it off the UI thread.
pub fn generate(root: &Path, resolved: &ResolvedPath) -> Result<Thumbnail, SecurityError> {
    if detect_kind(&resolved.absolute)? != FileKind::Image {
        return Err(SecurityError::UnsupportedFile(resolved.relative.clone()));
    }

    let (width, height) = image::image_dimensions(&resolved.absolute)
        .map_err(|err| SecurityError::Io(err.to_string()))?;

    if u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err(SecurityError::UnsupportedFile(format!(
            "{} is too large to decode",
            resolved.relative
        )));
    }

    if width.max(height) <= DIRECT_RENDER_MAX_EDGE {
        return Ok(Thumbnail {
            relative_path: resolved.relative.clone(),
            width,
            height,
            cached: false,
        });
    }

    let key = cache_key(resolved)?;
    let relative_path = format!("{THUMBNAIL_DIR}/{key}.png");
    let target: PathBuf = root.join(&relative_path);

    if target.exists() {
        if let Ok((w, h)) = image::image_dimensions(&target) {
            return Ok(Thumbnail {
                relative_path,
                width: w,
                height: h,
                cached: true,
            });
        }
    }

    let source =
        image::open(&resolved.absolute).map_err(|err| SecurityError::Io(err.to_string()))?;
    let thumb = source.resize(THUMBNAIL_MAX_EDGE, THUMBNAIL_MAX_EDGE, FilterType::Triangle);

    let mut bytes: Vec<u8> = Vec::new();
    thumb
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Png,
        )
        .map_err(|err| SecurityError::Io(err.to_string()))?;
    crate::persistence::write_atomic(&target, &bytes)
        .map_err(|err| SecurityError::Io(err.to_string()))?;

    Ok(Thumbnail {
        relative_path,
        width: thumb.width(),
        height: thumb.height(),
        cached: true,
    })
}
