//! Media service boundary.
//!
//! Phase 1 only inspects containers and reports whether direct webview playback
//! is worth attempting. Remuxing, proxy transcoding and native players are
//! deliberately absent: this module exists so those can be added behind the
//! same narrow command without changing the frontend contract.

use serde::Serialize;

use crate::security::{detect_kind, FileKind, ResolvedPath, SecurityError};

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PlaybackStrategy {
    /// Hand the file to an HTML media element.
    Direct,
    /// The container is not consistently supported by the target webviews.
    /// Phase 2 will remux or generate a proxy; today the user is offered an
    /// external player.
    ExternalPlayer,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaProbe {
    pub relative_path: String,
    pub kind: FileKind,
    pub container: String,
    pub size: u64,
    pub strategy: PlaybackStrategy,
}

/// Containers every target webview handles when the codecs are ordinary.
fn container_of(relative: &str) -> String {
    relative
        .rsplit('.')
        .next()
        .map(|e| e.to_lowercase())
        .unwrap_or_default()
}

pub fn probe(resolved: &ResolvedPath) -> Result<MediaProbe, SecurityError> {
    let kind = detect_kind(&resolved.absolute)?;
    if !matches!(kind, FileKind::Video | FileKind::Audio) {
        return Err(SecurityError::UnsupportedFile(resolved.relative.clone()));
    }
    let meta = std::fs::metadata(&resolved.absolute)?;
    let container = container_of(&resolved.relative);
    // Codec-level capability is decided in the frontend by asking the webview
    // itself; the container list here only avoids obviously futile attempts.
    let strategy = match container.as_str() {
        "mp4" | "m4v" | "webm" | "mp3" | "m4a" | "ogg" | "oga" | "opus" | "wav" | "flac" => {
            PlaybackStrategy::Direct
        }
        _ => PlaybackStrategy::ExternalPlayer,
    };
    Ok(MediaProbe {
        relative_path: resolved.relative.clone(),
        kind,
        container,
        size: meta.len(),
        strategy,
    })
}
